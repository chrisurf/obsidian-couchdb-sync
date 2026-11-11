// @vitest-environment happy-dom
// pouchdb-browser touches browser globals at import time, so this suite runs under
// a lightweight DOM. The in-memory adapter needs no IndexedDB.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import PouchDB from "pouchdb-browser";
import memoryAdapter from "pouchdb-adapter-memory";
import { TFile } from "obsidian";
import { SyncEngine } from "../src/engine";
import { SyncDatabase } from "../src/database";
import { DEFAULT_SETTINGS, FILE_PREFIX, type CouchDBSyncSettings, type SyncRecord } from "../src/types";

PouchDB.plugin(memoryAdapter);

/**
 * A tracked file deleted from disk whose document this device cannot read (written by
 * a newer plugin version, or under another passphrase) used to throw out of the
 * reconcile sweep: the panel showed "reconcile: Invalid encrypted payload format" and
 * no other stranded delete was ever synced. Now that one document is left as it is and
 * the rest of the sweep runs.
 */

interface Entry { bytes: Uint8Array; mtime: number; ctime: number; size: number }
type Internals = {
	handleLocalUpsert(f: TFile): Promise<void>;
	reconcileLocalDeletes(): Promise<void>;
	syncState: Map<string, SyncRecord>;
};
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

beforeEach(() => {
	files = new Map();
	settings = { ...DEFAULT_SETTINGS, e2eeEnabled: false, liveSync: true, deviceId: "d" };
	db = new SyncDatabase(settings, `mem-reconcile-unreadable-${counter++}`, { adapter: "memory" });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	engine = new SyncEngine(makeApp() as any, db, settings, () => undefined);
});
afterEach(async () => { engine.stop(); await db.destroyLocal().catch(() => undefined); });

describe("reconcileLocalDeletes with an unreadable document", () => {
	it("syncs the other deletes and leaves the unreadable document untouched", async () => {
		setFile("a.md", "alpha", 1000);
		setFile("b.md", "bravo", 1000);
		await pv(engine).handleLocalUpsert(tfile("a.md"));
		await pv(engine).handleLocalUpsert(tfile("b.md"));
		expect([...pv(engine).syncState.keys()].sort()).toEqual(["a.md", "b.md"]);

		// Another device rewrites a.md in a form this device cannot decrypt (there is no
		// passphrase here at all). a.md sorts first, so the sweep meets it before b.md.
		const raw = db.local as unknown as PouchDB.Database;
		const a = await raw.get(FILE_PREFIX + "a.md");
		await raw.put({ ...a, meta: "v2:AA==:AA==:AA==" });
		const unreadableRev = (await raw.get(FILE_PREFIX + "a.md"))._rev;

		// Both files vanish from disk without a delete event.
		files.delete("a.md");
		files.delete("b.md");

		await expect(pv(engine).reconcileLocalDeletes()).resolves.toBeUndefined();

		expect((await db.get(FILE_PREFIX + "b.md"))?.deleted).toBe(true);
		expect((await raw.get(FILE_PREFIX + "a.md"))._rev).toBe(unreadableRev);
	});
});
