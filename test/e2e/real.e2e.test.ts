// The scripted full-stack driver: boots a REAL `pi --mode rpc` with the whole
// maestro stack in the deterministic CI profile (mock model provider + local
// bare remote + gh shim), plays the canned scenario with rule-based answers, and
// asserts on real shipped outcomes.
//
// It shares the driver core with the LLM-driver (test/e2e/driver/cli.ts); the
// only difference is *who decides* the prompts and answers — here a fixed
// sequence + ScriptedAnswerer instead of a live agent.
//
// GATED. It runs only when PI_E2E_FULL=1 AND a recorded cassette exists (or
// PI_E2E_RECORD=1 is set to record one against a real upstream). Without a
// cassette the mock provider has nothing to serve, so the test skips rather than
// fail — see docs/e2e-testing.md for the one-time recording procedure.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ScriptedAnswerer } from "./driver/answerer.js";
import { assertScenario, readPlan } from "./driver/assertions.js";
import { startCassetteServer } from "./driver/ci/cassette-server.js";
import { setupCiEnv } from "./driver/env-profile.js";
import { type LaunchedSut, launchSut } from "./driver/launch.js";
import { resolveSteps, SANDBOX_FEATURES } from "./driver/scenario.js";

const REPO_ROOT = process.cwd();
const CI_DIR = join(REPO_ROOT, "test", "e2e", "driver", "ci");
const CASSETTE_DIR =
	process.env.PI_E2E_CASSETTE_DIR ?? join(CI_DIR, "cassettes");
const RECORD = process.env.PI_E2E_RECORD === "1";

const hasCassettes =
	existsSync(CASSETTE_DIR) &&
	readdirSync(CASSETTE_DIR).some((f) => f.endsWith(".json"));
const RUN = process.env.PI_E2E_FULL === "1" && (hasCassettes || RECORD);

describe.skipIf(!RUN)("scripted full-stack e2e", () => {
	let teardown: (() => void) | undefined;
	let closeCassette: (() => Promise<void>) | undefined;
	let sut: LaunchedSut | undefined;

	afterAll(async () => {
		sut?.client.close();
		sut?.child.kill("SIGKILL");
		teardown?.();
		await closeCassette?.();
	});

	it(
		"drives the sandbox-features plan to shipped",
		async () => {
			const cassette = await startCassetteServer({
				dir: CASSETTE_DIR,
				mode: RECORD ? "record" : "replay",
				upstreamBaseUrl:
					process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
				onMiss: (key, method, path) =>
					process.stderr.write(`cassette miss ${method} ${path} (${key})\n`),
			});
			closeCassette = cassette.close;

			const profile = setupCiEnv({
				mockProviderExtension: join(CI_DIR, "mock-provider.ts"),
				mockBaseUrl: cassette.url,
				ghShimDir: join(CI_DIR, "gh-shim"),
			});
			teardown = profile.teardown;

			sut = launchSut({
				maestroRoot: REPO_ROOT,
				repoDir: profile.repoDir,
				piHome: profile.piHome,
				answerer: new ScriptedAnswerer(),
				env: profile.env,
				extraExtensions: profile.extraExtensions,
				transcriptPath: join(profile.piHome, "events.jsonl"),
			});

			// Play the fixed prompt sequence.
			for (const step of resolveSteps(SANDBOX_FEATURES)) {
				const state = (await sut.client.getState()) as {
					isStreaming?: boolean;
				};
				await sut.client.prompt(
					step.prompt,
					state.isStreaming ? "followUp" : undefined,
				);
			}

			// Poll plan state until every deliverable is terminal or we time out.
			await waitForShipped(profile.piHome, 5 * 60 * 1000);

			const result = assertScenario(
				profile.piHome,
				profile.repoDir,
				SANDBOX_FEATURES,
			);
			expect(result.ok, result.summary).toBe(true);
		},
		6 * 60 * 1000,
	);
});

/** Resolve once every deliverable reaches a terminal status (or times out). */
function waitForShipped(piHome: string, timeoutMs: number): Promise<void> {
	const terminal = new Set(["shipped", "failed", "abandoned", "superseded"]);
	const start = Date.now();
	return new Promise((resolve) => {
		const tick = () => {
			const plan = readPlan(piHome, SANDBOX_FEATURES.name);
			const nodes = plan?.nodes ?? [];
			const settled =
				nodes.length > 0 && nodes.every((node) => terminal.has(node.status));
			if (settled || Date.now() - start > timeoutMs) {
				resolve();
				return;
			}
			setTimeout(tick, 3000);
		};
		tick();
	});
}
