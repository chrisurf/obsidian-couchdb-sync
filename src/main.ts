import { Notice, Platform, Plugin, setIcon } from "obsidian";
import PouchDB from "pouchdb-browser";
import {
	CouchDBSyncSettings,
	CURRENT_SETTINGS_VERSION,
	DEFAULT_SETTINGS,
	SecretsMode,
	SYNC_STATE,
	SyncState,
	SyncStatus,
	VersionDoc,
} from "./types";
import { migrateSettings } from "./migrate";
import {
	clearSecretKeyCache,
	decideSealAction,
	DeviceKeyStore,
	loadOrCreateDeviceKey,
	sealSecrets,
	toPersisted,
	unsealSecrets,
} from "./secrets";
import { askNewSecretsPassphrase, askUnlockPassphrase } from "./secretsmodal";
import { RemoteScan, SyncDatabase } from "./database";
import { SyncEngine, IndexReport, buildIndexReport, removeFromDb } from "./engine";
import { CouchDBSyncSettingTab } from "./settings";
import { SyncStatusView, VIEW_TYPE_SYNC_STATUS } from "./view";
import { WhatsNewModal } from "./whatsnewmodal";
import { shouldShowWhatsNew } from "./whatsnew";
import { generateDeviceId, sha256Hex, textToBytes, toError } from "./util";

/** _local doc id under which we remember which remote this cache belongs to. */
const ORIGIN_FP_DOC = "_local/couchdb-sync-origin";

/**
 * Stable fingerprint of the "remote identity" — the tuple that determines
 * which remote a local cache belongs to. Username is included so two users
 * sharing the same server+database are still distinguishable.
 */
async function originFingerprint(settings: CouchDBSyncSettings): Promise<string> {
	const norm = `${settings.serverUrl.trim().replace(/\/+$/, "")}|${settings.dbName.trim()}|${settings.username.trim()}`;
	return sha256Hex(textToBytes(norm));
}

/**
 * Obsidian runs all vaults under the same Electron origin (`app://obsidian.md`),
 * so a hardcoded local PouchDB name would be shared across every vault on the
 * machine — leaking files between vaults and risking cross-vault writes. We
 * therefore derive the name from a random per-vault id persisted in this
 * vault's data.json (which Obsidian already scopes per-vault).
 */
const LOCAL_DB_PREFIX = "couchdb-sync-local";
const LEGACY_LOCAL_DB_NAME = "couchdb-sync-local"; // pre-vault-isolation default

/**
 * How many consecutive unclean starts (unsafeShutdown still set at launch) force sync
 * OFF. One is expected on mobile — a background kill before the initial index finishes
 * leaves the flag set with no onunload to clear it — so only a repeated failure to
 * reach steady state counts as a real start-crash loop worth stopping.
 */
const UNCLEAN_START_LIMIT = 3;

/**
 * How long a direct server scan is reused before the index report takes a fresh one.
 * The panel refreshes every few seconds off the local cache; the true server state
 * changes far more slowly and each scan is a network round-trip plus a decrypt of any
 * new file doc, so a short cache keeps the "Server" column honest without hammering
 * the server on every tick.
 */
const REMOTE_SCAN_TTL_MS = 15_000;

function localDbName(settings: CouchDBSyncSettings): string {
	return `${LOCAL_DB_PREFIX}-${settings.localDbId}`;
}

/**
 * Lucide icon per state for the status bar. The icon doubles as the on/off
 * switch, so the not-running states use "play": a pause glyph on a control whose
 * click turns syncing ON reads backwards.
 */
const STATUS_ICON: Record<SyncState, string> = {
	[SYNC_STATE.IDLE]: "play",
	[SYNC_STATE.CONNECTING]: "plug",
	[SYNC_STATE.SYNCING]: "refresh-cw",
	[SYNC_STATE.SYNCED]: "check",
	[SYNC_STATE.OFFLINE]: "cloud-off",
	[SYNC_STATE.PAUSED]: "play",
	[SYNC_STATE.ERROR]: "alert-triangle",
};

export default class CouchDBSyncPlugin extends Plugin {
	settings!: CouchDBSyncSettings;
	private db: SyncDatabase | null = null;
	private engine: SyncEngine | null = null;
	/**
	 * De-dupes concurrent index reports. The settings view (3 s) and the status-bar
	 * drift summary (5 s) both ask for one, and a report is expensive (a hidden-file
	 * walk plus a decrypt of every file doc). Sharing ONE in-flight promise across
	 * every caller — running session or idle — means overlapping timers can never
	 * stack full scans on top of each other.
	 */
	private reportInFlight: Promise<IndexReport | null> | null = null;
	/**
	 * Last direct scan of the REMOTE server, with the time it was taken. The index
	 * report refreshes on a 3 s timer but a live server round-trip (allDocs + a decrypt
	 * of each new file doc) is far heavier than reading the local cache, so it is
	 * throttled to REMOTE_SCAN_TTL_MS and shared here between refreshes.
	 */
	private remoteScan: { at: number; scan: RemoteScan } | null = null;
	private remoteScanInFlight: Promise<RemoteScan | undefined> | null = null;
	/** guards the idle auto-resolver so overlapping refresh ticks don't stack it */
	private resolvingIdle = false;
	/** cached legacy-cache doc count (probed at most once per session) */
	private legacyDocCountCache: number | null = null;
	private statusEl!: HTMLElement;
	private statusIconEl!: HTMLElement;
	private statusTextEl!: HTMLElement;
	private restartLock: Promise<void> = Promise.resolve();

	// --- credential storage (see secrets.ts) ---------------------------------
	/** Key material that opens `encryptedSecrets`; null while locked. */
	private secretKey: string | null = null;
	/** The sealed blob exactly as it sits on disk. */
	private sealedSecrets = "";
	/**
	 * True once the blob has been opened — or there was nothing to open (fresh vault,
	 * or a pre-v6 config whose plaintext is still in memory waiting to be sealed).
	 * While false, the credentials in `settings` are NOT the ones on disk, so saving
	 * must leave the stored blob alone.
	 */
	private secretsUnlocked = false;
	/** De-dupes the unlock prompt when several callers hit a locked vault at once. */
	private unlockInFlight: Promise<boolean> | null = null;
	/** The user dismissed the unlock prompt; automatic paths stop re-asking. */
	private unlockPromptDeclined = false;
	/**
	 * Device-local key store. Obsidian scopes this storage per vault and keeps it
	 * outside the vault folder, which is the whole point: copying, backing up or
	 * syncing the vault does not carry the key with it.
	 */
	private deviceStore: DeviceKeyStore = {
		get: (key) => {
			const raw: unknown = this.app.loadLocalStorage(key);
			return typeof raw === "string" && raw.length > 0 ? raw : null;
		},
		set: (key, value) => this.app.saveLocalStorage(key, value),
	};

	/** Latest status, shared with the settings view via listeners. */
	status: SyncStatus = { state: SYNC_STATE.IDLE };
	private statusListeners = new Set<(s: SyncStatus) => void>();

	/**
	 * Cached drift summary from the most recent index report. Used by the status
	 * bar so the checkmark only appears when truly 100 % synced — engine SYNCED
	 * alone is not enough (replication can be idle while disk and DB still
	 * diverge, e.g. cached docs not yet materialized).
	 */
	private effectiveDrift: { drift: number; pct: number } | null = null;
	private driftRefreshTimer: number | null = null;
	/** debounces DB-closed recovery so a burst of "connection is closing" errors triggers one restart */
	private recoveryTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		// Status bar: two controls, not one label. The icon is the on/off switch —
		// the same one the status card shows — and the text opens the full status
		// panel. Both are reachable without going through settings, which is where
		// they are needed most.
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("couchdb-sync-status");
		this.statusIconEl = this.statusEl.createSpan({
			cls: "couchdb-sync-status-icon couchdb-sync-status-btn",
		});
		this.statusTextEl = this.statusEl.createSpan({
			cls: "couchdb-sync-status-text couchdb-sync-status-btn",
		});
		this.statusIconEl.onclick = () => void this.toggleSyncFromStatusBar();
		this.statusTextEl.onclick = () => void this.revealStatusView();
		// Paint directly rather than via setStatus: the status already IS the initial
		// idle state, and setStatus short-circuits on an unchanged status — which
		// would leave the bar blank until something else happened to change it.
		this.renderStatusBar();

