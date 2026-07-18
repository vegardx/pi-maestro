import { defineConfig } from "vitest/config";

// Full-stack scripted e2e: boots a REAL `pi --mode rpc` maestro in the CI
// profile (mock provider + local remote + gh shim) and drives the canned
// scenario to shipped. Gated behind PI_E2E_FULL=1 and a recorded cassette (the
// test self-skips otherwise). Kept in its own config — separate from the
// hermetic `test:e2e` suite — because a real run takes minutes.
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 6 * 60 * 1000,
		hookTimeout: 60 * 1000,
		setupFiles: ["./vitest.setup.ts"],
		pool: "forks",
		fileParallelism: false,
		include: ["test/e2e/real.e2e.test.ts"],
	},
});
