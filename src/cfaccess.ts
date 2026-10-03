/**
 * Cloudflare Access support (R8 Level 2): the service-token headers, where the token
 * is kept, and how an Access answer is told apart from a CouchDB one.
 *
 * Pure — no Obsidian API — so all of it is unit-tested directly.
 *
 * WHERE THE TOKEN LIVES, AND WHY IT IS NOT WHERE THE PASSWORD LIVES
 *
 * The client id and secret are kept in the device-local store (`App.saveLocalStorage`),
 * never in `data.json` — not even sealed. Two credentials therefore use two mechanisms,
 * and that is deliberate:
 *
 * - An Access service token should be issued PER DEVICE, so one lost phone can be
 *   revoked without touching the others. The CouchDB password is the same everywhere
 *   and has to travel with the configuration.
 * - The sealed blob is only as strong as the device store anyway: the key that opens
 *   it lives there. Keeping the token directly in that store is equally strong against
 *   local disk access, and strictly stronger against everything that carries the vault
 *   onward (backups, file sync, a repo mirror, a pasted bug report) — `data.json`
 *   holds no trace of it.
 *
 * The cost, which the settings text states: the device store is plaintext on disk and
 * is gone when the app data is cleared, so the token must be entered again on that
 * device.
 *
 * Only the on/off switch (`cfAccessEnabled`) is persisted in `data.json`. It carries
 * nothing secret, and a device that receives the configuration learns from it that
 * this server needs a token it does not have yet.
 */
import type { CouchDBSyncSettings, RemoteError } from "./types";

/** Device-store keys. Obsidian scopes the store per vault, outside the vault folder. */
export const CF_ACCESS_ID_STORAGE_KEY = "couchdb-sync-cf-access-client-id";
export const CF_ACCESS_SECRET_STORAGE_KEY = "couchdb-sync-cf-access-client-secret";

/** The two headers Cloudflare Access reads a service token from. */
export const CF_ACCESS_ID_HEADER = "CF-Access-Client-Id";
export const CF_ACCESS_SECRET_HEADER = "CF-Access-Client-Secret";

/**
 * `error` names the fetch wrapper puts into the JSON body it substitutes for an Access
 * page. PouchDB turns a body's `error` into the thrown error's `name`, which is how the
 * cause survives the trip through PouchDB to {@link classifyRemoteError}.
 */
export const ACCESS_DENIED_ERROR = "cf_access_denied";
export const ACCESS_LOGIN_ERROR = "cf_access_login";

/** The minimal key/value store; `App.loadLocalStorage`/`saveLocalStorage` in the app. */
export interface AccessTokenStore {
	get(key: string): string | null;
	set(key: string, value: string): void;
}

export interface AccessToken {
	clientId: string;
	clientSecret: string;
}

/** The runtime-only settings fields — the ones that must never reach `data.json`. */
export const ACCESS_RUNTIME_KEYS = ["cfAccessClientId", "cfAccessClientSecret"] as const;

export function loadAccessToken(store: AccessTokenStore): AccessToken {
	return {
		clientId: store.get(CF_ACCESS_ID_STORAGE_KEY) ?? "",
		clientSecret: store.get(CF_ACCESS_SECRET_STORAGE_KEY) ?? "",
	};
}

/**
 * Write both values. Surrounding whitespace is dropped: both are pasted from the
 * Cloudflare dashboard, and a trailing space or newline would turn into a 403 that
 * looks exactly like a revoked token.
 */
export function saveAccessToken(store: AccessTokenStore, token: AccessToken): void {
	store.set(CF_ACCESS_ID_STORAGE_KEY, token.clientId.trim());
	store.set(CF_ACCESS_SECRET_STORAGE_KEY, token.clientSecret.trim());
}

/**
 * A copy of what is about to be written to `data.json`, without the token fields.
 * Applied on every save, so the token cannot reach the file through any path that
 * happens to copy the settings object.
 */
export function withoutAccessToken<T extends object>(persisted: T): Omit<T, (typeof ACCESS_RUNTIME_KEYS)[number]> {
	const out = { ...persisted } as Record<string, unknown>;
	for (const k of ACCESS_RUNTIME_KEYS) delete out[k];
	return out as Omit<T, (typeof ACCESS_RUNTIME_KEYS)[number]>;
}

type AccessSettings = Pick<CouchDBSyncSettings, "cfAccessEnabled" | "cfAccessClientId" | "cfAccessClientSecret">;

/** Access is switched on, but this device has no (complete) token. */
export function accessTokenMissing(s: AccessSettings): boolean {
	return s.cfAccessEnabled && (!s.cfAccessClientId.trim() || !s.cfAccessClientSecret.trim());
}

/**
 * The headers to add to every request. Empty unless the switch is on AND both values
 * are present: half a token is rejected by Access just like none, and sending it would
 * only blur which of the two is missing.
 */
