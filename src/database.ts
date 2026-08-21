import { requestUrl, RequestUrlParam } from "obsidian";
import PouchDB from "pouchdb-browser";
import {
	CHUNK_ATTACHMENT,
	CouchDBSyncSettings,
	FileDoc,
	FILE_PREFIX,
	VersionDoc,
} from "./types";
import {
	Wire,
	dehydrateFile,
	dehydrateVersion,
	historyRangeBase,
	hydrateFile,
	hydrateVersion,
	toStoredId,
} from "./envelope";
import { base64ToUint8, toError, uint8ToBase64 } from "./util";

const RANGE_END = "￿";

/** PouchDB's own marker: documents under this prefix are never replicated. */
const LOCAL_DOC_PREFIX = "_local/";

function assertLocalId(id: string, method: string): void {
	if (!id.startsWith(LOCAL_DOC_PREFIX)) {
		throw new Error(
			`${method}: "${id}" is not a ${LOCAL_DOC_PREFIX} id and would replicate — use the shared variant`
		);
	}
}

/** A chunk's decrypted-or-raw bytes plus whether they are encrypted. */
export interface ChunkBytes {
	enc: boolean;
	bytes: Uint8Array;
}

/**
 * Result of scanning the REMOTE CouchDB directly (not the local replica). This is
 * how the panel learns the true server state independently of whether replication
 * is currently working — so a broken login shows up as `reachable:false` instead of
 * a stale "all in sync" read from a frozen local cache.
 */
export interface RemoteScan {
	reachable: boolean;
	/** why the remote could not be read: bad credentials, missing DB, or transport. */
	error?: "auth" | "notfound" | "network";
	message?: string;
	/** decrypted, non-deleted file paths that exist on the server */
	paths: string[];
	/** server paths that carry unresolved conflict revisions */
	conflicts: string[];
	count: number;
	/** server docs that could not be decrypted with the current passphrase */
	decryptFailed: number;
}

/** Normalize whatever PouchDB.getAttachment returns (Blob / Buffer / base64) to bytes. */
async function attachmentToBytes(x: unknown): Promise<Uint8Array> {
	if (x instanceof Uint8Array) return x; // node Buffer is a Uint8Array subclass
	if (x instanceof ArrayBuffer) return new Uint8Array(x);
	if (x && typeof (x as Blob).arrayBuffer === "function") {
		return new Uint8Array(await (x as Blob).arrayBuffer());
	}
	if (typeof x === "string") return base64ToUint8(x); // base64 fallback
	throw new Error("unexpected attachment payload type");
}

/**
 * A fetch() implementation backed by Obsidian's requestUrl(). This bypasses the
 * browser/WebView CORS layer entirely, which removes the single biggest source of
 * "works in the browser but not in the app" failures (especially on mobile).
 */
function obsidianFetch(): typeof fetch {
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		// Each variant carries its URL in a different place. `toString()` on a Request
		// yields "[object Object]", which would have been sent as the request URL had
		// PouchDB ever passed one; read `.url`/`.href` instead of stringifying.
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

		const headers: Record<string, string> = {};
		if (init?.headers) {
			if (init.headers instanceof Headers) {
				init.headers.forEach((v, k) => (headers[k] = v));
			} else if (Array.isArray(init.headers)) {
				for (const [k, v] of init.headers) headers[k] = v;
			} else {
				Object.assign(headers, init.headers);
			}
		}

		const param: RequestUrlParam = {
			url,
			method: init?.method ?? "GET",
			headers,
			throw: false, // let PouchDB interpret 404/409/etc. itself
		};
		if (init?.body != null) {
			param.body = init.body as string | ArrayBuffer;
		}

		const res = await requestUrl(param);
		const body =
			res.arrayBuffer && res.arrayBuffer.byteLength > 0 ? res.arrayBuffer : res.text;
		return new Response(body, {
			status: res.status,
			headers: res.headers,
		});
	};
}

