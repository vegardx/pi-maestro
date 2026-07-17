import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		// E2E lifecycle tests boot the real orchestrator and are run separately
		// via `npm run test:e2e` (vitest.e2e.config.ts) so the unit suite — and
		// `npm run check` — stays fast. See docs/e2e-testing.md.
		exclude: [...configDefaults.exclude, "test/**/*.e2e.test.ts"],
		// Strip leaked git env (GIT_DIR et al.) before any test file loads —
		// see vitest.setup.ts for the incident this prevents.
		setupFiles: ["./vitest.setup.ts"],
		// A single forked worker keeps the process tree shallow, so an abrupt
		// host kill orphans at most one child. `fileParallelism: false` reuses
		// one fork across all files (vitest 4 replacement for singleFork).
		pool: "forks",
		fileParallelism: false,
	},
});
