import { App, Modal, Notice } from "obsidian";
import type CouchDBSyncPlugin from "./main";
import { VersionDoc } from "./types";
import { diffLines } from "./util";

/**
 * What a confirm dialog needs to know. `body` is the prose; `detail` is an optional
 * render hook for a dialog that has to SHOW something — the "Reset server"
 * pre-flight lists the files the reset would destroy, and a plain string cannot
 * carry a list or a bar chart.
 *
 * The hook exists instead of a second modal class on purpose: two destructive
 * dialogs that look different is a worse outcome than either of them alone.
 */
export interface ConfirmOptions {
	title: string;
	body: string;
	/** extra content rendered under the body, e.g. a delta the user must weigh */
	detail?: (el: HTMLElement) => void;
	cta: string;
	danger?: boolean;
	/**
	 * Focus Cancel rather than leaving focus on the dialog. For a dialog whose
	 * default answer should be "no" — a stray Enter must not delete a server.
	 */
	focusCancel?: boolean;
	onConfirm: () => void | Promise<void>;
}

/** Minimal confirm dialog for irreversible actions. No native pop-ups elsewhere. */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private opts: ConfirmOptions
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("couchdb-sync-confirm");
		contentEl.createEl("h3", { text: this.opts.title });
		if (this.opts.body) {
			contentEl.createEl("p", { text: this.opts.body, cls: "couchdb-sync-confirm-body" });
		}
		this.opts.detail?.(contentEl.createDiv({ cls: "couchdb-sync-confirm-detail" }));
		const row = contentEl.createDiv({ cls: "couchdb-sync-modal-buttons" });
		const cancel = row.createEl("button", { text: "Cancel" });
		cancel.onclick = () => this.close();
		const ok = row.createEl("button", {
			text: this.opts.cta,
			cls: this.opts.danger ? "mod-warning" : "mod-cta",
		});
		ok.onclick = async () => {
			this.close();
			await this.opts.onConfirm();
		};
		if (this.opts.focusCancel) cancel.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export function confirm(app: App, opts: ConfirmOptions): void {
	new ConfirmModal(app, opts).open();
}

const LOCAL = "local"; // sentinel for the working-copy pseudo entry

/**
 * Per-file history viewer: a chronological timeline of every recorded version, a
 * diff between any two of them (side-by-side or inline) and one-click restore.
 */
export class HistoryModal extends Modal {
	private versions: VersionDoc[] = [];
	private localText: string | null = null;
	private localExists = false;
	private mode: "side" | "inline" = "side";
	private aKey = "0"; // older side of the comparison
	private bKey = LOCAL; // newer side (defaults to the working copy)
	private diffEl?: HTMLElement;
	private selA?: HTMLSelectElement;
	private selB?: HTMLSelectElement;
	private textCache = new Map<string, string | null>();