export class SyncDatabase {
	local: PouchDB.Database<FileDoc>;
	remote: PouchDB.Database<FileDoc> | null = null;
	private settings: CouchDBSyncSettings;
	/** decrypt outcome of the most recent getAll() scan (see getDecryptStats) */
	private lastScanSeen = 0;
	private lastScanFailed = 0;
	/**
	 * Cache of hydrated (decrypted) file docs, keyed by id → {rev, doc}. Decrypting a
	 * doc's `meta` costs a full PBKDF2 key derivation (~30 ms in the browser, since
	 * every doc has a unique salt), and the index report re-scans ALL file docs on a
	 * timer. Without this cache a large vault re-derives hundreds of keys every few
	 * seconds and the index view never finishes ("Loading…"). A doc is re-decrypted
	 * only when its `_rev` changes; the cheap mutable fields (`_conflicts`) are
	 * refreshed from the live scan each time.
	 */
	private hydratedCache = new Map<string, { rev: string; doc: FileDoc }>();
	/** Same cache, but for docs decrypted from the REMOTE scan (see scanRemote). */
	private hydratedRemoteCache = new Map<string, { rev: string; doc: FileDoc }>();
	/** Name + options are kept so the local handle can be re-opened after the OS closes it. */
	private readonly localName: string;
	private readonly localOptions?: PouchDB.Configuration.LocalDatabaseConfiguration;

	constructor(
		settings: CouchDBSyncSettings,
		localName: string,
		localOptions?: PouchDB.Configuration.LocalDatabaseConfiguration
	) {
		this.settings = settings;
		this.localName = localName;
		this.localOptions = localOptions;
		// localOptions lets tests swap in the in-memory adapter; production passes none.
		this.local = this.openLocal();
	}

	private openLocal(): PouchDB.Database<FileDoc> {
		return new PouchDB<FileDoc>(this.localName, { auto_compaction: true, ...this.localOptions });
	}

	/**
	 * Re-open the local replica with a fresh IndexedDB connection (same name → same
	 * on-disk data). Mobile OSes close IndexedDB connections while an app is
	 * suspended; our single long-lived handle is then stale and every transaction
	 * throws "The database connection is closing." Replacing the handle reconnects
	 * it. The old handle is NOT close()d — it is already closing/closed and close()
	 * on it can itself throw. The hydrated-doc cache is kept: it is keyed by _id+_rev
	 * and the reopened replica holds the identical revs, so cached decrypts stay
	 * valid (and a large vault avoids re-deriving every PBKDF2 key after a resume).
	 */
	reopenLocal(): void {
		this.local = this.openLocal();
	}

	/**
	 * Ensure the local handle is usable, re-opening it if the connection was closed
	 * (mobile background/resume). Returns whether a re-open happened, so callers can
	 * rebuild anything bound to the old handle (e.g. the engine's live replication).
	 * A cheap `info()` probe is the reliable liveness check — it runs an IDB
	 * transaction, which is exactly what throws on a closing connection.
	 */
	async ensureOpen(): Promise<boolean> {
		try {
			await this.local.info();
			return false;
		} catch (e) {
			// A healthy handle's info() always succeeds, so ANY failure here means the
			// connection is unusable — reopen unconditionally rather than trying to
			// classify the error. This is what makes manual recovery (Force sync /
			// toggle on) work for every post-suspend IndexedDB failure variant, not
			// just the "connection is closing" one (iOS also throws UnknownError, and
			// PouchDB surfaces a bare "unknown"). Reopening the same name is cheap and
			// idempotent; it never touches data or encryption.
			console.debug("[couchdb-sync] local DB probe failed — reopening handle", e);
			this.reopenLocal();
			return true;
		}
	}

