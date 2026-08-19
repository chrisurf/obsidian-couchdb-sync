import { browser, expect } from "@wdio/globals";
import { describe, it, before } from "mocha";
import assert from "node:assert/strict";
import { PLUGIN_ID } from "./helpers.js";

/**
 * The credential-storage guarantee, asserted against the file that actually lands on
 * disk: `data.json` must never contain the CouchDB password or the E2EE passphrase in
 * readable form. Unit tests cover the sealing itself (tests/secrets.test.ts); only a
 * real Obsidian can prove that what `saveData` wrote is the sealed shape.
 *
 * No CouchDB server required — nothing here syncs, it only saves settings.
 */
describe("CouchDB Sync — credential storage", function () {
	const PASSWORD = "e2e-plaintext-password-9f3a";
	const PASSPHRASE = "e2e-plaintext-passphrase-7c1b";
	let raw: string;
	let settingsAfter: { password: string; passphrase: string; encryptedSecrets: string };

	before(async function () {
		raw = await browser.executeObsidian(
			async ({ app }, id, password, passphrase) => {
				const plugin = (
					app as unknown as {
						plugins: {
							plugins: Record<
								string,
								{ settings: Record<string, unknown>; saveSettings(): Promise<void> }
							>;
						};
					}
				).plugins.plugins[id];
				plugin.settings.password = password;
				plugin.settings.passphrase = passphrase;
				await plugin.saveSettings();
				return await app.vault.adapter.read(
					`${app.vault.configDir}/plugins/${id}/data.json`
				);
			},
			PLUGIN_ID,
			PASSWORD,
			PASSPHRASE
		);

		settingsAfter = await browser.executeObsidian(({ app }, id) => {
			const plugin = (
				app as unknown as {
					plugins: {
						plugins: Record<
							string,
							{ settings: { password: string; passphrase: string; encryptedSecrets: string } }
						>;
					};
				}
			).plugins.plugins[id];
			const s = plugin.settings;
			return { password: s.password, passphrase: s.passphrase, encryptedSecrets: s.encryptedSecrets };
		}, PLUGIN_ID);
	});

	it("writes neither secret to data.json", async function () {
		assert.ok(!raw.includes(PASSWORD), "data.json contained the plaintext password");
		assert.ok(!raw.includes(PASSPHRASE), "data.json contained the plaintext passphrase");
	});

	it("drops the plaintext keys entirely rather than blanking them", async function () {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		assert.ok(!("password" in parsed), "data.json still has a 'password' key");
		assert.ok(!("passphrase" in parsed), "data.json still has a 'passphrase' key");
	});

	it("stores the sealed blob instead", async function () {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		assert.equal(typeof parsed.encryptedSecrets, "string");
		assert.ok(
			(parsed.encryptedSecrets as string).startsWith("s1:"),
			`unexpected blob: ${String(parsed.encryptedSecrets).slice(0, 40)}`
		);
	});

	it("keeps the credentials usable in memory", async function () {
		// The whole point of sealing at the persistence boundary: everything else in the
		// plugin still reads settings.password / settings.passphrase unchanged.
		await expect(settingsAfter.password).toBe(PASSWORD);
		await expect(settingsAfter.passphrase).toBe(PASSPHRASE);
	});

	it("keeps other settings readable", async function () {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		assert.equal(parsed.secretsMode, "device");
		assert.equal(typeof parsed.deviceId, "string");
	});
});
