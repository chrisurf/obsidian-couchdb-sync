import { describe, it, expect } from "vitest";
import { comparePaths } from "../src/util";

/**
 * R9 — "Reset server" empties the remote database and re-uploads this device's
 * files. The one thing the user needs before confirming is whether anything exists
 * ONLY on the server, because that is the set the action destroys and no other
 * action can reach.
 *
 * The comparison is pure so this — the decision that costs data when it is wrong —
 * is tested without a database, a network or an Obsidian app.
 */
describe("comparePaths — identical sets", () => {
	it("reports equal, with nothing on either side", () => {
		const d = comparePaths(["a.md", "b/c.md"], ["b/c.md", "a.md"]);
		expect(d.equal).toBe(true);
		expect(d.serverOnly).toEqual([]);
		expect(d.localOnly).toEqual([]);
		expect(d.serverCount).toBe(2);
		expect(d.diskCount).toBe(2);
	});

	it("treats two empty sides as equal — a fresh server destroys nothing", () => {
		const d = comparePaths([], []);
		expect(d.equal).toBe(true);
		expect(d.serverCount).toBe(0);
		expect(d.diskCount).toBe(0);
	});
});

describe("comparePaths — server-only files (the case that costs data)", () => {
	it("names every path the reset would destroy", () => {
		const d = comparePaths(["a.md", "phone/notes.md", "z.md"], ["a.md", "z.md"]);
		expect(d.equal).toBe(false);
		expect(d.serverOnly).toEqual(["phone/notes.md"]);
		expect(d.localOnly).toEqual([]);
		expect(d.serverCount).toBe(3);
		expect(d.diskCount).toBe(2);
	});

	it("is not equal even when the counts happen to match", () => {
		// Same size, different contents — the shape that a count comparison would miss.
		const d = comparePaths(["a.md", "server.md"], ["a.md", "disk.md"]);
		expect(d.equal).toBe(false);
		expect(d.serverOnly).toEqual(["server.md"]);
		expect(d.localOnly).toEqual(["disk.md"]);
		expect(d.serverCount).toBe(d.diskCount);
	});
});

describe("comparePaths — local-only files (a difference, but not a loss)", () => {
	it("separates them from the server-only set", () => {
		const d = comparePaths(["a.md"], ["a.md", "new.md"]);
		expect(d.equal).toBe(false);
		expect(d.serverOnly).toEqual([]); // nothing is lost
		expect(d.localOnly).toEqual(["new.md"]); // re-uploaded by the reset
	});

	it("reports both sets when both are present", () => {
		const d = comparePaths(["shared.md", "s1.md", "s2.md"], ["shared.md", "l1.md"]);
		expect(d.serverOnly).toEqual(["s1.md", "s2.md"]);
		expect(d.localOnly).toEqual(["l1.md"]);
		expect(d.serverCount).toBe(3);
		expect(d.diskCount).toBe(2);
	});

	it("an empty server loses nothing, however full the disk is", () => {
		const d = comparePaths([], ["a.md", "b.md"]);
		expect(d.serverOnly).toEqual([]);
		expect(d.localOnly).toEqual(["a.md", "b.md"]);
		expect(d.equal).toBe(false);
	});
});

describe("comparePaths — shape of the result", () => {
	it("sorts both lists so the dialog reads the same way twice", () => {
		const d = comparePaths(["z.md", "a.md", "m.md"], []);
		expect(d.serverOnly).toEqual(["a.md", "m.md", "z.md"]);
	});

	it("collapses duplicates so the two counts are comparable", () => {
		const d = comparePaths(["a.md", "a.md"], ["a.md"]);
		expect(d.serverCount).toBe(1);
		expect(d.diskCount).toBe(1);
		expect(d.equal).toBe(true);
	});

	it("does not mutate its inputs", () => {
		const server = ["z.md", "a.md"];
		const disk = ["b.md"];
		comparePaths(server, disk);
		expect(server).toEqual(["z.md", "a.md"]);
		expect(disk).toEqual(["b.md"]);
	});
});