	/**
	 * Run a LOCAL-DB operation, transparently recovering from a dead IndexedDB
	 * connection (mobile background/resume): on failure, re-open the handle and retry
	 * ONCE on the fresh connection. This is what keeps idle index reads working right
	 * after a resume, before the full recovery restart has run.
	 *
	 * The retry fires for any non-benign failure, not only the "connection is closing"
	 * message: after a suspend, iOS surfaces the dead connection under several labels
	 * (`InvalidStateError`, `UnknownError`) and PouchDB even maps some to a bare
	 * `{ status: 500, message: "unknown" }` — the "Could not read index: unknown" seen
	 * in the field. A local PouchDB op has no other reason to 500, so classifying by
	 * message is fragile; instead only the benign, expected outcomes (404 missing / 409
	 * conflict / 412 precondition) are passed straight through, and everything else is
	 * treated as a dead handle worth one reopen-and-retry.
	 */
	private async withLocal<T>(fn: (db: PouchDB.Database<FileDoc>) => Promise<T>): Promise<T> {
		try {
			return await fn(this.local);
		} catch (e) {
			const status = (e as { status?: number } | null)?.status;
			if (status === 404 || status === 409 || status === 412) throw e; // benign — caller handles
			this.reopenLocal();
			return await fn(this.local);
		}
	}

	private remoteUrl(): string {
		const base = this.settings.serverUrl.replace(/\/+$/, "");
		return `${base}/${encodeURIComponent(this.settings.dbName)}`;
	}

	connectRemote(): PouchDB.Database<FileDoc> {
		// Close any prior handle before replacing it — idle history/conflict reads
		// call this repeatedly, and orphaning the old PouchDB leaks its fetch state.
		if (this.remote) {
			void this.remote.close().catch(() => undefined);
		}
		this.remote = new PouchDB<FileDoc>(this.remoteUrl(), {
			auth: { username: this.settings.username, password: this.settings.password },
			fetch: obsidianFetch(),
			skip_setup: true,
		});
		return this.remote;
	}

	/**
	 * Drop the cached remote handle so the next use builds a fresh one.
	 *
	 * The handle bakes `auth` in at construction (see connectRemote), so it keeps
	 * presenting whatever credentials were current when it was made — for its whole
	 * lifetime. Without this, editing the password, or unlocking credentials that were
	 * locked when the handle was built, left every automatic path (the idle server
	 * scan reuses `this.remote`) authenticating with the OLD or EMPTY password on a
	 * timer. A server that throttles repeated failed logins then locks the account out,
	 * and the plugin can never recover on its own because nothing rebuilds the handle.
	 */
	closeRemote(): void {
		if (!this.remote) return;
		void this.remote.close().catch(() => undefined);
		this.remote = null;
		this.hydratedRemoteCache.clear();
	}

	/** Are there credentials to authenticate with at all? */
	hasCredentials(): boolean {
		return !!this.settings.username && !!this.settings.password;
	}

	/** Verify credentials + reachability. Returns a human-readable result. */
	async testConnection(): Promise<{ ok: boolean; message: string }> {
		try {
			const r = this.connectRemote();
			const info = await r.info();
			return {
				ok: true,
				message: `Connected to "${info.db_name}" (${info.doc_count} docs).`,
			};
		} catch (e: unknown) {
			const err = e as { status?: number; message?: string; name?: string };
			if (err.status === 401) return { ok: false, message: "Authentication failed (401). Check user/password." };
			if (err.status === 404) return { ok: false, message: "Database not found (404). Check the database name." };
			return { ok: false, message: `Connection failed: ${err.message ?? err.name ?? "unknown error"}` };
		}
	}

