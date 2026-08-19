/**
 * "What's new" note shown once after a fresh install or an update.
 *
 * Its purpose is discovery: sync is invisible when it works, so the features
 * that make it inspectable — the status bar controls, the sidebar panel, the
 * per-file state tree — are easy to never find. A fresh install also needs to be
 * told the one thing the plugin cannot do for it: point it at a server. The pure
 * version comparison lives here, apart from the Obsidian modal, so it can be
 * unit-tested without a DOM.
 */

/**
 * Hero image at the top of the modal, the same one the README uses. It is
 * fetched from GitHub rather than bundled, because the asset is far larger than
 * the plugin itself, and the modal hides it when the fetch fails — an offline
 * vault still gets the text.
 *
 * NOTE: this resolves only once `assets/` is on the default branch. Until then
 * the modal renders without the banner, which is the designed fallback.
 */
export const HERO_IMAGE_URL =
	"https://raw.githubusercontent.com/chrisurf/obsidian-cauchdb-sync/main/assets/hero.png";

/**
 * "Buy me a coffee" link and its button image, shown right under the hero.
 * The plugin is free and syncs only to a server the user runs themselves, so
 * this is the one place it asks for optional support. The button image is loaded
 * remotely like the hero; the LINK does not depend on it and falls back to a
 * text button, so the ask never silently disappears.
 */
export const BUY_ME_A_COFFEE_URL = "https://www.buymeacoffee.com/chrisurf";
export const BUY_ME_A_COFFEE_IMAGE_URL =
	"https://raw.githubusercontent.com/chrisurf/obsidian-cauchdb-sync/main/assets/buymeacoffee.png";

/**
 * Markdown rendered inside the modal.
 *
 * Paragraphs are ONE line each on purpose. Obsidian renders a single newline as a
 * line break (it is not CommonMark here), so hard-wrapping this string at 90
 * columns put a ragged break in the middle of every sentence in the modal.
 * It leads with the setup step a fresh
 * install is blocked on, then the newest work — sync driven from the status bar
 * and the panel moved into the sidebar — and closes with what the plugin does,
 * so a first-time reader and someone upgrading from an early version both come
 * away knowing where to click.
 */
export const WHATS_NEW = `## 🌱 Beta — and simpler than ever

CouchDB Sync is now in **beta**: it works well and is genuinely useful for everyday syncing. It's still maturing and behaviour may change between versions, so — as with any sync tool — please keep backups of important vaults. Bug reports and feedback are very welcome. 🙏

**The best part: syncing is now super simple.** Flip it on once and it just runs — every change uploads and downloads automatically in the background, across all your devices. Encryption is always on and live sync is always on, so there are no modes to choose and no buttons to babysit. Once your server and passphrase check out, the setup even tidies itself away so the settings stay clean.

## 🔌 First time here? Connect a server

Your notes sync through a **CouchDB** server that you choose — rented, or running on a machine of your own. Open **Settings → CouchDB Sync**, enter the server URL, database name, username and password, and press **Test connection**.

Then set a **passphrase** and keep it identical on every device. It locks your notes before they leave this device, so the server only ever stores unreadable data — and nobody, including you, can recover your notes without it. Write it down somewhere safe.

## 🔐 Your password no longer sits in a file

Your server password and your encryption passphrase used to be stored as plain text in the plugin's \`data.json\` — inside your vault, and so inside every copy, backup and file-sync of it. They are now kept **encrypted**, unlocked by a key that lives on this device only and never travels with the vault. Nothing to set up: it happens on the next save.

If you copy a vault to another device, it therefore arrives *without* usable credentials — enter them once there, as you would for a new device. Prefer a passphrase over a device key? **Settings → Credential storage** can ask for one at every launch instead.

## 🎛️ Sync from the status bar

The status-bar item at the bottom of Obsidian is now two controls:

- The **icon** switches sync on and off.
- The **label** (\`CouchDB 63%\`) opens the full status panel in the right sidebar.

That panel is the *same* component the settings tab embeds — the same tree, the same per-file actions, not a read-only copy. You can run sync without opening settings at all.

## 🔀 One switch, one action

The controls now say exactly what they do:

- The **switch** decides *whether* this vault syncs. It is a state: it persists, it survives restarts, and turning it off means nothing touches the network.
- **Force sync** just *does it once*. It is an action — it changes no setting.

There is no second "start automatically" preference to contradict the switch, and no button that quietly doubles as a second off switch.

## ✨ Smaller things you will notice

- The status card animates its own figures while work is in flight, instead of showing a second progress counter that disagreed with the first.
- Files being transferred shimmer and show their chunk progress (\`12 / 40 chunks · 30%\`).
- The index status keeps its detail under slow, overlapping refreshes instead of falling back to "Loading…".

## 📸 Everything at a glance

**Status panel** — how many files are in sync (\`X / Y\`, with %), plus a folder tree of every file across this device *and* the server, colour-coded: 🟢 in sync, 🟠 local only, ⚪ remote only, 🟣 differs, 🔴 conflict. Folders roll up to the most urgent state inside them.

**Per-file actions** — every row has a ⋯ menu with only the moves that make sense for its state: download, upload, sync once, delete here, delete everywhere. Folders apply them in bulk.

**History** — the plugin keeps a version log per file. Compare any two versions side by side and restore an older one on every device; restores are themselves reversible.

**Encrypted end to end** — note content *and* metadata (paths, sizes, timestamps) are AES-256-GCM encrypted before upload. The server never sees a filename.

Open it from the label in the status bar, or with the **CouchDB Sync: Open sync status panel** command.`;

/**
 * Whether the note is due for the running version. It is shown whenever the
 * installed version differs from the last one the user has seen, which covers
 * a fresh install (nothing seen yet) and an upgrade, and never repeats for a
 * version already acknowledged.
 */
export function shouldShowWhatsNew(currentVersion: string, lastSeenVersion: string): boolean {
	return currentVersion !== "" && currentVersion !== lastSeenVersion;
}
