import { App, Modal, Setting } from "obsidian";

/**
 * Asks for the passphrase that protects this vault's stored credentials (the
 * "ask at every launch" credential-storage mode, see `secrets.ts`).
 *
 * Two shapes, one modal:
 * - unlock (`confirmValue: false`): one field, used at launch to reopen the sealed blob.
 * - set (`confirmValue: true`): two fields that must match, used when switching TO
 *   this mode — a typo in a write-only field would lock the user out of their own
 *   credentials on the next launch.
 *
 * Resolves with the entered passphrase, or null if the user cancelled. It never
 * rejects: every caller's response to "no passphrase" is the same (stay locked).
 */
class SecretsPromptModal extends Modal {
	private value = "";
	private confirmed = "";
	private settled = false;

	constructor(
		app: App,
		private opts: {
			title: string;
			body: string;
			cta: string;
			confirmValue: boolean;
			resolve: (v: string | null) => void;
		}
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.opts.title);
		const { contentEl } = this;
		contentEl.createEl("p", { text: this.opts.body });

		const errEl = contentEl.createDiv({ cls: "couchdb-sync-conn-banner-err" });

		const submit = () => {
			if (!this.value) return;
			if (this.opts.confirmValue && this.value !== this.confirmed) {
				errEl.setText("The two passphrases do not match.");
				return;
			}
			this.settle(this.value);
			this.close();
		};

		new Setting(contentEl).setName("Passphrase").addText((t) => {
			t.inputEl.type = "password";
			t.onChange((v) => {
				this.value = v;
				errEl.setText("");
			});
			// Enter submits, so unlocking at launch is one field and one keypress.
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") submit();
			});
			window.setTimeout(() => t.inputEl.focus(), 0);
		});

		if (this.opts.confirmValue) {
			new Setting(contentEl).setName("Repeat passphrase").addText((t) => {
				t.inputEl.type = "password";
				t.onChange((v) => {
					this.confirmed = v;
					errEl.setText("");
				});
				t.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") submit();
				});
			});
		}

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText(this.opts.cta)
					.setCta()
					.onClick(() => submit())
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
		// Closing via Esc / the X never reaches submit(), so the promise settles here.
		this.settle(null);
	}

	private settle(v: string | null): void {
		if (this.settled) return;
		this.settled = true;
		this.opts.resolve(v);
	}
}

/** Ask for the existing passphrase (launch unlock). Resolves null when cancelled. */
export function askUnlockPassphrase(app: App): Promise<string | null> {
	return new Promise((resolve) => {
		new SecretsPromptModal(app, {
			title: "Unlock CouchDB Sync credentials",
			body:
				"Your server password and encryption passphrase are stored encrypted in this vault. " +
				"Enter the passphrase you chose for them to unlock syncing on this device.",
			cta: "Unlock",
			confirmValue: false,
			resolve,
		}).open();
	});
}

/** Ask for a NEW passphrase, typed twice. Resolves null when cancelled. */
export function askNewSecretsPassphrase(app: App): Promise<string | null> {
	return new Promise((resolve) => {
		new SecretsPromptModal(app, {
			title: "Set a passphrase for your credentials",
			body:
				"From now on this passphrase is required once per launch before syncing can start. " +
				"It is never stored anywhere — if you lose it you will have to re-enter your server " +
				"password and your encryption passphrase.",
			cta: "Set passphrase",
			confirmValue: true,
			resolve,
		}).open();
	});
}
