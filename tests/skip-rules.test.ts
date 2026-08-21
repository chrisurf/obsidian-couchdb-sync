import { describe, it, expect } from "vitest";
import {
	isPathExcluded,
	needsHiddenScan,
	shouldWalkHiddenDir,
	type SkipRules,
} from "../src/util";
import { defaultExclude } from "../src/types";

/** Baseline for a vault using the default configuration folder. */
const BASELINE = defaultExclude(".obsidian");

/**
 * The hidden-file scan prunes whole subtrees instead of walking everything and
 * discarding the result afterwards. Pruning is only safe if a pruned folder can
 * never contain a path that WOULD have been synced — the invariant asserted here.
 */

const on = (exclude: string[], include: string[] = []): SkipRules => ({
	syncHidden: true,
	syncExclude: exclude,
	syncInclude: include,
});

const off = (include: string[], exclude: string[] = []): SkipRules => ({
	syncHidden: false,
	syncExclude: exclude,
	syncInclude: include,
});

describe("shouldWalkHiddenDir — hidden sync ON (blacklist)", () => {
	const rules = on(BASELINE);

	it("skips folders covered by an exclude pattern", () => {
		expect(shouldWalkHiddenDir(".obsidian", rules)).toBe(false);
		expect(shouldWalkHiddenDir(".git", rules)).toBe(false);
		expect(shouldWalkHiddenDir(".trash", rules)).toBe(false);
	});

	it("skips nested folders inside an excluded subtree", () => {
		expect(shouldWalkHiddenDir(".obsidian/plugins", rules)).toBe(false);
		expect(shouldWalkHiddenDir(".obsidian/plugins/couchdb-sync/node_modules", rules)).toBe(false);
	});

	it("skips a node_modules folder at any depth (mid-path pattern)", () => {
		expect(shouldWalkHiddenDir(".config/node_modules", rules)).toBe(false);
		expect(shouldWalkHiddenDir(".a/b/node_modules", rules)).toBe(false);
	});

	it("still enters hidden folders that are not excluded", () => {
		expect(shouldWalkHiddenDir(".config", rules)).toBe(true);
		expect(shouldWalkHiddenDir(".notes/drafts", rules)).toBe(true);
	});

	it("enters everything when nothing is excluded", () => {
		expect(shouldWalkHiddenDir(".obsidian", on([]))).toBe(true);
	});

	it("accepts a trailing slash identically", () => {
		expect(shouldWalkHiddenDir(".obsidian/", rules)).toBe(shouldWalkHiddenDir(".obsidian", rules));
		expect(shouldWalkHiddenDir(".config/", rules)).toBe(shouldWalkHiddenDir(".config", rules));
	});

	it("descends into an excluded folder that holds an explicitly included path", () => {
		// The override in isPathExcluded is worthless if the walk prunes the folder
		// before the path is ever considered.
		const withException = on(BASELINE, [".obsidian/snippets/"]);
		expect(shouldWalkHiddenDir(".obsidian", withException)).toBe(true);
		expect(shouldWalkHiddenDir(".obsidian/snippets", withException)).toBe(true);
		expect(shouldWalkHiddenDir(".obsidian/plugins", withException)).toBe(false);
	});
});

describe("shouldWalkHiddenDir — hidden sync OFF (whitelist)", () => {
	it("skips everything when nothing is whitelisted", () => {
		expect(shouldWalkHiddenDir(".obsidian", off([]))).toBe(false);
		expect(shouldWalkHiddenDir(".git", off([]))).toBe(false);
	});

	it("descends towards a whitelisted path", () => {
		const rules = off([".obsidian/snippets/"]);
		expect(shouldWalkHiddenDir(".obsidian", rules)).toBe(true);
		expect(shouldWalkHiddenDir(".obsidian/snippets", rules)).toBe(true);
		expect(shouldWalkHiddenDir(".obsidian/snippets/sub", rules)).toBe(true);
	});

	it("does not descend into sibling folders of a whitelisted path", () => {
		const rules = off([".obsidian/snippets/"]);
		expect(shouldWalkHiddenDir(".obsidian/plugins", rules)).toBe(false);
		expect(shouldWalkHiddenDir(".git", rules)).toBe(false);
	});

	it("handles a whitelisted single file", () => {
		const rules = off([".obsidian/app.json"]);
		expect(shouldWalkHiddenDir(".obsidian", rules)).toBe(true);
		expect(shouldWalkHiddenDir(".obsidian/plugins", rules)).toBe(false);
	});
});

