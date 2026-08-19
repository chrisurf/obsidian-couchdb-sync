import { App, Menu, Notice, Setting, ToggleComponent, setIcon } from "obsidian";
import type CouchDBSyncPlugin from "./main";
import { HistoryModal, confirm } from "./history";
import { DiffMergeModal } from "./diffmerge";
import type { IndexReport } from "./engine";
import { SYNC_STATE, SyncStatus } from "./types";

const AUTO_REFRESH_MS = 3_000;

/** How a file relates to this device vs the database (drives the colour coding).
 *   excluded — filtered out by the skip rules (not synced)     (dimmed)
 *   synced   — on this device and in sync                      (green)
 *   remote   — in the database only, not on this device        (grey)
 *   local    — on this device only, not in the database        (amber)
 *   drift    — on both, content differs (auto-reconcilable)    (purple)
 *   conflict — unresolved conflict revisions in the database   (red)
 */
type FileState = "excluded" | "synced" | "remote" | "local" | "drift" | "conflict";

/** Syncable states (everything except the informational "excluded"). */
const SYNCABLE: FileState[] = ["synced", "remote", "local", "drift", "conflict"];

/**
 * Single severity ordering used everywhere: it decides which state a file gets
 * when several apply, the order the lists are shown in, and the colour a folder
 * rolls up to (the most urgent state anywhere inside it). One table = one source
 * of truth, so the summary, the lists, the files and the folders never disagree.
 * "excluded" is the lowest — a folder is only dimmed when it is entirely excluded.
 */
const SEVERITY: Record<FileState, number> = {
	excluded: 0,
	synced: 1,
	remote: 2,
	local: 3,
	drift: 4,
	conflict: 5,
};

/**
 * Icon per sync state for the status card. Only SYNCED gets the check mark — a
 * checkmark on IDLE ("Not syncing") read as "all done" even right after a wipe with
 * every file still unsynced. Idle/offline/paused get their own, honest glyphs.
 */
const STATE_ICON: Record<string, string> = {
	[SYNC_STATE.IDLE]: "circle-slash",
	[SYNC_STATE.CONNECTING]: "plug",
	[SYNC_STATE.SYNCING]: "refresh-cw",
	[SYNC_STATE.SYNCED]: "check",
	[SYNC_STATE.OFFLINE]: "cloud-off",
	[SYNC_STATE.PAUSED]: "pause",
	[SYNC_STATE.ERROR]: "alert-triangle",
};

/**
 * The sync status panel: status card, per-state lists and the file tree, with all
 * per-file and per-folder actions.
 *
 * It lives in its own class because it is shown in two places — embedded at the
 * top of the settings tab, and as the right-sidebar view opened from the status
 * bar. Both mount the same instance type, so there is exactly one implementation
 * of the classification, the rendering and the actions; a change to either can
 * never leave the two views disagreeing.
 *
 * Lifecycle: {@link mount} renders into a host element the panel owns entirely,
 * {@link unmount} stops its timers and invalidates in-flight loads. Multiple
 * panels may be mounted at once (settings open next to the sidebar); they share
 * nothing but the plugin, and index reports are de-duplicated there.
 */
export class IndexPanel {
	private app: App;
	private plugin: CouchDBSyncPlugin;
	/** Host element this panel owns; emptied and rebuilt by {@link remount}. */
	private root?: HTMLElement;
	private statusUnsub?: () => void;
	private autoRefresh?: number;
	private activeTimer?: number;
	private liveStatusEl?: HTMLElement;
	// persistent index-status elements (updated in place to avoid flicker)
	private summaryEl?: HTMLElement;
	private countsEl?: HTMLElement;
	private legendEl?: HTMLElement;
	private driftEl?: HTMLElement;
	private treeEl?: HTMLElement;
	private excludedToggleEl?: HTMLElement;
	private driftSig = "";
	private treeSig = "";
	private openSections = new Set<string>();
	/**
	 * "full" (the right-sidebar panel) shows everything; "compact" (the settings tab)
	 * shows only the high-level status card + store widgets, with a button into the
	 * full panel — so the settings stay short and the details live in one place.
	 */
	private readonly mode: "full" | "compact";
	/**
	 * Section ids whose open/closed default has already been seeded this mount. A store
	 * tree opens by default only the FIRST time it is seen (when it needs attention);
	 * afterwards the user's own toggle (persisted in openSections) wins.
	 */
	private autoSeeded = new Set<string>();
	/**
	 * Bumped whenever the index-status elements are rebuilt (`display()`) or the tab
	 * is hidden. A load that started against an older generation holds references to
	 * elements that are now detached from the document — it must neither write to
	 * them nor stamp `driftSig`/`treeSig`, because a stamped signature would make
	 * every later refresh believe the (empty) view is already up to date. That
	 * combination is exactly what left the status card showing a legend, no file
	 * tree and a permanent "Loading…". See {@link loadIndex}.
	 */
	private renderGen = 0;
	/** Bumped per load; only the newest load of the current generation may render. */
	private loadSeq = 0;
	/** In-flight load, shared by non-forced callers instead of being dropped. */
	private indexLoad: Promise<void> | null = null;
	/**
	 * The last report that was actually rendered. Re-painted immediately when the tab
	 * is rebuilt, so re-opening settings never blanks the counts and the file tree
	 * while a fresh report is still on its way.
	 */
	private lastReport: IndexReport | null = null;

	constructor(plugin: CouchDBSyncPlugin, mode: "full" | "compact" = "full") {
		this.plugin = plugin;
		this.app = plugin.app;
		this.mode = mode;
	}

	/** Render into (and take ownership of) the given host element. */
	mount(root: HTMLElement): void {
		this.root = root;
		this.renderIndexStatus(root);
	}

	/** Stop timers and stand down in-flight loads. Safe to call repeatedly. */
	unmount(): void {
		if (this.driftEl) this.saveOpenState(this.driftEl);
		if (this.treeEl) this.saveOpenState(this.treeEl);
		// Stand down any in-flight load: the elements it targets are going away.
		this.renderGen++;
		this.statusUnsub?.();
		this.statusUnsub = undefined;
		if (this.autoRefresh !== undefined) {
			window.clearInterval(this.autoRefresh);
			this.autoRefresh = undefined;
		}
		if (this.activeTimer !== undefined) {
			window.clearInterval(this.activeTimer);
			this.activeTimer = undefined;
		}
	}

	/**
	 * Force a full refresh. For callers outside the panel whose action changes what
	 * the report may contain (verifying the connection, for instance), so they do
	 * not have to know about render signatures.
	 */
	refresh(): void {
		this.driftSig = "";
		this.treeSig = "";
		void this.loadIndex(true);
	}

	/** Rebuild from scratch — used when an action invalidates the whole view. */
	private remount(): void {
		if (!this.root) return;
		this.unmount();
		this.root.empty();
		this.renderIndexStatus(this.root);
	}