	async getAll(): Promise<FileDoc[]> {
		// Range query over file docs ONLY ("f:".."f:￿") so chunk docs are never
		// loaded into memory — that is what caused the out-of-memory crashes. We pull
		// `conflicts:true` in the SAME scan so the index report gets conflict info for
		// free (no second pass). The HMAC-based ids still sort under "f:", so the
		// range is unchanged. Each doc is hydrated (decrypted) back to engine form.
		const res = await this.withLocal((db) =>
			db.allDocs({
				include_docs: true,
				conflicts: true,
				startkey: FILE_PREFIX,
				endkey: FILE_PREFIX + RANGE_END,
			})
		);
		const wires: Wire[] = [];
		for (const row of res.rows) {
			const d = row.doc as unknown as Wire | undefined;
			if (d && d.type === "file") wires.push(d);
		}
		const seen = wires.length;
		let failed = 0;
		/**
		 * First decrypt failure of this scan. Reported ONCE at the end instead of once
		 * per document: a locked or passphrase-less vault fails on every doc, which
		 * turned a single condition into hundreds of identical stack traces in the
		 * console — noise that buries whatever actually went wrong.
		 */
		let firstFailure: Error | undefined;
		// Rebuilt each scan so docs that disappeared drop out of the cache (bounded).
		const nextCache = new Map<string, { rev: string; doc: FileDoc }>();
		const out: (FileDoc | null)[] = new Array<FileDoc | null>(wires.length).fill(null);

		// Split into cache hits (free) and misses (each miss is a PBKDF2 derivation).
		const misses: { i: number; d: Wire }[] = [];
		for (let i = 0; i < wires.length; i++) {
			const d = wires[i];
			const rev = d._rev ?? "";
			const cached = this.hydratedCache.get(d._id);
			if (cached && cached.rev === rev) {
				// Reuse the expensive decrypt; only refresh the cheap, mutable
				// structural field that can change without a new winning _rev.
				const doc: FileDoc = { ...cached.doc };
				if (d._conflicts) doc._conflicts = d._conflicts;
				else delete doc._conflicts;
				out[i] = doc;
				nextCache.set(d._id, cached);
			} else {
				misses.push({ i, d });
			}
		}

		// Decrypt the misses with bounded concurrency: crypto.subtle runs off the
		// main thread, so overlapping derivations cut the first-scan wall-clock on a
		// large vault (where it would otherwise be N * ~30 ms serially).
		const CONCURRENCY = 8;
		for (let start = 0; start < misses.length; start += CONCURRENCY) {
			const batch = misses.slice(start, start + CONCURRENCY);
			await Promise.all(
				batch.map(async ({ i, d }) => {
					try {
						const doc = await hydrateFile(d, this.settings);
						out[i] = doc;
						nextCache.set(d._id, { rev: d._rev ?? "", doc });
					} catch (e) {
						failed++;
						firstFailure ??= toError(e);
					}
				})
			);
		}

		if (failed > 0) {
			console.warn(
				`[couchdb-sync] ${failed} of ${seen} file doc(s) could not be decrypted: ${firstFailure?.message ?? "unknown error"}`
			);
		}
		this.hydratedCache = nextCache;
		// Remember whether a scan hit encrypted docs it could not decrypt at all —
		// the index report uses this to detect a wrong passphrase (see getDecryptStats).
		this.lastScanSeen = seen;
		this.lastScanFailed = failed;
		return out.filter((d): d is FileDoc => d !== null);
	}

	/**
	 * Stats from the most recent {@link getAll} scan. `failed === seen && seen > 0`
	 * means every file doc failed to decrypt — the passphrase is wrong.
	 */
	getDecryptStats(): { seen: number; failed: number } {
		return { seen: this.lastScanSeen, failed: this.lastScanFailed };
	}

