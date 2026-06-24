import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		// A single forked worker keeps the process tree shallow, so an abrupt
		// host kill orphans at most one child. `fileParallelism: false` reuses
		// one fork across all files (vitest 4 replacement for singleFork).
		pool: "forks",
		fileParallelism: false,
	},
});
