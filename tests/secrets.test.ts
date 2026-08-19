import { describe, it, expect } from "vitest";
import {
	decideSealAction,
	DEVICE_KEY_STORAGE_KEY,
	DeviceKeyStore,
	generateDeviceKey,
	isSealed,
	loadOrCreateDeviceKey,
	sealSecrets,
	toPersisted,
	unsealSecrets,
} from "../src/secrets";
import { DEFAULT_SETTINGS, type CouchDBSyncSettings } from "../src/types";

/** In-memory stand-in for Obsidian's vault-scoped local storage. */
function fakeStore(initial: Record<string, string> = {}): DeviceKeyStore & { data: Map<string, string> } {
	const data = new Map(Object.entries(initial));
	return {
		data,
		get: (k) => data.get(k) ?? null,
		set: (k, v) => void data.set(k, v),
	};
}

describe("device key", () => {
	it("generates 32 bytes of base64", () => {
		const key = generateDeviceKey();
		expect(Buffer.from(key, "base64")).toHaveLength(32);
	});

	it("never repeats", () => {
		expect(generateDeviceKey()).not.toBe(generateDeviceKey());
	});

	it("creates and persists a key on first use", () => {
		const store = fakeStore();
		const key = loadOrCreateDeviceKey(store);
		expect(key).toBeTruthy();
		expect(store.data.get(DEVICE_KEY_STORAGE_KEY)).toBe(key);
	});

	it("returns the same key on subsequent launches", () => {
		const store = fakeStore();
		expect(loadOrCreateDeviceKey(store)).toBe(loadOrCreateDeviceKey(store));
	});

	it("returns null when the store refuses to keep the key", () => {
		// A store that drops writes would otherwise hand out a key that cannot decrypt
		// anything next launch, silently orphaning the sealed blob.
		const store: DeviceKeyStore = { get: () => null, set: () => undefined };
		expect(loadOrCreateDeviceKey(store)).toBeNull();
	});
});

describe("seal / unseal", () => {
	const secrets = { password: "hunter2", passphrase: "correct horse battery staple" };

	it("round-trips the credentials", async () => {
		const key = generateDeviceKey();
		const blob = await sealSecrets(secrets, key);
		expect(isSealed(blob)).toBe(true);
		expect(await unsealSecrets(blob, key)).toEqual(secrets);
	});

	it("leaks neither secret into the blob", async () => {
		const blob = await sealSecrets(secrets, generateDeviceKey());
		expect(blob).not.toContain("hunter2");
		expect(blob).not.toContain("correct horse");
	});

	it("produces a different blob every time (random IV)", async () => {
		const key = generateDeviceKey();
		expect(await sealSecrets(secrets, key)).not.toBe(await sealSecrets(secrets, key));
	});

	it("returns null for the wrong key rather than throwing", async () => {
		const blob = await sealSecrets(secrets, generateDeviceKey());
		await expect(unsealSecrets(blob, generateDeviceKey())).resolves.toBeNull();
	});

	it("returns null for a damaged or foreign blob", async () => {
		const key = generateDeviceKey();
		const blob = await sealSecrets(secrets, key);
		await expect(unsealSecrets(blob.slice(0, -4) + "AAAA", key)).resolves.toBeNull();
		await expect(unsealSecrets("not-a-blob", key)).resolves.toBeNull();
		await expect(unsealSecrets("s1:only-two-parts", key)).resolves.toBeNull();
		await expect(unsealSecrets("", key)).resolves.toBeNull();
	});

	it("returns null without a key", async () => {
		const blob = await sealSecrets(secrets, generateDeviceKey());
		await expect(unsealSecrets(blob, "")).resolves.toBeNull();
	});

	it("refuses to seal without a key", async () => {
		await expect(sealSecrets(secrets, "")).rejects.toThrow();
	});

	it("round-trips empty credentials", async () => {
		const key = generateDeviceKey();
		const empty = { password: "", passphrase: "" };
		expect(await unsealSecrets(await sealSecrets(empty, key), key)).toEqual(empty);
	});
});

describe("decideSealAction", () => {
	const creds = { password: "hunter2", passphrase: "correct horse" };
	const empty = { password: "", passphrase: "" };

	it("seals normally once unlocked", () => {
		expect(decideSealAction({ key: "k", unlocked: true, ...creds })).toBe("seal");
	});

	it("seals an unlocked vault that has no credentials yet", () => {
		expect(decideSealAction({ key: "k", unlocked: true, ...empty })).toBe("seal");
	});

	it("KEEPS the stored blob while locked with nothing entered", () => {
		// The crash guard and teardown both save from a locked session; re-sealing
		// empty credentials there would destroy the user's password and passphrase.
		expect(decideSealAction({ key: "k", unlocked: false, ...empty })).toBe("keep");
	});

	it("KEEPS the stored blob whenever there is no key", () => {
		expect(decideSealAction({ key: null, unlocked: false, ...empty })).toBe("keep");
		expect(decideSealAction({ key: null, unlocked: false, ...creds })).toBe("keep");
		expect(decideSealAction({ key: null, unlocked: true, ...creds })).toBe("keep");
	});

	it("seals over an unreadable blob once the user re-enters credentials", () => {
		expect(decideSealAction({ key: "k", unlocked: false, password: "x", passphrase: "" })).toBe(
			"seal"
		);
		expect(decideSealAction({ key: "k", unlocked: false, password: "", passphrase: "y" })).toBe(
			"seal"
		);
	});
});

describe("toPersisted", () => {
	const settings: CouchDBSyncSettings = {
		...DEFAULT_SETTINGS,
		serverUrl: "https://couch.example.com:6984",
		username: "alice",
		password: "hunter2",
		passphrase: "correct horse battery staple",
	};

	it("removes both secrets from what goes to disk", () => {
		const out = toPersisted(settings, "s1:iv:cipher") as Record<string, unknown>;
		expect("password" in out).toBe(false);
		expect("passphrase" in out).toBe(false);
		expect(JSON.stringify(out)).not.toContain("hunter2");
		expect(JSON.stringify(out)).not.toContain("correct horse");
	});

	it("keeps every other setting and stores the blob", () => {
		const out = toPersisted(settings, "s1:iv:cipher");
		expect(out.serverUrl).toBe("https://couch.example.com:6984");
		expect(out.username).toBe("alice");
		expect(out.encryptedSecrets).toBe("s1:iv:cipher");
	});

	it("does not mutate the live settings object", () => {
		toPersisted(settings, "s1:iv:cipher");
		expect(settings.password).toBe("hunter2");
		expect(settings.passphrase).toBe("correct horse battery staple");
	});
});
