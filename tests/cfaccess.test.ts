import { describe, it, expect } from "vitest";
import {
	ACCESS_DENIED_ERROR,
	ACCESS_LOGIN_ERROR,
	CF_ACCESS_ID_HEADER,
	CF_ACCESS_ID_STORAGE_KEY,
	CF_ACCESS_SECRET_HEADER,
	CF_ACCESS_SECRET_STORAGE_KEY,
	AccessTokenStore,
	accessErrorBody,
	accessHeaders,
	accessTokenMissing,
	classifyRemoteError,
	detectAccessResponse,
	loadAccessToken,
	remoteErrorLong,
	remoteErrorShort,
	saveAccessToken,
	withoutAccessToken,
} from "../src/cfaccess";
import { toPersisted } from "../src/secrets";
import { DEFAULT_SETTINGS, RemoteError } from "../src/types";

function memStore(): AccessTokenStore & { map: Map<string, string> } {
	const map = new Map<string, string>();
	return {
		map,
		get: (k) => {
			const v = map.get(k);
			return v && v.length > 0 ? v : null;
		},
		set: (k, v) => void map.set(k, v),
	};
}

const on = { cfAccessEnabled: true, cfAccessClientId: "abc.access", cfAccessClientSecret: "s3cret" };

describe("accessHeaders", () => {
	it("sends nothing when the switch is off — the pre-R8 request shape", () => {
		expect(accessHeaders({ ...on, cfAccessEnabled: false })).toEqual({});
		expect(accessHeaders(DEFAULT_SETTINGS)).toEqual({});
	});

	it("sends both headers when on and complete", () => {
		expect(accessHeaders(on)).toEqual({
			[CF_ACCESS_ID_HEADER]: "abc.access",
			[CF_ACCESS_SECRET_HEADER]: "s3cret",
		});
	});

	it("sends nothing for half a token", () => {
		expect(accessHeaders({ ...on, cfAccessClientSecret: "" })).toEqual({});
		expect(accessHeaders({ ...on, cfAccessClientId: "  " })).toEqual({});
	});

	it("trims pasted whitespace", () => {
		expect(accessHeaders({ ...on, cfAccessClientId: " abc.access\n", cfAccessClientSecret: "s3cret " })).toEqual({
			[CF_ACCESS_ID_HEADER]: "abc.access",
			[CF_ACCESS_SECRET_HEADER]: "s3cret",
		});
	});
});

describe("accessTokenMissing", () => {
	it("is false while the switch is off, whatever the fields hold", () => {
		expect(accessTokenMissing(DEFAULT_SETTINGS)).toBe(false);
	});
	it("is true when on with either value missing", () => {
		expect(accessTokenMissing({ ...on, cfAccessClientId: "" })).toBe(true);
		expect(accessTokenMissing({ ...on, cfAccessClientSecret: "" })).toBe(true);
	});
	it("is false when on and complete", () => {
		expect(accessTokenMissing(on)).toBe(false);
	});
});

describe("device-store round trip", () => {
	it("returns empty values from an empty store", () => {
		expect(loadAccessToken(memStore())).toEqual({ clientId: "", clientSecret: "" });
	});

	it("saves under the two dedicated keys and reads them back trimmed", () => {
		const store = memStore();
		saveAccessToken(store, { clientId: " id.access ", clientSecret: "sec\n" });
		expect(store.map.get(CF_ACCESS_ID_STORAGE_KEY)).toBe("id.access");
		expect(store.map.get(CF_ACCESS_SECRET_STORAGE_KEY)).toBe("sec");
		expect(loadAccessToken(store)).toEqual({ clientId: "id.access", clientSecret: "sec" });
	});

	it("clearing writes empty values that read back as absent", () => {
		const store = memStore();
		saveAccessToken(store, { clientId: "a", clientSecret: "b" });
		saveAccessToken(store, { clientId: "", clientSecret: "" });
		expect(loadAccessToken(store)).toEqual({ clientId: "", clientSecret: "" });
	});

	it("never touches the device key used for sealed credentials", () => {
		const store = memStore();
		store.set("couchdb-sync-secret-key", "KEY");
		saveAccessToken(store, { clientId: "a", clientSecret: "b" });
		expect(store.map.get("couchdb-sync-secret-key")).toBe("KEY");
	});
});

