// @vitest-environment happy-dom
// The real PouchDB HTTP adapter against a scripted server: requestUrl (the only way
// the plugin talks to the network) is replaced by a fake that records every request
// and answers per scenario. This exercises the whole path — header injection, the
// Access-page substitution, PouchDB's error construction, and the classification.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
type Reply = { status: number; headers?: Record<string, string>; body?: string; bytes?: Uint8Array };
let handler: (url: string, method: string) => Reply = () => ({ status: 500 });
let throwNetwork = false;

vi.mock("obsidian", async (importOriginal) => {
	const orig = await importOriginal<Record<string, unknown>>();
	return {
		...orig,
		requestUrl: async (p: { url: string; method?: string; headers?: Record<string, string> }) => {
			calls.push({ url: p.url, method: p.method ?? "GET", headers: { ...(p.headers ?? {}) } });
			if (throwNetwork) throw new Error("net::ERR_NAME_NOT_RESOLVED");
			const r = handler(p.url, p.method ?? "GET");
			const bytes = r.bytes ?? new TextEncoder().encode(r.body ?? "");
			const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
			return {
				status: r.status,
				headers: r.headers ?? { "content-type": "application/json" },
				arrayBuffer: ab,
				text: new TextDecoder().decode(bytes),
			};
		},
	};
});

import PouchDB from "pouchdb-browser";
import memoryAdapter from "pouchdb-adapter-memory";
import { SyncDatabase } from "../src/database";
import { CF_ACCESS_ID_HEADER, CF_ACCESS_SECRET_HEADER } from "../src/cfaccess";
import { CouchDBSyncSettings, DEFAULT_SETTINGS } from "../src/types";

PouchDB.plugin(memoryAdapter);

const json = (status: number, obj: unknown): Reply => ({
	status,
	headers: { "content-type": "application/json" },
	body: JSON.stringify(obj),
});
const html = (status: number, extra: Record<string, string> = {}): Reply => ({
	status,
	headers: { "content-type": "text/html; charset=UTF-8", ...extra },
	body: "<!DOCTYPE html><html><body>Forbidden</body></html>",
});

/** A minimal CouchDB: db info, empty all_docs, empty changes, no checkpoints. */
function couch(url: string, _method: string): Reply {
	const path = new URL(url).pathname;
	if (/\/notes\/?$/.test(path)) return json(200, { db_name: "notes", doc_count: 3, update_seq: "0" });
	if (path.endsWith("/_all_docs")) return json(200, { total_rows: 0, offset: 0, rows: [] });
	if (path.endsWith("/_changes")) return json(200, { results: [], last_seq: "0" });
	if (path.includes("/_local/")) return json(404, { error: "not_found", reason: "missing" });
	if (path.endsWith("/_bulk_get")) return json(200, { results: [] });
	if (path.endsWith("/_revs_diff")) return json(200, {});
	if (path === "/") return json(200, { couchdb: "Welcome", uuid: "u" });
	return json(404, { error: "not_found", reason: "missing" });
}

let n = 0;
let db: SyncDatabase;
let settings: CouchDBSyncSettings;

function make(over: Partial<CouchDBSyncSettings> = {}): void {
	settings = {
		...DEFAULT_SETTINGS,
		serverUrl: "https://couch.example.com",
		dbName: "notes",
		username: "user",
		password: "pw",
		e2eeEnabled: false,
		...over,
	};
	db = new SyncDatabase(settings, `access-test-${n++}`, { adapter: "memory" });
}

const TOKEN = { cfAccessEnabled: true, cfAccessClientId: "id.access", cfAccessClientSecret: "sec" };

function hasAccessHeaders(h: Record<string, string>): boolean {
	return h[CF_ACCESS_ID_HEADER] === "id.access" && h[CF_ACCESS_SECRET_HEADER] === "sec";
}
function anyAccessHeader(h: Record<string, string>): boolean {
	return Object.keys(h).some((k) => k.toLowerCase().startsWith("cf-access-"));
}