		this.registerView(VIEW_TYPE_SYNC_STATUS, (leaf) => new SyncStatusView(leaf, this));

		// Left-ribbon launcher for the status panel. Uses the SAME icon the sidebar
		// view carries (SyncStatusView.getIcon), so the ribbon button, the view tab and
		// the status bar all read as one feature. addRibbonIcon auto-unregisters on unload.
		this.addRibbonIcon("refresh-cw", "CouchDB Sync: open status panel", () =>
			void this.revealStatusView()
		);

		this.addSettingTab(new CouchDBSyncSettingTab(this.app, this));

		this.addCommand({
			id: "open-panel",
			name: "Open sync status panel",
			callback: () => void this.revealStatusView(),
		});

		this.addCommand({
			id: "force-sync",
			name: "Force sync",
			callback: () => this.restartSync(),
		});

		this.addCommand({
			id: "toggle-sync",
			name: "Turn sync on/off",
			callback: () => this.setSyncEnabled(!this.settings.syncEnabled),
		});

		this.addCommand({
			id: "wipe-local-cache",
			name: "Wipe local cache (rebuild with Force sync)",
			callback: async () => {
				await this.wipeLocalOnly();
				new Notice(
					"CouchDB Sync: local cache wiped. Press 'Force sync' to rebuild — it uploads your local files and downloads anything the server has."
				);
			},
		});

		this.addCommand({
			id: "whats-new",
			name: "Show what's new",
			callback: () => this.showWhatsNew(),
		});

		// Crash guard: if the previous session never reached a safe state, it left
		// unsafeShutdown=true. A start-crash LOOP must be broken by switching sync OFF —
		// but a SINGLE unclean start is normal on mobile, where the OS suspends/kills the
		// app before the initial index finishes and no onunload runs. Disabling sync on
		// the first one is exactly the reported "my phone edits stop syncing / sync is
		// silently off" trap. So count consecutive unclean starts and only force sync off
		// once the streak shows a real loop (>= UNCLEAN_START_LIMIT); a lone background
		// kill just increments the streak and sync keeps running, ready to reach steady
		// state (which resets the streak) on the next foreground.
		let crashed = false;
		if (this.settings.unsafeShutdown) {
			this.settings.unsafeShutdown = false;
			this.settings.unsafeShutdownStreak += 1;
			if (this.settings.unsafeShutdownStreak >= UNCLEAN_START_LIMIT) {
				crashed = true;
				this.settings.syncEnabled = false;
				this.settings.unsafeShutdownStreak = 0;
				new Notice(
					"CouchDB Sync: the previous syncs did not finish cleanly, so sync has been " +
						"switched OFF. Fix the issue (or wipe the local cache), then switch sync back on.",
					12000
				);
			}
			await this.saveSettings();
		}

		if (!this.settings.syncEnabled) {
			// Master switch off — stay fully idle, no network, until it is switched on.
			// Only the crash case carries a detail; for a plain "off" the status card
			// derives the wording from the live state.
			this.setStatus(
				SYNC_STATE.IDLE,
				crashed ? "Stopped after an unclean shutdown — switch sync on to resume." : undefined
			);
		} else {
			// Sync is on, so it runs: start once the layout is ready, so the initial
			// scan sees a settled vault.
			this.app.workspace.onLayoutReady(() => void this.restartSync());
		}

		// Once the workspace is up, surface the "what's new" note — a modal during
		// layout restore would fight with Obsidian for the screen.
		this.app.workspace.onLayoutReady(() => this.maybeShowWhatsNew());

		// Keep the status bar honest: the engine reports SYNCED as soon as
		// replication is idle, but disk and DB can still be out of sync. The
		// status bar should only show the checkmark when drift is truly zero,
		// so we recompute the drift summary on a slow tick and re-render.
		this.driftRefreshTimer = window.setInterval(
			() => void this.refreshDriftSummary(),
			5000
		);
		this.register(() => {
			if (this.driftRefreshTimer !== null) {
				window.clearInterval(this.driftRefreshTimer);
				this.driftRefreshTimer = null;
			}
		});
		// First read once the layout has had a moment to settle (don't block onload).
		window.setTimeout(() => void this.refreshDriftSummary(), 1500);

