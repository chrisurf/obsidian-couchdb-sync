// @vitest-environment happy-dom
// pouchdb-browser touches browser globals (self/window) at import time, so this
// suite runs under a lightweight DOM. The in-memory adapter needs no IndexedDB.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import PouchDB from "pouchdb-browser";
import memoryAdapter from "pouchdb-adapter-memory";
import { SyncDatabase } from "../src/database";
import { DEFAULT_SETTINGS, FileDoc } from "../src/types";

PouchDB.plugin(memoryAdapter);

// Each test gets its own in-memory database so nothing leaks between cases.
let counter = 0;
let db: SyncDatabase;

function fileDoc(path: string, over: Partial<FileDoc> = {}): FileDoc {
	return {
		_id: "f:" + path,
		type: "file",
		path,
		mtime: 1000,
		ctime: 1000,
		size: 3,
		deleted: false,
		deviceId: "devA",
		binary: false,
		enc: false,
		children: ["h:aaa"],
		hash: "abc",
		...over,
	};
}

beforeEach(() => {
	db = new SyncDatabase({ ...DEFAULT_SETTINGS }, `mem-test-${counter++}`, { adapter: "memory" });
});

afterEach(async () => {
	await db.destroyLocal().catch(() => undefined);
});

describe("SyncDatabase.getAll — range query never loads chunks/history", () => {
	it("returns only file docs, excluding chunk and version docs", async () => {
		await db.put(fileDoc("a.md"));
		await db.put(fileDoc("b.md"));
		// a chunk doc (h:) — must NEVER be returned by getAll (the old OOM source)
		await db.putChunkIfAbsent("h:aaa", false, new Uint8Array([1, 2, 3]));
		// a history doc (H:) — sorts before f:, must also be excluded
		await (db.local as unknown as PouchDB.Database).put({
			_id: "H:a.md\n000000000001000\nabc",
			type: "version",
			path: "a.md",
		});

		const all = await db.getAll();
		const ids = all.map((d) => d._id).sort();
		expect(ids).toEqual(["f:a.md", "f:b.md"]);
		expect(all.every((d) => d.type === "file")).toBe(true);
	});

	it("includes logical tombstones (deleted:true) but not _deleted docs", async () => {
		await db.put(fileDoc("live.md"));
		await db.put(fileDoc("gone.md", { deleted: true, children: [], hash: "", size: 0 }));
		const all = await db.getAll();
		expect(all.map((d) => d._id).sort()).toEqual(["f:gone.md", "f:live.md"]);
	});
});

describe("SyncDatabase.get", () => {
	it("returns null for a missing id (404), not a throw", async () => {
		expect(await db.get("f:nope.md")).toBeNull();
	});

	it("round-trips a put and reattaches the rev on update", async () => {
		await db.put(fileDoc("x.md", { hash: "h1" }));
		await db.put(fileDoc("x.md", { hash: "h2" })); // put() must fetch existing _rev
		const got = await db.get("f:x.md");
		expect(got?.hash).toBe("h2");
	});
});

describe("SyncDatabase.getConflicted", () => {
	it("detects a document with conflicting leaf revisions", async () => {
		await db.put(fileDoc("c.md", { deviceId: "devA", mtime: 100 }));
		const current = await db.get("f:c.md");
		// inject a competing gen-1 leaf via new_edits:false -> a real conflict
		await (db.local as unknown as PouchDB.Database).bulkDocs(
			[
				{
					...current,
					_rev: "1-00000000000000000000000000000000",
					deviceId: "devB",
					mtime: 200,
				},
			],
			{ new_edits: false }
		);
		const conflicted = await db.getConflicted();
		expect(conflicted.map((d) => d._id)).toEqual(["f:c.md"]);
		expect(conflicted[0]._conflicts?.length).toBe(1);
	});

	it("returns nothing when there are no conflicts", async () => {
		await db.put(fileDoc("clean.md"));
		expect(await db.getConflicted()).toEqual([]);
	});
});