	// --- index status view -------------------------------------------------

	private renderIndexStatus(root: HTMLElement): void {
		// A fresh element set invalidates every load still running against the old one.
		this.renderGen++;
		// A fresh mount re-evaluates each store section's default open/closed state.
		this.autoSeeded.clear();

		// --- status card: live status + summary + legend in one visual block ---
		const card = root.createDiv({ cls: "couchdb-sync-card" });

		this.liveStatusEl = card.createDiv({ cls: "couchdb-sync-livestatus" });
		this.statusUnsub?.();
		this.statusUnsub = this.plugin.onStatusChange((st) => this.renderLiveStatus(st));

		this.summaryEl = card.createDiv({ cls: "couchdb-sync-summary" });
		this.countsEl = card.createDiv({ cls: "couchdb-sync-counts" });
		this.legendEl = card.createDiv({ cls: "couchdb-sync-legend" });

		// --- index content (drift lists + tree + excluded toggle) ---
		const box = root.createDiv({ cls: "couchdb-sync-index" });
		this.driftEl = box.createDiv();
		this.treeEl = box.createDiv();
		this.excludedToggleEl = box.createDiv();
		this.driftSig = "";
		this.treeSig = "";

		// Paint the last known state straight away, so the details (counts, lists,
		// tree) are on screen immediately and the pending report merely refreshes
		// them. Without this, a slow report leaves the whole view empty for as long
		// as it takes — which is what made the transparency disappear.
		if (this.lastReport) this.renderReport(this.lastReport, true);
		else this.summaryEl.setText("Reading index…");

		void this.loadIndex(true);

		if (this.autoRefresh !== undefined) window.clearInterval(this.autoRefresh);
		this.autoRefresh = window.setInterval(() => void this.loadIndex(false), AUTO_REFRESH_MS);

		if (this.activeTimer !== undefined) window.clearInterval(this.activeTimer);
		this.activeTimer = window.setInterval(() => this.highlightActive(), 600);
	}

	/** Highlight rows being worked on and show live chunk progress (done/total · %). */
	private highlightActive(): void {
		const transfers = new Map(
			this.plugin.getActiveTransfers().map((t) => [t.path, t] as const)
		);
		const root = this.driftEl?.parentElement;
		if (!root) return;
		root.querySelectorAll<HTMLElement>("[data-couchdb-path]").forEach((el) => {
			const t = transfers.get(el.dataset.couchdbPath ?? "");
			el.toggleClass("couchdb-sync-active", !!t);
			let prog = el.querySelector<HTMLElement>(".couchdb-sync-prog");
			if (t) {
				if (!prog) prog = el.createSpan({ cls: "couchdb-sync-prog" });
				const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
				prog.setText(`  ${t.done}/${t.total} chunks · ${pct}%`);
			} else if (prog) {
				prog.remove();
			}
		});
	}

	private renderLiveStatus(st: SyncStatus): void {
		const el = this.liveStatusEl;
		if (!el) return;
		el.empty();

		// The master switch wins the display: when sync is off, the state coming from
		// the engine is irrelevant — show a plain "Off" with no spinner.
		const on = this.plugin.isSyncEnabled();
		const syncing = on && st.state === SYNC_STATE.SYNCING;
		const row = el.createDiv({ cls: "couchdb-sync-livestatus-row" });
		row.toggleClass("couchdb-sync-livestatus-off", !on);
		const icon = row.createSpan({ cls: "couchdb-sync-status-icon" });
		// The master switch off -> power icon; otherwise the honest per-state glyph
		// (crucially NOT a check unless we are actually in sync — see STATE_ICON).
		setIcon(icon, !on ? "power-off" : (STATE_ICON[st.state] ?? "circle-slash"));
		icon.toggleClass("couchdb-sync-spin", syncing);

		const labelMap: Record<string, string> = {
			[SYNC_STATE.IDLE]: "Not syncing",
			[SYNC_STATE.CONNECTING]: "Connecting…",
			[SYNC_STATE.SYNCING]: "Syncing…",
			[SYNC_STATE.SYNCED]: "In sync",
			[SYNC_STATE.OFFLINE]: "Offline",
			[SYNC_STATE.PAUSED]: "Paused",
			[SYNC_STATE.ERROR]: "Error",
		};
		row.createSpan({
			text: on ? (labelMap[st.state] ?? st.state) : "Off",
			cls: "couchdb-sync-livestatus-label",
		});

		// Primary action, right next to the state it acts on: start a sync, or stop
		// the running one. Everything a user reaches for in the common case lives in
		// this card — no scrolling down to a separate Actions section.
		this.renderPrimaryAction(row, st, on);

		// Master on/off toggle (right-aligned): the hard kill switch for ALL sync.
		// On -> sync this vault (starts now and on every launch); off -> everything
		// stops immediately and stays stopped across restarts.
		const toggleWrap = row.createDiv({ cls: "couchdb-sync-power" });
		toggleWrap.createSpan({ text: on ? "Sync on" : "Sync off", cls: "couchdb-sync-power-caption" });
		const toggle = new ToggleComponent(toggleWrap);
		toggle.setValue(on); // set before wiring onChange so this does not re-fire it
		toggle.setTooltip(on ? "Turn all synchronization off" : "Turn synchronization on");
		toggle.onChange(async (v) => {
			toggle.setDisabled(true);
			try {
				await this.plugin.setSyncEnabled(v);
				new Notice(v ? "CouchDB Sync: sync turned on." : "CouchDB Sync: sync turned off.");
			} catch (e) {
				new Notice(`CouchDB Sync: ${e instanceof Error ? e.message : String(e)}`);
			} finally {
				// Re-render from the authoritative state (label, icon, toggle position).
				this.renderLiveStatus(this.plugin.status);
			}
		});

		// Always say WHY, not just WHAT. A bare "Not syncing" leaves the user guessing
		// whether something is broken, finished, or simply never started. While work
		// IS happening there is nothing to explain — the figures below animate instead
		// of a second line appearing and disappearing under the state label.
		const reason = this.statusReason(st, on);
		if (reason) {
			el.createEl("p", {
				text: reason,
				cls: st.state === SYNC_STATE.ERROR ? "couchdb-sync-warn" : "couchdb-sync-statusdetail",
			});
		}

		this.markSummaryActivity();
	}

	/**
	 * Mark the summary figures as "work in flight", which makes them animate.
	 *
	 * Activity is shown ON the numbers themselves rather than as an extra status
	 * line: the numbers update live anyway, so a separate "Indexing 60/111…" line
	 * repeated what they already said — with a different denominator, appearing and
	 * disappearing, and taking the rest of the page up and down with it. A class
	 * toggle changes no layout at all.
	 */
	private markSummaryActivity(): void {
		const busy =
			this.plugin.isSyncEnabled() &&
			this.plugin.isRunning() &&
			this.plugin.status.state === SYNC_STATE.SYNCING;
		this.summaryEl?.toggleClass("couchdb-sync-summary-busy", busy);
	}

