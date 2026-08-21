export type ConflictStrategy = "master" | "newest";

/**
 * Where the key that protects the credentials in `data.json` comes from.
 *
 * - "device": a random key held in this device's (vault-scoped) local storage, which
 *   is never part of the vault. No prompt, ever.
 * - "ask": a passphrase the user types once per launch; it lives only in memory.
 *
 * See `secrets.ts` for the mechanism.
 */
export type SecretsMode = "device" | "ask";

/**
 * Settings schema version. Bumped whenever the persisted shape changes in a way
 * that needs a one-time migration (see `migrateSettings` in main.ts). Fresh
 * installs are stamped with the current version and skip migration.
 */
export const CURRENT_SETTINGS_VERSION = 7;

export interface CouchDBSyncSettings {
	/** persisted settings schema version; drives one-time migrations */
	schemaVersion: number;

	/** e.g. https://couch.example.com:6984 */
	serverUrl: string;
	/** remote database name */
	dbName: string;
	username: string;
	/**
	 * CouchDB password. RUNTIME ONLY — never written to data.json; it is sealed into
	 * `encryptedSecrets` on save and restored into this field on load (see secrets.ts).
	 */
	password: string;

	/** end-to-end encryption of document content (at rest on the server) */
	e2eeEnabled: boolean;
	/**
	 * Shared secret; MUST match on every device. Never replicated, and — like
	 * `password` — RUNTIME ONLY: it is persisted inside `encryptedSecrets`, never in
	 * the clear.
	 */
	passphrase: string;

	/** where the key protecting `encryptedSecrets` comes from */
	secretsMode: SecretsMode;

	/**
	 * The sealed `{ password, passphrase }` blob, the only form in which those two
	 * ever touch the disk. Opaque without the key, which lives outside the vault.
	 * Empty until credentials are first entered.
	 */
	encryptedSecrets: string;

	/** how conflicts are resolved automatically, without prompting */
	conflictStrategy: ConflictStrategy;
	/** when conflictStrategy === "master", this device's writes win */
	isMaster: boolean;

	/** stable per-install id (auto-generated) */
	deviceId: string;

	/**
	 * Stable, random per-VAULT id used to name the local PouchDB so two vaults on
	 * the same machine can never share their local replica. Auto-generated on
	 * first load; persisted in data.json (which lives inside each vault's
	 * .obsidian/plugins/couchdb-sync/, so it is already vault-scoped). Adding the
	 * random component guarantees uniqueness even across vaults that happen to
	 * have the same name or path.
	 */
	localDbId: string;

	/**
	 * Master on/off switch for the whole sync mechanism, and the ONLY thing that
	 * decides whether this vault syncs.
	 *
	 * ON means "sync this vault": a session starts automatically when Obsidian
	 * launches. OFF is a hard kill switch — NOTHING touches the network: no session
	 * starts, live sync cannot resume, per-file sync actions refuse, and the idle
	 * conflict resolver stands down. The local index view still reads the cache
	 * (local-only, no network) so state stays inspectable while sync is off.
	 *
	 * There is deliberately no separate "start automatically" preference: two flags
	 * for one intent produced the contradictory "SYNC ON … Idle" state, where the
	 * switch said yes and nothing ran. Stopping the *current* session without
	 * changing this switch is still possible (the status card's Stop button); that
	 * state is explicitly labelled, unlike the silent one it replaces.
	 *
	 * Persisted, so "off" survives restarts. On by default.
	 */
	syncEnabled: boolean;

	/** whether live (continuous) sync is enabled */
	liveSync: boolean;

	/**
	 * Sync hidden files (dotfiles and dot-folders like .obsidian, .git). Off by
	 * default. Our own plugin's data.json is always excluded.
	 *
	 * This decides only what happens to HIDDEN paths; `syncExclude` applies either
	 * way. See `isPathExcluded` in util.ts for the single rule that combines the two.
	 */
	syncHidden: boolean;

	/**
	 * "Do not sync these" — paths that are never synced, hidden or not.
	 *
	 * Persisted as `hiddenExclude` before schema v7, when it was consulted only for
	 * hidden paths. That made its own defaults inert: `node_modules/` matched nothing
	 * under `Projects/app/`, and a vault holding a Node project had no setting that
	 * could stop it. Migration v7 carries the entries over unchanged; they simply
	 * reach further now.
	 */
	syncExclude: string[];

	/**
	 * "Sync these anyway" — the narrow opt-in. Overrides `syncExclude` AND the hidden
	 * toggle, because a blacklist cannot express "from this excluded area I want
	 * exactly one thing". Persisted as `hiddenInclude` before schema v7.
	 */
	syncInclude: string[];

	/**
	 * How many past versions to keep per file in the explicit history log. Content
	 * chunks are content-addressed and shared, so history mostly costs small metadata.
	 */
	keepHistory: number;