describe("SyncDatabase chunk storage (attachments)", () => {
	it("round-trips raw chunk bytes through an attachment", async () => {
		const bytes = new Uint8Array([9, 8, 7, 6, 5, 0, 255, 128]);
		await db.putChunkIfAbsent("h:rt", false, bytes);
		const c = await db.getChunkLocal("h:rt");
		expect(c?.enc).toBe(false);
		expect(Array.from(c!.bytes)).toEqual(Array.from(bytes));
	});

	it("putChunkIfAbsent is idempotent and never throws on a duplicate (first write wins)", async () => {
		await db.putChunkIfAbsent("h:dup", false, new Uint8Array([1]));
		await db.putChunkIfAbsent("h:dup", false, new Uint8Array([2]));
		const c = await db.getChunkLocal("h:dup");
		expect(Array.from(c!.bytes)).toEqual([1]); // immutable — original kept
	});

	it("preserves the enc flag", async () => {
		await db.putChunkIfAbsent("h:enc", true, new Uint8Array([42, 42]));
		const c = await db.getChunkLocal("h:enc");
		expect(c?.enc).toBe(true);
	});

	it("getChunkLocal returns null for a missing chunk", async () => {
		expect(await db.getChunkLocal("h:missing")).toBeNull();
	});
});

describe("SyncDatabase version history", () => {
	it("putVersionIfAbsent is idempotent and listVersions is chronological", async () => {
		const mk = (ts: string, hash: string) => ({
			_id: `H:note.md\n${ts}\n${hash}`,
			type: "version" as const,
			path: "note.md",
			ts: Number(ts),
			mtime: Number(ts),
			size: 1,
			hash,
			deviceId: "devA",
			binary: false,
			enc: false,
			children: [],
			deleted: false,
		});
		await db.putVersionIfAbsent(mk("000000000000002", "hh2"));
		await db.putVersionIfAbsent(mk("000000000000001", "hh1"));
		await db.putVersionIfAbsent(mk("000000000000001", "hh1")); // duplicate — ignored
		const vers = await db.listVersions("note.md");
		expect(vers.map((v) => v.hash)).toEqual(["hh1", "hh2"]); // oldest -> newest by padded ts
	});

	it("listVersions is scoped to the exact path", async () => {
		const base = (path: string) => ({
			_id: `H:${path}\n000000000000001\nx`,
			type: "version" as const,
			path,
			ts: 1,
			mtime: 1,
			size: 1,
			hash: "x",
			deviceId: "d",
			binary: false,
			enc: false,
			children: [],
			deleted: false,
		});
		await db.putVersionIfAbsent(base("one.md"));
		await db.putVersionIfAbsent(base("two.md"));
		expect((await db.listVersions("one.md")).length).toBe(1);
	});
});

