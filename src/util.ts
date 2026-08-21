import type { ConflictStrategy } from "./types";

/** True when two string arrays have the same length and equal elements in order. */
export function stringArraysEqual(a: string[], b: string[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/**
 * Decide which candidate revision wins a conflict, by the configured strategy.
 * "master": the master device's revision wins if present; otherwise fall back to
 * newest. "newest" (and every fallback): the largest mtime wins. Pure so it can be
 * unit-tested without a database. `cands` must be non-empty.
 *
 * The mtime comparison has a DETERMINISTIC tie-break (by content hash, then device
 * id): on equal mtimes every device must pick the same winner, otherwise two
 * devices resolving the same conflict independently choose different sides and the
 * conflict never converges.
 */
export function pickConflictWinner<T extends { deviceId?: string; mtime?: number; hash?: string }>(
	cands: T[],
	strategy: ConflictStrategy,
	masterId: string | null
): T {
	if (strategy === "master" && masterId) {
		const m = cands.find((c) => c.deviceId === masterId);
		if (m) return m;
	}
	return cands.slice().sort((a, b) => {
		const byMtime = (b.mtime ?? 0) - (a.mtime ?? 0);
		if (byMtime !== 0) return byMtime;
		const byHash = (b.hash ?? "").localeCompare(a.hash ?? "");
		if (byHash !== 0) return byHash;
		return (b.deviceId ?? "").localeCompare(a.deviceId ?? "");
	})[0];
}

/** Fast, non-cryptographic 53-bit string hash (cyrb53) for echo detection. */
export function cyrb53(str: string, seed = 0): string {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
	let binary = "";
	const bytes = new Uint8Array(buf);
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode.apply(
			null,
			bytes.subarray(i, i + chunk) as unknown as number[]
		);
	}
	return btoa(binary);
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

export function uint8ToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode.apply(
			null,
			bytes.subarray(i, i + chunk) as unknown as number[]
		);
	}
	return btoa(binary);
}

export function base64ToUint8(b64: string): Uint8Array {
	return new Uint8Array(base64ToArrayBuffer(b64));
}