	/**
	 * Scan the REMOTE database directly for its file docs — the server's own truth,
	 * NOT the local replica. Only file docs are read (range over the "f:" prefix, which
	 * survives the HMAC id even when encryption is on), so chunk bytes never load. Each
	 * doc is hydrated (decrypted) to recover its path; a per-rev cache makes repeated
	 * scans cheap. A failure to reach the server (bad credentials, missing DB, transport)
	 * is returned as `reachable:false` with a reason rather than thrown, so the caller can
	 * render an honest "server unreachable (401)" instead of a false "in sync".
	 */
	async scanRemote(): Promise<RemoteScan> {
		// Never send a login we know is incomplete. This runs on a timer, so an empty
		// password (credentials still locked, or not entered yet) would otherwise become
		// a steady drip of failed authentications — the fastest way to get throttled or
		// locked out by the server.
		if (!this.hasCredentials()) {
			return {
				reachable: false,
				error: "auth",
				message: "no credentials available",
				paths: [],
				conflicts: [],
				count: 0,
				decryptFailed: 0,
			};
		}
		const r = this.remote ?? this.connectRemote();
		let res: PouchDB.Core.AllDocsResponse<FileDoc>;
		try {
			res = await r.allDocs({
				include_docs: true,
				conflicts: true,
				startkey: FILE_PREFIX,
				endkey: FILE_PREFIX + RANGE_END,
			});
		} catch (e: unknown) {
			const err = e as { status?: number; message?: string; name?: string };
			const error =
				err.status === 401 ? "auth" : err.status === 404 ? "notfound" : "network";
			return {
				reachable: false,
				error,
				message: err.message ?? err.name,
				paths: [],
				conflicts: [],
				count: 0,
				decryptFailed: 0,
			};
		}

		const wires: Wire[] = [];
		for (const row of res.rows) {
			const d = row.doc as unknown as Wire | undefined;
			if (d && d.type === "file") wires.push(d);
		}
		const out = new Array<FileDoc | null>(wires.length).fill(null);
		const next = new Map<string, { rev: string; doc: FileDoc }>();
		const misses: { i: number; d: Wire }[] = [];
		for (let i = 0; i < wires.length; i++) {
			const d = wires[i];
			const rev = d._rev ?? "";
			const cached = this.hydratedRemoteCache.get(d._id);
			if (cached && cached.rev === rev) {
				const doc: FileDoc = { ...cached.doc };
				if (d._conflicts) doc._conflicts = d._conflicts;
				else delete doc._conflicts;
				out[i] = doc;
				next.set(d._id, cached);
			} else {
				misses.push({ i, d });
			}
		}
		let failed = 0;
		const CONCURRENCY = 8;
		for (let start = 0; start < misses.length; start += CONCURRENCY) {
			const batch = misses.slice(start, start + CONCURRENCY);
			await Promise.all(
				batch.map(async ({ i, d }) => {
					try {
						const doc = await hydrateFile(d, this.settings);
						out[i] = doc;
						next.set(d._id, { rev: d._rev ?? "", doc });
					} catch (e) {
						failed++;
						console.error("[couchdb-sync] cannot decrypt remote file doc", d._id, e);
					}
				})
			);
		}
		this.hydratedRemoteCache = next;

		const paths: string[] = [];
		const conflicts: string[] = [];
		for (const doc of out) {
			if (!doc || doc.deleted) continue;
			paths.push(doc.path);
			if (Array.isArray(doc._conflicts) && doc._conflicts.length > 0) conflicts.push(doc.path);
		}
		return { reachable: true, paths, conflicts, count: paths.length, decryptFailed: failed };
	}

	async get(id: string): Promise<FileDoc | null> {
		const sid = await toStoredId(id, this.settings);
		try {
			const raw = await this.withLocal((db) => db.get(sid, { conflicts: true }));
			return await hydrateFile(raw as unknown as Wire, this.settings);
		} catch (e) {
			const err = e as { status?: number };
			if (err.status === 404) return null;
			throw e;
		}
	}

	async put(doc: FileDoc): Promise<void> {
		const wire = await dehydrateFile(doc, this.settings);
		await this.withLocal(async (db) => {
			try {
				const existing = await db.get(wire._id);
				wire._rev = (existing as { _rev?: string })._rev;
			} catch (e) {
				if ((e as { status?: number }).status !== 404) throw e;
			}
			await db.put(wire as unknown as FileDoc);
		});
	}

	/** File documents that currently have unresolved conflict revisions. */
	async getConflicted(): Promise<FileDoc[]> {
		// File docs only (chunks are immutable and never conflict); range-bounded so
		// we never pull chunk data into memory.
		const res = await this.withLocal((db) =>
			db.allDocs({
				include_docs: true,
				conflicts: true,
				startkey: FILE_PREFIX,
				endkey: FILE_PREFIX + RANGE_END,
			})
		);
		const out: FileDoc[] = [];
		for (const row of res.rows) {
			const d = row.doc as unknown as Wire | undefined;
			if (d && d.type === "file" && Array.isArray(d._conflicts) && d._conflicts.length > 0) {
				try {
					out.push(await hydrateFile(d, this.settings));
				} catch (e) {
					console.error("[couchdb-sync] cannot decrypt conflicted doc", d._id, e);
				}
			}
		}
		return out;
	}

