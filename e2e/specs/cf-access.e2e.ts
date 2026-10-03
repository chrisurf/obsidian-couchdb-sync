import { browser } from "@wdio/globals";
import { describe, it, before, after } from "mocha";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { PLUGIN_ID } from "./helpers.js";

/**
 * Cloudflare Access (R8 Level 2) inside a real Obsidian.
 *
 * Two things only a real app can prove:
 *   1. the service token never reaches data.json, lives in the device store, and is
 *      restored from there on load — including the one-time move of a token that is
 *      found in data.json;
 *   2. what Obsidian's real requestUrl() does with an Access answer (redirects, HTML),
 *      and that every request carries the headers.
 *
 * No Cloudflare and no CouchDB needed: a local gateway plays both — a minimal CouchDB
 * behind an Access-like gate whose behaviour each test picks.
 */

const ID = "e2e-client-id.access";
const SECRET = "e2e-client-secret-4b7d";
const DB = "notes";

type Mode = "service-auth" | "login-redirect" | "couch-forbidden";
let mode: Mode = "service-auth";
const seen: { url: string; id?: string; secret?: string }[] = [];
let server: http.Server;
let base = "";

function startGateway(): Promise<void> {
	server = http.createServer((req, res) => {
		const id = req.headers["cf-access-client-id"] as string | undefined;
		const secret = req.headers["cf-access-client-secret"] as string | undefined;
		seen.push({ url: req.url ?? "", id, secret });
		const sendJson = (status: number, body: unknown) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		const sendHtml = (status: number, extra: Record<string, string> = {}) => {
			res.writeHead(status, { "content-type": "text/html; charset=UTF-8", ...extra });
			res.end("<!DOCTYPE html><html><body>Cloudflare Access</body></html>");
		};
		const url = req.url ?? "/";
		if (url.startsWith("/cdn-cgi/access/login")) return sendHtml(200);
		if (mode === "login-redirect") {
			res.writeHead(302, { location: `${base}/cdn-cgi/access/login/couch?redirect_url=${encodeURIComponent(url)}` });
			return res.end();
		}
		if (id !== ID || secret !== SECRET) return sendHtml(403);
		if (mode === "couch-forbidden") {
			return sendJson(403, { error: "forbidden", reason: "You are not allowed to access this db." });
		}
		const path = url.split("?")[0];
		if (path === `/${DB}` || path === `/${DB}/`) return sendJson(200, { db_name: DB, doc_count: 7, update_seq: "0" });
		if (path === `/${DB}/_all_docs`) return sendJson(200, { total_rows: 0, offset: 0, rows: [] });
		return sendJson(404, { error: "not_found", reason: "missing" });
	});
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => {
			base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			resolve();
		})
	);
}

interface PluginLike {
	settings: Record<string, unknown>;
	saveSettings(): Promise<void>;
	loadSettings(): Promise<void>;
	setAccessToken(t: { clientId?: string; clientSecret?: string }): Promise<void>;
	getSharedDb(): {
		testConnection(): Promise<{ ok: boolean; message: string; error?: string }>;
		scanRemote(): Promise<{ reachable: boolean; error?: string }>;
		closeRemote(): void;
	};
}

interface ProbeResult {
	test: { ok: boolean; message: string; error?: string };
	scan: { reachable: boolean; error?: string };
}

/** Apply settings + token, then run the connection test and a server scan. */
async function probe(
	cfg: Record<string, unknown>,
	token: { clientId: string; clientSecret: string }
): Promise<ProbeResult> {
	return (await browser.executeObsidian(
		async ({ app }, pid, c, t) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, PluginLike> } }).plugins.plugins[pid];
			Object.assign(plugin.settings, c);
			await plugin.setAccessToken(t);
			await plugin.saveSettings();
			const db = plugin.getSharedDb();
			db.closeRemote();
			const test = await db.testConnection();
			const scan = await db.scanRemote();
			return { test, scan: { reachable: scan.reachable, error: scan.error } };
		},
		PLUGIN_ID,
		cfg,
		token
	)) as ProbeResult;
}

async function readDataJson(): Promise<string> {
	return (await browser.executeObsidian(
		async ({ app }, pid) => app.vault.adapter.read(`${app.vault.configDir}/plugins/${pid}/data.json`),
		PLUGIN_ID
	)) as string;
}

function readStore(): Promise<{ id: unknown; secret: unknown }> {
	return browser.executeObsidian(({ app }) => {
		const a = app as unknown as { loadLocalStorage(k: string): unknown };
		return {
			id: a.loadLocalStorage("couchdb-sync-cf-access-client-id"),
			secret: a.loadLocalStorage("couchdb-sync-cf-access-client-secret"),
		};
	});
}

