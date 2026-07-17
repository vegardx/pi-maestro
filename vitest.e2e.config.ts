import { defineConfig } from "vitest/config";

// E2E lifecycle suite: boots the real orchestrator over the real RPC protocol
// with fakes for tmux/pi/git (see docs/e2e-testing.md). Kept out of the default
// `vitest run` (vitest.config.ts excludes `*.e2e.test.ts`); run via
// `npm run test:e2e`.
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		setupFiles: ["./vitest.setup.ts"],
		pool: "forks",
		fileParallelism: false,
		include: ["test/**/*.e2e.test.ts"],
	},
});
