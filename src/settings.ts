import { App, Notice, PluginSettingTab, Setting, type SettingDefinitionItem, type SettingDefinitionRender } from "obsidian";
import type CouchDBSyncPlugin from "./main";
import { SyncDatabase } from "./database";
import { selfTest } from "./crypto";
import { IndexPanel } from "./indexpanel";
import { confirm } from "./history";

/**
 * The plugin's settings tab: the sync status panel at the top, then the settings
 * themselves. The panel is a shared component (see IndexPanel) — the same one the
 * right-sidebar view mounts — so the two can never drift apart.
 *
 * Built with Obsidian 1.13's declarative settings API (`getSettingDefinitions`)
 * rather than the deprecated imperative `display()`, so the settings are indexed
 * by name/description in Obsidian's global settings search. Rows whose control is
 * more than a plain bind (the credential fields with their live "connection
 * verified" reset, the encryption self-test, the async legacy-cache cleanup, and
 * the custom status panel) use the API's `render` escape hatch, which keeps their
 * exact behaviour while still contributing their name/description to search.
 * Reactive show/hide (passphrase, master toggle, hidden-file lists) is expressed
 * with `visible` predicates and refreshed via `this.update()`.
 */
export class CouchDBSyncSettingTab extends PluginSettingTab {
	plugin: CouchDBSyncPlugin;
	private panel: IndexPanel;
	/** Cached legacy-cache doc count; probed once, then drives the legacy-wipe row. */
	private legacyCount = 0;
	private legacyProbed = false;
	/** User asked to edit the connection section even though it is valid (keeps it open). */
	private editConnection = false;
	/** One-shot: run an index scan on open so the passphrase status is fresh, then re-render. */
	private passProbed = false;

	constructor(app: App, plugin: CouchDBSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		// Settings shows the high-level card only (status + store widgets); the full
		// detail (attention list + the three store trees) lives in the sidebar panel.
		this.panel = new IndexPanel(plugin, "compact");
	}

	hide(): void {
		this.panel.unmount();
		// Re-probe passphrase status on the next open, and start collapsed if valid.
		this.passProbed = false;
		this.editConnection = false;
	}