describe("CouchDB Sync — Cloudflare Access", function () {
	this.timeout(60 * 1000);

	before(async function () {
		await startGateway();
	});

	after(async function () {
		// Leave the sandbox as found: switch off, empty store, no server.
		await browser.executeObsidian(async ({ app }, pid) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, PluginLike> } }).plugins.plugins[pid];
			await plugin.setAccessToken({ clientId: "", clientSecret: "" });
			Object.assign(plugin.settings, { cfAccessEnabled: false, serverUrl: "", connectionVerified: false });
			await plugin.saveSettings();
		}, PLUGIN_ID);
		await new Promise<void>((r) => server.close(() => r()));
	});

	it("is off by default — an existing setup is untouched", async function () {
		const enabled = await browser.executeObsidian(({ app }, pid) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, PluginLike> } }).plugins.plugins[pid];
			return plugin.settings.cfAccessEnabled;
		}, PLUGIN_ID);
		assert.equal(enabled, false);
	});

	const cfg = () => ({ serverUrl: base, dbName: DB, username: "u", password: "p", cfAccessEnabled: true });

	it("connects through the gate and sends both headers on every request", async function () {
		mode = "service-auth";
		seen.length = 0;
		const r = await probe(cfg(), { clientId: ID, clientSecret: SECRET });
		assert.equal(r.test.ok, true, r.test.message);
		assert.equal(r.scan.reachable, true);
		assert.ok(seen.length >= 2, `expected requests, saw ${seen.length}`);
		for (const s of seen) {
			assert.equal(s.id, ID, `missing client id on ${s.url}`);
			assert.equal(s.secret, SECRET, `missing client secret on ${s.url}`);
		}
	});

	it("a wrong secret reads as a rejected token, not as a wrong password", async function () {
		mode = "service-auth";
		const r = await probe(cfg(), { clientId: ID, clientSecret: "wrong" });
		assert.equal(r.test.ok, false);
		assert.equal(r.test.error, "access-denied", r.test.message);
		assert.equal(r.scan.error, "access-denied");
	});

	it("a login redirect (policy not Service Auth) is named as such", async function () {
		mode = "login-redirect";
		const r = await probe(cfg(), { clientId: ID, clientSecret: SECRET });
		assert.equal(r.test.ok, false);
		assert.equal(r.test.error, "access-login", r.test.message);
		assert.match(r.test.message, /Service Auth/);
		assert.equal(r.scan.error, "access-login");
	});

	it("CouchDB's own 403 is a membership problem and no longer a false success", async function () {
		mode = "couch-forbidden";
		const r = await probe(cfg(), { clientId: ID, clientSecret: SECRET });
		assert.equal(r.test.ok, false, r.test.message);
		assert.equal(r.test.error, "forbidden");
		assert.equal(r.scan.error, "forbidden");
	});

	it("with the switch off behind Access, the message says to turn it on", async function () {
		mode = "service-auth";
		seen.length = 0;
		const r = await probe({ ...cfg(), cfAccessEnabled: false }, { clientId: ID, clientSecret: SECRET });
		assert.equal(r.test.error, "access-denied");
		assert.match(r.test.message, /Turn on/);
		assert.ok(seen.every((s) => s.id === undefined && s.secret === undefined), "headers sent while off");
	});

	it("never writes the token to data.json; keeps it in the device store", async function () {
		await probe(cfg(), { clientId: ID, clientSecret: SECRET });
		const raw = await readDataJson();
		assert.ok(!raw.includes(ID), "data.json contained the client id");
		assert.ok(!raw.includes(SECRET), "data.json contained the client secret");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		assert.ok(!("cfAccessClientId" in parsed));
		assert.ok(!("cfAccessClientSecret" in parsed));
		assert.equal(parsed.cfAccessEnabled, true, "the switch itself is persisted");
		const store = await readStore();
		assert.equal(store.id, ID);
		assert.equal(store.secret, SECRET);
	});

	it("restores the token from the device store on load", async function () {
		const s = await browser.executeObsidian(async ({ app }, pid) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, PluginLike> } }).plugins.plugins[pid];
			await plugin.loadSettings();
			return { id: plugin.settings.cfAccessClientId, secret: plugin.settings.cfAccessClientSecret };
		}, PLUGIN_ID);
		assert.deepEqual(s, { id: ID, secret: SECRET });
	});

	it("moves a token found in data.json into the device store and strips it", async function () {
		const result = await browser.executeObsidian(
			async ({ app }, pid, id, secret) => {
				const a = app as unknown as { saveLocalStorage(k: string, v: unknown): void };
				a.saveLocalStorage("couchdb-sync-cf-access-client-id", null);
				a.saveLocalStorage("couchdb-sync-cf-access-client-secret", null);
				const file = `${app.vault.configDir}/plugins/${pid}/data.json`;
				const data = JSON.parse(await app.vault.adapter.read(file)) as Record<string, unknown>;
				data.cfAccessClientId = id;
				data.cfAccessClientSecret = secret;
				await app.vault.adapter.write(file, JSON.stringify(data));
				const plugin = (app as unknown as { plugins: { plugins: Record<string, PluginLike> } }).plugins.plugins[pid];
				await plugin.loadSettings();
				return {
					inMemory: [plugin.settings.cfAccessClientId, plugin.settings.cfAccessClientSecret],
					after: await app.vault.adapter.read(file),
				};
			},
			PLUGIN_ID,
			ID,
			SECRET
		);
		assert.deepEqual(result.inMemory, [ID, SECRET]);
		assert.ok(!result.after.includes(ID) && !result.after.includes(SECRET), "token still in data.json");
		const store = await readStore();
		assert.equal(store.id, ID);
		assert.equal(store.secret, SECRET);
	});
});