	async getRev(id: string, rev: string): Promise<FileDoc> {
		const sid = await toStoredId(id, this.settings);
		const raw = await this.withLocal((db) => db.get(sid, { rev }));
		return hydrateFile(raw as unknown as Wire, this.settings);
	}

	// --- explicit per-file version history ---------------------------------

	/** All history entries for a path, oldest → newest (chronological). */
	async listVersions(path: string): Promise<VersionDoc[]> {
		const base = await historyRangeBase(path, this.settings);
		const res = await this.withLocal((db) =>
			db.allDocs({
				include_docs: true,
				startkey: base,
				endkey: base + RANGE_END,
			})
		);
		const out: VersionDoc[] = [];
		for (const row of res.rows) {
			const d = row.doc as unknown as Wire | undefined;
			if (d && d.type === "version") {
				try {
					out.push(await hydrateVersion(d, this.settings));
				} catch (e) {
					console.error("[couchdb-sync] cannot decrypt version doc", d._id, e);
				}
			}
		}
		return out;
	}

	/** Append a version entry (idempotent: ignores a same-id duplicate). */
	async putVersionIfAbsent(doc: VersionDoc): Promise<void> {
		const wire = await dehydrateVersion(doc, this.settings);
		await this.withLocal(async (local) => {
			const db = local as unknown as PouchDB.Database;
			try {
				await db.get(wire._id);
				return; // already recorded
			} catch (e) {
				if ((e as { status?: number }).status !== 404) throw e;
			}
			try {
				await db.put(wire);
			} catch (e) {
				if ((e as { status?: number }).status !== 409) throw e; // raced
			}
		});
	}

	async removeVersion(id: string, rev: string): Promise<void> {
		const sid = await toStoredId(id, this.settings);
		await this.withLocal((db) => db.remove(sid, rev));
	}

	async removeRev(id: string, rev: string): Promise<void> {
		const sid = await toStoredId(id, this.settings);
		await this.withLocal((db) => db.remove(sid, rev));
	}

	// --- chunk storage -----------------------------------------------------

	/**
	 * Store a chunk only if it does not already exist (chunks are immutable). The
	 * bytes are written as a binary attachment, so CouchDB stores them binary and the
	 * document body stays tiny.
	 */
	async putChunkIfAbsent(id: string, enc: boolean, bytes: Uint8Array): Promise<void> {
		await this.withLocal(async (local) => {
			const db = local as unknown as PouchDB.Database;
			try {
				await db.get(id);
				return; // already present
			} catch (e) {
				if ((e as { status?: number }).status !== 404) throw e;
			}
			try {
				await db.put({
					_id: id,
					type: "chunk",
					enc,
					_attachments: {
						[CHUNK_ATTACHMENT]: {
							content_type: "application/octet-stream",
							// PouchDB accepts a base64 STRING for an inline attachment; CouchDB
							// stores it binary. (Transient base64 only — never the resting form.)
							data: uint8ToBase64(bytes),
						},
					},
				});
			} catch (e) {
				if ((e as { status?: number }).status !== 409) throw e; // created concurrently
			}
		});
	}

	private async readChunk(
		db: PouchDB.Database<FileDoc>,
		id: string
	): Promise<ChunkBytes | null> {
		let enc = false;
		try {
			const doc = (await db.get(id)) as unknown as { enc?: boolean };
			enc = !!doc.enc;
		} catch (e) {
			if ((e as { status?: number }).status === 404) return null;
			throw e;
		}
		const att = await (db as unknown as PouchDB.Database).getAttachment(id, CHUNK_ATTACHMENT);
		return { enc, bytes: await attachmentToBytes(att) };
	}

	/** Fetch a single chunk's bytes from the local DB (or null). Keeps memory bounded. */
	async getChunkLocal(id: string): Promise<ChunkBytes | null> {
		return this.withLocal((db) => this.readChunk(db, id));
	}