beforeEach(() => {
	calls.length = 0;
	handler = couch;
	throwNetwork = false;
});

afterEach(async () => {
	db.closeRemote();
	await db.destroyLocal().catch(() => undefined);
});

describe("Access off — unchanged behaviour", () => {
	it("testConnection succeeds and sends no Access header", async () => {
		make();
		const res = await db.testConnection();
		expect(res).toMatchObject({ ok: true });
		expect(res.message).toContain('"notes"');
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((c) => !anyAccessHeader(c.headers))).toBe(true);
		// Basic auth still goes out exactly as before
		expect(calls[0].headers.Authorization ?? calls[0].headers.authorization).toMatch(/^Basic /);
	});

	it("token fields filled but switch off → still no Access header", async () => {
		make({ cfAccessClientId: "id.access", cfAccessClientSecret: "sec" });
		await db.scanRemote();
		expect(calls.every((c) => !anyAccessHeader(c.headers))).toBe(true);
	});

	it("401/404 keep their old meaning", async () => {
		make();
		handler = () => json(401, { error: "unauthorized", reason: "Name or password is incorrect." });
		expect(await db.testConnection()).toMatchObject({ ok: false, error: "auth" });
		expect((await db.scanRemote()).error).toBe("auth");
		handler = () => json(404, { error: "not_found", reason: "Database does not exist." });
		db.closeRemote();
		expect(await db.testConnection()).toMatchObject({ ok: false, error: "notfound" });
		expect((await db.scanRemote()).error).toBe("notfound");
	});
});

describe("Access on — headers on every path", () => {
	it("testConnection carries both headers", async () => {
		make(TOKEN);
		expect((await db.testConnection()).ok).toBe(true);
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((c) => hasAccessHeaders(c.headers))).toBe(true);
	});

	it("scanRemote carries both headers", async () => {
		make(TOKEN);
		const scan = await db.scanRemote();
		expect(scan.reachable).toBe(true);
		expect(calls.every((c) => hasAccessHeaders(c.headers))).toBe(true);
	});

	it("replication (pull and push) carries both headers on every request", async () => {
		make(TOKEN);
		const remote = db.connectRemote();
		await db.local.replicate.from(remote);
		const put = await db.local.put({ _id: "f:x", type: "file" } as never);
		handler = (url, method) => {
			const path = new URL(url).pathname;
			if (path.endsWith("/_revs_diff")) return json(200, { "f:x": { missing: [put.rev] } });
			if (path.endsWith("/_bulk_docs")) return json(201, [{ ok: true, id: "f:x", rev: put.rev }]);
			if (path.includes("/_local/") && method === "PUT") return json(201, { ok: true });
			return couch(url, method);
		};
		await db.local.replicate.to(remote);
		expect(calls.some((c) => c.url.includes("_changes"))).toBe(true);
		expect(calls.some((c) => c.url.includes("_bulk_docs"))).toBe(true);
		const missing = calls.filter((c) => !hasAccessHeaders(c.headers)).map((c) => `${c.method} ${c.url}`);
		expect(missing).toEqual([]);
	});

	it("a token edit takes effect on the next request without rebuilding anything else", async () => {
		make(TOKEN);
		await db.scanRemote();
		settings.cfAccessClientSecret = "rotated";
		db.closeRemote(); // what invalidateConnection does
		calls.length = 0;
		await db.scanRemote();
		expect(calls[0].headers[CF_ACCESS_SECRET_HEADER]).toBe("rotated");
	});

	it("binary chunk responses still pass through untouched", async () => {
		make(TOKEN);
		const payload = new Uint8Array([0, 1, 2, 250, 255]);
		handler = (url) => {
			const path = decodeURIComponent(new URL(url).pathname);
			if (path.endsWith("/h:abc")) return json(200, { _id: "h:abc", _rev: "1-a", type: "chunk", enc: true });
			if (path.includes("/h:abc/")) {
				return { status: 200, headers: { "content-type": "application/octet-stream" }, bytes: payload };
			}
			return couch(url, "GET");
		};
		db.connectRemote();
		const chunk = await db.getChunkRemote("h:abc");
		expect(chunk?.enc).toBe(true);
		expect(Array.from(chunk!.bytes)).toEqual(Array.from(payload));
	});
});