/** Generate a short, stable, random device id. */
export function generateDeviceId(): string {
	const rnd = crypto.getRandomValues(new Uint8Array(8));
	return Array.from(rnd, (b) => b.toString(16).padStart(2, "0")).join("");
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function textToBytes(s: string): Uint8Array {
	return textEncoder.encode(s);
}

export function bytesToText(b: Uint8Array): string {
	return textDecoder.decode(b);
}

/** SHA-256 of the given bytes as a lowercase hex string. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
	const arr = new Uint8Array(digest);
	let hex = "";
	for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, "0");
	return hex;
}

/** Split a byte array into fixed-size pieces. An empty input yields no pieces. */
export function splitBytes(bytes: Uint8Array, size: number): Uint8Array[] {
	const out: Uint8Array[] = [];
	for (let i = 0; i < bytes.length; i += size) {
		out.push(bytes.subarray(i, i + size));
	}
	return out;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
	let len = 0;
	for (const p of parts) len += p.length;
	const out = new Uint8Array(len);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

/**
 * Known text extensions. Everything else is treated as binary, which is the safe
 * default: an unknown large file (e.g. ".lpf", media, archives) must never be read
 * as a UTF-8 string (that throws "Invalid string length" on big files).
 */
const TEXT_EXTENSIONS = new Set([
	"md", "markdown", "txt", "text", "rtf", "log",
	"json", "jsonc", "ndjson", "csv", "tsv",
	"yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties",
	"xml", "html", "htm", "svg", "css", "scss",
	"js", "mjs", "cjs", "ts", "tsx", "jsx",
	"canvas", "bib", "org", "tex", "rmd",
]);

export function isBinaryPath(path: string): boolean {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return !TEXT_EXTENSIONS.has(ext);
}

/**
 * Content-based text/binary detection — reliable regardless of file extension.
 * Inspects a sample of the raw bytes:
 *  - a NUL byte means binary (this is exactly how git decides), and
 *  - an unusually high share of other control bytes means binary too.
 * Empty files and normal UTF-8/ASCII text return true (text).
 */
export function looksLikeText(sample: Uint8Array): boolean {
	const len = Math.min(sample.length, 8000);
	if (len === 0) return true;
	let control = 0;
	for (let i = 0; i < len; i++) {
		const b = sample[i];
		if (b === 0) return false; // NUL -> definitely binary
		// allow tab(9), LF(10), VT(11), FF(12), CR(13); flag other C0 controls
		if (b < 9 || (b > 13 && b < 32)) control++;
	}
	return control / len < 0.3;
}

/** A hidden path has at least one segment starting with "." (dotfile/dot-folder). */
export function isHidden(path: string): boolean {
	return path.split("/").some((seg) => seg.startsWith("."));
}

export function matchesIgnore(path: string, patterns: string[]): boolean {
	return patterns.some((p) => {
		if (!p) return false;
		// prefix match for folder-ish patterns, otherwise substring
		if (p.endsWith("/")) return path.startsWith(p) || path.includes("/" + p);
		return path === p || path.startsWith(p);
	});
}

/** The subset of settings that decides which paths are in scope for syncing. */
export interface SkipRules {
	syncHidden: boolean;
	/** "Do not sync these" — applies to EVERY path, hidden or not. */
	syncExclude: string[];
	/** "Sync these anyway" — the narrow opt-in that beats both of the above. */
	syncInclude: string[];
}

/**
 * Is this path out of scope for syncing?
 *
 * One rule, in one place, for every file in the vault:
 *
 *   **exclude wins, unless the path is explicitly re-included.**
 *
 * That is the `.gitignore` model with a negation, which is the mental model most
 * users already have. Concretely, in order:
 *
 * 1. `syncInclude` — an explicit opt-in. It overrides everything below it, because a
 *    blacklist cannot express "from this excluded area I want exactly one thing":
 *    `<configDir>/snippets/` is one line here, while saying the same with exclusions
 *    means enumerating every other plugin folder — a list that is never finished,
 *    since each newly installed plugin adds one more to forget.
 * 2. `syncExclude` — the general blacklist. It used to be consulted only for hidden
 *    paths, which made its own defaults a lie: `node_modules/` did nothing for
 *    `Projects/app/node_modules/`, and a vault holding one Node project had no
 *    setting anywhere that could stop it syncing tens of thousands of files.
 * 3. the hidden toggle — anything with a dot segment is skipped unless
 *    `syncHidden` is on.
 *
 * Nothing here deletes: a newly excluded file stops being pushed, stays on every
 * disk, and shows in the tree as *excluded*. Removing the line brings it back.
 */
export function isPathExcluded(path: string, rules: SkipRules): boolean {
	if (matchesIgnore(path, rules.syncInclude)) return false;
	if (matchesIgnore(path, rules.syncExclude)) return true;
	return isHidden(path) ? !rules.syncHidden : false;
}

/**
 * Should the hidden-file scan descend into this directory?
 *
 * The scan used to walk every hidden folder and let the caller filter the result
 * afterwards, which meant a vault with a large `.obsidian` tree (plugin
 * node_modules, caches) cost thousands of serial directory listings per index
 * report — for paths that were discarded milliseconds later. This prunes the walk
 * at the folder level instead.
 *
 * Pruning is only sound when EVERY path under the folder is guaranteed to be
 * skipped, which holds because both ignore forms are prefix-based: if a pattern
 * matches "<dir>/", it matches "<dir>/<anything>" too.
 *
 * - an include pattern pointing AT or INTO the folder always wins, mirroring the
 *   override in {@link isPathExcluded} — otherwise the one way to re-enable a single
 *   path inside an excluded area would be pruned before it is ever considered.
 * - hidden sync ON (blacklist): skip the subtree when the folder itself is excluded.
 * - hidden sync OFF (whitelist): only descend when some include pattern points at
 *   this folder or below it — everything else is skipped anyway.
 */
export function shouldWalkHiddenDir(dir: string, rules: SkipRules): boolean {
	const withSlash = dir.endsWith("/") ? dir : dir + "/";
	if (pointsInto(withSlash, rules.syncInclude)) return true;
	if (rules.syncHidden) {
		return !matchesIgnore(withSlash, rules.syncExclude);
	}
	return false;
}

/** Does any pattern name this folder, sit inside it, or cover it? */
function pointsInto(dirWithSlash: string, patterns: string[]): boolean {
	return patterns.some(
		(p) => !!p && (p.startsWith(dirWithSlash) || matchesIgnore(dirWithSlash, [p]))
	);
}

/**
 * Is there any reason to walk hidden files at all?
 *
 * The walk is expensive (serial `adapter.list()` calls) and used to be gated on
 * `syncHidden` alone — which quietly made the include list inert in the one mode it
 * was written for: with the toggle off, nothing hidden was ever listed, so
 * "sync these anyway" pushed nothing. A hidden include entry is now reason enough
 * to walk; a normal one (re-including a path under an excluded folder) is not,
 * because those files arrive through `Vault#getFiles()` anyway.
 */
export function needsHiddenScan(rules: SkipRules): boolean {
	return rules.syncHidden || rules.syncInclude.some((p) => !!p && isHidden(p));
}

/**
 * What separates the server's contents from this device's disk. Produced by
 * {@link comparePaths} and shown before "Reset server" empties the remote database.
 */
export interface PathDelta {
	/** the two sides hold exactly the same paths — the reset destroys nothing */
	equal: boolean;
	/** on the server, not on this disk — the set the reset actually destroys */
	serverOnly: string[];
	/** on this disk, not on the server — uploaded again afterwards, so not a loss */
	localOnly: string[];
	serverCount: number;
	diskCount: number;
}

/**
 * Compare the server's paths with this device's, for the pre-flight in front of
 * "Reset server". Pure, so the one decision that costs data if it is wrong can be
 * tested without a database or an Obsidian app.
 *
 * The disk side is deliberately the DISK and not the local cache: the re-upload
 * that follows a reset walks `Vault#getFiles()`, so what survives is what is on
 * disk. `IndexReport.serverOnly` is computed against the cache and answers a
 * different question.
 *
 * Duplicates on either side are collapsed, and the counts report distinct paths, so
 * the two figures shown side by side are comparable.
 */
export function comparePaths(serverPaths: string[], diskPaths: string[]): PathDelta {
	const server = new Set(serverPaths);
	const disk = new Set(diskPaths);
	const sort = (a: string[]) => a.sort((x, y) => x.localeCompare(y));
	const serverOnly = sort([...server].filter((p) => !disk.has(p)));
	const localOnly = sort([...disk].filter((p) => !server.has(p)));
	return {
		equal: serverOnly.length === 0 && localOnly.length === 0,
		serverOnly,
		localOnly,
		serverCount: server.size,
		diskCount: disk.size,
	};
}

/** One block of a line-by-line diff: unchanged context, or a changed region. */
export type DiffHunk =
	| { type: "equal"; lines: string[] }
	| { type: "change"; local: string[]; remote: string[] };

/** Beyond this many lines on either side we skip the (quadratic) LCS and emit one block. */
const DIFF_MAX_LINES = 2500;

/**
 * Line-by-line diff of two texts via a longest-common-subsequence walk. Returns an
 * ordered list of hunks (equal context and change blocks) that a merge UI can render
 * and let the user resolve hunk by hunk. For very large inputs it falls back to a
 * single change block (whole-file pick-a-side) so the editor never freezes.
 */
export function diffLines(aText: string, bText: string): DiffHunk[] {
	const a = aText.split("\n");
	const b = bText.split("\n");
	if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
		return aText === bText ? [{ type: "equal", lines: a }] : [{ type: "change", local: a, remote: b }];
	}

	const n = a.length;
	const m = b.length;
	// lcs[i*(m+1)+j] = LCS length of a[i..] and b[j..]
	const lcs = new Int32Array((n + 1) * (m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i * (m + 1) + j] =
				a[i] === b[j]
					? lcs[(i + 1) * (m + 1) + (j + 1)] + 1
					: Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + (j + 1)]);
		}
	}

	const hunks: DiffHunk[] = [];
	const pushEqual = (line: string) => {
		const last = hunks[hunks.length - 1];
		if (last && last.type === "equal") last.lines.push(line);
		else hunks.push({ type: "equal", lines: [line] });
	};
	const pushChange = (local: string[], remote: string[]) => {
		const last = hunks[hunks.length - 1];
		if (last && last.type === "change") {
			last.local.push(...local);
			last.remote.push(...remote);
		} else {
			hunks.push({ type: "change", local: [...local], remote: [...remote] });
		}
	};

	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			pushEqual(a[i]);
			i++;
			j++;
		} else if (lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + (j + 1)]) {
			pushChange([a[i]], []);
			i++;
		} else {
			pushChange([], [b[j]]);
			j++;
		}
	}
	if (i < n) pushChange(a.slice(i), []);
	if (j < m) pushChange([], b.slice(j));
	return hunks;
}