export function accessHeaders(s: AccessSettings): Record<string, string> {
	if (!s.cfAccessEnabled) return {};
	const id = s.cfAccessClientId.trim();
	const secret = s.cfAccessClientSecret.trim();
	if (!id || !secret) return {};
	return { [CF_ACCESS_ID_HEADER]: id, [CF_ACCESS_SECRET_HEADER]: secret };
}

/** Read one header case-insensitively (requestUrl does not normalise names). */
function header(headers: Record<string, string> | undefined, name: string): string {
	if (!headers) return "";
	const want = name.toLowerCase();
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() === want) return v;
	}
	return "";
}

/** Where an Access login lives: the team domain, or the `/cdn-cgi/access/` path. */
function isAccessLoginUrl(url: string): boolean {
	return /cloudflareaccess\.com/i.test(url) || /\/cdn-cgi\/access\//i.test(url);
}

/**
 * Decide whether a response came from Cloudflare Access rather than from CouchDB.
 *
 * CouchDB answers every API request with JSON, so an HTML body is never CouchDB:
 *
 * - HTML with 401/403 → Access refused the service token (wrong, revoked, expired).
 * - HTML with any other success or redirect status, or a redirect to an Access login
 *   URL → the application's policy is not set to *Service Auth*, so Access answers a
 *   machine client with an identity-provider login page. Without this, that page
 *   reaches PouchDB's JSON parser and the user sees a syntax error.
 *
 * Anything else — including HTML error pages from a proxy (5xx) — is left alone, so
 * transport problems keep reading as transport problems.
 *
 * Cloudflare does not document which status it uses for a missing or invalid token;
 * this classifies by body type first and status second so it holds either way.
 */
export function detectAccessResponse(
	status: number,
	headers: Record<string, string> | undefined
): "denied" | "login" | null {
	const location = header(headers, "location");
	if (status >= 300 && status < 400 && isAccessLoginUrl(location)) return "login";
	const type = header(headers, "content-type").toLowerCase();
	if (!type.includes("text/html")) return null;
	if (status === 401 || status === 403) return "denied";
	if (status >= 200 && status < 400) return "login";
	return null;
}

/** The JSON body the fetch wrapper hands PouchDB in place of an Access page. */
export function accessErrorBody(kind: "denied" | "login"): { error: string; reason: string } {
	return kind === "denied"
		? { error: ACCESS_DENIED_ERROR, reason: "Cloudflare Access rejected the service token." }
		: {
				error: ACCESS_LOGIN_ERROR,
				reason: "Cloudflare Access answered with a login page instead of the database.",
			};
}

/**
 * Map a thrown PouchDB error to a cause.
 *
 * The Access causes are recognised by `name` first — the fetch wrapper put it there,
 * so it is unambiguous — and only then by status. That order matters for 403: CouchDB
 * itself answers 403 when the login is fine but the account is not a member of the
 * database, and that needs a different fix than a rejected token.
 */
export function classifyRemoteError(err: { status?: number; name?: string } | null | undefined): RemoteError {
	const name = err?.name ?? "";
	if (name === ACCESS_DENIED_ERROR) return "access-denied";
	if (name === ACCESS_LOGIN_ERROR) return "access-login";
	const status = err?.status;
	if (status === 401) return "auth";
	if (status === 403) return "forbidden";
	if (status === 404) return "notfound";
	return "network";
}

/** Short label for the Server column ("✕ 401"). */
export function remoteErrorShort(e?: RemoteError): string {
	switch (e) {
		case "auth":
			return "401";
		case "forbidden":
			return "403";
		case "notfound":
			return "404";
		case "access-denied":
		case "access-login":
			return "Access";
		default:
			return "offline";
	}
}

/**
 * The full sentence for a cause, phrased so it says what to change. Shared by the
 * connection test, the panel and the reset preflight, so the three never disagree.
 */
export function remoteErrorLong(e?: RemoteError, opts: { accessEnabled?: boolean } = {}): string {
	switch (e) {
		case "auth":
			return "the login was rejected (401). Check the user name and password.";
		case "forbidden":
			return "the server answered but refused access (403). The login works, but this account is not allowed to use this database — add it as a member of the database.";
		case "notfound":
			return "the database was not found (404). Check the database name.";
		case "access-denied":
			return opts.accessEnabled
				? "Cloudflare Access rejected the service token (403). Check the client id and secret, or whether the token has expired or been revoked."
				: "the server is behind Cloudflare Access and refused the request. Turn on “Cloudflare Access” and enter a service token for this device.";
		case "access-login":
			return opts.accessEnabled
				? "Cloudflare Access answered with a login page. Set the Access policy's action to “Service Auth” so it accepts the service token."
				: "the server is behind Cloudflare Access, which answered with a login page. Turn on “Cloudflare Access”, enter a service token, and set the policy's action to “Service Auth”.";
		default:
			return "could not reach the server (network/transport).";
	}
}
