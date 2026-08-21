import { describe, it, expect } from "vitest";
import { migrateSettings } from "../src/migrate";
import { CouchDBSyncSettings, DEFAULT_SETTINGS, defaultExclude } from "../src/types";

/** The usual configuration folder; migrateSettings takes it from Vault#configDir. */
const CONFIG_DIR = ".obsidian";

/** Build a settings object like main.ts does: defaults merged with persisted data. */
function merged(overrides: Record<string, unknown>): CouchDBSyncSettings & Record<string, unknown> {
	return Object.assign({}, DEFAULT_SETTINGS, overrides) as CouchDBSyncSettings & Record<string, unknown>;
}

describe("migrateSettings (v1)", () => {
	it("re-unions the default excludes into a config that dropped .git/.obsidian", () => {
		// Mirrors the real polluted data.json: syncHidden on, .git/ and .obsidian/ missing.
		const s = merged({
			syncHidden: true,
			hiddenExclude: [".trash/", ".DS_Store", "node_modules/", ".obsidian/cache"],
		});
		const changed = migrateSettings(s, 0, CONFIG_DIR);
		expect(changed).toBe(true);
		expect(s.syncExclude).toContain(".git/");
		expect(s.syncExclude).toContain(".obsidian/");
		// user's own extra entries are preserved
		expect(s.syncExclude).toContain(".DS_Store");
		// no duplicates introduced
		expect(new Set(s.syncExclude).size).toBe(s.syncExclude.length);
	});

	it("excludes a RENAMED configuration folder, not the hardcoded .obsidian", () => {
		// A vault whose config folder is not ".obsidian" would otherwise never get it
		// on the baseline, so turning hidden sync on would replicate the whole
		// settings directory. The real name comes from Vault#configDir.
		const s = merged({ syncHidden: true, hiddenExclude: [] });
		expect(migrateSettings(s, 0, "my-config")).toBe(true);
		expect(s.syncExclude).toContain("my-config/");
		expect(s.syncExclude).not.toContain(".obsidian/");
		// folder-independent entries are still applied
		expect(s.syncExclude).toContain(".git/");
	});

	it("strips the dead excludePatterns / ignorePatterns keys", () => {
		const s = merged({
			excludePatterns: [".git/", "node_modules/"],
			ignorePatterns: [".trash/"],
		});
		const changed = migrateSettings(s, 0, CONFIG_DIR);
		expect(changed).toBe(true);
		expect("excludePatterns" in s).toBe(false);
		expect("ignorePatterns" in s).toBe(false);
	});

	it("is a no-op for a config that already has the full default baseline and no dead keys", () => {
		// Already v7-shaped (no legacy key), so nothing to rename either.
		const s = merged({ syncExclude: defaultExclude(CONFIG_DIR) });
		expect(migrateSettings(s, 0, CONFIG_DIR)).toBe(false);
	});

	it("does not run v1 changes when priorVersion is already >= 1 (respects later user edits)", () => {
		// A user who deliberately removed .git/ AFTER migrating must not have it re-added.
		const s = merged({ syncExclude: [".DS_Store"], excludePatterns: ["leftover"] });
		const changed = migrateSettings(s, 7, CONFIG_DIR);
		expect(changed).toBe(false);
		expect(s.syncExclude).toEqual([".DS_Store"]);
		expect("excludePatterns" in s).toBe(true); // gated: not touched at v>=1
	});

	it("is idempotent: a second run after applying v1 changes nothing", () => {
		const s = merged({ hiddenExclude: [".DS_Store"], ignorePatterns: ["x"] });
		migrateSettings(s, 0, CONFIG_DIR);
		const secondChanged = migrateSettings(s, 0, CONFIG_DIR);
		expect(secondChanged).toBe(false);
	});
});

describe("migrateSettings (v2) — autoStart folded into syncEnabled", () => {
	it("switches sync OFF when auto-start was off, preserving the user's intent", () => {
		// The reported state: master switch on, auto-start off (e.g. turned off by the
		// crash guard) — the combination that produced "SYNC ON … Idle". After the
		// merge it must NOT silently start replicating; it becomes a visible "off".
		const s = merged({ syncEnabled: true, autoStart: false });
		const changed = migrateSettings(s, 1, CONFIG_DIR);
		expect(changed).toBe(true);
		expect(s.syncEnabled).toBe(false);
		expect("autoStart" in s).toBe(false);
	});

	it("keeps sync ON when auto-start was on", () => {
		const s = merged({ syncEnabled: true, autoStart: true });
		const changed = migrateSettings(s, 1, CONFIG_DIR);
		expect(changed).toBe(true);
		expect(s.syncEnabled).toBe(true);
		expect("autoStart" in s).toBe(false);
	});

	it("leaves an already-off master switch off", () => {
		const s = merged({ syncEnabled: false, autoStart: true });
		migrateSettings(s, 1, CONFIG_DIR);
		expect(s.syncEnabled).toBe(false);
	});

	it("is a no-op for a config that never had autoStart", () => {
		const s = merged({ syncEnabled: true });
		expect(migrateSettings(s, 1, CONFIG_DIR)).toBe(false);
		expect(s.syncEnabled).toBe(true);
	});

	it("does not re-run for configs already at v2 (respects later user edits)", () => {
		// Someone who switched sync back ON after migrating must keep it on, even if
		// a stale autoStart key is still lying around.
		const s = merged({ syncEnabled: true, autoStart: false });
		expect(migrateSettings(s, 2, CONFIG_DIR)).toBe(false);
		expect(s.syncEnabled).toBe(true);
	});

	it("is idempotent", () => {
		const s = merged({ syncEnabled: true, autoStart: false });
		migrateSettings(s, 0, CONFIG_DIR);
		expect(migrateSettings(s, 0, CONFIG_DIR)).toBe(false);
		expect(s.syncEnabled).toBe(false);
	});

	it("applies both v1 and v2 for a config coming from version 0", () => {
		const s = merged({
			syncHidden: true,
			hiddenExclude: [".DS_Store"],
			autoStart: false,
			excludePatterns: ["dead"],
		});
		expect(migrateSettings(s, 0, CONFIG_DIR)).toBe(true);
		expect(s.syncExclude).toContain(".git/");
		expect("excludePatterns" in s).toBe(false);
		expect(s.syncEnabled).toBe(false);
		expect("autoStart" in s).toBe(false);
	});
});

