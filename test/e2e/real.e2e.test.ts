// The scripted full-stack driver: boots a REAL `pi --mode rpc` with the whole
// maestro stack in the deterministic CI profile (a scripted mock model + local
// bare remote + gh shim), seeds the canned plan, drives it to shipped over the
// real RPC protocol, and asserts on real outcomes (plan.json statuses + git
// history). No tmux, no API key, no cassette — the scripted model (ci/
// scripted-model.ts) synthesizes the tool-call turns deterministically, so this
// runs on every PR.
//
// Gated only by PI_E2E_FULL=1 (it boots a real pi process and spawns real
// worker processes, so it is heavier than the unit suite and excluded from the
// default `vitest run`). test:e2e:full sets it.

import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ScriptedAnswerer } from "./driver/answerer.js";
import { assertScenario } from "./driver/assertions.js";
import {
	type RunningScriptedModel,
	startScriptedModel,
} from "./driver/ci/scripted-model.js";
import { type EnvProfile, setupCiEnv } from "./driver/env-profile.js";
import { type LaunchedSut, launchSut } from "./driver/launch.js";
import { SANDBOX_FEATURES } from "./driver/scenario.js";
import { seedScenarioPlan } from "./driver/seed-plan.js";

const REPO_ROOT = process.cwd();
const CI_DIR = join(REPO_ROOT, "test", "e2e", "driver", "ci");
const RUN = process.env.PI_E2E_FULL === "1";

describe.skipIf(!RUN)("scripted full-stack e2e", () => {
	let model: RunningScriptedModel | undefined;
	let profile: EnvProfile | undefined;
	let sut: LaunchedSut | undefined;

	afterAll(async () => {
		sut?.client.close();
		sut?.child.kill("SIGKILL");
		profile?.teardown();
		await model?.close();
	});

	it(
		"drives the seeded sandbox-features plan to shipped",
		async () => {
			model = await startScriptedModel();
			const p = setupCiEnv({
				mockBaseUrl: model.url,
				ghShimDir: join(CI_DIR, "gh-shim"),
			});
			profile = p;
			const slug = seedScenarioPlan(p.piHome, p.repoDir);

			sut = launchSut({
				maestroRoot: REPO_ROOT,
				repoDir: p.repoDir,
				piHome: p.piHome,
				answerer: new ScriptedAnswerer(),
				env: p.env,
				extraExtensions: p.extraExtensions,
				transcriptPath: join(p.piHome, "events.jsonl"),
			});

			// Seeded: open the plan and go straight at execution — no model-sensitive
			// authoring (docs/modes-architecture.md backlog #7).
			for (const prompt of [`/plan ${slug}`, "/start"]) {
				const state = (await sut.client.getState()) as {
					isStreaming?: boolean;
				};
				await sut.client.prompt(
					prompt,
					state.isStreaming ? "followUp" : undefined,
				);
			}

			// Poll until the real assertion passes (or the SUT dies / we time out) —
			// robust against reviewer nodes ending at `complete` rather than `shipped`.
			await waitForAssertion(
				() => assertScenario(p.piHome, p.repoDir, SANDBOX_FEATURES).ok,
				4 * 60 * 1000,
				() => sut?.died(),
			);

			const result = assertScenario(p.piHome, p.repoDir, SANDBOX_FEATURES);
			expect(result.ok, result.summary).toBe(true);
		},
		5 * 60 * 1000,
	);
});

/** Resolve once `pass()` is true (assertion satisfied), the SUT dies, or timeout. */
function waitForAssertion(
	pass: () => boolean,
	timeoutMs: number,
	died: () => unknown,
): Promise<void> {
	const start = Date.now();
	return new Promise((resolve) => {
		const tick = () => {
			if (died() || pass() || Date.now() - start > timeoutMs) {
				resolve();
				return;
			}
			setTimeout(tick, 2000);
		};
		tick();
	});
}