describe("withoutAccessToken — what reaches data.json", () => {
	it("drops both token fields and keeps the switch", () => {
		const settings = {
			...DEFAULT_SETTINGS,
			password: "pw",
			passphrase: "pp",
			cfAccessEnabled: true,
			cfAccessClientId: "ID-VALUE",
			cfAccessClientSecret: "SECRET-VALUE",
		};
		const persisted = withoutAccessToken(toPersisted(settings, "s1:blob"));
		const json = JSON.stringify(persisted);
		expect(json).not.toContain("ID-VALUE");
		expect(json).not.toContain("SECRET-VALUE");
		expect("cfAccessClientId" in persisted).toBe(false);
		expect("cfAccessClientSecret" in persisted).toBe(false);
		expect(persisted.cfAccessEnabled).toBe(true);
		// the existing guarantees still hold on the combined path
		expect("password" in persisted).toBe(false);
		expect("passphrase" in persisted).toBe(false);
		expect(persisted.encryptedSecrets).toBe("s1:blob");
	});

	it("does not mutate the live settings", () => {
		const settings = { ...DEFAULT_SETTINGS, cfAccessClientId: "x", cfAccessClientSecret: "y" };
		withoutAccessToken(settings);
		expect(settings.cfAccessClientId).toBe("x");
		expect(settings.cfAccessClientSecret).toBe("y");
	});
});

describe("backward compatibility of the settings shape", () => {
	it("a pre-R8 data.json merges to Access off with empty runtime fields", () => {
		// what loadSettings does: Object.assign({}, DEFAULT_SETTINGS, loaded)
		const loaded = { schemaVersion: 7, serverUrl: "https://couch.example.com", dbName: "notes", username: "u" };
		const merged = Object.assign({}, DEFAULT_SETTINGS, loaded);
		expect(merged.cfAccessEnabled).toBe(false);
		expect(merged.cfAccessClientId).toBe("");
		expect(merged.cfAccessClientSecret).toBe("");
		expect(accessHeaders(merged)).toEqual({});
		expect(accessTokenMissing(merged)).toBe(false);
	});
});

describe("detectAccessResponse", () => {
	const html = { "Content-Type": "text/html; charset=UTF-8" };
	const json = { "content-type": "application/json" };

	it.each([
		[403, html, "denied"],
		[401, html, "denied"],
		[200, html, "login"],
		[302, html, "login"],
		[302, { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/couch.example.com" }, "login"],
		[307, { Location: "https://couch.example.com/cdn-cgi/access/login?x=1" }, "login"],
	] as const)("status %i %o → %s", (status, headers, want) => {
		expect(detectAccessResponse(status, headers)).toBe(want);
	});

	it.each([
		[200, json],
		[401, json],
		[403, json],
		[404, json],
		[502, html], // a proxy's error page is a transport problem, not Access
		[500, html],
		[200, { "content-type": "application/octet-stream" }], // chunk attachment
		[302, { location: "https://elsewhere.example.com/" }],
		[200, undefined],
	] as const)("status %i %o → not Access", (status, headers) => {
		expect(detectAccessResponse(status, headers)).toBeNull();
	});
});

describe("accessErrorBody", () => {
	it("carries the cause in `error`", () => {
		expect(accessErrorBody("denied").error).toBe(ACCESS_DENIED_ERROR);
		expect(accessErrorBody("login").error).toBe(ACCESS_LOGIN_ERROR);
	});
});

describe("classifyRemoteError", () => {
	it.each([
		[{ status: 401, name: "unauthorized" }, "auth"],
		[{ status: 403, name: "forbidden" }, "forbidden"],
		[{ status: 404, name: "not_found" }, "notfound"],
		[{ status: 403, name: ACCESS_DENIED_ERROR }, "access-denied"],
		[{ status: 403, name: ACCESS_LOGIN_ERROR }, "access-login"],
		[{ status: 500 }, "network"],
		[{ name: "TypeError" }, "network"],
		[null, "network"],
		[undefined, "network"],
	] as const)("%o → %s", (err, want) => {
		expect(classifyRemoteError(err)).toBe(want);
	});
});

describe("remote error wording", () => {
	const all: RemoteError[] = ["auth", "forbidden", "notfound", "access-denied", "access-login", "network"];

	it("every cause has its own sentence", () => {
		const texts = all.map((e) => remoteErrorLong(e, { accessEnabled: true }));
		expect(new Set(texts).size).toBe(all.length);
	});

	it("CouchDB's 403 and Access's 403 say different things", () => {
		expect(remoteErrorLong("forbidden")).toMatch(/member/);
		expect(remoteErrorLong("access-denied", { accessEnabled: true })).toMatch(/service token/);
	});

	it("tells a user without the switch to turn it on", () => {
		expect(remoteErrorLong("access-login")).toMatch(/Turn on/);
		expect(remoteErrorLong("access-denied")).toMatch(/Turn on/);
	});

	it("names Service Auth for the login-page case", () => {
		expect(remoteErrorLong("access-login", { accessEnabled: true })).toMatch(/Service Auth/);
	});

	it("short labels", () => {
		expect(all.map((e) => remoteErrorShort(e))).toEqual(["401", "403", "404", "Access", "Access", "offline"]);
		expect(remoteErrorShort(undefined)).toBe("offline");
	});
});