describe("migrateSettings (v3) — encryption is always on", () => {
	it("forces e2eeEnabled on for a config that had it off", () => {
		const s = merged({ e2eeEnabled: false });
		const changed = migrateSettings(s, 2, CONFIG_DIR);
		expect(changed).toBe(true);
		expect(s.e2eeEnabled).toBe(true);
	});

	it("leaves an already-encrypted config unchanged at v3", () => {
		const s = merged({ e2eeEnabled: true });
		expect(migrateSettings(s, 2, CONFIG_DIR)).toBe(false);
		expect(s.e2eeEnabled).toBe(true);
	});

	it("does not re-enable for configs already at v3 (respects the schema gate)", () => {
		const s = merged({ e2eeEnabled: false });
		expect(migrateSettings(s, 3, CONFIG_DIR)).toBe(false);
		expect(s.e2eeEnabled).toBe(false);
	});
});

describe("migrateSettings (v4) — live sync is always on", () => {
	it("forces liveSync on for a config that used one-shot mode", () => {
		const s = merged({ liveSync: false });
		const changed = migrateSettings(s, 3, CONFIG_DIR);
		expect(changed).toBe(true);
		expect(s.liveSync).toBe(true);
	});

	it("leaves an already-live config unchanged at v4", () => {
		const s = merged({ liveSync: true });
		expect(migrateSettings(s, 3, CONFIG_DIR)).toBe(false);
		expect(s.liveSync).toBe(true);
	});

	it("does not re-enable for configs already at v4 (respects the schema gate)", () => {
		const s = merged({ liveSync: false });
		expect(migrateSettings(s, 4, CONFIG_DIR)).toBe(false);
		expect(s.liveSync).toBe(false);
	});
});

describe("migrateSettings (v7) — the path lists stop being hidden-only", () => {
	it("carries a pre-v7 config's entries over verbatim and drops the old keys", () => {
		// The point of the migration: the SAME entries, now applied to every path.
		// Nothing is added (no re-union of the defaults) and nothing is removed.
		const s = merged({
			hiddenExclude: [".DS_Store", "node_modules/", "tmp/"],
			hiddenInclude: [".obsidian/snippets/"],
		});
		const changed = migrateSettings(s, 6, CONFIG_DIR);
		expect(changed).toBe(true);
		expect(s.syncExclude).toEqual([".DS_Store", "node_modules/", "tmp/"]);
		expect(s.syncInclude).toEqual([".obsidian/snippets/"]);
		expect("hiddenExclude" in s).toBe(false);
		expect("hiddenInclude" in s).toBe(false);
	});

	it("keeps a deliberately emptied list empty instead of restoring the defaults", () => {
		const s = merged({ hiddenExclude: [], hiddenInclude: [] });
		migrateSettings(s, 6, CONFIG_DIR);
		expect(s.syncExclude).toEqual([]);
		expect(s.syncInclude).toEqual([]);
	});

	it("ignores a corrupted list rather than carrying garbage into the skip rules", () => {
		const s = merged({ hiddenExclude: "node_modules/", hiddenInclude: [1, ".x/"] });
		migrateSettings(s, 6, CONFIG_DIR);
		expect(s.syncExclude).toEqual([]);
		expect(s.syncInclude).toEqual([".x/"]);
	});

	it("does not touch an already-v7 config", () => {
		const s = merged({ syncExclude: [".DS_Store"], syncInclude: [] });
		expect(migrateSettings(s, 7, CONFIG_DIR)).toBe(false);
		expect(s.syncExclude).toEqual([".DS_Store"]);
	});

	it("runs the rename BEFORE v1, so a version-0 config is unioned into the new key", () => {
		const s = merged({ hiddenExclude: [".DS_Store"] });
		expect(migrateSettings(s, 0, CONFIG_DIR)).toBe(true);
		expect("hiddenExclude" in s).toBe(false);
		expect(s.syncExclude).toContain(".DS_Store"); // the user's own entry survives
		expect(s.syncExclude).toContain(".git/"); // and v1's baseline lands in the new key
		expect(s.syncExclude).toContain(`${CONFIG_DIR}/`);
	});
});

describe("migrateSettings (v5) — forget-cache-on-disable removed", () => {
	it("strips the dead forgetCacheOnDisable key", () => {
		const s = merged({ forgetCacheOnDisable: true });
		const changed = migrateSettings(s, 4, CONFIG_DIR);
		expect(changed).toBe(true);
		expect("forgetCacheOnDisable" in s).toBe(false);
	});

	it("is a no-op when the key is already absent", () => {
		const s = merged({});
		delete (s as Record<string, unknown>).forgetCacheOnDisable;
		expect(migrateSettings(s, 4, CONFIG_DIR)).toBe(false);
	});

	it("does not touch the key for configs already at v5", () => {
		const s = merged({ forgetCacheOnDisable: true });
		expect(migrateSettings(s, 5, CONFIG_DIR)).toBe(false);
		expect("forgetCacheOnDisable" in s).toBe(true);
	});
});