	/**
	 * Add a show/hide toggle (an eye icon) to a masked text field. The field stays
	 * masked by default; clicking flips its input between `password` and plain `text`
	 * and swaps the icon (eye ⇄ eye-off). `getInput` is read lazily so it resolves the
	 * element the `addText` callback captured. A fresh render always starts masked, so
	 * a revealed value never persists across re-renders.
	 */
	private addRevealButton(setting: Setting, getInput: () => HTMLInputElement | undefined): void {
		let shown = false;
		setting.addExtraButton((b) =>
			b
				.setIcon("eye")
				.setTooltip("Show")
				.onClick(() => {
					const input = getInput();
					if (!input) return;
					shown = !shown;
					input.type = shown ? "text" : "password";
					b.setIcon(shown ? "eye-off" : "eye").setTooltip(shown ? "Hide" : "Show");
				})
		);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.settings;
		// The configuration folder is ".obsidian" by default but can be renamed, so
		// the examples in the hidden-file settings name this vault's actual folder.
		const cfg = this.app.vault.configDir;

		// Probe the legacy shared cache once (async); reveal its cleanup row via
		// update() only if it actually exists.
		if (!this.legacyProbed) {
			this.legacyProbed = true;
			void this.plugin.legacyLocalDbDocCount().then((n) => {
				if (n > 0) {
					this.legacyCount = n;
					this.update();
				}
			});
		}

		// Any change to credentials voids the "connection verified" flag — otherwise
		// flipping the URL would not re-gate the index status view.
		const onCredsChanged = () => this.plugin.invalidateConnection();

		/**
		 * A row that renders imperatively but still contributes to settings search.
		 * `build` mirrors Obsidian's own `addText`/`addToggle` callbacks (`=> any`):
		 * it returns the chainable component/Setting, which we discard — typing it as
		 * `unknown` (not `void`) is what keeps that a plain builder rather than a
		 * "void-returning" slot that no-misused-promises would police.
		 */
		const row = (
			name: string,
			desc: string | undefined,
			build: (setting: Setting) => unknown,
			extra?: Partial<SettingDefinitionRender>
		): SettingDefinitionRender => ({
			name,
			desc,
			...extra,
			render: (setting) => {
				setting.setName(name);
				if (desc) setting.setDesc(desc);
				build(setting);
			},
		});

		// --- connection & encryption validity (drives the collapsible section) ---
		/**
		 * "ask" mode with the vault still locked: there is no key to seal anything with,
		 * so a password typed here could not be persisted. The fields are held shut until
		 * the user either unlocks or starts over, instead of quietly discarding input.
		 * A locked DEVICE-mode vault has a key (a fresh one), so typing works there and
		 * simply replaces the unreadable blob.
		 */
		const credsLocked = () =>
			!this.plugin.secretsAreUnlocked() && this.plugin.settings.secretsMode === "ask";

		const connOk = () => s.connectionVerified;
		const passStatus = () => this.plugin.passphraseStatus(); // "empty" | "mismatch" | "ok"
		const encOk = () => passStatus() === "ok";
		const allOk = () => connOk() && encOk();
		// Collapsed = everything valid and the user is not explicitly editing.
		const collapsed = () => allOk() && !this.editConnection;

		return [
			// --- status panel (custom UI; owns its row entirely) ---
			{
				name: "Sync status",
				searchable: false,
				render: (setting) => {
					const el = setting.settingEl;
					el.empty();
					el.removeClass("setting-item");
					el.addClass("couchdb-sync-panel-host");
					this.panel.unmount();
					this.panel.mount(el);
					// One index scan on first open so the passphrase status (getDecryptStats)
					// is fresh, then re-render once so the connection section collapses/expands
					// on the real state instead of a first-paint guess. Guarded so update()
					// (which re-runs this render) cannot loop.
					if (!this.passProbed) {
						this.passProbed = true;
						void this.plugin
							.getIndexReport()
							.then(() => this.update())
							.catch(() => undefined);
					}
					return () => this.panel.unmount();
				},
			},

			// --- collapsed summary: shown only when connection + encryption are valid ---
			{
				name: "Connection & encryption",
				searchable: false,
				visible: () => collapsed(),
				render: (setting) => {
					setting.settingEl.addClass("couchdb-sync-conn-ok");
					setting.setName("Connection & encryption ✓");
					setting.setDesc(
						"Server connection verified and your passphrase decrypts your notes. Everything is set up."
					);
					setting.addButton((b) =>
						b.setButtonText("Edit").onClick(() => {
							this.editConnection = true;
							this.update();
						})
					);
				},
			},

			// --- Connection & encryption (one collapsible section) ---
			// Shown only while something is unset/invalid or the user chose to edit; once the
			// connection is verified AND the passphrase decrypts, it collapses to the green
			// summary row above so it stops taking up space.
			{
				type: "group",
				heading: "Connection & encryption",
				visible: () => !collapsed(),
				items: [
					// Status banner: red problems while invalid, or a "collapse" affordance when
					// everything is valid but the user is editing.
					{
						name: "Connection status",
						searchable: false,
						render: (setting) => {
							setting.settingEl.empty();
							setting.settingEl.addClass("couchdb-sync-conn-bannerhost");
							const problems: string[] = [];
							if (!this.plugin.secretsAreUnlocked()) {
								problems.push(
									this.plugin.settings.secretsMode === "ask"
										? "Your stored credentials are locked — enter their passphrase under “Credential storage”."
										: "Your stored credentials cannot be read on this device (the vault was copied here, or this device's key is gone). Enter them again below."
								);
							}
							if (!connOk()) {
								problems.push(
									"Server connection not verified — fill in the details below and press “Test connection”."
								);
							}
							const ps = passStatus();
							if (ps === "empty") problems.push("Set an encryption passphrase — it is required.");
							else if (ps === "mismatch") {
								problems.push(
									"The encryption passphrase doesn't match the encrypted data on the server."
								);
							}
							const banner = setting.settingEl.createDiv({ cls: "couchdb-sync-conn-banner" });
							if (problems.length === 0) {
								banner.addClass("couchdb-sync-conn-banner-ok");
								banner.createSpan({ text: "✓ Connection verified and encryption passphrase OK." });
								const btn = banner.createEl("button", {
									text: "Collapse ▲",
									cls: "couchdb-sync-rowbtn",
								});
								btn.onclick = () => {
									this.editConnection = false;
									this.update();
								};
							} else {
								banner.addClass("couchdb-sync-conn-banner-err");
								const ul = banner.createEl("ul");
								for (const p of problems) ul.createEl("li", { text: p });
							}
						},
					},
					row("Server URL", "Full URL incl. protocol and port. Must be https for mobile and for encryption in transit.", (setting) =>
						setting.addText((t) =>
							t
								.setPlaceholder("https://couch.example.com:6984")
								.setValue(s.serverUrl)
								.onChange(async (v) => {
									s.serverUrl = v.trim();
									await this.plugin.saveSettings();
									await onCredsChanged();
								})
						)
					),
					row("Database name", undefined, (setting) =>
						setting.addText((t) =>
							t.setValue(s.dbName).onChange(async (v) => {
								s.dbName = v.trim();
								await this.plugin.saveSettings();
								await onCredsChanged();
							})
						)
					),
					row("Username", undefined, (setting) =>
						setting.addText((t) =>
							t.setValue(s.username).onChange(async (v) => {
								s.username = v.trim();
								await this.plugin.saveSettings();
								await onCredsChanged();
							})
						)
					),
					row("Password", undefined, (setting) => {
						let input: HTMLInputElement | undefined;
						setting.addText((t) => {
							input = t.inputEl;
							t.inputEl.type = "password"; // masked by default
							t.setDisabled(credsLocked());
							t.setValue(s.password).onChange(async (v) => {
								s.password = v;
								await this.plugin.saveSettings();
								await onCredsChanged();
							});
						});
						this.addRevealButton(setting, () => input);
					}),
					row(
						"Test connection",
						"Check the server URL, database and credentials. On success this unlocks the Index status view; if the passphrase also checks out, this section collapses.",
						(setting) =>
							setting.addButton((b) =>
								// Locked credentials would make this probe the server with an empty
								// password and report a bogus "wrong login".
								b.setDisabled(credsLocked()).setButtonText("Test").onClick(async () => {
									const db = new SyncDatabase(s, "couchdb-sync-test-probe");
									const res = await db.testConnection();
									new Notice(res.message, res.ok ? 4000 : 8000);
									// The probe only needs the remote; destroy the throwaway local
									// replica instead of leaving an empty PouchDB behind.
									await db.destroyLocal().catch(() => undefined);
									if (res.ok) {
										await this.plugin.markConnectionVerified();
										this.panel.refresh(); // the index view is unlocked now
										// A successful test ends "editing"; if the passphrase is also
										// good the section now collapses on the next render.
										this.editConnection = false;
										await this.plugin.getIndexReport().catch(() => undefined);
										this.update();
									}
								})
							)
					),
					// Encryption is mandatory — there is deliberately no on/off toggle. The
					// passphrase lives here so connection + encryption are one setup step.
					row(
						"Encryption passphrase",
						"Your notes are always end-to-end encrypted (AES-256-GCM). Use the same passphrase on every device — it's the only key to your notes, never leaves your device, and can't be recovered if you lose it.",
						(setting) => {
							let input: HTMLInputElement | undefined;
							setting.addText((t) => {
								input = t.inputEl;
								t.inputEl.type = "password"; // masked by default
								t.setDisabled(credsLocked());
								t.setValue(s.passphrase).onChange(async (v) => {
									s.passphrase = v;
									await this.plugin.saveSettings();
								});
							});
							this.addRevealButton(setting, () => input);
							setting.addButton((b) =>
								b.setDisabled(credsLocked()).setButtonText("Verify").onClick(async () => {
									if (!s.passphrase) {
										new Notice("Passphrase is empty.");
										return;
									}
									const ok = await selfTest(s.passphrase).catch(() => false);
									if (!ok) {
										new Notice("Encryption self-test failed.");
										return;
									}
									// Re-scan the local cache with the current passphrase so its
									// decrypt status is fresh, then reflect it and re-render (which
									// collapses the section when the connection is also verified).
									await this.plugin.getIndexReport().catch(() => undefined);
									const ps = passStatus();
									new Notice(
										ps === "mismatch"
											? "This passphrase does not match the encrypted data on the server."
											: "Encryption passphrase OK ✓"
									);
									this.update();
								})
							);
						}
					),
				],
			},

			// --- Credential storage ---
			// Your password and passphrase are never written to data.json in the clear;
			// this section only decides where the key that protects them comes from.
			{
				type: "group",
				heading: "Credential storage",
				items: [
					row(
						"Where credentials are kept",
						"Your CouchDB password and encryption passphrase are stored encrypted inside this vault — " +
							"never in plain text. Choose what unlocks them: a key kept on this device only (no prompt, " +
							"and a copied vault arrives without usable credentials), or a passphrase you type once per launch.",
						(setting) =>
							setting.addDropdown((d) =>
								d
									.addOption("device", "This device (no prompt)")
									.addOption("ask", "Ask a passphrase at every launch")
									.setValue(s.secretsMode)
									.onChange(async (v) => {
										// setSecretsMode re-seals under the new key and saves; on
										// cancel/failure nothing changed, and the re-render puts the
										// dropdown back where it was.
										await this.plugin.setSecretsMode(v as typeof s.secretsMode);
										this.update();
									})
							)
					),
					row(
						"Unlock credentials",
						"Enter the passphrase that protects the stored credentials to start syncing on this device.",
						(setting) =>
							setting.addButton((b) =>
								b
									.setCta()
									.setButtonText("Unlock")
									.onClick(async () => {
										if (await this.plugin.ensureSecretsUnlocked(true)) {
											new Notice("Credentials unlocked.");
											await this.plugin.restartSync();
										}
										this.update();
									})
							),
						{
							visible: () =>
								!this.plugin.secretsAreUnlocked() && this.plugin.settings.secretsMode === "ask",
						}
					),
					row(
						"Re-enter credentials",
						"Forgot the passphrase, or moved this vault from another device? Discard the stored " +
							"credentials on THIS device and type them in again. Your notes and the server are not touched.",
						(setting) =>
							setting.addButton((b) =>
								b
									.setDestructive()
									.setButtonText("Start over")
									.onClick(() => {
										confirm(this.app, {
											title: "Discard the stored credentials?",
											body:
												"This device forgets the saved server password and encryption passphrase " +
												"so you can enter them again. Nothing on the server changes — but if you " +
												"do not know your encryption passphrase, the notes already on the server " +
												"cannot be read without it.",
											cta: "Start over",
											danger: true,
											onConfirm: async () => {
												if (await this.plugin.resetStoredSecrets()) {
													this.editConnection = true; // reveal the (now empty) fields
													new Notice("Stored credentials cleared — please enter them again.");
												}
												this.update();
											},
										});
									})
							),
						{ visible: () => !this.plugin.secretsAreUnlocked() }
					),
					{
						name: "Credential storage status",
						searchable: false,
						render: (setting) => {
							setting.settingEl.empty();
							setting.settingEl.addClass("setting-item-description");
							const unlocked = this.plugin.secretsAreUnlocked();
							const stored = this.plugin.hasStoredSecrets();
							setting.settingEl.setText(
								!unlocked
									? "Locked — the stored credentials cannot be read on this device."
									: stored
										? "Unlocked — credentials are stored encrypted; data.json holds no readable password."
										: "No credentials stored yet."
							);
						},
					},
				],
			},

			// --- Conflict handling ---
			{
				type: "group",
				heading: "Conflict handling",
				items: [
					row("Conflict strategy", "How conflicts are resolved automatically — no pop-ups, ever.", (setting) =>
						setting.addDropdown((d) =>
							d
								.addOption("newest", "Newest version wins")
								.addOption("master", "Master device wins")
								.setValue(s.conflictStrategy)
								.onChange(async (v) => {
									s.conflictStrategy = v as typeof s.conflictStrategy;
									await this.plugin.saveSettings();
									this.update(); // show/hide the master-device row
								})
						)
					),
					row(
						"This device is the master",
						"On conflict, this device's version always wins. Set this on exactly one (e.g. your desktop).",
						(setting) =>
							setting.addToggle((t) =>
								t.setValue(s.isMaster).onChange(async (v) => {
									s.isMaster = v;
									await this.plugin.saveSettings();
								})
							),
						{ visible: () => this.plugin.settings.conflictStrategy === "master" }
					),
				],
			},

			// --- Sync ---
			// NOTE: there is deliberately no "start automatically" toggle. The master
			// switch in the status card is the single source of truth: on means this
			// vault syncs (including on launch). See CouchDBSyncSettings.syncEnabled.
			{
				type: "group",
				heading: "Sync",
				items: [
					// Live sync (real-time, both directions) is always on — there is no toggle
					// to turn it off. Use the master Sync switch to stop syncing entirely.
					row(
						"Sync hidden files",
						`Hidden files are things like ${cfg} (your settings & plugins) and .git. ` +
							"Normal notes & attachments are always synced. (Our own plugin's data.json is never synced.)",
						(setting) =>
							setting.addToggle((t) =>
								t.setValue(s.syncHidden).onChange(async (v) => {
									s.syncHidden = v;
									await this.plugin.saveSettings();
									this.update(); // swap between the exclude / include list
								})
							)
					),
					// ON: blacklist — everything hidden syncs except these
					row(
						"…except these",
						"One path per line. These hidden files/folders are NOT synced. Everything else hidden is.",
						(setting) =>
							setting.addTextArea((t) => {
								t.setValue(s.hiddenExclude.join("\n")).onChange(async (v) => {
									s.hiddenExclude = v.split("\n").map((x) => x.trim()).filter((x) => x.length > 0);
									await this.plugin.saveSettings();
								});
								t.inputEl.rows = 8;
							}),
						{ visible: () => this.plugin.settings.syncHidden }
					),
					// OFF: whitelist — nothing hidden syncs except these
					row(
						"…but still sync these",
						"One path per line. Hidden files are skipped — list any you DO want synced " +
							`(e.g. ${cfg}/snippets/). Leave empty to skip all hidden files.`,
						(setting) =>
							setting.addTextArea((t) => {
								t.setValue(s.hiddenInclude.join("\n")).onChange(async (v) => {
									s.hiddenInclude = v.split("\n").map((x) => x.trim()).filter((x) => x.length > 0);
									await this.plugin.saveSettings();
								});
								t.inputEl.rows = 4;
							}),
						{ visible: () => !this.plugin.settings.syncHidden }
					),
				],
			},

			// --- Actions ---
			// NOTE: "Force sync" is deliberately NOT repeated here — it lives in the
			// status card, next to the state it acts on. Only actions that are not part
			// of the everyday loop remain in this section.
			{
				type: "group",
				heading: "Actions",
				items: [
					row(
						"Download from server",
						"Make the SERVER win on this device: write the server's version of every file to " +
							"disk, overwriting a divergent local copy and fetching anything missing. Nothing " +
							"is uploaded, and local-only files are kept. Any overwritten local edit is saved " +
							"to history first. Useful on a follower device or to force the master's state.",
						(setting) =>
							setting.addButton((b) =>
								b.setButtonText("Download only").onClick(async () => {
									new Notice("Downloading from server…");
									await this.plugin.downloadFromServer();
								})
							)
					),
					row(
						"Upload to server",
						"Make THIS DEVICE win on the server: overwrite the server's version of every file " +
							"with this device's copy, and add any local-only files. Server-only files are kept " +
							"(this does not delete). This changes what every other device sees, so use it when " +
							"this vault is the one you trust — e.g. after a desync.",
						(setting) =>
							setting.addButton((b) =>
								b
									.setDestructive()
									.setButtonText("Upload to server")
									.onClick(() => {
										confirm(this.app, {
											title: "Upload everything to the server?",
											body:
												"This overwrites the server's copy of every file with this device's " +
												"version. Other devices will pick up this state on their next sync. " +
												"Server-only files are kept, not deleted. Continue?",
											cta: "Upload to server",
											danger: true,
											onConfirm: async () => {
												new Notice("Uploading to server…");
												await this.plugin.uploadToServer();
											},
										});
									})
							)
					),
					row(
						"Reset the server from this device",
						"Delete EVERYTHING on the server and replace it with this device's files. Removes " +
							"leftovers no other action can reach — duplicate documents from an older version, " +
							"orphaned data, the entire version history. Drops the whole database if your account " +
							"is allowed to; otherwise it deletes every document instead, which needs no more " +
							"rights than syncing. Use this when the server state is wrong and this vault is the " +
							"copy you trust. " +
							"It is also how you change your encryption passphrase: switch sync off, enter the new " +
							"passphrase above, then reset — every file is re-uploaded under the new key. The new " +
							"passphrase then has to be entered on every other device by hand, followed by " +
							"“Wipe local cache” there.",
						(setting) =>
							setting.addButton((b) =>
								b
									.setDestructive()
									.setButtonText("Reset server")
									.onClick(() => {
										confirm(this.app, {
											title: "Delete everything on the server?",
											body:
												"The database on the server is deleted and rebuilt from this device: " +
												`${this.plugin.settings.dbName} on ${this.plugin.settings.serverUrl}.\n\n` +
												"Gone for good: every file version in the history, and anything that " +
												"exists ONLY on the server (files no longer on this device are not " +
												"restored). Your notes on this device are not touched.\n\n" +
												"Every other device still holds a copy of the old database and will " +
												"push it back when it syncs. On each of them: switch sync off now, " +
												"and run “Wipe local cache” before switching it on again.",
											cta: "Delete and re-upload",
											danger: true,
											onConfirm: async () => {
												new Notice("Emptying the server and re-uploading…");
												await this.plugin.resetServerFromLocal();
												this.update();
											},
										});
									})
							)
					),
					row(
						"Wipe local cache",
						"Delete this device's local copy only — fast, and the server is NOT touched. Afterwards press “Force sync” or “Download only” to rebuild it.",
						(setting) =>
							setting.addButton((b) =>
								b
									.setDestructive()
									.setButtonText("Wipe local cache")
									.onClick(async () => {
										await this.plugin.wipeLocalOnly();
										new Notice("Local cache wiped. Press “Force sync” or “Download only” to rebuild.");
										this.update();
									})
							)
					),
					// Legacy cleanup: before vault isolation, every vault on the machine
					// shared one global PouchDB. Offer to delete it so old-vault data stops
					// leaking into the index status. Only shown once the probe finds it.
					row(
						"Wipe legacy shared cache",
						"A pre-vault-isolation local cache was found. It is shared across ALL vaults on this machine and may show files from other vaults in the index. Safe to delete — the server is not touched.",
						(setting) => {
							setting.setDesc(
								`A pre-vault-isolation local cache with ${this.legacyCount} document(s) was found. It is shared across ALL vaults on this machine and may show files from other vaults in the index. Safe to delete — the server is not touched.`
							);
							setting.addButton((b) =>
								b
									.setDestructive()
									.setButtonText("Wipe legacy cache")
									.onClick(async () => {
										await this.plugin.wipeLegacyLocalDb();
										this.legacyCount = 0;
										new Notice("Legacy shared cache wiped.");
										this.update();
									})
							);
						},
						{ visible: () => this.legacyCount > 0 }
					),
					{
						name: "Device identifiers",
						searchable: false,
						render: (setting) => {
							setting.settingEl.empty();
							setting.settingEl.addClass("setting-item-description");
							setting.settingEl.setText(
								`Device ID: ${s.deviceId || "(not yet assigned)"}  ·  Local DB id: ${s.localDbId || "(not yet assigned)"}`
							);
						},
					},
				],
			},
		];
	}
}
