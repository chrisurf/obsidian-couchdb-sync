import { CouchDBSyncSettings, defaultExclude } from "./types";

/**
 * Pure, idempotent settings migration. Mutates the given (already default-merged)
 * settings object in place and returns whether anything changed. The caller gates
 * this by schema version, so it runs once per bump and never clobbers a user's
 * later deliberate edits. Kept free of the Obsidian API so it is unit-testable.
 *
 * v1: (a) re-union the safe default hidden-exclude baseline (`.git/`, the vault's
 * configuration folder, …) so a config that predates a given entry stops syncing a
 * whole git repo / the entire settings folder; (b) strip the dead `excludePatterns`
 * / `ignorePatterns` keys left over from the pre-hidden ignore model.
 *
 * v2: fold the removed `autoStart` flag into `syncEnabled`. The two meant almost
 * the same thing, which is how a config could claim "sync is on" while nothing ever
 * ran. A config that had auto-start OFF keeps that intent — sync is switched off,
 * visibly, rather than silently starting to replicate after an update. Everything
 * else is untouched, so the common case (auto-start on) simply keeps syncing.
 *
 * v3: encryption is now mandatory (the off switch was removed from the UI), so force
 * `e2eeEnabled` on for any config that had it disabled. Encryption was on by default
 * anyway, so this only affects the rare config that deliberately turned it off.
 *
 * v4: live (real-time) sync is now mandatory — its toggle was removed — so force
 * `liveSync` on for any config that had it off (the old "sync only on command" mode).
 *
 * v5: the "forget local cache when plugin is disabled" feature was removed entirely
 * (teardown runs on ordinary app close too, so an always-on wipe would destroy the
 * cache on every quit; the explicit "Wipe local cache" action covers the privacy
 * case). Strip the now-dead `forgetCacheOnDisable` key.
 *
 * v6: the CouchDB password and the E2EE passphrase are no longer stored in the
 * clear. A pre-v6 data.json holds both as plain strings; they are read into the
 * runtime settings by the normal default-merge, and the very next save seals them
 * into `encryptedSecrets` and drops the plaintext keys (see `secrets.ts` and
 * `CouchDBSyncPlugin.saveSettings`). Nothing to rewrite here — this step exists so
 * the version bump is recorded and the save that performs the sealing is triggered.
 * Note for users: this cleans the CURRENT data.json only; older backups of it still
 * contain the plaintext credentials.
 *
 * v7: the two path lists stop being hidden-only. `hiddenExclude` becomes
 * `syncExclude`, checked for EVERY path, and `hiddenInclude` becomes `syncInclude`,
 * the opt-in that overrides it. The entries are carried over verbatim — nothing is
 * added and nothing is dropped — but they now reach further: a config listing `tmp/`
 * stops syncing `Notes/tmp/` as well, and the `node_modules/` line that only ever
 * matched inside a hidden folder finally covers `Projects/app/node_modules/`. That
 * is the point of the change; recording it as a schema bump is what keeps it from
 * happening quietly. Nothing is deleted anywhere: a newly excluded file stops being
 * pushed, stays on every disk, and appears in the tree as *excluded* — removing the
 * line brings it straight back.
 */
/** Pre-v7 names of the two path lists (see the v7 note above). */
const LEGACY_EXCLUDE = "hiddenExclude";
const LEGACY_INCLUDE = "hiddenInclude";

/** A persisted value we only trust once it looks like the list it claims to be. */
function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

export function migrateSettings(
	settings: CouchDBSyncSettings & Record<string, unknown>,
	priorVersion: number,
	configDir: string
): boolean {
	let changed = false;

	// v7, deliberately FIRST although it is the newest step: it renames the two path
	// lists, and the v1 step below edits one of them. Normalizing the names up front
	// means every step after this one sees exactly one spelling — and makes the whole
	// function idempotent, which it would not be if v1 could re-create a key v7 had
	// already renamed away.
	if (priorVersion < 7) {
		// The exclude list applies to every path now, and the include list overrides it
		// — so both outgrew their "hidden" names. The entries are carried across
		// verbatim; only their reach changes.
		for (const [legacy, current] of [
			[LEGACY_EXCLUDE, "syncExclude"],
			[LEGACY_INCLUDE, "syncInclude"],
		] as const) {
			if (legacy in settings) {
				settings[current] = asStringArray(settings[legacy]);
				delete settings[legacy];
				changed = true;
			}
		}
	}

	if (priorVersion < 1) {
		// (a) union the default excludes into whatever the user already has
		const have = new Set(settings.syncExclude ?? []);
		const before = have.size;
		for (const p of defaultExclude(configDir)) have.add(p);
		if (have.size !== before) {
			settings.syncExclude = [...have];
			changed = true;
		}

		// (b) drop dead keys from the pre-hidden ignore model
		for (const deadKey of ["excludePatterns", "ignorePatterns"]) {
			if (deadKey in settings) {
				delete settings[deadKey];
				changed = true;
			}
		}
	}

	if (priorVersion < 2) {
		// Never start replicating on this vault's behalf just because an update
		// removed a flag: an explicit "do not start on launch" becomes an explicit
		// "sync is off", which the status card states plainly and the user can undo
		// with one click.
		if (settings.autoStart === false) {
			settings.syncEnabled = false;
			changed = true;
		}
		if ("autoStart" in settings) {
			delete settings.autoStart;
			changed = true;
		}
	}

	if (priorVersion < 3) {
		// Encryption is mandatory now — there is no UI toggle to turn it off — so any
		// config that had it disabled is forced on. Everything a device syncs from here
		// on is end-to-end encrypted.
		if (settings.e2eeEnabled !== true) {
			settings.e2eeEnabled = true;
			changed = true;
		}
	}

	if (priorVersion < 4) {
		// Live (real-time) sync is mandatory now — the toggle is gone — so any config
		// left in the old one-shot ("sync only on command") mode is switched to live.
		if (settings.liveSync !== true) {
			settings.liveSync = true;
			changed = true;
		}
	}

	if (priorVersion < 5) {
		// The "forget local cache on disable" feature is gone; drop its dead key so it
		// stops lingering in data.json.
		if ("forgetCacheOnDisable" in settings) {
			delete settings.forgetCacheOnDisable;
			changed = true;
		}
	}

	return changed;
}
