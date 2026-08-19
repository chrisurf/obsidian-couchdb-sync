import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
	resolve: {
		alias: {
			// The real "obsidian" package is types-only; route runtime imports to a stub.
			obsidian: fileURLToPath(new URL("./tests/obsidian-stub.ts", import.meta.url)),
		},
	},
	test: {
		globals: true,
		environment: "node",
		include: ["tests/**/*.test.ts"],
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: [
				"src/main.ts",
				"src/settings.ts",
				"src/indexpanel.ts",
				"src/view.ts",
				// Obsidian-API-only UI (Modal); covered by the e2e suite.
				"src/secretsmodal.ts",
			],
		},
	},
});
