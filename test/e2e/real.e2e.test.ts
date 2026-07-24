// The scripted full-stack driver: boots a REAL `pi --mode rpc` with the whole
// maestro stack in the deterministic CI profile (a scripted mock model + local
// bare remote + gh shim), seeds a canned plan, drives it to shipped over the
// real RPC protocol, and asserts on real outcomes (plan.json statuses + git
// history). No tmux, no API key, no cassette — the scripted model (ci/
// scripted-model.ts) synthesizes the tool-call turns deterministically, so this
// runs on every PR.
//
// Gated only by PI_E2E_FULL=1 (it boots a real pi process and spawns real
// worker processes, so it is heavier than the unit suite and excluded from the
// default `vitest run`). test:e2e:full sets it.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptedAnswerer } from "./driver/answerer.js";
import { assertEnsemble, assertScenario } from "./driver/assertions.js";
import {
	type RunningScriptedModel,
	startScriptedModel,
} from "./driver/ci/scripted-model.js";
import { type EnvProfile, setupCiEnv } from "./driver/env-profile.js";
import { type LaunchedSut, launchSut } from "./driver/launch.js";
import { ENSEMBLE_METRICS, SANDBOX_FEATURES } from "./driver/scenario.js";
import { seedEnsemblePlan, seedScenarioPlan } from "./driver/seed-plan.js";

const REPO_ROOT = process.cwd();
const CI_DIR = join(REPO_ROOT, "test", "e2e", "driver", "ci");
const RUN = process.env.PI_E2E_FULL === "1";

interface Drive {
	readonly profile: EnvProfile;
	readonly sut: LaunchedSut;
	readonly model: RunningScriptedModel;
}

/** Boot the CI profile against the scripted model, seed a plan, drive to auto. */
async function boot(
	seed: (piHome: string, repoDir: string) => string,
): Promise<Drive> {
	const model = await startScriptedModel();
	const profile = setupCiEnv({
		mockBaseUrl: model.url,
		ghShimDir: join(CI_DIR, "gh-shim"),
	});
	const slug = seed(profile.piHome, profile.repoDir);
	const sut = launchSut({
		maestroRoot: REPO_ROOT,
		repoDir: profile.repoDir,
		piHome: profile.piHome,
		answerer: new ScriptedAnswerer(),
		env: profile.env,
		extraExtensions: profile.extraExtensions,
		transcriptPath: join(profile.piHome, "events.jsonl"),
	});
	// Seeded: open the plan and go straight at execution — no model-sensitive
	// authoring (docs/modes-architecture.md backlog #7).
	for (const prompt of [`/plan ${slug}`, "/start"]) {
		const state = (await sut.client.getState()) as { isStreaming?: boolean };
		await sut.client.prompt(prompt, state.isStreaming ? "followUp" : undefined);
	}
	return { profile, sut, model };
}

function teardown(drive: Drive | undefined): void {
	drive?.sut.client.close();
	drive?.sut.child.kill("SIGKILL");
	drive?.profile.teardown();
	void drive?.model.close();
}

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

describe.skipIf(!RUN)("scripted full-stack e2e", () => {
	it(
		"drives the seeded sandbox-features plan to shipped",
		async () => {
			let drive: Drive | undefined;
			try {
				drive = await boot(seedScenarioPlan);
				const p = drive.profile;
				const check = () =>
					assertScenario(p.piHome, p.repoDir, SANDBOX_FEATURES);
				await waitForAssertion(
					() => check().ok,
					4 * 60 * 1000,
					() => drive?.sut.died(),
				);
				const result = check();
				expect(result.ok, result.summary).toBe(true);
			} finally {
				teardown(drive);
			}
		},
		5 * 60 * 1000,
	);

	it(
		"drives the seeded ensemble to one integrated PR (candidates never ship)",
		async () => {
			let drive: Drive | undefined;
			try {
				drive = await boot(seedEnsemblePlan);
				const p = drive.profile;
				const check = () =>
					assertEnsemble(p.piHome, p.repoDir, ENSEMBLE_METRICS, {
						parentBranch: "feat/build-metrics",
						minCandidates: 2,
						...(p.env.PI_E2E_GH_STATE
							? { ghStateDir: p.env.PI_E2E_GH_STATE }
							: {}),
					});
				await waitForAssertion(
					() => check().ok,
					4 * 60 * 1000,
					() => drive?.sut.died(),
				);
				const result = check();
				expect(result.ok, result.summary).toBe(true);
			} finally {
				teardown(drive);
			}
		},
		5 * 60 * 1000,
	);
});