describe("Access on, token missing on this device", () => {
	it("testConnection says so and sends nothing", async () => {
		make({ cfAccessEnabled: true });
		const res = await db.testConnection();
		expect(res).toMatchObject({ ok: false, error: "access-denied" });
		expect(res.message).toMatch(/no service token/);
		expect(calls).toEqual([]);
	});

	it("scanRemote does not probe the server", async () => {
		make({ cfAccessEnabled: true, cfAccessClientId: "id.access" });
		const scan = await db.scanRemote();
		expect(scan).toMatchObject({ reachable: false, error: "access-denied" });
		expect(calls).toEqual([]);
	});
});

describe("the three-way error mapping", () => {
	it("403 HTML → access-denied (token rejected)", async () => {
		make(TOKEN);
		handler = () => html(403);
		const res = await db.testConnection();
		expect(res).toMatchObject({ ok: false, error: "access-denied" });
		expect(res.message).toMatch(/service token/);
		expect((await db.scanRemote()).error).toBe("access-denied");
	});

	it("200 HTML login page → access-login, not a JSON syntax error", async () => {
		make(TOKEN);
		handler = () => html(200);
		const res = await db.testConnection();
		expect(res).toMatchObject({ ok: false, error: "access-login" });
		expect(res.message).toMatch(/Service Auth/);
		expect(res.message).not.toMatch(/JSON|Unexpected token/);
		const scan = await db.scanRemote();
		expect(scan.error).toBe("access-login");
	});

	it("302 to the Access login → access-login", async () => {
		make(TOKEN);
		handler = () => ({
			status: 302,
			headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/couch.example.com" },
			body: "",
		});
		expect(await db.testConnection()).toMatchObject({ ok: false, error: "access-login" });
	});

	it("Access in front but switch off → tells the user to turn it on", async () => {
		make();
		handler = () => html(200);
		const res = await db.testConnection();
		expect(res).toMatchObject({ ok: false, error: "access-login" });
		expect(res.message).toMatch(/Turn on/);
	});

	it("CouchDB's own 403 JSON → forbidden, and the test no longer reports success", async () => {
		make();
		handler = () => json(403, { error: "forbidden", reason: "You are not allowed to access this db." });
		const res = await db.testConnection();
		expect(res).toMatchObject({ ok: false, error: "forbidden" });
		expect(res.message).not.toMatch(/undefined docs/);
		expect((await db.scanRemote()).error).toBe("forbidden");
	});

	it("a proxy's 502 HTML page stays a transport error", async () => {
		make(TOKEN);
		handler = () => html(502);
		const res = await db.testConnection();
		expect(res).toMatchObject({ ok: false, error: "network" });
		expect((await db.scanRemote()).error).toBe("network");
	});

	it("a thrown transport error → network, with its message", async () => {
		make(TOKEN);
		throwNetwork = true;
		const res = await db.testConnection();
		expect(res).toMatchObject({ ok: false, error: "network" });
		expect(res.message).toContain("ERR_NAME_NOT_RESOLVED");
		const scan = await db.scanRemote();
		expect(scan).toMatchObject({ reachable: false, error: "network" });
	});

	it("replication against a rejecting Access surfaces the Access cause", async () => {
		make(TOKEN);
		handler = () => html(403);
		const remote = db.connectRemote();
		const err = (await db.local.replicate.from(remote).then(
			() => null,
			(e: unknown) => e
		)) as { name?: string; status?: number } | null;
		expect(err).not.toBeNull();
		expect(err?.status).toBe(403);
		expect(err?.name).toBe("cf_access_denied");
	});
});
