import { describe, it, expect } from "vitest";
import {
	DEVICE_KEYS,
	DEVICE_STATE_STORAGE_KEY,
	DeviceStateStore,
	adoptDeviceState,
	loadDeviceState,
	saveDeviceState,
	withoutDeviceState,
} from "../src/device";
import { toPersisted } from "../src/secrets";
import { CouchDBSyncSettings, DEFAULT_SETTINGS } from "../src/types";

function memStore(): DeviceStateStore & { map: Map<string, string> } {
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

function ids(): () => string {
	let n = 0;
	return () => `id-${++n}`;
}

/** data.json as another device wrote it (identity included, as before). */
function fromFile(over: Partial<CouchDBSyncSettings> = {}): CouchDBSyncSettings {
	return {
		...DEFAULT_SETTINGS,
		deviceId: "other-device",
		localDbId: "replica-1",
		isMaster: true,
		unsafeShutdown: false,
		unsafeShutdownStreak: 0,
		...over,
	};
}

describe("device identity", () => {
	it("first start: keeps the local replica, draws a new device id, stores both", () => {
		const store = memStore();
		const s = fromFile();
		expect(adoptDeviceState(s, store, ids())).toBe(true);
		expect(s.deviceId).toBe("id-1");
		expect(s.localDbId).toBe("replica-1");
		expect(s.isMaster).toBe(true);
		expect(loadDeviceState(store)).toEqual({
			deviceId: "id-1",
			localDbId: "replica-1",
			isMaster: true,
			unsafeShutdown: false,
			unsafeShutdownStreak: 0,
		});
	});

	it("two devices that share one data.json end up with different ids", () => {
		const a = fromFile();
		const b = fromFile();
		adoptDeviceState(a, memStore(), () => "aaaa");
		adoptDeviceState(b, memStore(), () => "bbbb");
		expect(a.deviceId).not.toBe(b.deviceId);
	});

	it("later starts: the device store wins over whatever the file says", () => {
		const store = memStore();
		adoptDeviceState(fromFile(), store, ids());
		// The other device turned itself into the master and reset its replica.
		const s = fromFile({ deviceId: "other-device", localDbId: "replica-2", isMaster: true, unsafeShutdown: true });
		const before = loadDeviceState(store)!;
		before.isMaster = false;
		store.set(DEVICE_STATE_STORAGE_KEY, JSON.stringify(before));
		expect(adoptDeviceState(s, store, ids())).toBe(false);
		expect(s.deviceId).toBe("id-1");
		expect(s.localDbId).toBe("replica-1");
		expect(s.isMaster).toBe(false);
		expect(s.unsafeShutdown).toBe(false);
	});

	it("a fresh vault gets a device id and a replica id", () => {
		const s = { ...DEFAULT_SETTINGS };
		adoptDeviceState(s, memStore(), ids());
		expect(s.deviceId).toBe("id-1");
		expect(s.localDbId).toBe("id-2");
	});

	it("an unreadable store entry counts as none", () => {
		const store = memStore();
		store.set(DEVICE_STATE_STORAGE_KEY, "{not json");
		expect(loadDeviceState(store)).toBeNull();
		store.set(DEVICE_STATE_STORAGE_KEY, JSON.stringify({ deviceId: "x" }));
		expect(loadDeviceState(store)).toBeNull();
	});

	it("data.json carries no identity, everything else stays", () => {
		const s = fromFile({ serverUrl: "https://db.example.com", conflictStrategy: "master" });
		const store = memStore();
		adoptDeviceState(s, store, ids());
		saveDeviceState(store, s);
		const file = withoutDeviceState(toPersisted(s, "blob")) as unknown as Record<string, unknown>;
		for (const k of DEVICE_KEYS) expect(k in file).toBe(false);
		expect(file.serverUrl).toBe("https://db.example.com");
		expect(file.conflictStrategy).toBe("master");
		expect(file.encryptedSecrets).toBe("blob");
		// The live settings object keeps its identity.
		expect(s.deviceId).toBe("id-1");
	});
});
