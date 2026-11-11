// @vitest-environment happy-dom
// pouchdb-browser touches browser globals at import time, so this suite runs under
// a lightweight DOM. The in-memory adapter needs no IndexedDB.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import PouchDB from "pouchdb-browser";
import memoryAdapter from "pouchdb-adapter-memory";
import { TFile } from "obsidian";
import { SyncEngine } from "../src/engine";
import { SyncDatabase } from "../src/database";
import { DEFAULT_SETTINGS, FILE_PREFIX, type CouchDBSyncSettings } from "../src/types";

PouchDB.plugin(memoryAdapter);

/**
 * A conflict revision this device cannot read — written by a newer plugin version, or
 * under another passphrase — used to abort conflict resolution for the whole vault:
 * every conflict after it stayed red, on every pass. Now that one file keeps its
 * conflict (and the unreadable revision, which is another device's edit) and every
 * other conflict still resolves.
 */

interface Entry { bytes: Uint8Array; mtime: number; ctime: number; size: number }
type Internals = { handleLocalUpsert(f: TFile): Promise<void> };
const pv = (e: SyncEngine) => e as unknown as Internals;

let counter = 0;
let db: SyncDatabase;
let engine: SyncEngine;
let files: Map<string, Entry>;
let settings: CouchDBSyncSettings;

function setFile(path: string, text: string, mtime: number): void {
	const bytes = new TextEncoder().encode(text);
	files.set(path, { bytes, mtime, ctime: mtime, size: bytes.byteLength });
}
function tfile(path: string): TFile {
	const e = files.get(path)!;
	const f = new TFile();
	Object.assign(f, { path, stat: { mtime: e.mtime, ctime: e.ctime, size: e.size } });
	return f;
}
function makeApp() {
	return {
		vault: {
			configDir: ".obsidian",
			on: () => ({}),
			offref: () => undefined,
			getFiles: () => [...files.keys()].map(tfile),
			getAbstractFileByPath: (p: string) => (files.has(p) ? tfile(p) : null),
			create: async (p: string, text: string) => { setFile(p, text, 5000); return tfile(p); },
			modify: async (f: TFile, text: string) => { setFile(f.path, text, 6000); },
			createBinary: async () => undefined,
			modifyBinary: async () => undefined,
			createFolder: async () => undefined,
			adapter: {
				async readBinary(p: string): Promise<ArrayBuffer> { return files.get(p)!.bytes.slice().buffer; },
				async exists(p: string) { return files.has(p); },
				async stat(p: string) {
					const e = files.get(p);
					return e ? { type: "file" as const, mtime: e.mtime, ctime: e.ctime, size: e.size } : null;
				},
			},
		},
		fileManager: { trashFile: async () => undefined },
	};
}

/** Add a competing gen-1 leaf to `path`'s document, as replication would. */
async function addLeaf(path: string, patch: Record<string, unknown>): Promise<string> {
	const raw = db.local as unknown as PouchDB.Database;
	const current = await raw.get(FILE_PREFIX + path);
	// Sorts below any real rev, so the readable revision stays the head (the losing
	// leaf is the unreadable one, as in a vault an updated device has written to).
	const rev = "1-00000000000000000000000000000000";
	await raw.bulkDocs([{ ...current, _rev: rev, ...patch }], { new_edits: false });
	return rev;
}

beforeEach(() => {
	files = new Map();
	settings = { ...DEFAULT_SETTINGS, e2eeEnabled: false, liveSync: true, deviceId: "d" };
	db = new SyncDatabase(settings, `mem-unreadable-${counter++}`, { adapter: "memory" });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	engine = new SyncEngine(makeApp() as any, db, settings, () => undefined);
});
afterEach(async () => { engine.stop(); await db.destroyLocal().catch(() => undefined); });

describe("conflict resolution with an unreadable revision", () => {
	it("resolves the other conflicts and keeps the unreadable one", async () => {
		setFile("a.md", "alpha", 1000);
		setFile("b.md", "bravo", 1000);
		await pv(engine).handleLocalUpsert(tfile("a.md"));
		await pv(engine).handleLocalUpsert(tfile("b.md"));

		// a.md sorts first, so it is met before b.md. Its competing revision carries
		// metadata this device cannot decrypt (there is no passphrase here at all).
		const unreadable = await addLeaf("a.md", { meta: "v2:AA==:AA==:AA==", deviceId: "newer" });
		// b.md has an ordinary, readable conflict.
		await addLeaf("b.md", { deviceId: "other", mtime: 2000 });

		const before = await db.getConflicted();
		expect(before.map((d) => d.path).sort()).toEqual(["a.md", "b.md"]);

		await engine.resolveConflictsStandalone();

		const after = await db.getConflicted();
		expect(after.map((d) => d.path)).toEqual(["a.md"]);
		// The unreadable revision is another device's edit: it must still be there.
		expect(after[0]._conflicts).toContain(unreadable);
	});
});