	/**
	 * Why the plugin is in its current state, in one sentence.
	 *
	 * Derived from the CURRENT state rather than read out of the last status event:
	 * a status detail is a moment in time, but the card can be opened long after
	 * that moment, and "Not syncing" with no explanation is what made the previous
	 * UI feel broken. Anything the plugin knows and the user can act on — not
	 * configured, missing passphrase, nothing running — is stated here explicitly;
	 * `st.detail` is used when it carries something more specific.
	 */
	private statusReason(st: SyncStatus, on: boolean): string {
		if (st.state === SYNC_STATE.ERROR) {
			return st.detail ?? "Something went wrong — see the developer console for details.";
		}
		if (!on) return st.detail ?? "Sync is switched off for this vault.";

		const s = this.plugin.settings;
		// Locked credentials look exactly like "nothing configured" from here, so say
		// what actually happened — the vault was copied here, or its device key is gone.
		if (!this.plugin.secretsAreUnlocked()) {
			return "Your stored credentials are locked on this device — unlock or re-enter them in settings.";
		}
		if (!s.serverUrl || !s.username) {
			return "Not configured yet — fill in the CouchDB connection below.";
		}
		if (s.e2eeEnabled && !s.passphrase) {
			return "Encryption is on, but no passphrase is set.";
		}
		if (!this.plugin.isRunning()) {
			return st.detail ?? "Nothing is running right now — press Force sync to start.";
		}
		return st.detail ?? ""; // running and healthy: the state label says it all
	}

	/**
	 * The status card's single primary action: run a sync now.
	 *
	 * One control, one meaning, in every state — a verb, never a state change. That
	 * separation is the whole point of having two controls here at all:
	 *
	 *   toggle -> WHETHER this vault syncs   (a state; persisted; also the way to stop)
	 *   button -> DO IT NOW                  (an action; one-off; changes nothing)
	 *
	 * It used to turn into "Stop" while a session ran, which made it look like a
	 * second on/off switch competing with the toggle — two controls that both appear
	 * to mean "off". Stopping now belongs to the toggle alone.
	 *
	 * The button stays available while a session is running: there it means "run a
	 * full pass again", which is exactly what is wanted after a wipe, when a file is
	 * stuck, or simply to be sure everything is up before closing the laptop. It is
	 * also the only way to sync at all when live sync is off.
	 */
	private renderPrimaryAction(row: HTMLElement, st: SyncStatus, on: boolean): void {
		if (!on) return; // sync is off: the toggle is the only meaningful action

		const btn = row.createEl("button", { cls: "couchdb-sync-primary-action" });
		setIcon(btn.createSpan({ cls: "couchdb-sync-primary-icon" }), "refresh-cw");
		btn.createSpan({ text: "Force sync" });
		// "Force" says deliberate re-trigger, not overwrite: this runs an ordinary
		// two-way pass, and conflicts are still resolved by the configured strategy.
		// The per-file menu is where overwriting one side actually lives.
		btn.ariaLabel =
			"Run a full sync pass now — uploads local changes and pulls server changes. " +
			"Does not overwrite either side; conflicts still follow your conflict strategy.";

		btn.onclick = async () => {
			btn.disabled = true;
			try {
				await this.plugin.restartSync();
			} catch (e) {
				new Notice(`CouchDB Sync: ${e instanceof Error ? e.message : String(e)}`);
			} finally {
				// Re-render from the authoritative state; the status listener also
				// fires, but this covers the case where the state did not change.
				this.renderLiveStatus(this.plugin.status);
				this.refresh();
			}
		};

		// A sync that is starting up should not invite a second click.
		if (st.state === SYNC_STATE.CONNECTING) btn.disabled = true;
	}

	/**
	 * Refresh the index status.
	 *
	 * Concurrency contract — the whole reason this is not a plain async method:
	 *  - At most one load runs at a time. A non-forced caller (the auto-refresh tick)
	 *    JOINS the running load instead of being dropped on the floor; a forced
	 *    caller supersedes it.
	 *  - Only the newest load of the current render generation may write. Anything
	 *    older returns silently after its await, so a slow report can never write
	 *    into elements that `display()` has meanwhile detached, and can never stamp
	 *    `driftSig`/`treeSig` on behalf of a view it no longer owns.
	 *
	 * Rendering itself is synchronous (see {@link renderReport}), so once a load is
	 * cleared to write, nothing can invalidate it half-way through.
	 */
	private loadIndex(force: boolean): Promise<void> {
		if (this.indexLoad && !force) return this.indexLoad;
		const gen = this.renderGen;
		const seq = ++this.loadSeq;
		const isCurrent = () => gen === this.renderGen && seq === this.loadSeq;
		const run = this.loadIndexInner(force, isCurrent).finally(() => {
			if (this.indexLoad === run) this.indexLoad = null;
		});
		this.indexLoad = run;
		return run;
	}