describe("SyncDatabase per-device local docs", () => {
	it("putLocalDoc / getLocalDoc round-trip and update", async () => {
		await db.putLocalDoc("_local/state", { records: { "a.md": { mtime: 1, size: 2, hash: "h" } } });
		await db.putLocalDoc("_local/state", { records: { "a.md": { mtime: 9, size: 2, hash: "h9" } } });
		const doc = await db.getLocalDoc<{ records: Record<string, { hash: string }> }>("_local/state");
		expect(doc?.records["a.md"].hash).toBe("h9");
	});

	it("getLocalDoc returns null when absent", async () => {
		expect(await db.getLocalDoc("_local/missing")).toBeNull();
	});

	// R5: whether a document replicates is decided by its id, not by the method that
	// wrote it. The two methods exist so a caller has to state which it means, and
	// these guards are what make the wrong choice fail loudly instead of quietly
	// pushing per-device state to the server (or stranding shared state on one device).
	it("putLocalDoc refuses an id that would replicate", async () => {
		await expect(db.putLocalDoc("couchdb-sync:masterinfo", { a: 1 })).rejects.toThrow(
			/_local\//
		);
	});

	it("putSharedDoc refuses a non-replicating id", async () => {
		await expect(db.putSharedDoc("_local/state", { a: 1 })).rejects.toThrow(/cannot replicate/);
	});

	it("getLocalDoc refuses an id that is not per-device", async () => {
		await expect(db.getLocalDoc("couchdb-sync:masterinfo")).rejects.toThrow(/_local\//);
	});

	it("putSharedDoc round-trips a replicating document", async () => {
		await db.putSharedDoc("couchdb-sync:masterinfo", { type: "masterinfo", masterId: "dev-1" });
		await db.putSharedDoc("couchdb-sync:masterinfo", { type: "masterinfo", masterId: "dev-2" });
		const doc = (await db.local.get("couchdb-sync:masterinfo")) as unknown as {
			masterId: string;
		};
		expect(doc.masterId).toBe("dev-2");
	});
});

// B7: a wrong passphrase must be DETECTABLE, not silently reported as an empty
// database (which would classify every file as "local only" and tempt an
// "Upload all" that mints divergent duplicates under the wrong key).
describe("SyncDatabase wrong-passphrase detection", () => {
	it("getDecryptStats reports failed === seen when the passphrase is wrong", async () => {
		const name = `mem-enc-${counter++}`;
		const writer = new SyncDatabase(
			{ ...DEFAULT_SETTINGS, e2eeEnabled: true, passphrase: "correct horse battery staple" },
			name,
			{ adapter: "memory" }
		);
		await writer.put(fileDoc("secret.md", { enc: true, hash: "h1" }));
		await writer.put(fileDoc("notes/todo.md", { enc: true, hash: "h2" }));

		// A second handle on the SAME store, but with the WRONG passphrase.
		const reader = new SyncDatabase(
			{ ...DEFAULT_SETTINGS, e2eeEnabled: true, passphrase: "totally different" },
			name,
			{ adapter: "memory" }
		);
		const docs = await reader.getAll();
		const stats = reader.getDecryptStats();

		expect(docs).toEqual([]); // nothing decrypts under the wrong key
		expect(stats.seen).toBe(2); // but the encrypted docs ARE there
		expect(stats.failed).toBe(stats.seen); // and every one failed → mismatch

		await writer.destroyLocal().catch(() => undefined);
	});

	it("getDecryptStats reports no failures with the correct passphrase", async () => {
		const name = `mem-enc-${counter++}`;
		const s = { ...DEFAULT_SETTINGS, e2eeEnabled: true, passphrase: "the right key" };
		const dbEnc = new SyncDatabase(s, name, { adapter: "memory" });
		await dbEnc.put(fileDoc("a.md", { enc: true, hash: "h1" }));
		const docs = await dbEnc.getAll();
		const stats = dbEnc.getDecryptStats();
		expect(docs.length).toBe(1);
		expect(stats.failed).toBe(0);
		await dbEnc.destroyLocal().catch(() => undefined);
	});
});

// The hydrated-doc cache must serve CORRECT data: reuse unchanged docs but reflect
// any change (a new _rev re-hydrates; a removed doc drops out). Decrypting a doc's
// meta is a full PBKDF2 derivation, so caching it across the timer-driven index
// scans is what keeps the index view from getting stuck on "Loading…".
describe("SyncDatabase getAll hydrated-doc cache", () => {
	it("reflects a content change on the next scan (cache invalidated by _rev)", async () => {
		const name = `mem-cache-${counter++}`;
		const dbEnc = new SyncDatabase(
			{ ...DEFAULT_SETTINGS, e2eeEnabled: true, passphrase: "cache key" },
			name,
			{ adapter: "memory" }
		);
		await dbEnc.put(fileDoc("a.md", { enc: true, hash: "h1" }));
		await dbEnc.put(fileDoc("b.md", { enc: true, hash: "hb" }));

		const first = await dbEnc.getAll();
		expect(first.find((d) => d.path === "a.md")?.hash).toBe("h1");

		// Change a.md (new _rev) and confirm the scan re-hydrates it, not serving stale.
		const cur = await dbEnc.get("f:a.md");
		await dbEnc.put({ ...cur!, hash: "h2", _rev: cur!._rev });
		const second = await dbEnc.getAll();
		expect(second.find((d) => d.path === "a.md")?.hash).toBe("h2");
		expect(second.find((d) => d.path === "b.md")?.hash).toBe("hb"); // unchanged, reused
		expect(second.length).toBe(2);

		await dbEnc.destroyLocal().catch(() => undefined);
	});

	it("drops a deleted doc from the cache", async () => {
		const name = `mem-cache-${counter++}`;
		const dbEnc = new SyncDatabase(
			{ ...DEFAULT_SETTINGS, e2eeEnabled: true, passphrase: "cache key" },
			name,
			{ adapter: "memory" }
		);
		await dbEnc.put(fileDoc("keep.md", { enc: true, hash: "k" }));
		await dbEnc.put(fileDoc("gone.md", { enc: true, hash: "g", deleted: true }));
		const docs = (await dbEnc.getAll()).filter((d) => !d.deleted);
		expect(docs.map((d) => d.path)).toEqual(["keep.md"]);
		await dbEnc.destroyLocal().catch(() => undefined);
	});
});

describe("SyncDatabase — recovers from a closed IndexedDB connection (mobile resume)", () => {
	it("reopens the local handle and retries when a read hits 'connection is closing'", async () => {
		await db.put(fileDoc("a.md"));

		// Simulate the OS having closed the connection while backgrounded: the first
		// allDocs on the current handle rejects with the exact IDB error, then the
		// handle is replaced (reopenLocal) and the retry runs on a fresh instance.
		const original = db.local.allDocs.bind(db.local);
		let calls = 0;
		// @ts-expect-error — override the instance method for the test
		db.local.allDocs = (...args: unknown[]) => {
			calls++;
			if (calls === 1) {
				return Promise.reject(
					new Error("Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.")
				);
			}
			return original(...(args as Parameters<typeof original>));
		};

		// Must not throw: getAll self-heals by reopening and retrying.
		const docs = await db.getAll();
		expect(calls).toBe(1); // the stubbed (old) handle was hit exactly once, then replaced
		expect(Array.isArray(docs)).toBe(true);
	});

	it("also recovers from the bare PouchDB 'unknown' (status 500) variant", async () => {
		await db.put(fileDoc("a.md"));
		const original = db.local.allDocs.bind(db.local);
		let calls = 0;
		// @ts-expect-error — override the instance method for the test
		db.local.allDocs = (...args: unknown[]) => {
			calls++;
			// PouchDB maps some post-suspend IDB failures to { status: 500, message: "unknown" }.
			if (calls === 1) return Promise.reject({ status: 500, name: "unknown", message: "unknown" });
			return original(...(args as Parameters<typeof original>));
		};
		const docs = await db.getAll();
		expect(calls).toBe(1);
		expect(Array.isArray(docs)).toBe(true);
	});

	it("passes a benign not-found straight through WITHOUT reopening", async () => {
		const before = db.local;
		// A real missing doc surfaces as a 404 from PouchDB; get() maps it to null and
		// withLocal must NOT treat that expected outcome as a dead handle.
		expect(await db.get("does-not-exist.md")).toBe(null);
		expect(db.local).toBe(before); // no reopen for a benign not-found
	});

	it("reopenLocal replaces the handle instance", () => {
		const before = db.local;
		db.reopenLocal();
		expect(db.local).not.toBe(before);
	});

	it("ensureOpen returns false when healthy and reopens on ANY probe failure", async () => {
		// healthy: info() resolves -> no reopen
		expect(await db.ensureOpen()).toBe(false);

		// unusable: info() rejects (any error) -> reopen unconditionally, return true.
		// Uses a generic error on purpose: a healthy handle never fails info().
		const before = db.local;
		// @ts-expect-error — override for the test
		db.local.info = () => Promise.reject(new Error("unknown"));
		expect(await db.ensureOpen()).toBe(true);
		expect(db.local).not.toBe(before); // a fresh handle
	});
});