	/**
	 * Show excluded files (matched by the skip rules) in the Sync state tree so they
	 * can be inspected and synced once on demand. Off by default; bounded — only
	 * excluded files that already exist as normal vault files or as database docs are
	 * listed (never a full walk of .git/node_modules).
	 */
	showExcluded: boolean;

	/**
	 * Crash guard. Set to true while a sync session is starting/running and cleared
	 * once it reaches a safe steady state. If it is still true at launch, the previous
	 * session did not finish cleanly (hang/crash), so we start in safe mode (no
	 * auto-start) to keep the recovery buttons reachable.
	 */
	unsafeShutdown: boolean;

	/**
	 * Consecutive launches that found unsafeShutdown still set (a start that never
	 * reached steady state). A single unclean start is normal on mobile — the OS
	 * suspends/kills the app before the initial index finishes and no onunload runs —
	 * so sync is only forced off once this streak crosses UNCLEAN_START_LIMIT, i.e.
	 * on a genuine repeated start-crash loop rather than a one-off background kill.
	 * Reset to 0 whenever a session reaches a safe steady state (or shuts down cleanly).
	 */
	unsafeShutdownStreak: number;

	/**
	 * Set true once we have proven the configured server+credentials are valid
	 * (Test connection succeeded, or a sync session reached steady state). Gates
	 * the index status view so users cannot accidentally inspect the local cache
	 * by typing random text into the URL field — that cache may legitimately
	 * exist from a previous configuration, but its contents should not be shown
	 * until the user has demonstrated control of the matching remote.
	 */
	connectionVerified: boolean;

	/**
	 * Plugin version whose "what's new" note the user has already seen. Empty on
	 * a fresh install, so the note shows once; it is stamped with the running
	 * version the moment the note is due, which also covers every later update
	 * (installed version !== stamped version). Not a preference — there is
	 * nothing to configure, only something to remember.
	 */
	lastWhatsNewVersion: string;
}

/**
 * Paths that are excluded BY DEFAULT (safe baseline), at any depth and whether
 * hidden or not. Kept as a named constant so the one-time settings migration can
 * re-union them into an existing config that predates a given entry — e.g. a config
 * that never had `.git/` or `.obsidian/` in its blacklist would otherwise sync a
 * whole git repo. Users can still opt any of these back IN by removing the line (or
 * by naming a path under it in `syncInclude`); the migration only runs once per
 * schema bump, so a deliberate later removal is respected.
 */
export const DEFAULT_EXCLUDE: string[] = [
	".git/",
	".trash/",
	".DS_Store",
	"node_modules/",
	".claude/",
	"tmp/",
];

/**
 * The full default exclude baseline for one vault, including its configuration
 * folder.
 *
 * That folder is `.obsidian` in most vaults but users can rename it, and
 * Obsidian exposes the real value as `Vault#configDir`. Hardcoding the usual
 * name meant a renamed config folder was not on the baseline at all — so
 * enabling hidden-file sync would have replicated the whole settings directory,
 * workspace layout and plugin state, which is exactly what the baseline exists
 * to prevent. The value is therefore injected by the caller.
 */
export function defaultExclude(configDir: string): string[] {
	return [
		`${configDir}/`,
		...DEFAULT_EXCLUDE,
		`${configDir}/workspace.json`,
		`${configDir}/workspace-mobile.json`,
		`${configDir}/cache`,
	];
}

export const DEFAULT_SETTINGS: CouchDBSyncSettings = {
	schemaVersion: CURRENT_SETTINGS_VERSION,
	serverUrl: "",
	dbName: "obsidian",
	username: "",
	password: "",
	e2eeEnabled: true, // encryption on by default
	passphrase: "",
	secretsMode: "device",
	encryptedSecrets: "",
	conflictStrategy: "newest",
	isMaster: false,
	deviceId: "",
	localDbId: "",
	syncEnabled: true,
	liveSync: true,
	syncHidden: false,
	// never synced, hidden or not. The vault's configuration folder is added on load
	// (its name is only known from Vault#configDir — see defaultExclude).
	syncExclude: [...DEFAULT_EXCLUDE],
	// nothing is re-included by default
	syncInclude: [],
	keepHistory: 50,
	showExcluded: false,
	unsafeShutdown: false,
	unsafeShutdownStreak: 0,
	connectionVerified: false,
	lastWhatsNewVersion: "",
};

/**
 * One CouchDB document per vault file. The content itself lives in separate,
 * content-addressed chunk documents; this doc only holds metadata and the ordered
 * list of chunk ids. That keeps every document small (no matter how big the file)
 * and lets unchanged chunks be reused. `_id` is the vault-relative path.
 */
export interface FileDoc {
	_id: string;
	_rev?: string;
	_deleted?: boolean;
	_conflicts?: string[];

	type: "file";
	path: string;
	mtime: number;
	ctime: number;
	size: number;

	/** logical deletion (tombstone) so deletes replicate cleanly */
	deleted: boolean;

	/** originating device — used by the "master wins" strategy */
	deviceId: string;

