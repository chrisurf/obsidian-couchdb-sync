import { base64ToUint8, textToBytes, uint8ToBase64 } from "./util";
import type { CouchDBSyncSettings } from "./types";

/**
 * Credential storage: keeping the CouchDB password and the E2EE passphrase OUT of
 * `data.json`.
 *
 * `data.json` lives inside the vault (`<configDir>/plugins/couchdb-sync/data.json`).
 * The vault is exactly the thing users copy to other machines, back up, put in git,
 * hand to a cloud file sync, or paste into a bug report — so a plaintext password
 * sitting in it leaks through every one of those paths. This module moves both
 * secrets into a single encrypted blob (`encryptedSecrets`) whose key never enters
 * the vault at all:
 *
 * - "device": a random 32-byte key generated on first use and kept in Obsidian's
 *   device-local storage (see `DeviceKeyStore`), which is per-installation and is
 *   never part of the vault. Zero UX cost — no prompt, ever — and a copied vault
 *   simply arrives without credentials rather than with readable ones.
 * - "ask": the key is a passphrase the user types once per launch. It exists only in
 *   memory, so not even the device holds it at rest.
 *
 * Everything here is pure and Obsidian-free (the device store is injected), so it is
 * unit-testable like `util.ts` and `crypto.ts`.
 *
 * Blob format: "s1:<ivB64>:<cipherB64>", AES-256-GCM.
 */

/** Wire prefix of a sealed blob. Bump when the layout changes. */
const PREFIX = "s1";
const IV_BYTES = 12;
const DEVICE_KEY_BYTES = 32;
const PBKDF2_ITERATIONS = 210_000;

/**
 * Key material is stretched with a FIXED salt, unlike `crypto.ts`'s per-message
 * random salt. Two reasons: the derived key must be cacheable (`saveSettings` runs
 * on every keystroke in the settings tab, and a 210k-iteration derivation per
 * keystroke would stall mobile), and in "device" mode the input is already 32 bytes
 * of CSPRNG output, for which stretching is a formality. In "ask" mode the fixed
 * salt is the same trade-off `hmacPath` documents: the attacker still needs this
 * vault's `data.json`, and the salt is domain-separated so a config key can never
 * collide with a content key.
 */
const KEY_SALT = textToBytes("couchdb-sync:config-secrets:v1");

/** Device-local storage key. Obsidian scopes this per installation, outside the vault. */
export const DEVICE_KEY_STORAGE_KEY = "couchdb-sync-secret-key";

/**
 * The device-local key/value store. Obsidian's `App.loadLocalStorage` /
 * `App.saveLocalStorage` implement this; tests pass a Map-backed fake.
 */
export interface DeviceKeyStore {
	get(key: string): string | null;
	set(key: string, value: string): void;
}

/** The settings fields that must never be written to disk in the clear. */
export interface Secrets {
	password: string;
	passphrase: string;
}

/**
 * The persisted shape: everything in the settings EXCEPT the two secrets, which are
 * replaced by the sealed blob. The keys are deleted rather than blanked, so an
 * upgraded `data.json` carries no trace of the old plaintext fields.
 */
export type PersistedSettings = Omit<CouchDBSyncSettings, "password" | "passphrase">;

const keyCache = new Map<string, CryptoKey>();

async function deriveKey(material: string): Promise<CryptoKey> {
	const cached = keyCache.get(material);
	if (cached) return cached;
	const baseKey = await crypto.subtle.importKey(
		"raw",
		textToBytes(material) as unknown as BufferSource,
		"PBKDF2",
		false,
		["deriveKey"]
	);
	const key = await crypto.subtle.deriveKey(
		{
			name: "PBKDF2",
			salt: KEY_SALT as unknown as BufferSource,
			iterations: PBKDF2_ITERATIONS,
			hash: "SHA-256",
		},
		baseKey,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"]
	);
	keyCache.set(material, key);
	return key;
}

/** Fresh 32 bytes of CSPRNG output, base64-encoded. */
export function generateDeviceKey(): string {
	return uint8ToBase64(crypto.getRandomValues(new Uint8Array(DEVICE_KEY_BYTES)));
}

/**
 * Read this device's key, generating and persisting one on first use. Returns null
 * only if the store refuses to keep it — in which case the caller must treat the
 * secrets as locked rather than write them out unprotected.
 */