	/** Fetch a single chunk's bytes directly from the remote DB (or null). */
	async getChunkRemote(id: string): Promise<ChunkBytes | null> {
		if (!this.remote) return null;
		return this.readChunk(this.remote, id);
	}

	/** Permanently delete the local replica (used by "Reset local database"). */
	async destroyLocal(): Promise<void> {
		await this.local.destroy();
	}

	/**
	 * Empty the remote, by whichever means this account is allowed.
	 *
	 * Dropping the database is the clean way — it reclaims the space and leaves
	 * nothing behind — but in CouchDB 3 that is a SERVER ADMIN operation, and a
	 * sync account is normally just a member of one database. So a refusal is an
	 * expected outcome, not an error: fall back to deleting every document, which
	 * needs no more rights than ordinary syncing does.
	 *
	 * Returns which route was taken, because the outcomes differ in a way the user
	 * has to know about (see deleteAllRemoteDocs).
	 */
	async resetRemote(
		onProgress?: (deleted: number) => void
	): Promise<{ strategy: "dropped" | "emptied"; deleted: number }> {
		try {
			await this.destroyRemote();
			return { strategy: "dropped", deleted: 0 };
		} catch (e) {
			const err = e as { status?: number; message?: string };
			// 401/403 = not allowed to drop databases. Anything else (network, 404,
			// a failed recreate) is a real failure and must not be papered over by
			// silently deleting documents instead.
			if (err.status !== 401 && err.status !== 403) throw e;
		}
		const deleted = await this.deleteAllRemoteDocs(onProgress);
		return { strategy: "emptied", deleted };
	}

	/**
	 * Mark every document in the remote database deleted, in batches.
	 *
	 * Needs only write access — the same right syncing already uses. What it leaves
	 * behind is a deletion stub ("tombstone") per document: CouchDB keeps those on
	 * purpose, because they are how the deletion reaches every other replica. They
	 * carry no content and are excluded from every count the plugin shows, but the
	 * space the old documents occupied comes back only on compaction, which is again
	 * an admin operation. Dropping the database is therefore still the better route
	 * where it is permitted.
	 *
	 * Paging walks the key space forward with `startkey` and never revisits it. Design
	 * documents are left alone: they are not ours to delete, and they sort in the
	 * middle of our own id ranges.
	 */
	async deleteAllRemoteDocs(onProgress?: (deleted: number) => void): Promise<number> {
		const r = this.remote ?? this.connectRemote();
		const BATCH = 200;
		let startkey = "";
		let deleted = 0;
		for (;;) {
			const page = await r.allDocs({ limit: BATCH, startkey });
			if (page.rows.length === 0) break;
			const last = page.rows[page.rows.length - 1].id;

			const batch = page.rows
				.filter((row) => !row.id.startsWith("_design/") && row.value.rev)
				.map((row) => ({ _id: row.id, _rev: row.value.rev, _deleted: true }));

			if (batch.length > 0) {
				const results = await r.bulkDocs(batch as unknown as FileDoc[]);
				const failures = results.filter((x) => "error" in x && x.error);
				deleted += results.length - failures.length;
				onProgress?.(deleted);
				if (failures.length === results.length) {
					const first = failures[0] as { reason?: string; name?: string };
					throw new Error(
						`Could not delete documents on the server (${first.reason ?? first.name ?? "unknown reason"}).`
					);
				}
			}

			if (page.rows.length < BATCH) break; // that was the last page
			// Advance strictly past the last id we handled. NOT `skip`: the documents in
			// this page are gone from the index the moment they are deleted, so a skip
			// counted against the shrinking result set would step over live documents
			// and leave them behind. A key cursor cannot: it only ever moves forward,
			// which also guarantees this loop ends.
			// The separator is \u0000 rather than any printable character: history ids
			// embed a NEWLINE (HISTORY_SEP), which sorts below a space, so a cursor of
			// `last + " "` would jump over a path's own history documents. Nothing
			// sorts below \u0000, so nothing can be skipped.
			startkey = last + "\u0000";
		}
		return deleted;
	}