	/** Fetch a report and hand it to the (synchronous) renderers, if still current. */
	private async loadIndexInner(force: boolean, isCurrent: () => boolean): Promise<void> {
		let report: IndexReport | null;
		try {
			report = await this.plugin.getIndexReport();
		} catch (e) {
			if (!isCurrent()) return;
			const summary = this.summaryEl;
			if (!summary) return;
			summary.className = "couchdb-sync-warn";
			summary.setText(`Could not read index: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		if (!isCurrent()) return;
		if (!report) {
			await this.renderUnavailable(isCurrent);
			return;
		}
		this.renderReport(report, force);
	}

	/**
	 * Render the "no index to show" states: unconfigured, not yet verified, or a
	 * cache that belongs to a different remote. The one asynchronous lookup happens
	 * up front so the DOM work below stays synchronous and race-free.
	 */
	private async renderUnavailable(isCurrent: () => boolean): Promise<void> {
		const s = this.plugin.settings;
		const origin =
			s.serverUrl && s.connectionVerified
				? await this.plugin.getOriginState().catch(() => "unset" as const)
				: ("unset" as const);
		if (!isCurrent()) return;

		const summary = this.summaryEl;
		const counts = this.countsEl;
		const driftBox = this.driftEl;
		const treeBox = this.treeEl;
		if (!summary || !counts || !driftBox || !treeBox) return;

		// There is nothing to show any more — drop the cached report too, so a later
		// rebuild does not re-paint a stale tree for a remote we can no longer read.
		this.lastReport = null;
		summary.className = "";
		driftBox.empty();

		if (!s.serverUrl) {
			summary.setText("Sync is not running. Configure the connection (and passphrase) and restart sync.");
		} else if (!s.connectionVerified) {
			summary.setText(
				"Index status is hidden until the server connection is verified. Press 'Test connection' above — on success the index unlocks."
			);
		} else if (origin === "mismatch") {
			// Verified, but the cache was stamped by a different remote. Tell the user
			// and expose the two recovery actions: wipe (safe default) or re-stamp
			// (adopt the cache for this remote, if they know it is theirs).
			summary.className = "couchdb-sync-warn";
			summary.setText(
				"⚠ Local cache belongs to a different remote (server URL / database / username changed since it was filled). " +
					"Its contents are hidden to avoid showing files from the previous remote."
			);
			const actions = driftBox.createDiv({ cls: "couchdb-sync-drift" });
			const wipeBtn = actions.createEl("button", {
				text: "Wipe local cache",
				cls: "couchdb-sync-rowbtn",
			});
			wipeBtn.onclick = async () => {
				await this.plugin.wipeLocalOnly();
				new Notice("Local cache wiped. Press 'Force sync' to rebuild — it uploads your local files and downloads anything on the server.");
				this.remount();
			};
			const adoptBtn = actions.createEl("button", {
				text: "Adopt cache for this remote",
				cls: "couchdb-sync-rowbtn",
			});
			adoptBtn.onclick = async () => {
				await this.plugin.stampOriginFingerprint();
				new Notice("Cache adopted for the current remote.");
				this.driftSig = "";
				this.treeSig = "";
				await this.loadIndex(true);
			};
		} else {
			summary.setText("Sync is not running. Press 'Force sync' or 'Download only' to start.");
		}

		counts.setText("");
		this.legendEl?.empty();
		treeBox.empty();
		this.excludedToggleEl?.empty();
		this.driftSig = this.treeSig = "";
	}

	/**
	 * Render a report into the current element set. Fully synchronous by design: it
	 * reads every target element from `this` at the top and never awaits, so the
	 * elements cannot be swapped out underneath it and the signatures it stamps
	 * always describe what is really on screen.
	 *
	 * Summary + counts are updated in place every time (cheap, no flicker). The drift
	 * lists and the file tree are only rebuilt when their contents actually change
	 * (or when force=true), so the page doesn't flicker and an expanded tree stays
	 * expanded.
	 */
	private renderReport(report: IndexReport, force: boolean): void {
		const summary = this.summaryEl;
		const counts = this.countsEl;
		const driftBox = this.driftEl;
		const treeBox = this.treeEl;
		if (!summary || !counts || !driftBox || !treeBox) return;

		// The database holds encrypted docs but none decrypted — wrong passphrase.
		// Do NOT render the file lists/tree (every file would look "local only" and
		// tempt an "Upload all" that mints divergent duplicates under the wrong key).
		if (report.passphraseError) {
			this.lastReport = null; // nothing renderable to re-paint on a rebuild
			summary.className = "couchdb-sync-warn";
			summary.setText(
				"⚠ Encryption passphrase does not match this database — its documents cannot be decrypted. " +
					"Fix the passphrase in settings to match the other devices. (Do not upload while this warning shows: it would create duplicate, unreadable copies.)"
			);
			counts.setText("");
			driftBox.empty();
			this.legendEl?.empty();
			treeBox.empty();
			this.excludedToggleEl?.empty();
			this.driftSig = this.treeSig = "";
			return;
		}

		// Renderable from here on — remember it so a tab rebuild can re-paint at once.
		this.lastReport = report;

		// ---- single source of truth: classify every path into exactly one state ----
		// Each path gets the most severe state that applies (see SEVERITY). The same
		// map drives the summary, the widgets, the attention list and the trees — so
		// they can never disagree. "serverOnly" (on the server, not even cached) is
		// classified like "remote": something this device does not yet have.
		const stateByPath = new Map<string, FileState>();
		const setState = (p: string, s: FileState) => {
			const cur = stateByPath.get(p);
			if (cur === undefined || SEVERITY[s] > SEVERITY[cur]) stateByPath.set(p, s);
		};
		for (const p of report.inSync) setState(p, "synced");
		for (const p of report.dbOnly) setState(p, "remote");
		for (const p of report.serverOnly ?? []) setState(p, "remote");
		for (const p of report.localOnly) setState(p, "local");
		for (const p of report.drift) setState(p, "drift");
		for (const p of report.conflicts) setState(p, "conflict");
		if (this.plugin.settings.showExcluded) {
			for (const p of report.excluded) setState(p, "excluded");
		}

		const groups: Record<FileState, string[]> = {
			excluded: [],
			synced: [],
			remote: [],
			local: [],
			drift: [],
			conflict: [],
		};
		for (const [p, s] of stateByPath) groups[s].push(p);
		for (const k of Object.keys(groups) as FileState[]) groups[k].sort((a, b) => a.localeCompare(b));

		// the summary counts only SYNCABLE files; excluded are informational
		const syncTotal = SYNCABLE.reduce((n, s) => n + groups[s].length, 0);
		const pending = syncTotal - groups.synced.length;
		const pct = syncTotal === 0 ? 100 : Math.round((groups.synced.length / syncTotal) * 100);

		summary.className = "couchdb-sync-summary";
		if (pending === 0) {
			summary.addClass("couchdb-sync-summary-ok");
			summary.setText(`${groups.synced.length} / ${syncTotal} files in sync`);
		} else {
			summary.addClass("couchdb-sync-summary-pending");
			summary.setText(`${groups.synced.length} / ${syncTotal} files (${pct}%) · ${pending} pending`);
		}
		// className was just reset above, so re-apply the activity marker.
		this.markSummaryActivity();

		// ---- store cards (This device / Local cache / Server) + the two deltas ----
		this.renderStores(counts, report);

		// ---- status counters as small, actionable widgets ----
		this.renderStatWidgets(groups);

		// Settings shows only the high-level card; the details (attention list + trees)
		// live in the full side panel, so the settings tab stays short and uncluttered.
		if (this.mode === "compact") {
			driftBox.empty();
			treeBox.empty();
			this.excludedToggleEl?.empty();
			this.driftSig = this.treeSig = "";
			return;
		}

		// ---- save open/closed state of all <details> before rebuilding ----
		this.saveOpenState(driftBox);
		this.saveOpenState(treeBox);

		// ---- Needs attention: one collapsible section, capped ----
		const attnSig = JSON.stringify([groups.conflict, groups.drift, groups.local, groups.remote]);
		if (force || attnSig !== this.driftSig) {
			this.driftSig = attnSig;
			driftBox.empty();
			this.renderNeedsAttention(driftBox, groups);
			this.restoreOpenState(driftBox);
		}

		// ---- three stacked, collapsible store trees (Disk / Local cache / Server) ----
		const showExcluded = this.plugin.settings.showExcluded;
		const diskTreePaths = showExcluded
			? [...new Set([...report.diskPaths, ...report.excluded])].sort((a, b) => a.localeCompare(b))
			: report.diskPaths;
		const treeSig = JSON.stringify([
			diskTreePaths,
			report.allDbPaths,
			report.serverPaths ?? null,
			report.serverReachable ?? null,
			report.serverError ?? null,
			[...stateByPath.entries()],
		]);
		if (force || treeSig !== this.treeSig) {
			this.treeSig = treeSig;
			treeBox.empty();
			this.renderStoreTree(treeBox, "store-disk", "Disk (Vault)", "A", diskTreePaths, stateByPath, {});
			const cacheEmptyRebuild =
				report.allDbPaths.length === 0 &&
				(report.diskPaths.length > 0 || (report.serverPaths?.length ?? 0) > 0);
			this.renderStoreTree(treeBox, "store-cache", "Local cache", "B", report.allDbPaths, stateByPath, {
				emptyRebuild: cacheEmptyRebuild,
			});
			this.renderStoreTree(
				treeBox,
				"store-server",
				"Remote server (CouchDB)",
				"C",
				report.serverPaths ?? [],
				stateByPath,
				{ serverReachable: report.serverReachable, serverError: report.serverError }
			);
			this.restoreOpenState(treeBox);
		}

		// --- excluded-files toggle: only visible when excluded files exist ---
		const toggleBox = this.excludedToggleEl;
		if (toggleBox) {
			toggleBox.empty();
			if (report.excluded.length > 0) {
				new Setting(toggleBox)
					.setName(`Show ${report.excluded.length} excluded hidden file(s)`)
					.setDesc(
						`Hidden files (dot-folders like ${this.plugin.app.vault.configDir} or .git) that are ` +
						"skipped by your sync rules. Turn on to reveal them in the Disk tree above so you " +
						"can sync individual files once."
					)
					.addToggle((t) =>
						t.setValue(this.plugin.settings.showExcluded).onChange(async (v) => {
							this.plugin.settings.showExcluded = v;
							await this.plugin.saveSettings();
							// showExcluded is a pure DISPLAY filter over the same report — the
							// database contents did not change. Re-render the cached report
							// instead of calling loadIndex(), which would re-scan and re-decrypt
							// every doc just to hide/show rows.
							this.treeSig = "";
							if (this.lastReport) this.renderReport(this.lastReport, false);
						})
					);
			}
		}
	}

	/** The three store cards (A/B/C) followed by the two directional delta lines. */
	private renderStores(el: HTMLElement, report: IndexReport): void {
		el.empty();
		el.className = "couchdb-sync-counts couchdb-sync-storewrap";
		const grid = el.createDiv({ cls: "couchdb-sync-stores" });
		const mk = (label: string, val: string, sub: string, cls = "") => {
			const c = grid.createDiv({ cls: "couchdb-sync-store" });
			c.createDiv({ cls: "couchdb-sync-store-lab", text: label });
			c.createDiv({ cls: "couchdb-sync-store-val" + (cls ? ` ${cls}` : ""), text: val });
			c.createDiv({ cls: "couchdb-sync-store-sub", text: sub });
		};
		mk("This device", String(report.vaultCount), "files on disk");
		mk("Local cache", String(report.dbCount), "replica on this device");
		if (report.serverReachable === false) {
			mk("Server", "✕ " + this.serverErrShort(report.serverError), "unreachable", "couchdb-sync-store-err");
		} else if (report.serverReachable === true) {
			mk("Server", String(report.serverCount ?? 0), "source of truth", "couchdb-sync-store-ok");
		} else {
			mk("Server", "—", "sync off / not checked");
		}

		// Disk ↔ Cache
		const onlyDisk = report.localOnly.length;
		const onlyCache = report.dbOnly.length;
		if (onlyDisk === 0 && onlyCache === 0) {
			this.renderDelta(el, "Disk ↔ Cache", "good", "Disk and cache are identical.");
		} else {
			const parts: string[] = [];
			if (onlyDisk) parts.push(`${onlyDisk} only on disk (not cached)`);
			if (onlyCache) parts.push(`${onlyCache} only in cache`);
			this.renderDelta(el, "Disk ↔ Cache", "warn", parts.join(" · "));
		}

		// Cache ↔ Server
		if (report.serverReachable === undefined) {
			this.renderDelta(el, "Cache ↔ Server", "neutral", "Not checked (sync is off).");
		} else if (report.serverReachable === false) {
			this.renderDelta(el, "Cache ↔ Server", "err", "Server unreachable — " + this.serverErrLong(report.serverError));
		} else {
			const onlyServer = report.serverOnly?.length ?? 0;
			const notPushed = report.notPushed?.length ?? 0;
			if (onlyServer === 0 && notPushed === 0) {
				this.renderDelta(el, "Cache ↔ Server", "good", "Cache and server are identical.");
			} else {
				const parts: string[] = [];
				if (onlyServer) parts.push(`${onlyServer} only on the server (missing here)`);
				if (notPushed) parts.push(`${notPushed} not pushed to the server yet`);
				this.renderDelta(el, "Cache ↔ Server", "warn", parts.join(" · "));
			}
		}
	}

	private renderDelta(
		el: HTMLElement,
		tag: string,
		cls: "good" | "warn" | "err" | "neutral",
		text: string
	): void {
		const row = el.createDiv({ cls: `couchdb-sync-delta couchdb-sync-delta-${cls}` });
		row.createSpan({ cls: "couchdb-sync-delta-tag", text: tag });
		row.createSpan({ cls: "couchdb-sync-delta-txt", text: text });
	}

	private serverErrShort(e?: "auth" | "notfound" | "network"): string {
		return e === "auth" ? "401" : e === "notfound" ? "404" : "offline";
	}
	private serverErrLong(e?: "auth" | "notfound" | "network"): string {
		return e === "auth"
			? "the login was rejected (401). Check the user name and password."
			: e === "notfound"
				? "the database was not found (404). Check the database name."
				: "could not reach the server (network/transport).";
	}

	/** The five status counters as small, card-styled widgets; each acts on its files. */
	private renderStatWidgets(groups: Record<FileState, string[]>): void {
		const box = this.legendEl;
		if (!box) return;
		box.empty();
		box.className = "couchdb-sync-legend couchdb-sync-statgrid";
		const p = this.plugin;
		const refreshAfter = async () => {
			this.driftSig = "";
			this.treeSig = "";
			await this.loadIndex(true);
		};
		const runEach = (fn: (path: string) => Promise<unknown>) =>
			async (paths: string[]) => { for (const q of paths) await fn(q); };
		type Def = { state: FileState; label: string; tip: string; run: (paths: string[]) => Promise<void> };
		const defs: Def[] = [
			{ state: "synced", label: "synced", tip: "Sync all now", run: runEach((q) => p.forceSyncPath(q)) },
			{ state: "local", label: "local", tip: "Upload all to server", run: runEach((q) => p.takeLocalPath(q)) },
			{ state: "remote", label: "server only", tip: "Download all to this device", run: runEach((q) => p.takeRemotePath(q)) },
			{ state: "drift", label: "differs", tip: "Resolve all", run: runEach((q) => p.resolveByStrategyPath(q)) },
			{ state: "conflict", label: "conflict", tip: "Resolve all conflicts", run: runEach((q) => p.resolveByStrategyPath(q)) },
		];
		for (const d of defs) {
			const count = groups[d.state].length;
			// Keep the legacy "legend-item/label/count/btn" classes so the same DOM
			// contract holds — a stat widget IS the actionable legend entry, restyled.
			const tile = box.createDiv({
				cls: `couchdb-sync-stat couchdb-sync-legend-item couchdb-sync-state-${d.state}` +
					(count === 0 ? " couchdb-sync-stat-zero" : ""),
			});
			tile.createDiv({ cls: "couchdb-sync-stat-n couchdb-sync-legend-count", text: String(count) });
			const l = tile.createDiv({ cls: "couchdb-sync-stat-l" });
			l.createSpan({ cls: `couchdb-sync-swatch couchdb-sync-state-${d.state}` });
			l.createSpan({ cls: "couchdb-sync-legend-label", text: d.label });
			if (count > 0) {
				tile.addClass("couchdb-sync-stat-btn");
				tile.addClass("couchdb-sync-legend-btn");
				tile.ariaLabel = d.tip;
				tile.onclick = async () => {
					tile.addClass("couchdb-sync-legend-busy");
					try {
						await d.run(groups[d.state]);
						new Notice(`CouchDB Sync: ${d.tip} — ${count} file(s).`);
					} catch (e) {
						new Notice(`CouchDB Sync: error — ${e instanceof Error ? e.message : String(e)}`);
					} finally {
						tile.removeClass("couchdb-sync-legend-busy");
						await refreshAfter();
					}
				};
			}
		}
	}

	/** One collapsible "Needs attention" section: every non-synced file, capped. */
	private renderNeedsAttention(box: HTMLElement, groups: Record<FileState, string[]>): void {
		const CAP = 30;
		const order: FileState[] = ["conflict", "drift", "local", "remote"];
		const items: { path: string; state: FileState }[] = [];
		for (const st of order) for (const path of groups[st]) items.push({ path, state: st });

		const det = box.createEl("details", { cls: "couchdb-sync-section couchdb-sync-attention" });
		det.dataset.sectionId = "attention";
		det.open = items.length > 0;
		const sum = det.createEl("summary", { cls: "couchdb-sync-section-header" });
		sum.createSpan({ text: "Needs attention" });
		sum.createSpan({ text: String(items.length), cls: "couchdb-sync-section-count" });
		if (items.length === 0) {
			det.createDiv({ cls: "couchdb-sync-attention-clear", text: "✓ Everything is in sync." });
			return;
		}
		const list = det.createDiv({ cls: "couchdb-sync-attention-list" });
		for (const it of items.slice(0, CAP)) this.renderAttentionRow(list, it.path, it.state);
		if (items.length > CAP) {
			list.createDiv({
				cls: "couchdb-sync-attention-more",
				text: `+ ${items.length - CAP} more — open the trees below to see them all.`,
			});
		}
	}

	private renderAttentionRow(list: HTMLElement, path: string, state: FileState): void {
		const p = this.plugin;
		const refresh = async () => {
			this.driftSig = "";
			this.treeSig = "";
			await this.loadIndex(true);
		};
		const act = async (verb: string, fn: () => Promise<unknown>) => {
			try {
				await fn();
				new Notice(`CouchDB Sync: ${verb}`);
			} catch (e) {
				new Notice(`CouchDB Sync: ${verb} failed — ${e instanceof Error ? e.message : String(e)}`);
			} finally {
				await refresh();
			}
		};
		const stateLabel: Record<string, string> = {
			conflict: "conflict", drift: "differs", local: "local only", remote: "server only",
		};
		const row = list.createDiv({ cls: "couchdb-sync-attention-row" });
		row.dataset.couchdbPath = path;
		row.createSpan({ cls: `couchdb-sync-dot couchdb-sync-state-${state}` }); // pulses while transferring
		row.createSpan({ cls: `couchdb-sync-attention-chip couchdb-sync-state-${state}`, text: stateLabel[state] ?? state });
		row.createSpan({ cls: "couchdb-sync-attention-name", text: path });
		if (state === "drift" || state === "conflict") {
			const diff = row.createEl("button", { text: "Diff", cls: "couchdb-sync-rowbtn" });
			diff.onclick = () => this.openDiff(path);
			const newest = row.createEl("button", { text: "Use newest", cls: "couchdb-sync-rowbtn" });
			newest.onclick = () => void act("resolved to newest", () => p.resolveByStrategyPath(path));
		} else if (state === "local") {
			const up = row.createEl("button", { text: "Upload", cls: "couchdb-sync-rowbtn" });
			up.onclick = () => void act("uploaded", () => p.takeLocalPath(path));
		} else if (state === "remote") {
			const dl = row.createEl("button", { text: "Download", cls: "couchdb-sync-rowbtn" });
			dl.onclick = () => void act("downloaded", () => p.takeRemotePath(path));
		}
		const more = row.createEl("button", { cls: "couchdb-sync-iconbtn" });
		setIcon(more, "more-horizontal");
		more.setAttr("aria-label", "Actions");
		more.onclick = (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			this.openFileMenu(ev, path, state);
		};
	}

	/**
	 * One store as a collapsible tree section. It opens by default the first time it is
	 * seen if it needs a look (unreachable server, an empty cache while disk/server hold
	 * files, or any non-synced file inside); afterwards the user's own toggle wins.
	 */
	private renderStoreTree(
		box: HTMLElement,
		sectionId: string,
		title: string,
		tag: string,
		paths: string[],
		stateByPath: Map<string, FileState>,
		opts: { emptyRebuild?: boolean; serverReachable?: boolean; serverError?: "auth" | "notfound" | "network" }
	): void {
		const unreachable = opts.serverReachable === false;
		const emptyRebuild = !!opts.emptyRebuild;
		const attn = paths.reduce((n, p) => n + ((stateByPath.get(p) ?? "remote") !== "synced" ? 1 : 0), 0);
		const autoOpen = unreachable || emptyRebuild || attn > 0;
		if (!this.autoSeeded.has(sectionId)) {
			this.autoSeeded.add(sectionId);
			if (autoOpen) this.openSections.add(sectionId);
			else this.openSections.delete(sectionId);
		}

		const det = box.createEl("details", { cls: "couchdb-sync-section couchdb-sync-storetree" });
		det.dataset.sectionId = sectionId;
		det.open = autoOpen; // restoreOpenState (run by the caller) applies the persisted choice
		const sum = det.createEl("summary", { cls: "couchdb-sync-section-header" });
		sum.createSpan({ text: title });
		sum.createSpan({ cls: "couchdb-sync-storetree-tag", text: tag });
		let hint = "all in sync";
		let hintCls: "ok" | "attn" | "err" = "ok";
		if (unreachable) {
			hint = `✕ ${this.serverErrShort(opts.serverError)} unreachable`;
			hintCls = "err";
		} else if (emptyRebuild) {
			hint = "empty — Force sync to rebuild";
			hintCls = "attn";
		} else if (attn > 0) {
			hint = `${attn} need attention`;
			hintCls = "attn";
		}
		sum.createSpan({ cls: `couchdb-sync-storetree-hint couchdb-sync-hint-${hintCls}`, text: hint });
		sum.createSpan({ cls: "couchdb-sync-section-count", text: unreachable ? "?" : String(paths.length) });

		const body = det.createDiv({ cls: "couchdb-sync-tree" });
		if (unreachable) {
			body.createDiv({
				cls: "couchdb-sync-tree-empty",
				text: `✕ Unreachable — fix the connection (${this.serverErrShort(opts.serverError)}), then this shows exactly what the server holds.`,
			});
		} else if (paths.length === 0) {
			body.createDiv({
				cls: "couchdb-sync-tree-empty",
				text: emptyRebuild ? "empty — press Force sync to rebuild the cache" : "(empty)",
			});
		} else {
			this.renderTree(body.createDiv(), paths, stateByPath);
		}
	}

	private saveOpenState(root: HTMLElement): void {
		root.querySelectorAll<HTMLDetailsElement>("details[data-section-id]").forEach((det) => {
			if (det.open) this.openSections.add(det.dataset.sectionId!);
			else this.openSections.delete(det.dataset.sectionId!);
		});
	}

	private restoreOpenState(root: HTMLElement): void {
		root.querySelectorAll<HTMLDetailsElement>("details[data-section-id]").forEach((det) => {
			det.open = this.openSections.has(det.dataset.sectionId!);
		});
	}

	/**
	 * Context-aware per-file actions menu — only what makes sense for the state. Shared
	 * by every file row: the store trees AND the "Needs attention" list, so a file's
	 * full action set is one tap away wherever it appears.
	 */
	private openFileMenu(ev: MouseEvent, path: string, state: FileState): void {
		const p = this.plugin;
		const refresh = async () => {
			this.driftSig = "";
			this.treeSig = "";
			await this.loadIndex(true);
		};
		const run = async (verb: string, fn: () => Promise<unknown>) => {
			try {
				await fn();
				new Notice(`CouchDB Sync: ${verb}`);
			} catch (e) {
				new Notice(`CouchDB Sync: ${verb} failed — ${e instanceof Error ? e.message : String(e)}`);
			} finally {
				await refresh();
			}
		};
		const m = new Menu();
		if (state === "drift" || state === "conflict") {
			m.addItem((i) => i.setTitle("Open side-by-side diff…").setIcon("diff").onClick(() => this.openDiff(path)));
			m.addItem((i) => i.setTitle("Use newest version").setIcon("clock").onClick(async () => {
				try {
					const side = await p.useNewestPath(path);
					new Notice(`CouchDB Sync: took ${side} version (newest)`);
				} catch (e) {
					new Notice(`CouchDB Sync: use newest failed — ${e instanceof Error ? e.message : String(e)}`);
				} finally {
					await refresh();
				}
			}));
			m.addItem((i) => i.setTitle("Use server version (overwrite local)").setIcon("download").onClick(() => run("downloaded server version", () => p.takeRemotePath(path))));
			m.addItem((i) => i.setTitle("Use local version (overwrite server)").setIcon("upload").onClick(() => run("uploaded local version", () => p.takeLocalPath(path))));
		} else if (state === "remote") {
			m.addItem((i) => i.setTitle("Download to this device").setIcon("download").onClick(() => run("downloaded", () => p.takeRemotePath(path))));
		} else if (state === "local") {
			m.addItem((i) => i.setTitle("Upload to server").setIcon("upload").onClick(() => run("uploaded", () => p.takeLocalPath(path))));
		}
		m.addItem((i) => i.setTitle(state === "excluded" ? "Sync once" : "Force sync").setIcon("refresh-cw").onClick(() => void run("synced", () => p.forceSyncPath(path))));
		// HistoryModal notifies through a plain `() => void`; the refresh it triggers
		// is a background reload nobody waits on, so ignore the promise explicitly.
		m.addItem((i) => i.setTitle("Show history…").setIcon("history").onClick(() => new HistoryModal(p, path, () => void refresh()).open()));
		m.addSeparator();
		if (state !== "remote") {
			m.addItem((i) => i.setTitle("Delete on this device").setIcon("trash").onClick(() =>
				confirm(this.app, { title: "Delete on this device?", body: `Removes "${path}" from this device only. The server keeps its copy (it may re-download while live sync is on).`, cta: "Delete here", danger: true, onConfirm: () => run("deleted locally", () => p.deleteLocalPath(path)) })));
		}
		if (state === "synced" || state === "remote" || state === "drift" || state === "conflict") {
			m.addItem((i) => i.setTitle("Delete everywhere").setIcon("trash-2").onClick(() =>
				confirm(this.app, { title: "Delete everywhere?", body: `Deletes "${path}" on ALL devices. It stays in history and can be restored.`, cta: "Delete everywhere", danger: true, onConfirm: () => run("deleted everywhere", () => p.deleteEverywherePath(path)) })));
		}
		if (state !== "local") {
			m.addItem((i) => i.setTitle("Remove from database index (keep local)").setIcon("database").onClick(() =>
				confirm(this.app, { title: "Remove from index?", body: `Stops syncing "${path}" and removes it from the database. Every device keeps its local copy; it re-appears if re-indexed.`, cta: "Remove from index", onConfirm: () => run("removed from index", () => p.removeFromIndex(path, false)) })));
		}
		m.showAtMouseEvent(ev);
	}

	/** Open the side-by-side diff/merge editor for a drifting or conflicting file. */
	private openDiff(path: string): void {
		new DiffMergeModal(this.plugin, path, () => {
			this.driftSig = ""; // the resolution changes the lists — force a refresh
			this.treeSig = "";
			void this.loadIndex(true);
		}).open();
	}

	private renderTree(
		container: HTMLElement,
		paths: string[],
		stateByPath: Map<string, FileState>
	): void {
		interface Node {
			folders: Map<string, Node>;
			files: { name: string; path: string }[];
		}
		const make = (): Node => ({ folders: new Map(), files: [] });
		const rootNode = make();
		for (const path of paths) {
			const parts = path.split("/");
			let node = rootNode;
			for (let i = 0; i < parts.length - 1; i++) {
				const name = parts[i];
				if (!node.folders.has(name)) node.folders.set(name, make());
				node = node.folders.get(name)!;
			}
			node.files.push({ name: parts[parts.length - 1], path });
		}

		// A folder rolls up to the MOST URGENT state anywhere inside it (by SEVERITY).
		// So a folder is green only when its whole subtree is in sync, and turns red
		// the moment anything inside conflicts — no expanding needed to spot trouble.
		const folderState = (node: Node): FileState => {
			let worst: FileState = "excluded";
			const visit = (n: Node) => {
				for (const f of n.files) {
					const s = stateByPath.get(f.path) ?? "remote";
					if (SEVERITY[s] > SEVERITY[worst]) worst = s;
				}
				for (const child of n.folders.values()) visit(child);
			};
			visit(node);
			return worst;
		};

		const stateTitle: Record<FileState, string> = {
			synced: "On this device and in sync with the database",
			local: "On this device only — not yet uploaded to the database",
			remote: "In the database only — not downloaded to this device",
			drift: "On both sides but the content differs — will be reconciled by your conflict strategy",
			conflict: "Unresolved conflict revisions in the database — needs attention",
			excluded: "Excluded by the skip rules — not synced (you can still sync it once)",
		};

		// --- shared action helpers ---
		const p = this.plugin;
		const refresh = async () => {
			this.treeSig = "";
			this.driftSig = "";
			await this.loadIndex(true);
		};
		const run = async (verb: string, fn: () => Promise<unknown>) => {
			try {
				await fn();
				new Notice(`CouchDB Sync: ${verb}`);
			} catch (e) {
				new Notice(`CouchDB Sync: ${verb} failed — ${e instanceof Error ? e.message : String(e)}`);
			} finally {
				await refresh();
			}
		};
		const runMany = async (verb: string, list: string[], fn: (q: string) => Promise<unknown>) => {
			let ok = 0;
			for (const q of list) {
				try {
					await fn(q);
					ok++;
				} catch {
					/* keep going; report the tally */
				}
			}
			new Notice(`CouchDB Sync: ${verb} ${ok}/${list.length}`);
			await refresh();
		};

		const iconBtn = (row: HTMLElement, icon: string, label: string, onClick: (ev: MouseEvent) => void) => {
			const b = row.createEl("button", { cls: "couchdb-sync-iconbtn" });
			setIcon(b, icon);
			b.setAttr("aria-label", label);
			b.onclick = (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				onClick(ev);
			};
			return b;
		};

		// folder bulk actions, applied to the descendant files of the relevant state
		const folderMenu = (ev: MouseEvent, folderPath: string) => {
			const prefix = folderPath + "/";
			const under = paths.filter((q) => q === folderPath || q.startsWith(prefix));
			const byState = (states: FileState[]) => under.filter((q) => states.includes(stateByPath.get(q) ?? "remote"));
			const dl = byState(["remote", "drift", "conflict"]);
			const ul = byState(["local", "drift", "conflict"]);
			const m = new Menu();
			const diverged = byState(["drift", "conflict"]);
			if (diverged.length) m.addItem((i) => i.setTitle(`Use newest for ${diverged.length} differing`).setIcon("clock").onClick(() => runMany("used newest", diverged, (q) => p.useNewestPath(q))));
			if (dl.length) m.addItem((i) => i.setTitle(`Download ${dl.length} to this device`).setIcon("download").onClick(() => runMany("downloaded", dl, (q) => p.takeRemotePath(q))));
			if (ul.length) m.addItem((i) => i.setTitle(`Upload ${ul.length} to server`).setIcon("upload").onClick(() => runMany("uploaded", ul, (q) => p.takeLocalPath(q))));
			m.addItem((i) => i.setTitle("Sync all now").setIcon("refresh-cw").onClick(() => runMany("synced", byState(SYNCABLE), (q) => p.forceSyncPath(q))));
			m.addSeparator();
			m.addItem((i) => i.setTitle("Delete folder on this device").setIcon("trash").onClick(() =>
				confirm(this.app, { title: "Delete folder on this device?", body: `Removes ${under.length} file(s) under "${folderPath}" from this device only.`, cta: "Delete here", danger: true, onConfirm: () => runMany("deleted locally", byState(["synced", "local", "drift", "conflict", "excluded"]), (q) => p.deleteLocalPath(q)) })));
			m.addItem((i) => i.setTitle("Delete folder everywhere").setIcon("trash-2").onClick(() =>
				confirm(this.app, { title: "Delete folder everywhere?", body: `Deletes every file under "${folderPath}" on ALL devices. Restorable from history.`, cta: "Delete everywhere", danger: true, onConfirm: () => runMany("deleted everywhere", byState(["synced", "remote", "drift", "conflict"]), (q) => p.deleteEverywherePath(q)) })));
			m.addItem((i) => i.setTitle("Remove folder from index (keep local)").setIcon("database").onClick(() =>
				confirm(this.app, { title: "Remove folder from index?", body: `Stops syncing everything under "${folderPath}". Local files are kept everywhere.`, cta: "Remove from index", onConfirm: () => run("removed folder from index", () => p.removeFromIndex(folderPath, true)) })));
			m.showAtMouseEvent(ev);
		};

		const render = (node: Node, el: HTMLElement, prefix: string) => {
			const folderNames = [...node.folders.keys()].sort((a, b) => a.localeCompare(b));
			for (const name of folderNames) {
				const child = node.folders.get(name)!;
				const folderPath = prefix ? `${prefix}/${name}` : name;
				const fState = folderState(child);
				const det = el.createEl("details");
				det.dataset.sectionId = `folder-${folderPath}`;
				const sum = det.createEl("summary", {
					cls: `couchdb-sync-tree-folder couchdb-sync-state-${fState}`,
				});
				sum.setAttr("aria-label", stateTitle[fState]);
				sum.createSpan({ text: `📁 ${name}` });
				iconBtn(sum, "more-horizontal", "Folder actions", (ev) => folderMenu(ev, folderPath));
				render(child, det.createDiv({ cls: "couchdb-sync-tree-children" }), folderPath);
			}
			for (const file of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
				const fState = stateByPath.get(file.path) ?? "remote";
				const div = el.createDiv({ cls: `couchdb-sync-tree-file couchdb-sync-state-${fState}` });
				div.setAttr("aria-label", stateTitle[fState]);
				div.createSpan({ cls: "couchdb-sync-dot" });
				div.createSpan({ text: `📄 ${file.name}`, cls: "couchdb-sync-tree-fname" });
				iconBtn(div, "more-horizontal", "Actions", (ev) => this.openFileMenu(ev, file.path, fState));
				div.dataset.couchdbPath = file.path;
			}
		};
		render(rootNode, container, "");
	}
}