export function loadOrCreateDeviceKey(store: DeviceKeyStore): string | null {
	const existing = store.get(DEVICE_KEY_STORAGE_KEY);
	if (existing) return existing;
	const fresh = generateDeviceKey();
	try {
		store.set(DEVICE_KEY_STORAGE_KEY, fresh);
	} catch {
		return null;
	}
	// Read back: a store that silently drops the write would otherwise hand out a key
	// that cannot decrypt anything on the next launch, quietly orphaning the blob.
	return store.get(DEVICE_KEY_STORAGE_KEY);
}

export function isSealed(blob: string): boolean {
	return typeof blob === "string" && blob.startsWith(PREFIX + ":");
}

/** Encrypt the secrets into a single opaque blob. */
export async function sealSecrets(secrets: Secrets, keyMaterial: string): Promise<string> {
	if (!keyMaterial) throw new Error("Cannot seal credentials: no key");
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const key = await deriveKey(keyMaterial);
	const cipher = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: iv as unknown as BufferSource },
		key,
		textToBytes(
			JSON.stringify({ password: secrets.password, passphrase: secrets.passphrase })
		) as unknown as BufferSource
	);
	return [PREFIX, uint8ToBase64(iv), uint8ToBase64(new Uint8Array(cipher))].join(":");
}

/**
 * Inverse of `sealSecrets`. Returns null for a wrong key or a damaged blob — never
 * throws, because every caller's answer to a failure is the same ("locked"), and a
 * throw here would abort plugin load.
 */
export async function unsealSecrets(blob: string, keyMaterial: string): Promise<Secrets | null> {
	if (!keyMaterial || !isSealed(blob)) return null;
	const parts = blob.split(":");
	if (parts.length !== 3) return null;
	try {
		const key = await deriveKey(keyMaterial);
		const plain = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: base64ToUint8(parts[1]) as unknown as BufferSource },
			key,
			base64ToUint8(parts[2]) as unknown as BufferSource
		);
		const parsed = JSON.parse(new TextDecoder().decode(plain)) as Partial<Secrets>;
		return {
			password: typeof parsed.password === "string" ? parsed.password : "",
			passphrase: typeof parsed.passphrase === "string" ? parsed.passphrase : "",
		};
	} catch {
		return null;
	}
}

/** What a save should do with the stored blob. See {@link decideSealAction}. */
export type SealAction = "seal" | "keep";

/**
 * Decide whether a save may re-seal the credentials, or must pass the stored blob
 * through untouched.
 *
 * This is the single most dangerous decision in the whole mechanism, which is why it
 * lives here as a pure function rather than inline in a save path. `saveSettings()`
 * runs from places that fire long before — and independently of — any unlock: the
 * crash guard arms itself during load, teardown clears it on quit. If those saves
 * sealed whatever `settings` happened to hold (nothing, while locked), they would
 * overwrite a perfectly good blob and the user's password and E2EE passphrase would
 * be gone with no way back.
 *
 * So: seal only when there is a key AND either the blob was opened (we know what is
 * in it) or the user has actually entered something (a deliberate overwrite of a blob
 * that could not be read anyway — the documented recovery).
 */
export function decideSealAction(state: {
	/** key material, or null while locked */
	key: string | null;
	/** was the stored blob successfully opened (or was there nothing to open)? */
	unlocked: boolean;
	/** credentials currently held in memory */
	password: string;
	passphrase: string;
}): SealAction {
	if (!state.key) return "keep";
	if (state.unlocked) return "seal";
	return state.password || state.passphrase ? "seal" : "keep";
}

/**
 * Build the object that actually goes to disk: a copy of the settings with the two
 * secret fields removed and `encryptedSecrets` set to the given blob.
 *
 * The caller decides what that blob is — a freshly sealed one, or (while locked) the
 * one already on disk. Passing the existing blob through untouched is what stops a
 * routine `saveSettings()` from a locked session (the crash guard arms itself before
 * anything is unlocked) from replacing good credentials with an empty seal.
 */
export function toPersisted(settings: CouchDBSyncSettings, blob: string): PersistedSettings {
	const out = { ...settings, encryptedSecrets: blob } as PersistedSettings & Partial<Secrets>;
	delete out.password;
	delete out.passphrase;
	return out;
}

/** Drop cached derived keys (called when the key material changes or on unload). */
export function clearSecretKeyCache(): void {
	keyCache.clear();
}