	constructor(
		private plugin: CouchDBSyncPlugin,
		private path: string,
		private onChanged: () => void
	) {
		super(plugin.app);
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass("couchdb-sync-history-modal");
		this.titleEl.setText(`History — ${this.path}`);
		this.contentEl.setText("Loading history…");
		try {
			this.versions = await this.plugin.getFileHistory(this.path);
			this.localText = await this.plugin.getLocalText(this.path);
			this.localExists = this.localText !== null;
		} catch (e) {
			this.contentEl.setText(`Could not load history: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		// sensible default comparison: previous version vs current working copy
		this.bKey = this.localExists ? LOCAL : "0";
		this.aKey = this.versions.length > (this.localExists ? 0 : 1) ? (this.localExists ? "0" : "1") : "0";
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private label(v: VersionDoc): string {
		const when = new Date(v.ts).toLocaleString();
		const dev = v.deviceId ? ` · ${v.deviceId.slice(0, 6)}` : "";
		const kind = v.deleted ? " · deleted" : ` · ${formatSize(v.size)}`;
		return `${when}${kind}${dev}`;
	}

	private async textFor(key: string): Promise<string | null> {
		if (key === LOCAL) return this.localText;
		if (this.textCache.has(key)) return this.textCache.get(key) ?? null;
		const v = this.versions[Number(key)];
		let t: string | null = null;
		try {
			t = v ? await this.plugin.getVersionText(v) : null;
		} catch {
			t = null;
		}
		this.textCache.set(key, t);
		return t;
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		if (this.versions.length === 0 && !this.localExists) {
			contentEl.createEl("p", { text: "No history recorded for this file yet." });
			return;
		}

		// --- comparison controls ---
		const controls = contentEl.createDiv({ cls: "couchdb-sync-history-controls" });
		const opt = (sel: HTMLSelectElement) => {
			if (this.localExists) {
				const o = sel.createEl("option", { text: "Working copy (this device)" });
				o.value = LOCAL;
			}
			this.versions.forEach((v, i) => {
				const o = sel.createEl("option", { text: `${i === 0 ? "★ " : ""}${this.label(v)}` });
				o.value = String(i);
			});
		};
		controls.createSpan({ text: "Compare " });
		this.selA = controls.createEl("select", { cls: "dropdown couchdb-sync-history-sel" });
		opt(this.selA);
		this.selA.value = this.aKey;
		this.selA.onchange = () => {
			this.aKey = this.selA!.value;
			void this.renderDiff();
		};
		controls.createSpan({ text: " with " });
		this.selB = controls.createEl("select", { cls: "dropdown couchdb-sync-history-sel" });
		opt(this.selB);
		this.selB.value = this.bKey;
		this.selB.onchange = () => {
			this.bKey = this.selB!.value;
			void this.renderDiff();
		};
		const modeBtn = controls.createEl("button", { cls: "couchdb-sync-history-mode" });
		const setModeLabel = () =>
			modeBtn.setText(this.mode === "side" ? "Side by side" : "Inline");
		setModeLabel();
		modeBtn.onclick = () => {
			this.mode = this.mode === "side" ? "inline" : "side";
			setModeLabel();
			void this.renderDiff();
		};

		// --- diff pane ---
		this.diffEl = contentEl.createDiv({ cls: "couchdb-sync-diff" });
		void this.renderDiff();

		// --- timeline ---
		const tl = contentEl.createDiv({ cls: "couchdb-sync-timeline" });
		tl.createEl("h4", { text: "Timeline" });
		if (this.versions.length === 0) {
			tl.createEl("p", { text: "No versions recorded yet (only the local working copy exists)." });
		}
		this.versions.forEach((v, i) => {
			const row = tl.createDiv({ cls: "couchdb-sync-timeline-row" });
			const dot = row.createSpan({ cls: "couchdb-sync-timeline-dot" });
			if (v.deleted) dot.addClass("is-deleted");
			const meta = row.createDiv({ cls: "couchdb-sync-timeline-meta" });
			meta.createSpan({ text: this.label(v), cls: "couchdb-sync-timeline-when" });
			if (i === 0) meta.createSpan({ text: " current", cls: "couchdb-sync-badge" });
			if (v.note) meta.createDiv({ text: v.note, cls: "couchdb-sync-timeline-note" });
			const restore = row.createEl("button", {
				text: v.deleted ? "Re-apply deletion" : "Restore",
				cls: "couchdb-sync-rowbtn",
			});
			restore.onclick = () => this.confirmRestore(v);
		});
	}

	private async renderDiff(): Promise<void> {
		const el = this.diffEl;
		if (!el) return;
		el.empty();
		el.setText("Computing diff…");
		const [a, b] = await Promise.all([this.textFor(this.aKey), this.textFor(this.bKey)]);
		el.empty();

		if (a === null || b === null) {
			el.createEl("p", {
				cls: "couchdb-sync-diff-note",
				text:
					"One side is binary or unavailable — no line diff. Use Restore on the timeline to roll back.",
			});
			return;
		}
		if (a === b) {
			el.createEl("p", { cls: "couchdb-sync-diff-note", text: "No differences." });
			return;
		}

		const hunks = diffLines(a, b);
		if (this.mode === "inline") this.renderInline(el, hunks);
		else this.renderSideBySide(el, hunks);
	}

	private renderInline(el: HTMLElement, hunks: ReturnType<typeof diffLines>): void {
		const pre = el.createDiv({ cls: "couchdb-sync-diff-inline" });
		for (const h of hunks) {
			if (h.type === "equal") {
				for (const l of h.lines) pre.createDiv({ text: " " + l, cls: "cdl-eq" });
			} else {
				for (const l of h.local) pre.createDiv({ text: "− " + l, cls: "cdl-del" });
				for (const l of h.remote) pre.createDiv({ text: "+ " + l, cls: "cdl-add" });
			}
		}
	}

	private renderSideBySide(el: HTMLElement, hunks: ReturnType<typeof diffLines>): void {
		const grid = el.createDiv({ cls: "couchdb-sync-diff-side" });
		const left = grid.createDiv({ cls: "cdl-col" });
		const right = grid.createDiv({ cls: "cdl-col" });
		const add = (col: HTMLElement, text: string, cls: string) =>
			col.createDiv({ text: text === "" ? " " : text, cls });
		for (const h of hunks) {
			if (h.type === "equal") {
				for (const l of h.lines) {
					add(left, l, "cdl-eq");
					add(right, l, "cdl-eq");
				}
			} else {
				const n = Math.max(h.local.length, h.remote.length);
				for (let i = 0; i < n; i++) {
					add(left, h.local[i] ?? "", h.local[i] !== undefined ? "cdl-del" : "cdl-pad");
					add(right, h.remote[i] ?? "", h.remote[i] !== undefined ? "cdl-add" : "cdl-pad");
				}
			}
		}
	}

	private confirmRestore(v: VersionDoc): void {
		confirm(this.app, {
			title: v.deleted ? "Re-apply this deletion?" : "Restore this version?",
			body: v.deleted
				? `This will delete "${this.path}" again on every device.`
				: `"${this.path}" will be set back to its ${new Date(v.ts).toLocaleString()} version on every device. The current content is kept in history, so this is reversible.`,
			cta: v.deleted ? "Delete again" : "Restore",
			danger: v.deleted,
			onConfirm: async () => {
				try {
					await this.plugin.restoreVersion(this.path, v);
					new Notice(`CouchDB Sync: ${v.deleted ? "deleted" : "restored"} ${this.path}`);
					this.onChanged();
					this.close();
				} catch (e) {
					new Notice(`Restore failed: ${e instanceof Error ? e.message : String(e)}`);
				}
			},
		});
	}
}

function formatSize(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