/** Which side of a change block wins in the side-by-side merge editor. */
export type MergeChoice = "local" | "remote";

/**
 * A merge block: `equal` context shared by both sides, or a `change` block whose
 * `choice` records which side the user kept (local = left, remote = right). This is
 * the pure state model behind the diff/merge modal, kept here so it is unit-testable.
 */
export type MergeBlock =
	| { type: "equal"; lines: string[] }
	| { type: "change"; local: string[]; remote: string[]; choice: MergeChoice };

/**
 * Build the initial merge blocks for two texts. Every change block defaults to
 * `local` — the safe choice, since local is the user's current working copy — so an
 * immediate apply can never silently drop on-disk work.
 */
export function buildMergeBlocks(localText: string, remoteText: string): MergeBlock[] {
	return diffLines(localText, remoteText).map((h) =>
		h.type === "equal"
			? { type: "equal", lines: h.lines }
			: { type: "change", local: h.local, remote: h.remote, choice: "local" }
	);
}

/** Concatenate each block's winning lines into the reconciled document text. */
export function mergeResult(blocks: MergeBlock[]): string {
	const out: string[] = [];
	for (const b of blocks) {
		if (b.type === "equal") out.push(...b.lines);
		else out.push(...(b.choice === "local" ? b.local : b.remote));
	}
	return out.join("\n");
}

