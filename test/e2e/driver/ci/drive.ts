// Phase 1 driving runner: boots the seeded sandbox-features drive against the
// scripted model and reports how far the lifecycle got — per-node statuses, the
// branches created, and the files committed. Proves a worker reaches a
// committed, complete deliverable.  Run:
//   node_modules/.bin/jiti test/e2e/driver/ci/drive.ts

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedAnswerer } from "../answerer.js";
import { assertEnsemble, assertScenario, readPlan } from "../assertions.js";
import { setupCiEnv } from "../env-profile.js";
import { launchSut } from "../launch.js";
import { ENSEMBLE_METRICS, SANDBOX_FEATURES } from "../scenario.js";
import { seedEnsemblePlan, seedScenarioPlan } from "../seed-plan.js";
import { startScriptedModel } from "./scripted-model.js";

const CI_DIR = join(process.cwd(), "test", "e2e", "driver", "ci");
const MAX_MS = 200_000;
const ENSEMBLE = process.argv.includes("ensemble");

async function main(): Promise<void> {
	const logDir = mkdtempSync(join(tmpdir(), "pi-e2e-drive-"));
	const model = await startScriptedModel({
		logPath: join(logDir, "calls.jsonl"),
		bodyDir: join(logDir, "bodies"),
	});
	process.stdout.write(`scripted model at ${model.url}\nlogs: ${logDir}\n`);

	const profile = setupCiEnv({
		mockBaseUrl: model.url,
		ghShimDir: join(CI_DIR, "gh-shim"),
	});

	const slug = ENSEMBLE
		? seedEnsemblePlan(profile.piHome, profile.repoDir)
		: seedScenarioPlan(profile.piHome, profile.repoDir);
	const sut = launchSut({
		maestroRoot: process.cwd(),
		repoDir: profile.repoDir,
		piHome: profile.piHome,
		answerer: new ScriptedAnswerer(),
		env: profile.env,
		extraExtensions: profile.extraExtensions,
		transcriptPath: join(profile.piHome, "events.jsonl"),
	});

	for (const prompt of [`/plan ${slug}`, "/start"]) {
		const state = (await sut.client.getState()) as { isStreaming?: boolean };
		await sut.client.prompt(prompt, state.isStreaming ? "followUp" : undefined);
		await sleep(1500);
	}

	const start = Date.now();
	const check = () =>
		ENSEMBLE
			? assertEnsemble(profile.piHome, profile.repoDir, ENSEMBLE_METRICS, {
					parentBranch: "feat/build-metrics",
					minCandidates: 2,
					...(profile.env.PI_E2E_GH_STATE
						? { ghStateDir: profile.env.PI_E2E_GH_STATE }
						: {}),
				})
			: assertScenario(profile.piHome, profile.repoDir, SANDBOX_FEATURES);

	let lastLine = "";
	while (Date.now() - start < MAX_MS) {
		await sleep(2000);
		const death = sut.died();
		if (death) {
			process.stdout.write(
				`SUT died: code=${death.code} signal=${death.signal}\n${death.stderr ?? ""}\n`,
			);
			break;
		}
		const plan = readPlan(profile.piHome, slug);
		const nodes = plan?.nodes ?? [];
		const line = nodes.map((n) => `${n.id}=${n.status}`).join(" ");
		if (line !== lastLine) {
			lastLine = line;
			process.stdout.write(
				`[${Math.round((Date.now() - start) / 1000)}s calls=${model.seq()}] ${line}\n`,
			);
		}
		// Done when the real assertion passes (reviewer nodes end at `complete`,
		// not `shipped`, so poll the assertion rather than a status set).
		if (check().ok) {
			process.stdout.write("assertion satisfied\n");
			break;
		}
	}

	const plan = readPlan(profile.piHome, slug);
	process.stdout.write("\n=== final node statuses ===\n");
	for (const n of plan?.nodes ?? [])
		process.stdout.write(
			`  ${n.id}: ${n.status}${n.prUrl ? ` (PR ${n.prUrl})` : ""}${n.workerModel ? ` [${n.workerModel}]` : ""}\n`,
		);
	process.stdout.write("\n=== committed files (git log --all) ===\n");
	try {
		process.stdout.write(
			execFileSync(
				"git",
				["log", "--all", "--pretty=format:%d %s", "--name-only"],
				{
					cwd: profile.repoDir,
					encoding: "utf8",
				},
			),
		);
	} catch (e) {
		process.stdout.write(
			`(git log failed: ${e instanceof Error ? e.message : String(e)})\n`,
		);
	}
	process.stdout.write(
		`\n\nmodel calls: ${model.seq()}\nlogs kept: ${logDir}\npiHome kept: ${profile.piHome}\n`,
	);

	const result = check();
	process.stdout.write(
		`\n=== assert${ENSEMBLE ? "Ensemble" : "Scenario"}: ${result.ok ? "OK ✓" : "FAIL ✗"} ===\n${result.summary}\n`,
	);

	sut.client.close();
	sut.child.kill("SIGKILL");
	await model.close();
	void lastLine;
	process.exitCode = result.ok ? 0 : 1;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

main().then(
	() => process.exit(0),
	(err) => {
		process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
		process.exit(1);
	},
);