	/**
	 * Delete the REMOTE database and recreate it empty.
	 *
	 * Everything the server holds goes: file documents, every content chunk, and the
	 * whole version history — they all live in the one database. There is no partial
	 * form of this; CouchDB has no "delete all documents" that actually reclaims the
	 * space, and deleting documents one by one would leave a tombstone per document,
	 * which is precisely the sort of residue this exists to clear.
	 *
	 * The database is recreated immediately (without `skip_setup`, so PouchDB issues
	 * the PUT) — leaving it absent would make every later request a 404 that reads
	 * like a configuration error.
	 */
	async destroyRemote(): Promise<void> {
		const r = this.remote ?? this.connectRemote();
		await r.destroy();
		this.remote = null;
		this.hydratedRemoteCache.clear();
		const fresh = new PouchDB<FileDoc>(this.remoteUrl(), {
			auth: { username: this.settings.username, password: this.settings.password },
			fetch: obsidianFetch(),
		});
		try {
			await fresh.info(); // forces the create and proves it worked
		} catch (e) {
			// Deleting a database and creating one are separate CouchDB permissions, so
			// an account may be allowed the first and not the second. Say exactly that:
			// the old data is already gone, and the only way forward is to create the
			// database by hand — a bare "info failed" would send the user hunting for a
			// connection problem that does not exist.
			const err = e as { message?: string };
			throw new Error(
				`The database was deleted but could not be recreated (${err.message ?? "unknown error"}). ` +
					`Create "${this.settings.dbName}" on the server manually, then run the sync again.`
			);
		}
		this.remote = fresh;
	}

	// --- small documents: per-device state and shared metadata ---------------

	/**
	 * Read a per-device document. Asserts the prefix for the same reason the write
	 * side splits in two: whether a document replicates is decided by its id alone,
	 * and a method with "Local" in its name must not be the place that quietly
	 * decides otherwise.
	 */
	async getLocalDoc<T>(id: string): Promise<T | null> {
		assertLocalId(id, "getLocalDoc");
		return this.getDocById<T>(id);
	}

	private async getDocById<T>(id: string): Promise<T | null> {
		try {
			return (await this.withLocal((db) => db.get(id))) as unknown as T;
		} catch (e) {
			if ((e as { status?: number }).status === 404) return null;
			throw e;
		}
	}

	/** Upsert by id, reading the current _rev first so the write lands on top of it. */
	private async upsert(id: string, value: Record<string, unknown>): Promise<void> {
		const existing = (await this.getDocById<{ _rev?: string }>(id)) ?? {};
		await this.withLocal((local) =>
			(local as unknown as PouchDB.Database).put({
				...value,
				_id: id,
				_rev: existing._rev,
			})
		);
	}

	/**
	 * Write a document that stays on THIS device. PouchDB decides that by the id, not
	 * by the method: only ids under "_local/" are exempt from replication.
	 *
	 * The prefix is therefore asserted rather than assumed. Before this split there
	 * was one `putLocalDoc` used for both kinds, and the master-info document — whose
	 * id has no prefix — replicated to the server while the call read as local. The
	 * concrete leak that caused (a cleartext device id on the server) is long fixed,
	 * but the name still invited the next caller to make the same assumption.
	 */
	async putLocalDoc(id: string, value: Record<string, unknown>): Promise<void> {
		assertLocalId(id, "putLocalDoc");
		await this.upsert(id, value);
	}

	/**
	 * Write a document that DOES replicate to the server and every other device.
	 * Deliberately not "local": the master-info document is shared state, and every
	 * caller should have to say so.
	 */
	async putSharedDoc(id: string, value: Record<string, unknown>): Promise<void> {
		if (id.startsWith(LOCAL_DOC_PREFIX)) {
			throw new Error(`putSharedDoc: "${id}" is a ${LOCAL_DOC_PREFIX} id and cannot replicate`);
		}
		await this.upsert(id, value);
	}

	async close(): Promise<void> {
		await this.local.close();
		if (this.remote) await this.remote.close();
	}
}