		// Mobile resume recovery: iOS/Android close IndexedDB connections and kill live
		// replication while the app is backgrounded or the device sleeps. When the app
		// returns to the foreground, reopen the local handle and restart sync so both
		// reads and replication reconnect. registerDomEvent auto-unregisters on unload.
		this.registerDomEvent(document, "visibilitychange", () => {
			if (Platform.isMobile && document.visibilityState === "visible") {
				this.scheduleDbRecovery();
			}
		});
	}

	/**
	 * Recover from a closed local IndexedDB connection (mobile background/resume).
	 *
	 * Reopening the handle is not enough on its own: the running engine bound its live
	 * replication to the now-dead handle, so recovery restarts sync — `doRestart`
	 * calls `ensureOpen()` first, so the rebuilt engine binds to a fresh connection.
	 * Debounced because the trigger can fire in a burst (the live-sync error handler
	 * and the foreground event can both land within a few hundred ms), and guarded so
	 * turning sync off cancels a pending recovery instead of powering it back on.
	 */
	private scheduleDbRecovery(): void {
		if (this.recoveryTimer !== null) return; // one recovery in flight is enough
		this.recoveryTimer = window.setTimeout(() => {
			this.recoveryTimer = null;
			// This path is reached only when the handle was PROVEN dead — the engine hit
			// a closed-connection error, or the app just returned to the foreground on
			// mobile. Force a reopen rather than relying on the info() probe in
			// ensureOpen: on iOS the probe can occasionally still succeed on a handle
			// that then fails the next real transaction, which would otherwise loop.
			this.db?.reopenLocal();
			if (!this.settings.syncEnabled) {
				// Sync is off: no session to restart. Still refresh the (self-healing)
				// index read so the stale error text clears from the panel.
				void this.refreshDriftSummary();
				return;
			}
			void this.restartSync();
		}, 400);
	}

	/** Opens the "what's new" note for the installed version. */
	private showWhatsNew(): void {
		new WhatsNewModal(this.app, this.manifest.version, this, () =>
			void this.revealStatusView()
		).open();
	}

	/**
	 * Shows the note once per install or update, then records the version so the
	 * same one is never shown twice. The version is stamped BEFORE the modal
	 * opens: a vault that is closed without acknowledging it should not be
	 * greeted by the same note on every launch.
	 */
	private maybeShowWhatsNew(): void {
		const current = this.manifest.version;
		if (!shouldShowWhatsNew(current, this.settings.lastWhatsNewVersion)) return;
		this.settings.lastWhatsNewVersion = current;
		void this.saveSettings();
		this.showWhatsNew();
	}

	onunload(): void {
		// Plugin.onunload is declared void and Obsidian does not await it, so returning
		// a promise here only hid that the teardown races the unload. Kept explicit:
		// the work still runs, and the fire-and-forget is visible rather than implied.
		void this.teardown();
	}

	private async teardown(): Promise<void> {
		if (this.recoveryTimer !== null) {
			window.clearTimeout(this.recoveryTimer);
			this.recoveryTimer = null;
		}
		this.engine?.abort();
		await this.restartLock.catch(() => undefined); // let any in-flight start wind down
		// Flush the session's sync records before tearing down (the debounce that would
		// have written them is cancelled by stop()). Keeps the next launch from
		// re-hashing the whole vault. The local cache is deliberately kept — teardown
		// runs on ordinary app close too, so wiping here would destroy the cache on
		// every quit; use the explicit "Wipe local cache" action instead.
		await this.engine?.flushState().catch(() => undefined);
		this.engine?.stop();
		// Drain any in-flight index report before touching the shared handle.
		if (this.reportInFlight) await this.reportInFlight.catch(() => undefined);
		await this.db?.close().catch(() => undefined);
		this.engine = null;
		this.db = null;
		// clean shutdown -> not a crash, and not a loop
		this.settings.unsafeShutdown = false;
		this.settings.unsafeShutdownStreak = 0;
		await this.saveSettings().catch(() => undefined);
		// Drop the derived credential key. In "ask" mode the passphrase must never
		// outlive the session that asked for it.
		clearSecretKeyCache();
		this.secretKey = null;
	}

	private setStatus(state: SyncState, detail?: string): void {
		// Idempotent: the engine signals activity once per indexed file, so a large
		// vault would otherwise re-render the status bar and every listener thousands
		// of times for a status that never changed.
		if (this.status.state === state && this.status.detail === detail) return;

		const wasSyncing = this.status.state === SYNC_STATE.SYNCING;
		this.status = { state, detail };

		if (state === SYNC_STATE.ERROR && detail) console.error("[couchdb-sync]", detail);

		this.renderStatusBar();
		for (const cb of this.statusListeners) cb(this.status);

		// Just settled? Refresh the drift summary so the bar can flip from a %
		// to the checkmark immediately, without waiting for the periodic tick.
		if (wasSyncing && state === SYNC_STATE.SYNCED) {
			void this.refreshDriftSummary();
		}
	}

	/**
	 * Combine the raw engine state with the cached drift summary into the icon,
	 * label and ARIA description of the status bar. The checkmark is only shown
	 * when both: the engine is idle/synced AND drift is exactly zero. Any
	 * pending drift forces the syncing icon plus the real percentage.
	 */
	private renderStatusBar(): void {
		const raw = this.status;
		const drift = this.effectiveDrift;

		// Master switch off: show a single, unambiguous "off" indicator and never a
		// syncing spinner or drift % — nothing is being synced, so any progress-style
		// readout would be misleading (the drift summary still ticks for the index view).
		if (!this.settings.syncEnabled) {
			setIcon(this.statusIconEl, "play");
			this.statusIconEl.removeClass("couchdb-sync-spin");
			this.statusTextEl.setText("CouchDB off");
			this.statusEl.setAttr("aria-label", "CouchDB sync: off");
			this.statusIconEl.setAttr("aria-label", "Turn sync on");
			this.statusTextEl.setAttr("aria-label", "Open the sync status panel");
			return;
		}

		let displayed: SyncState = raw.state;
		let label = "CouchDB";
		let ariaSuffix = raw.detail ?? raw.state;

		if (raw.state === SYNC_STATE.ERROR || raw.state === SYNC_STATE.OFFLINE || raw.state === SYNC_STATE.CONNECTING) {
			// these states win unconditionally — drift % would be misleading here
			displayed = raw.state;
		} else if (drift && drift.drift > 0) {
			// Disk and DB still diverge -> not "in sync". Only call it *syncing* (and
			// spin the icon) when a session is actually running; with nothing running
			// a spinner would claim progress that is not happening.
			displayed = this.engine ? SYNC_STATE.SYNCING : SYNC_STATE.PAUSED;
			label = `CouchDB ${drift.pct}%`;
			ariaSuffix = this.engine
				? `syncing ${drift.pct}% — ${drift.drift} pending`
				: `not running — ${drift.pct}% in sync, ${drift.drift} pending`;
		} else if (
			drift &&
			drift.drift === 0 &&
			(raw.state === SYNC_STATE.SYNCED || raw.state === SYNC_STATE.IDLE || raw.state === SYNC_STATE.PAUSED)
		) {
			// truly 100 % in sync
			displayed = SYNC_STATE.SYNCED;
			label = "CouchDB ✓";
			ariaSuffix = "in sync (100%)";
		} else {
			// no drift data yet (gated, before first report, or after error). Stay
			// neutral — do NOT show the checkmark just because the engine is idle.
			displayed = raw.state === SYNC_STATE.SYNCED ? SYNC_STATE.IDLE : raw.state;
		}

		setIcon(this.statusIconEl, STATUS_ICON[displayed]);
		this.statusIconEl.toggleClass("couchdb-sync-spin", displayed === SYNC_STATE.SYNCING);
		this.statusTextEl.setText(label);
		this.statusEl.setAttr("aria-label", `CouchDB sync: ${ariaSuffix}`);
		// Per-control tooltips: the two halves do different things, so one shared
		// label on the container would be wrong for at least one of them.
		this.statusIconEl.setAttr("aria-label", "Turn sync off");
		this.statusTextEl.setAttr("aria-label", "Open the sync status panel");
	}

	/** Recompute the cached drift summary from the current index report. */
	private async refreshDriftSummary(): Promise<void> {
		try {
			const report = await this.getIndexReport();
			if (!report) {
				this.effectiveDrift = null;
			} else {
				const drift = report.localOnly.length + report.dbOnly.length + report.drift.length;
				const total = report.inSync.length + drift;
				const pct = total === 0 ? 100 : Math.round((report.inSync.length / total) * 100);
				this.effectiveDrift = { drift, pct };

				// Idle auto-resolve: when no session is running but the DB still holds
				// unresolved conflicts, clear them by the configured strategy so they
				// don't sit red forever waiting for the next full "Force sync". Guarded so
				// overlapping 5s/3s ticks never stack it.
				if (!this.engine && report.conflicts.length > 0 && !this.resolvingIdle) {
					this.resolvingIdle = true;
					void this.resolveConflictsIdle()
						.then((n) => {
							if (n > 0) void this.refreshDriftSummary();
						})
						.catch((e) => console.warn("[couchdb-sync] idle conflict resolve failed", e))
						.finally(() => {
							this.resolvingIdle = false;
						});
				}
			}
		} catch {
			// silent: keep whatever we had — the next tick will retry
			return;
		}
		this.renderStatusBar();
	}

	/**
	 * Status-bar icon click: the on/off switch, in the status bar.
	 *
	 * Deliberately the same thing the toggle in the status card does — not a third
	 * behaviour. The plugin has exactly two controls: a switch for WHETHER this
	 * vault syncs, and a "Force sync" button for DOING it once. The status-bar icon is
	 * the switch (it already shows that state), and the panel holds the action.
	 */
	private async toggleSyncFromStatusBar(): Promise<void> {
		const turningOn = !this.settings.syncEnabled;
		try {
			await this.setSyncEnabled(turningOn);
			new Notice(turningOn ? "CouchDB Sync: sync turned on." : "CouchDB Sync: sync turned off.");
		} catch (e) {
			new Notice(`CouchDB Sync: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** Open (or focus) the sync status panel in the right sidebar. */
	async revealStatusView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_SYNC_STATUS);
		if (existing.length > 0) {
			await workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_SYNC_STATUS, active: true });
		await workspace.revealLeaf(leaf);
	}

	/** Subscribe to status updates (used by the settings view). Returns an unsubscribe. */
	onStatusChange(cb: (s: SyncStatus) => void): () => void {
		this.statusListeners.add(cb);
		cb(this.status);
		return () => this.statusListeners.delete(cb);
	}

	/**
	 * Restart synchronization. Calls are serialized so two restarts (e.g. layout-ready
	 * plus a settings toggle) can never run concurrently and tear down each other's
	 * database mid-scan. A new call first aborts any running session so it stops fast.
	 */
	restartSync(): Promise<void> {
		this.engine?.abort();
		this.restartLock = this.restartLock
			.catch(() => undefined)
			.then(() => this.doRestart("sync"));
		return this.restartLock;
	}

	/** Pull the server's state into this device without uploading (follower mode). */
	downloadFromServer(): Promise<void> {
		this.engine?.abort();
		this.restartLock = this.restartLock
			.catch(() => undefined)
			.then(() => this.doRestart("download"));
		return this.restartLock;
	}

	/** Push this device's state to the server, overwriting the server's copy of each file. */
	uploadToServer(): Promise<void> {
		this.engine?.abort();
		this.restartLock = this.restartLock
			.catch(() => undefined)
			.then(() => this.doRestart("upload"));
		return this.restartLock;
	}

	private async doRestart(mode: "sync" | "download" | "upload" = "sync"): Promise<void> {
		// Preserve the outgoing engine's sync records across the restart churn (mobile
		// resume-recovery, Force sync, toggle). stop() cancels the debounced write, so
		// without this flush the rebuilt engine would re-hash the whole vault. The shared
		// local DB handle stays open across restarts, so the write here is safe.
		await this.engine?.flushState().catch(() => undefined);

		// Master kill switch: the single choke point every start path funnels through.
		// While off, no session may start — keep the engine torn down and stay idle.
		if (!this.settings.syncEnabled) {
			this.engine?.stop();
			this.engine = null;
			// No detail: the status card derives the reason from the live state.
			this.setStatus(SYNC_STATE.IDLE);
			return;
		}
		this.engine?.stop();
		this.engine = null;
		// Keep the shared local DB handle OPEN across restarts (see getSharedDb): the
		// engine and idle readers share ONE handle, so it must never be closed here.

		// Credentials must be readable before anything touches the network. This is the
		// one place that prompts in "ask" mode (every start path funnels through here),
		// and the one place that stops a locked device from replicating with empty
		// credentials — which would look like a wrong passphrase to the user.
		if (!this.secretsUnlocked && !(await this.ensureSecretsUnlocked())) {
			this.setStatus(
				SYNC_STATE.ERROR,
				"Your stored credentials are locked on this device. Unlock them (or re-enter them) in settings."
			);
			return;
		}

		if (!this.settings.serverUrl || !this.settings.username) {
			this.setStatus(SYNC_STATE.IDLE);
			new Notice("CouchDB Sync: please configure the server connection in settings.");
			return;
		}
		if (this.settings.e2eeEnabled && !this.settings.passphrase) {
			this.setStatus(SYNC_STATE.ERROR, "Encryption is on but no passphrase is set.");
			new Notice("CouchDB Sync: set an encryption passphrase (or disable encryption).");
			return;
		}

		const db = this.getSharedDb();
		// Reconnect the local IndexedDB if the OS closed it while backgrounded, so the
		// engine we build below binds its replication to a live handle. Manual recovery
		// (Force sync / toggle on) reaches this path too, which is why those now work.
		await db.ensureOpen();

		// Refuse to replicate into a remote that did NOT fill this local cache.
		// Otherwise repointing the connection at a different server/database and
		// letting sync run (e.g. automatically at launch) would push this vault's
		// docs into the new remote and mix the two. "unset" (fresh cache, first
		// sync) and "match" proceed; only a definite mismatch is blocked, and the
		// user recovers via Wipe local cache / Adopt cache for this remote.
		const origin = await this.checkOriginFingerprint().catch(() => "unset" as const);
		if (origin === "mismatch") {
			this.setStatus(
				SYNC_STATE.ERROR,
				"Local cache belongs to a different server/database. Wipe the local cache or adopt it for this remote before syncing."
			);
			new Notice(
				"CouchDB Sync: this vault's local cache was filled by a different remote. Open settings → 'Wipe local cache' or 'Adopt cache for this remote'."
			);
			return;
		}

		// Arm the crash guard BEFORE doing any heavy work, and persist it to disk.
		// If this run hangs/crashes before reaching a safe state, the next launch
		// sees the flag and starts in safe mode.
		this.settings.unsafeShutdown = true;
		await this.saveSettings();
		const engine = new SyncEngine(
			this.app,
			db,
			this.settings,
			(s, d) => this.setStatus(s, d),
			() => void this.markCleanState(), // initial index finished -> disarm guard
			() => this.scheduleDbRecovery() // local IndexedDB closed -> reopen + restart
		);
		this.engine = engine;
		try {
			if (mode === "download") await engine.startDownloadOnly();
			else if (mode === "upload") await engine.startUploadOnly();
			else await engine.start();
		} catch (e) {
			const err = toError(e);
			this.setStatus(SYNC_STATE.ERROR, err.message);
			new Notice(`CouchDB Sync failed to start: ${err.message}`);
		}
	}

	/** Clear the crash guard once a session has reached a safe steady state. */
	private async markCleanState(): Promise<void> {
		let dirty = false;
		if (this.settings.unsafeShutdown) {
			this.settings.unsafeShutdown = false;
			dirty = true;
		}
		// Reaching steady state clears the unclean-start streak: whatever interrupted the
		// previous launches, this session made it through, so it was not a crash loop.
		if (this.settings.unsafeShutdownStreak !== 0) {
			this.settings.unsafeShutdownStreak = 0;
			dirty = true;
		}
		// Reaching a steady-state sync proves the remote credentials work, so the
		// index status view is now safe to show without the user re-running Test.
		if (!this.settings.connectionVerified) {
			this.settings.connectionVerified = true;
			dirty = true;
		}
		if (dirty) await this.saveSettings();
		// Reaching steady state also means this local cache is now legitimately
		// tied to the configured remote — record the fingerprint so a later
		// credential change can be detected.
		await this.stampOriginFingerprint();
	}

	/** Mark the configured connection as verified (called by the Test button on success). */
	async markConnectionVerified(): Promise<void> {
		if (this.settings.connectionVerified) return;
		this.settings.connectionVerified = true;
		await this.saveSettings();
	}

	/** Reset the verified flag — required whenever serverUrl/dbName/username change. */
	async invalidateConnection(): Promise<void> {
		// A changed remote invalidates the cached server scan too, so the Server column
		// never shows the previous server's state after the URL/db/user is edited.
		this.remoteScan = null;
		// …and the cached remote HANDLE, which carries the old credentials baked in
		// (see SyncDatabase.closeRemote). Keeping it meant every later automatic scan
		// re-authenticated with the password the user just replaced.
		this.db?.closeRemote();
		if (!this.settings.connectionVerified) return;
		this.settings.connectionVerified = false;
		await this.saveSettings();
	}

	/**
	 * Compare the cache's stored origin fingerprint against the current settings.
	 * Returns null when there is no stored fingerprint yet (fresh DB or pre-fingerprint
	 * data), 'match' when they agree, or 'mismatch' when the cache was filled by a
	 * different remote — in which case the index view must NOT be shown without an
	 * explicit user action (otherwise switching credentials would silently surface
	 * the previous remote's filenames).
	 */
	async checkOriginFingerprint(): Promise<"match" | "mismatch" | "unset"> {
		// One shared, always-open handle (getSharedDb) is used by the engine and all
		// idle readers alike, so there is no second connection to close out from under
		// a pending transaction (the old IDBDatabase "connection is closing" bug).
		const stored = await this.getSharedDb()
			.getLocalDoc<{ fp?: string }>(ORIGIN_FP_DOC)
			.catch(() => null);
		if (!stored || !stored.fp) return "unset";
		const current = await originFingerprint(this.settings);
		return stored.fp === current ? "match" : "mismatch";
	}

	/** Stamp the current origin fingerprint into the cache so we recognize it later. */
	async stampOriginFingerprint(): Promise<void> {
		try {
			const fp = await originFingerprint(this.settings);
			await this.getSharedDb().putLocalDoc(ORIGIN_FP_DOC, { fp });
		} catch (e) {
			console.warn("[couchdb-sync] could not stamp origin fingerprint", e);
		}
	}

	/**
	 * Wipe the LOCAL replica only (fast). Does NOT download — the user starts that
	 * separately with "Force sync". The server data is untouched.
	 */
	wipeLocalOnly(): Promise<void> {
		this.engine?.abort();
		this.restartLock = this.restartLock
			.catch(() => undefined)
			.then(async () => {
				this.engine?.stop();
				this.engine = null;
				// Drain any in-flight report so we don't destroy the DB out from
				// under a pending read, then destroy and drop the handle. getSharedDb()
				// re-opens a fresh empty replica on the next read.
				if (this.reportInFlight) await this.reportInFlight.catch(() => undefined);
				await this.getSharedDb().destroyLocal().catch(() => undefined);
				this.db = null;
				this.reportInFlight = null;
				this.setStatus(
					SYNC_STATE.IDLE,
					"local cache wiped — press Force sync to rebuild (uploads local files, downloads remote)"
				);
			});
		return this.restartLock;
	}

	/**
	 * Make the server an exact copy of THIS device: delete the remote database, wipe
	 * the local replica, and upload every file on disk into the fresh database.
	 *
	 * Three steps in one action because doing any two of them is worse than doing all
	 * three. Emptying the server alone accomplishes nothing: the local replica still
	 * holds every document that was just deleted and pushes them straight back. And
	 * wiping the replica without emptying the server would simply download the old
	 * state again. Only the whole sequence produces "what is on this disk is what is
	 * on the server, and nothing else".
	 *
	 * This is how a vault recovers from residue no per-file action can reach —
	 * documents left behind by an older id scheme, orphaned chunks, a history that
	 * has grown past its worth.
	 *
	 * NOT a substitute for coordination: every OTHER device still holds a replica of
	 * the deleted database and will push it back the moment it syncs. Those devices
	 * must wipe their local cache before they reconnect. The confirmation dialog says
	 * so; there is nothing this device can do to enforce it.
	 */
	resetServerFromLocal(): Promise<void> {
		this.engine?.abort();
		this.restartLock = this.restartLock
			.catch(() => undefined)
			.then(() => this.doServerReset());
		return this.restartLock;
	}

	private async doServerReset(): Promise<void> {
		if (!this.secretsUnlocked && !(await this.ensureSecretsUnlocked())) {
			this.setStatus(SYNC_STATE.ERROR, "Credentials are locked — unlock them first.");
			return;
		}
		if (!this.settings.serverUrl || !this.settings.username) {
			new Notice("CouchDB Sync: configure the server connection first.");
			return;
		}
		if (this.settings.e2eeEnabled && !this.settings.passphrase) {
			new Notice("CouchDB Sync: set the encryption passphrase first — the upload needs it.");
			return;
		}

		this.engine?.stop();
		this.engine = null;
		if (this.reportInFlight) await this.reportInFlight.catch(() => undefined);
		this.remoteScan = null;

		this.setStatus(SYNC_STATE.CONNECTING, "Emptying the server…");
		const db = this.getSharedDb();
		let outcome: { strategy: "dropped" | "emptied"; deleted: number };
		try {
			outcome = await db.resetRemote((n) =>
				this.setStatus(SYNC_STATE.CONNECTING, `Emptying the server… ${n} documents removed`)
			);
		} catch (e) {
			const err = toError(e);
			this.setStatus(SYNC_STATE.ERROR, `Could not reset the server: ${err.message}`);
			new Notice(`CouchDB Sync: ${err.message}`, 15000);
			// The local replica is deliberately NOT wiped here. Whether the delete failed
			// outright or the recreate did, this replica is the only remaining copy of
			// what the server held — throwing it away on the error path would turn a
			// recoverable failure into real data loss.
			return;
		}

		// The replica mirrors what we just deleted, so it has to go too — otherwise the
		// upload below would re-push every document the reset was meant to remove.
		await db.destroyLocal().catch(() => undefined);
		this.db = null;
		this.reportInFlight = null;

		// Fresh replica, then index this device's files into it and push. Sync must be
		// ON for the upload to run at all (doRestart's master switch), so a reset from
		// a switched-off vault turns it on — the user just asked for an upload.
		if (!this.settings.syncEnabled) {
			this.settings.syncEnabled = true;
			await this.saveSettings();
		}
		await this.doRestart("upload");
		new Notice(
			outcome.strategy === "dropped"
				? "CouchDB Sync: the server database was rebuilt and now holds exactly this device's files."
				: `CouchDB Sync: ${outcome.deleted} document(s) deleted on the server; it now holds exactly this device's files. ` +
					"Your account may not drop databases, so deletion stubs remain — harmless, but the disk space " +
					"comes back only when the server compacts.",
			15000
		);
	}

	/**
	 * Stop the CURRENT session and go idle, without touching the master switch.
	 *
	 * No longer exposed as a control of its own: a second element that also means
	 * "off" competed with the master switch. It survives as internal plumbing —
	 * turning live sync off stops the continuous session here — and the user-facing
	 * way to stop is the switch, which is honest about being persistent.
	 *
	 * The resulting idle state carries a reason, so the status card can say why
	 * nothing is running instead of showing a bare "Not syncing".
	 */
	stopSync(): Promise<void> {
		this.engine?.abort();
		this.restartLock = this.restartLock
			.catch(() => undefined)
			.then(() => {
				this.engine?.stop();
				this.engine = null;
				// keep the shared DB handle open so the idle index view still works
				this.setStatus(SYNC_STATE.IDLE, "stopped — press Force sync to resume");
			});
		return this.restartLock;
	}

	/**
	 * Master on/off switch for the entire sync mechanism.
	 *
	 * OFF is a hard, persisted stop: abort and tear down the running session, then
	 * hold everything down. Because `syncEnabled` gates the single restart choke
	 * point (`doRestart`), auto-start, the idle conflict resolver and every per-file
	 * action, nothing can spin sync back up on its own — the switch is authoritative,
	 * not advisory. The shared local DB handle is deliberately kept open so the index
	 * status view keeps working (local reads only; no network).
	 *
	 * ON is a clean start: persist the flag, then run the normal restart path, which
	 * honours the existing `liveSync` preference (continuous vs. one-shot). Flipping
	 * the switch is serialized through `restartLock`, so it can never race a start.
	 */
	async setSyncEnabled(enabled: boolean): Promise<void> {
		if (this.settings.syncEnabled === enabled) return;
		this.settings.syncEnabled = enabled;
		await this.saveSettings();

		if (enabled) {
			await this.restartSync();
			return;
		}

		// Turning OFF: abort fast, then quiesce on the serialized lock.
		this.engine?.abort();
		this.restartLock = this.restartLock
			.catch(() => undefined)
			.then(() => {
				this.engine?.stop();
				this.engine = null;
				// Keep the shared DB handle OPEN — the idle index view still reads it.
				// No detail: the status card derives the reason from the live state.
				this.setStatus(SYNC_STATE.IDLE);
			});
		await this.restartLock;
	}

	/** Whether the master sync switch is on. */
	isSyncEnabled(): boolean {
		return this.settings.syncEnabled;
	}

	/** Whether a sync session is currently active. */
	isRunning(): boolean {
		return this.engine !== null;
	}

	/**
	 * The single shared local DB handle. Opened lazily and kept OPEN for the whole
	 * plugin lifetime (closed only on unload, destroyed only on wipe). The engine AND
	 * every idle reader use THIS one handle, so we never open a second PouchDB with
	 * the same name and then close it out from under a pending transaction — which was
	 * the root cause of "Failed to execute 'transaction' on 'IDBDatabase': The database
	 * connection is closing." Concurrent reads on one handle are safe; it was the
	 * per-call open/close pairs racing across the 3s and 5s timers that broke.
	 */
	private getSharedDb(): SyncDatabase {
		if (!this.db) this.db = new SyncDatabase(this.settings, localDbName(this.settings));
		return this.db;
	}

	/**
	 * Passphrase health for the settings UI, read synchronously from the most recent
	 * cache scan (getDecryptStats, kept fresh by the status panel). "empty" = none set;
	 * "mismatch" = the local cache holds encrypted docs and every one failed to decrypt
	 * (a wrong passphrase); "ok" = they decrypt, or there is nothing yet to contradict
	 * it (a fresh, empty cache can't prove the passphrase wrong).
	 */
	passphraseStatus(): "empty" | "mismatch" | "ok" {
		if (!this.settings.passphrase) return "empty";
		const { seen, failed } = this.getSharedDb().getDecryptStats();
		return seen > 0 && failed === seen ? "mismatch" : "ok";
	}

	/**
	 * Index/drift report for the settings view. Works even when sync is idle: if no
	 * session is running, it reads the local DB directly so the user always sees the
	 * full picture (counts, percentage, file tree — including hidden files).
	 */
	async getIndexReport(): Promise<IndexReport | null> {
		// One shared in-flight promise for every caller (see reportInFlight). On top
		// of the single always-open DB handle from getSharedDb, this guarantees there
		// is never a second PouchDB opened/closed on the same name — no IDBDatabase
		// race — and no duplicated hidden-file walk.
		if (this.reportInFlight) return this.reportInFlight;
		const p = this.computeIndexReport();
		this.reportInFlight = p;
		try {
			return await p;
		} finally {
			if (this.reportInFlight === p) this.reportInFlight = null;
		}
	}

	/** Build a fresh index report. Always go through getIndexReport (de-duped). */
	private async computeIndexReport(): Promise<IndexReport | null> {
		// The true server state (throttled, NON-blocking). Returns the last known scan
		// immediately and refreshes in the background — the local report must never wait
		// on a network round-trip, so an unreachable server just leaves the Server column
		// blank until the next refresh, instead of stalling the whole panel.
		// Every file doc is decrypted to build this report, so without a usable
		// passphrase there is nothing to report — only a scan that fails on every
		// document. Bail out and let the status card explain the real reason (locked
		// credentials, or no passphrase set yet) instead.
		if (!this.secretsUnlocked) return null;
		if (this.settings.e2eeEnabled && !this.settings.passphrase) return null;
		const remote = this.getRemoteScan();
		if (this.engine) return this.engine.getIndexReport(remote);
		if (!this.settings.serverUrl) return null; // not configured yet
		// Don't expose cached doc paths/names to the user until they have proven
		// they own the configured remote — otherwise typing random text into the
		// URL field is enough to inspect anything the local cache happens to hold.
		if (!this.settings.connectionVerified) return null;
		const db = this.getSharedDb();
		const stored = await db.getLocalDoc<{ fp?: string }>(ORIGIN_FP_DOC).catch(() => null);
		if (stored && stored.fp) {
			const current = await originFingerprint(this.settings);
			if (stored.fp !== current) return null; // mismatch -> hide
		}
		return buildIndexReport(this.app, this.settings, db, undefined, remote);
	}

	/**
	 * The last known scan of the true server state — returned SYNCHRONOUSLY and never
	 * blocking on the network. When the cached scan is stale (or missing) a fresh scan
	 * is kicked off in the background; its result is picked up by the next 3 s refresh.
	 * This keeps the local report instant: an unreachable server leaves the Server
	 * column blank for one refresh instead of stalling the whole panel.
	 *
	 * Returns undefined (and touches no network) unless the master switch is on with a
	 * URL and verified credentials — the kill switch means "no network", and unverified
	 * creds must not be probed automatically. scanRemote() reuses the engine's live
	 * remote handle when present, so this never reconnects (and never kills) a running
	 * live-sync feed.
	 */
	private getRemoteScan(): RemoteScan | undefined {
		if (!this.settings.syncEnabled || !this.settings.serverUrl || !this.settings.connectionVerified) {
			return undefined;
		}
		// Locked credentials mean the password in `settings` is empty. Probing on a
		// timer with that is a stream of failed logins, which is exactly what gets a
		// throttling server to lock the account — so touch no network until unlocked.
		if (!this.secretsUnlocked) return undefined;
		const now = Date.now();
		const fresh = this.remoteScan && now - this.remoteScan.at < REMOTE_SCAN_TTL_MS;
		if (!fresh && !this.remoteScanInFlight) {
			// Refresh in the background; do NOT await it here.
			this.remoteScanInFlight = this.getSharedDb()
				.scanRemote()
				.then((scan) => {
					this.remoteScan = { at: Date.now(), scan };
					return scan;
				})
				.catch((e) => {
					console.warn("[couchdb-sync] remote scan failed", e);
					return this.remoteScan?.scan; // keep the last good scan
				})
				.finally(() => {
					this.remoteScanInFlight = null;
				});
		}
		return this.remoteScan?.scan; // last known state, possibly undefined on first run
	}

	/** UI helper: state of the origin fingerprint for the current settings. */
	getOriginState(): Promise<"match" | "mismatch" | "unset"> {
		return this.checkOriginFingerprint();
	}

	/** Files currently being transferred with chunk progress (for live highlighting). */
	getActiveTransfers(): { path: string; done: number; total: number }[] {
		return this.engine?.getActiveTransfers() ?? [];
	}

	/**
	 * Ensure a sync session is running, starting one if needed, and return the engine.
	 * All mutating per-file actions go through the engine (single code path for
	 * chunking/encryption/IO), so they require a live session.
	 */
	private async ensureEngine(): Promise<SyncEngine> {
		// Respect the master switch: per-file sync actions must not silently power the
		// engine back on while sync is turned off.
		if (!this.settings.syncEnabled) {
			throw new Error("Sync is turned off. Switch it on to run this action.");
		}
		// If the OS closed the local IndexedDB while backgrounded, the current engine is
		// bound to a dead handle. Reopen it and rebuild the engine so per-file/bulk
		// actions (e.g. "Upload all") run on a live connection instead of throwing
		// "the database connection is closing."
		const reopened = await this.getSharedDb().ensureOpen();
		if (reopened || !this.engine) await this.restartSync();
		if (!this.engine) throw new Error("Sync is not configured. Set up the connection first.");
		return this.engine;
	}

	/** Force (re)sync a single file. Starts a session first if none is running. */
	async forceSyncPath(path: string): Promise<void> {
		const engine = await this.ensureEngine();
		await engine.forceSync(path);
	}

	/** Overwrite this device's copy with the database version. */
	async takeRemotePath(path: string): Promise<void> {
		const engine = await this.ensureEngine();
		await engine.takeRemote(path);
	}

	/** Compare timestamps and take whichever version is newer. */
	async useNewestPath(path: string): Promise<"local" | "remote"> {
		const engine = await this.ensureEngine();
		return engine.useNewest(path);
	}

	/** Resolve a drifting/conflicting file by the configured strategy (never a blind local upload). */
	async resolveByStrategyPath(path: string): Promise<void> {
		const engine = await this.ensureEngine();
		await engine.resolveByStrategy(path);
	}

	/** Overwrite the database with this device's copy. */
	async takeLocalPath(path: string): Promise<void> {
		const engine = await this.ensureEngine();
		await engine.takeLocal(path);
	}

	/** Delete a file on this device only (the server keeps its copy). */
	async deleteLocalPath(path: string): Promise<void> {
		const engine = await this.ensureEngine();
		await engine.deleteLocalOnly(path);
	}

	/** Delete a file everywhere (propagating tombstone + local removal). */
	async deleteEverywherePath(path: string): Promise<void> {
		const engine = await this.ensureEngine();
		await engine.deleteEverywhere(path);
	}

	/**
	 * Run a READ-ONLY engine operation. Uses the live engine when one is running;
	 * otherwise spins up a transient, NON-started engine bound to a transient DB so
	 * that merely viewing history never kicks off a full live sync. The transient DB
	 * connects to the remote so chunk reads can fall back to the server.
	 */
	private async withReader<T>(fn: (engine: SyncEngine) => Promise<T>): Promise<T> {
		if (this.engine) return fn(this.engine);
		if (!this.settings.serverUrl) throw new Error("Sync is not configured.");
		// Reuse the shared, always-open handle (never close it here — idle timers may
		// be reading it concurrently). Connect the remote so chunk reads can fall back
		// to the server for content not yet in the local replica.
		const db = this.getSharedDb();
		try {
			db.connectRemote();
		} catch {
			/* offline reads still work from the local replica */
		}
		const reader = new SyncEngine(this.app, db, this.settings, () => undefined, () => undefined);
		return fn(reader);
	}

	/**
	 * Resolve all outstanding conflicts by the configured strategy — even when no
	 * sync session is running. When a session is live it already auto-resolves, so
	 * this only does work in the idle case, via a transient engine on the shared
	 * handle. Returns how many conflicts were resolved.
	 */
	async resolveConflictsIdle(): Promise<number> {
		if (!this.settings.syncEnabled) return 0; // master switch off -> no network work
		if (this.engine) return 0; // a live session resolves conflicts on its own
		if (!this.settings.serverUrl) return 0;
		if (this.settings.e2eeEnabled && !this.settings.passphrase) return 0; // can't read chunks
		const db = this.getSharedDb();
		try {
			db.connectRemote(); // allow chunk reads to fall back to the server
		} catch {
			/* offline: resolve from the local replica only */
		}
		const reader = new SyncEngine(this.app, db, this.settings, () => undefined, () => undefined);
		try {
			return await reader.resolveConflictsStandalone();
		} finally {
			reader.stop(); // cancel its debounced timers; never close the shared handle
		}
	}

	// --- file history ---------------------------------------------------------

	/** All versions of a file, newest first. */
	getFileHistory(path: string): Promise<VersionDoc[]> {
		return this.withReader((e) => e.listHistory(path));
	}

	/** Decoded text of a version (null for binary / deletion entries). */
	getVersionText(v: VersionDoc): Promise<string | null> {
		return this.withReader((e) => e.getVersionText(v));
	}

	/** Current on-disk text of a file (null if missing or binary). */
	getLocalText(path: string): Promise<string | null> {
		return this.withReader((e) => e.getLocalText(path));
	}

	/** Current text of the DATABASE copy of a file (null if missing or binary). */
	getRemoteText(path: string): Promise<string | null> {
		return this.withReader((e) => e.getRemoteText(path));
	}

	/**
	 * Apply a reconciled text from the side-by-side merge editor: overwrite the local
	 * file and upload it so the database matches, leaving the file fully in sync.
	 * Requires a live session (single mutating code path), so it honours the master
	 * switch via ensureEngine.
	 */
	async applyMergedTextPath(path: string, text: string): Promise<void> {
		const engine = await this.ensureEngine();
		await engine.applyMergedText(path, text);
	}

	/** Restore an earlier version as the current content everywhere (mutating). */
	async restoreVersion(path: string, v: VersionDoc): Promise<void> {
		const engine = await this.ensureEngine();
		await engine.restoreVersion(path, v);
	}

	/** Remove a file/folder from the DB index (works even when idle). */
	async removeFromIndex(target: string, folder: boolean): Promise<number> {
		if (this.engine) return this.engine.removeFromIndex(target, folder);
		if (!this.settings.serverUrl) return 0;
		return removeFromDb(this.getSharedDb(), target, folder);
	}

	async loadSettings(): Promise<void> {
		// Read the RAW persisted data first: we need the ORIGINAL schemaVersion to
		// decide whether to migrate. (Object.assign with DEFAULT_SETTINGS would
		// otherwise backfill schemaVersion to current and make every old config look
		// already-migrated.)
		const loaded = ((await this.loadData()) ?? null) as
			| (Partial<CouchDBSyncSettings> & Record<string, unknown>)
			| null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
		let dirty = false;

		// One-time settings migration for configs written before CURRENT_SETTINGS_VERSION.
		const priorVersion = loaded?.schemaVersion ?? 0;
		if (!loaded || priorVersion < CURRENT_SETTINGS_VERSION) {
			if (
				migrateSettings(
					this.settings as CouchDBSyncSettings & Record<string, unknown>,
					priorVersion,
					this.app.vault.configDir
				)
			) {
				dirty = true;
			}
			this.settings.schemaVersion = CURRENT_SETTINGS_VERSION;
			dirty = true;
		}

		if (!this.settings.deviceId) {
			this.settings.deviceId = generateDeviceId();
			dirty = true;
		}
		// Vault-isolated local PouchDB name (see LOCAL_DB_PREFIX comment). The id is
		// random so two vaults can never collide even if they share a name or path.
		if (!this.settings.localDbId) {
			this.settings.localDbId = generateDeviceId();
			dirty = true;
		}

		// Credentials: everything above merged the PERSISTED shape, in which the two
		// secrets are absent (v6+) or plaintext leftovers (pre-v6). Open the sealed blob
		// so the rest of the plugin sees the same live `settings.password` /
		// `settings.passphrase` it always has.
		this.sealedSecrets =
			typeof this.settings.encryptedSecrets === "string" ? this.settings.encryptedSecrets : "";
		await this.openSecrets();
		// A pre-v6 config arrives with plaintext credentials in `loaded`; the save below
		// (dirty is set by the schema bump) is what seals them and drops the plain keys.
		if (dirty) await this.saveSettings();
	}

	/**
	 * Unlock the stored credentials at load time.
	 *
	 * "device" mode succeeds silently — the key is generated on first use, so a fresh
	 * install never prompts. It fails only when the vault (and with it `data.json`) was
	 * copied from another device or its local storage was cleared; then the blob stays
	 * unreadable and we deliberately stay locked rather than guess.
	 *
	 * "ask" mode cannot be resolved here at all: `onload` runs before the workspace is
	 * ready and a modal at that point fights with Obsidian for the screen. It stays
	 * locked until `ensureSecretsUnlocked()` prompts once the layout is up.
	 */
	private async openSecrets(): Promise<void> {
		this.secretKey = null;
		this.secretsUnlocked = false;

		if (this.settings.secretsMode === "ask") {
			// Stays locked either way: with a blob, `ensureSecretsUnlocked` asks for the
			// passphrase that opens it; without one (only reachable via a hand-edited
			// data.json, since switching to this mode always writes a blob) it asks for a
			// fresh passphrase instead. Reporting "unlocked" here would be worse than
			// useless — there would be no key to seal anything typed afterwards with, and
			// the credentials would vanish on the next launch.
			return;
		}

		const key = loadOrCreateDeviceKey(this.deviceStore);
		if (!key) {
			// No device storage means no key we could ever read back — staying locked
			// keeps the credentials off the disk instead of writing them unprotected.
			console.warn("[couchdb-sync] no device key store available; credentials stay locked");
			return;
		}
		this.secretKey = key;
		if (!this.sealedSecrets) {
			// Fresh vault, or a pre-v6 config whose plaintext credentials are already in
			// `settings` — either way there is nothing to open and saving may seal.
			this.secretsUnlocked = true;
			return;
		}
		const opened = await unsealSecrets(this.sealedSecrets, key);
		if (!opened) return; // wrong/absent key: locked, blob preserved
		this.settings.password = opened.password;
		this.settings.passphrase = opened.passphrase;
		this.secretsUnlocked = true;
	}

	/** Are the stored credentials readable on this device right now? */
	secretsAreUnlocked(): boolean {
		return this.secretsUnlocked;
	}

	/** Are there actual credentials behind the seal (as opposed to an empty one)? */
	hasStoredSecrets(): boolean {
		if (!this.sealedSecrets) return false;
		if (!this.secretsUnlocked) return true; // sealed but unreadable — something is in there
		return !!(this.settings.password || this.settings.passphrase);
	}

	/**
	 * Make sure the credentials are readable, prompting once in "ask" mode. Concurrent
	 * callers share the single in-flight prompt so a mobile resume plus a Force sync
	 * cannot stack two modals. Returns false when the vault stays locked.
	 *
	 * A cancelled prompt is remembered: automatic paths (launch, mobile resume
	 * recovery, a queued restart) then stop asking, so dismissing the dialog once does
	 * not turn every background restart into another modal. `force` — the explicit
	 * Unlock button — clears that and asks again.
	 */
	async ensureSecretsUnlocked(force = false): Promise<boolean> {
		if (this.secretsUnlocked) return true;
		if (this.settings.secretsMode !== "ask") return false; // no prompt can fix a bad device key
		if (force) this.unlockPromptDeclined = false;
		else if (this.unlockPromptDeclined) return false;
		if (this.unlockInFlight) return this.unlockInFlight;

		const attempt = async (): Promise<boolean> => {
			// Nothing sealed to open: ask for a passphrase to protect the credentials
			// from here on, so the mode repairs itself instead of dead-ending.
			if (!this.sealedSecrets) {
				const chosen = await askNewSecretsPassphrase(this.app);
				if (!chosen) {
					this.unlockPromptDeclined = true;
					return false;
				}
				this.secretKey = chosen;
				this.secretsUnlocked = true;
				await this.saveSettings();
				return true;
			}
			const entered = await askUnlockPassphrase(this.app);
			if (!entered) {
				this.unlockPromptDeclined = true;
				return false;
			}
			const opened = await unsealSecrets(this.sealedSecrets, entered);
			if (!opened) {
				new Notice("CouchDB Sync: that passphrase does not unlock the stored credentials.");
				return false;
			}
			this.secretKey = entered;
			this.settings.password = opened.password;
			this.settings.passphrase = opened.passphrase;
			this.secretsUnlocked = true;
			// Anything built while locked carries an empty password — throw it away so
			// the first request after unlocking uses the real credentials.
			this.db?.closeRemote();
			return true;
		};

		this.unlockInFlight = attempt();
		try {
			return await this.unlockInFlight;
		} finally {
			this.unlockInFlight = null;
		}
	}

	/**
	 * Give up on an unreadable blob and start over on this device: discard it, take a
	 * fresh key, and leave the credential fields empty and editable again.
	 *
	 * This is the way out of the one state the user cannot otherwise leave — locked in
	 * "ask" mode with the passphrase forgotten, where there is no key to seal newly
	 * typed credentials with, so anything entered would be silently dropped on the next
	 * launch. Nothing on the server is touched; only this device's stored copy of the
	 * credentials goes away, and the user re-enters them.
	 */
	async resetStoredSecrets(): Promise<boolean> {
		if (this.settings.secretsMode === "ask") {
			const chosen = await askNewSecretsPassphrase(this.app);
			if (!chosen) return false;
			this.secretKey = chosen;
		} else {
			const key = loadOrCreateDeviceKey(this.deviceStore);
			if (!key) {
				new Notice("CouchDB Sync: this device cannot store a key for your credentials.");
				return false;
			}
			this.secretKey = key;
		}
		this.settings.password = "";
		this.settings.passphrase = "";
		this.sealedSecrets = "";
		this.secretsUnlocked = true;
		this.unlockPromptDeclined = false;
		await this.saveSettings();
		return true;
	}

	/**
	 * Switch where the credential key comes from. Requires the credentials to be
	 * readable first — re-sealing a blob we cannot open would throw away the password
	 * and the passphrase behind it. Returns false when the change did not happen.
	 */
	async setSecretsMode(mode: SecretsMode): Promise<boolean> {
		if (mode === this.settings.secretsMode) return true;
		if (!(await this.ensureSecretsUnlocked(true))) {
			new Notice("CouchDB Sync: unlock your stored credentials before changing how they are kept.");
			return false;
		}
		if (mode === "ask") {
			const chosen = await askNewSecretsPassphrase(this.app);
			if (!chosen) return false;
			this.secretKey = chosen;
		} else {
			const key = loadOrCreateDeviceKey(this.deviceStore);
			if (!key) {
				new Notice("CouchDB Sync: this device cannot store a key; keeping the current setting.");
				return false;
			}
			this.secretKey = key;
		}
		this.settings.secretsMode = mode;
		this.secretsUnlocked = true;
		// Re-seal immediately under the new key, so the blob on disk and the mode that
		// describes how to open it are never out of step.
		await this.saveSettings();
		return true;
	}

	/**
	 * Does the legacy, vault-shared PouchDB ("couchdb-sync-local", no suffix) still
	 * exist on this machine and hold data? If yes, it is a leftover from before
	 * vault isolation and the user should explicitly wipe it (we cannot tell which
	 * vault its contents belong to). Returns the doc count, or 0 if absent/empty.
	 */
	async legacyLocalDbDocCount(): Promise<number> {
		// Cache the result: the settings tab calls this on every display(), and probing
		// opens a (potentially large) PouchDB just to read its doc count.
		if (this.legacyDocCountCache !== null) return this.legacyDocCountCache;
		// Don't probe our own current DB.
		if (this.settings.localDbId === "" || localDbName(this.settings) === LEGACY_LOCAL_DB_NAME) {
			this.legacyDocCountCache = 0;
			return 0;
		}
		const db = new PouchDB(LEGACY_LOCAL_DB_NAME, { skip_setup: true });
		try {
			const info = await db.info();
			this.legacyDocCountCache = info.doc_count ?? 0;
		} catch {
			this.legacyDocCountCache = 0;
		} finally {
			await db.close().catch(() => undefined);
		}
		return this.legacyDocCountCache;
	}

	/** Permanently destroy the legacy vault-shared local PouchDB. */
	async wipeLegacyLocalDb(): Promise<void> {
		const db = new PouchDB(LEGACY_LOCAL_DB_NAME);
		try {
			await db.destroy();
			this.legacyDocCountCache = 0; // gone now — reflect it without re-probing
		} catch (e) {
			console.warn("[couchdb-sync] could not destroy legacy local DB", e);
		}
	}

	/**
	 * Persist the settings with the credentials sealed (see secrets.ts). The live
	 * `settings.password` / `settings.passphrase` are left untouched — the rest of the
	 * plugin keeps reading them exactly as before; only the copy that goes to
	 * `data.json` has them replaced by the encrypted blob.
	 */
	async saveSettings(): Promise<void> {
		const blob = await this.sealForDisk();
		this.settings.encryptedSecrets = blob; // keep the in-memory view honest
		await this.saveData(toPersisted(this.settings, blob));
	}

	/**
	 * The blob to write — a fresh seal, or the stored one passed through untouched.
	 * `decideSealAction` owns that call (and documents why it matters).
	 */
	private async sealForDisk(): Promise<string> {
		const key = this.secretKey;
		const action = decideSealAction({
			key,
			unlocked: this.secretsUnlocked,
			password: this.settings.password,
			passphrase: this.settings.passphrase,
		});
		if (action === "keep" || !key) return this.sealedSecrets;
		try {
			const blob = await sealSecrets(
				{ password: this.settings.password, passphrase: this.settings.passphrase },
				key
			);
			this.sealedSecrets = blob;
			// Re-entering credentials over an unreadable blob is a legitimate recovery,
			// and it leaves the vault unlocked again.
			this.secretsUnlocked = true;
			return blob;
		} catch (e) {
			console.error("[couchdb-sync] could not seal credentials", e);
			return this.sealedSecrets;
		}
	}
}
