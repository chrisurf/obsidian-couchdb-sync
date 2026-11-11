/**
 * Device identity: the settings that describe THIS device, not the vault.
 *
 * Pure — no Obsidian API — so all of it is unit-tested directly.
 *
 * WHY THEY DO NOT LIVE IN data.json
 *
 * `data.json` sits inside the vault. Whatever carries the vault from one device to
 * another — a file sync tool between two Macs, a backup restored elsewhere, a copied
 * vault — carries `data.json` with it. Every other setting is meant to travel: the
 * server, the excludes and the strategy are the same on all devices. These are not:
 *
 * - `deviceId` names this device in history entries, conflict tie-breaks and the
 *   master record. Two devices with the same id look like one device.
 * - `localDbId` names this device's local replica. Copied to another device and then
 *   reset there, it would switch this device to a new, empty replica as well.
 * - `isMaster` says that THIS device wins in the "master" strategy. Copied, every
 *   device is master.
 * - `unsafeShutdown` / `unsafeShutdownStreak` are this device's crash guard. Copied,
 *   a crash on one device counts against the other.
 *
 * They are therefore kept in the device-local store (`App.saveLocalStorage`, scoped
 * per vault and outside the vault folder) and stripped from what is written to
 * `data.json`. The other settings stay in `data.json` and keep travelling.
 *
 * MIGRATION
 *
 * A device without a stored identity takes `localDbId`, `isMaster` and the crash
 * guard from the file (its local replica keeps its name, nothing is downloaded
 * again) but always draws a NEW `deviceId`: the file may have come from another
 * device, and a fresh id is the only way to be sure no two devices share one. The
 * new id only labels future history entries; the master record is republished
 * under it.
 */
import type { CouchDBSyncSettings } from "./types";

/** Device-store key. Obsidian scopes the store per vault, outside the vault folder. */
export const DEVICE_STATE_STORAGE_KEY = "couchdb-sync-device-state";

/** The minimal key/value store; `App.loadLocalStorage`/`saveLocalStorage` in the app. */
export interface DeviceStateStore {
	get(key: string): string | null;
	set(key: string, value: string): void;
}

/** The settings fields that belong to the device, not to the vault. */
export const DEVICE_KEYS = ["deviceId", "localDbId", "isMaster", "unsafeShutdown", "unsafeShutdownStreak"] as const;

export type DeviceState = Pick<CouchDBSyncSettings, (typeof DEVICE_KEYS)[number]>;

function pick(settings: CouchDBSyncSettings): DeviceState {
	return {
		deviceId: settings.deviceId,
		localDbId: settings.localDbId,
		isMaster: settings.isMaster,
		unsafeShutdown: settings.unsafeShutdown,
		unsafeShutdownStreak: settings.unsafeShutdownStreak,
	};
}

/** The stored identity of this device, or `null` if it has none (or it is unreadable). */
export function loadDeviceState(store: DeviceStateStore): DeviceState | null {
	const raw = store.get(DEVICE_STATE_STORAGE_KEY);
	if (!raw) return null;
	try {
		const v = JSON.parse(raw) as Partial<DeviceState>;
		if (typeof v.deviceId !== "string" || !v.deviceId) return null;
		if (typeof v.localDbId !== "string" || !v.localDbId) return null;
		return {
			deviceId: v.deviceId,
			localDbId: v.localDbId,
			isMaster: v.isMaster === true,
			unsafeShutdown: v.unsafeShutdown === true,
			unsafeShutdownStreak: typeof v.unsafeShutdownStreak === "number" ? v.unsafeShutdownStreak : 0,
		};
	} catch {
		return null;
	}
}

export function saveDeviceState(store: DeviceStateStore, settings: CouchDBSyncSettings): void {
	store.set(DEVICE_STATE_STORAGE_KEY, JSON.stringify(pick(settings)));
}

/**
 * Put this device's identity into `settings` (loaded from `data.json`): the stored
 * one if there is one, otherwise the migration described above. Returns true if the
 * device store was written (first start with this logic).
 */
export function adoptDeviceState(
	settings: CouchDBSyncSettings,
	store: DeviceStateStore,
	newId: () => string
): boolean {
	const stored = loadDeviceState(store);
	if (stored) {
		Object.assign(settings, stored);
		return false;
	}
	settings.deviceId = newId();
	if (!settings.localDbId) settings.localDbId = newId();
	saveDeviceState(store, settings);
	return true;
}

/** A copy of what is about to be written to `data.json`, without the device fields. */
export function withoutDeviceState<T extends object>(persisted: T): T {
	const out = { ...persisted } as T & Partial<DeviceState>;
	for (const k of DEVICE_KEYS) delete out[k];
	return out;
}