/**
 * Coerce anything thrown, rejected, or emitted into a real `Error`.
 *
 * PouchDB does not reject with `Error` objects: replication failures arrive as
 * plain objects like `{ status: 401, name: "unauthorized", reason: "Name or
 * password is incorrect." }`. Passing one of those through `String(e)` yields
 * "[object Object]", which is what the status card used to show instead of the
 * actual reason. Preferring `reason`/`message` keeps the sentence a user can act
 * on, and the JSON fallback keeps *something* identifying rather than nothing.
 */
export function toError(e: unknown): Error {
	if (e instanceof Error) return e;
	if (typeof e === "object" && e !== null) {
		const o = e as { message?: unknown; reason?: unknown; error?: unknown };
		for (const field of [o.reason, o.message, o.error]) {
			if (typeof field === "string" && field.length > 0) return new Error(field);
		}
		try {
			return new Error(JSON.stringify(e));
		} catch {
			// circular or otherwise unserializable — fall through to String()
		}
	}
	return new Error(String(e));
}

/**
 * True for the "IndexedDB connection is closing/closed" family of errors.
 *
 * Mobile OSes (iOS/Android) close IndexedDB connections while an app is
 * backgrounded or the device sleeps. Our long-lived local PouchDB handle is then
 * stale, and any transaction on it throws — via PouchDB — with a message like
 * "Failed to execute 'transaction' on 'IDBDatabase': The database connection is
 * closing." (name `InvalidStateError`). Detecting exactly this family lets the
 * plugin recover (reopen the handle + restart) rather than surface a dead-end
 * error. Pure, so it is unit-testable.
 */
export function isIdbClosingError(e: unknown): boolean {
	const err = e as { message?: unknown; name?: unknown } | null;
	const msg = typeof err?.message === "string" ? err.message : "";
	const name = typeof err?.name === "string" ? err.name : "";

	// DOMException names IndexedDB throws when its connection is closing/closed or the
	// OS tore it down while the app was suspended. iOS/Android WebViews surface several
	// beyond the "closing" one — an `UnknownError`/`AbortError` after a resume is the
	// same dead-connection situation, just a different label. These names are
	// IndexedDB-specific, so matching them is safe even on the replication path (a
	// remote HTTP error carries a status code, not a DOMException name).
	if (
		name === "InvalidStateError" ||
		name === "UnknownError" ||
		name === "AbortError" ||
		name === "TransactionInactiveError" ||
		name === "NotReadableError" ||
		name === "TimeoutError"
	) {
		return true;
	}

	return /connection is clos|database is clos|database is closed|being closed|IDBDatabase|Indexed Database|backing store/i.test(msg);
}