describe("needsHiddenScan", () => {
	it("is true whenever hidden sync is on", () => {
		expect(needsHiddenScan(on(BASELINE))).toBe(true);
	});

	it("is true when a HIDDEN path is explicitly included, even with the toggle off", () => {
		// Hidden files reach the engine only through the walk (no vault events fire for
		// them), so gating the walk on the toggle alone made the include list inert.
		expect(needsHiddenScan(off([".obsidian/snippets/"]))).toBe(true);
	});

	it("is false when the toggle is off and only NORMAL paths are re-included", () => {
		// Those arrive through Vault#getFiles() anyway — no reason to pay for the walk.
		expect(needsHiddenScan(off(["Projects/app/node_modules/keep.js"]))).toBe(false);
	});

	it("is false when nothing hidden is in scope at all", () => {
		expect(needsHiddenScan(off([]))).toBe(false);
	});
});

/**
 * R13: one exclude list that applies to EVERY path. Before this, the lists were
 * consulted only inside the hidden branch, so `node_modules/` — shipped in the
 * defaults — matched nothing under `Projects/app/` and a vault holding a Node
 * project had no setting anywhere that could stop it.
 */
describe("isPathExcluded — normal (non-hidden) paths", () => {
	const rules = on(BASELINE); // exclude list applies whatever the toggle says
	const rulesOff = off([], BASELINE);

	it("excludes a node_modules folder nested anywhere in the vault", () => {
		expect(isPathExcluded("Projects/app/node_modules/x.js", rules)).toBe(true);
		expect(isPathExcluded("Projects/app/node_modules/x.js", rulesOff)).toBe(true);
	});

	it("excludes a normal folder named in the list at any depth", () => {
		expect(isPathExcluded("Notes/tmp/scratch.md", rulesOff)).toBe(true);
		expect(isPathExcluded("tmp/scratch.md", rulesOff)).toBe(true);
	});

	it("syncs ordinary notes and attachments", () => {
		expect(isPathExcluded("Notes/note.md", rulesOff)).toBe(false);
		expect(isPathExcluded("Attachments/photo.png", rulesOff)).toBe(false);
		expect(isPathExcluded("node_modules_of_mine/note.md", rulesOff)).toBe(false);
	});

	it("re-includes an excluded normal path when it is listed explicitly", () => {
		const withException = off(["Projects/app/node_modules/patch.js"], BASELINE);
		expect(isPathExcluded("Projects/app/node_modules/patch.js", withException)).toBe(false);
		expect(isPathExcluded("Projects/app/node_modules/other.js", withException)).toBe(true);
	});

	it("syncs everything when the exclude list is empty", () => {
		expect(isPathExcluded("Projects/app/node_modules/x.js", off([], []))).toBe(false);
	});
});

describe("isPathExcluded — hidden paths keep their existing contract", () => {
	it("skips everything hidden when the toggle is off and nothing is included", () => {
		const rules = off([], BASELINE);
		expect(isPathExcluded(".obsidian/app.json", rules)).toBe(true);
		expect(isPathExcluded(".git/HEAD", rules)).toBe(true);
		expect(isPathExcluded(".notes/draft.md", rules)).toBe(true);
		expect(isPathExcluded("Notes/.secret/x.md", rules)).toBe(true);
	});

	it("syncs hidden paths that are not excluded when the toggle is on", () => {
		const rules = on(BASELINE);
		expect(isPathExcluded(".notes/draft.md", rules)).toBe(false);
		expect(isPathExcluded(".obsidian/app.json", rules)).toBe(true); // still excluded
	});

	it("honours the whitelist when the toggle is off", () => {
		const rules = off([".obsidian/snippets/"], BASELINE);
		expect(isPathExcluded(".obsidian/snippets/x.css", rules)).toBe(false);
		expect(isPathExcluded(".obsidian/plugins/x/main.js", rules)).toBe(true);
	});

	it("lets an explicit include beat the exclude list, in either mode", () => {
		// The one thing a blacklist cannot express: "from this excluded area I want
		// exactly one thing".
		for (const rules of [
			on(BASELINE, [".obsidian/snippets/"]),
			off([".obsidian/snippets/"], BASELINE),
		]) {
			expect(isPathExcluded(".obsidian/snippets/x.css", rules)).toBe(false);
			expect(isPathExcluded(".obsidian/app.json", rules)).toBe(true);
		}
	});
});

describe("pruning invariant: a pruned folder holds only skipped paths", () => {
	const dirs = [".obsidian", ".git", ".obsidian/plugins", ".config", ".notes/drafts", ".a/b/node_modules"];
	const children = ["file.md", "deep/nested/file.bin", "x.json"];

	for (const rules of [
		on(BASELINE),
		on([]),
		off([]),
		off([".obsidian/snippets/"]),
		on(BASELINE, [".obsidian/snippets/"]),
	]) {
		for (const dir of dirs) {
			if (shouldWalkHiddenDir(dir, rules)) continue;
			for (const child of children) {
				it(`${dir}/${child} is skipped when the walk prunes ${dir} (syncHidden=${rules.syncHidden})`, () => {
					expect(isPathExcluded(`${dir}/${child}`, rules)).toBe(true);
				});
			}
		}
	}
});