	/** true when the file is binary (chunks are base64 of raw bytes) */
	binary: boolean;

	/** true when chunk payloads are encrypted */
	enc: boolean;

	/** ordered list of chunk document ids; empty for an empty file */
	children: string[];

	/** cheap fingerprint of the content (hash of the ordered children) */
	hash: string;
}

/**
 * One immutable entry in a file's explicit version history. We keep history
 * ourselves (instead of relying on PouchDB `_rev` history, which compaction and a
 * low `_revs_limit` prune away) so the timeline is always complete and restorable.
 *
 * `_id` is "H:" + path + "\n" + zero-padded timestamp + "\n" + short hash. The
 * newline delimiter cannot appear in a vault path, so a path-prefixed range query
 * is unambiguous; the padded timestamp makes the lexicographic order chronological.
 * History docs replicate like any other doc, so every device shares one timeline.
 * They sort BEFORE the "f:" file docs and "h:" chunks, so file-doc range scans
 * never see them.
 */
export interface VersionDoc {
	_id: string;
	_rev?: string;
	_deleted?: boolean;

	type: "version";
	path: string;
	/** when this version was committed (ms since epoch) */
	ts: number;
	mtime: number;
	size: number;
	hash: string;
	deviceId: string;
	binary: boolean;
	enc: boolean;
	/** ordered chunk ids of this version (empty for a deletion entry) */
	children: string[];
	/** true when this entry records a deletion */
	deleted: boolean;
	/** optional human note, e.g. "restored from <date>" */
	note?: string;
}

/** Attachment name under which a chunk's (possibly encrypted) raw bytes are stored. */
export const CHUNK_ATTACHMENT = "b";

/**
 * A content-addressed chunk. `_id` is "h:" + a hash of the chunk, so identical
 * content always maps to the same document and is stored once. Chunks are
 * immutable (never updated), which means they never produce sync conflicts.
 *
 * The chunk bytes live in a CouchDB **attachment** (named CHUNK_ATTACHMENT), not
 * inline as base64 — so CouchDB stores them binary (no ~1.77x base64-of-encrypt-of-
 * base64 bloat) and large chunks never sit in the document body.
 */
export interface ChunkDoc {
	_id: string;
	_rev?: string;
	type: "chunk";
	/** true when the attachment bytes are AES-256-GCM encrypted (encryptBytes layout) */
	enc: boolean;
	/** the raw/encrypted bytes live in _attachments[CHUNK_ATTACHMENT] */
	_attachments?: Record<string, unknown>;
}

/** Per-device record of the last successfully synced state of a file (not replicated). */
export interface SyncRecord {
	mtime: number;
	size: number;
	hash: string;
}

export const SYNC_STATE = {
	IDLE: "idle",
	CONNECTING: "connecting",
	SYNCING: "syncing",
	SYNCED: "synced",
	OFFLINE: "offline",
	PAUSED: "paused",
	ERROR: "error",
} as const;

export type SyncState = (typeof SYNC_STATE)[keyof typeof SYNC_STATE];

/**
 * Current sync status, shared with the status bar and the settings view.
 *
 * Deliberately carries no progress counter. The status card already reports
 * progress as "<synced> / <total> files (<pct>%)", derived from the index report;
 * a second counter with a different denominator (files touched by the current
 * pass) said almost the same thing in the common case and disagreed with it in
 * every other. One number, one meaning — `state` tells the card whether work is
 * in flight, and it animates its own figures accordingly.
 */
export interface SyncStatus {
	state: SyncState;
	/** why the plugin is in this state, when there is something worth saying */
	detail?: string;
}

/** Raw chunk size in bytes before base64/encryption. Keeps documents well-sized. */
export const CHUNK_SIZE = 1024 * 1024; // 1 MiB

/**
 * How often live sync re-reconciles in BOTH directions to catch what the fast paths
 * (vault events for push, the live replication feed for pull) delivered late or not
 * at all. On the pull side a file another device created can land in the local
 * database yet sit undisplayed while a big local upload runs; on the push side a
 * mobile vault event can be dropped across an app suspension. The periodic sweep
 * materializes new remote files to disk first (so incoming files appear promptly)
 * and then re-pushes local changes the events missed. Each half is cheap and a no-op
 * when nothing drifted, so it can run often without hurting a large vault.
 */
export const RECONCILE_INTERVAL_MS = 15_000;

/**
 * Document id prefixes. File metadata docs are keyed "f:" + path; chunks are "h:" + hash.
 * The prefix lets us range-query ONLY the (small) file docs and never load chunk data
 * into memory by accident — which would otherwise blow up RAM on large vaults.
 */
export const FILE_PREFIX = "f:";
export const CHUNK_PREFIX = "h:";
/** History/version docs. Sorts before "f:" so file-doc range scans skip them. */
export const HISTORY_PREFIX = "H:";
/** Delimiter inside a history id; a newline can never appear in a vault path. */
export const HISTORY_SEP = "\n";
