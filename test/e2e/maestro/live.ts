// The live drive for the rebuilt maestro.
//
//   node_modules/.bin/jiti test/e2e/maestro/live.ts [--prod-models] [--keep]
//                                                  [--recover]
//
// Real models, real worktrees, real commits, a local bare remote. The seeded
// plan is the acceptance bar in one shape: a worker that builds something,
// hands the diff to a reviewer, ACTS on what comes back, and only then
// reports — followed by a second deliverable that reads the first's hand-off.
//
// A worker spawning a read-only review panel and acting on its findings before
// shipping has never once happened in this system. That is what this is for.
//
// `--recover` drives the other question a unit test cannot reach: the maestro
// is SIGKILLed while a worker is in flight, and a new one is started over the
// same store. The worker is a detached process holding a socket that just
// died, and what happens to it is not knowable from the code — hence a drive.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { plansRoot } from "../../../packages/maestro/src/paths.js";
import type { Plan } from "../../../packages/maestro/src/plan.js";
import type { Run } from "../../../packages/maestro/src/run.js";
import { standings } from "../../../packages/maestro/src/run.js";
import { createPlanStore } from "../../../packages/maestro/src/store.js";
import { ScriptedAnswerer } from "../driver/answerer.js";
import { setupLiveEnv } from "../driver/env-profile.js";
import { launchSut } from "../driver/launch.js";
import { buildProdProfile } from "../driver/prod-profile.js";
import { buildSitProfile } from "../driver/sit-profile.js";

const ROOT = process.cwd();
const MAESTRO_EXTENSION = join(ROOT, "packages/maestro/src/extension.ts");
const SLUG = "live-drive";
const DEADLINE_MS = 20 * 60_000;

const PROD = process.argv.includes("--prod-models");
const RECOVER = process.argv.includes("--recover");

function plan(repoDir: string): Plan {
	return {
		slug: SLUG,
		title: "Live drive",
		preflight: [],
		postflight: [],
		repos: [{ key: "main", path: repoDir }],
		deliverables: [
			{
				id: "stats",
				title: "A small statistics module",
				body: "A self-contained module with a couple of functions and tests. Keep it small — this exists to be reviewed, not to be impressive.",
				after: [],
				reads: [],
				tasks: [
					{
						id: "stats-build",
						title: "Write src/stats.ts and tests/stats.test.ts",
						body: "Export `mean` and `median` over a number array. Handle the empty array explicitly rather than returning NaN. Add tests that would fail if the empty case regressed.",
					},
					{
						id: "stats-review",
						title: "Have the diff reviewed",
						body: "Ask for a review of what you just wrote, and be specific about what you want looked at.",
						by: { persona: "code-review" },
					},
					{
						id: "stats-act",
						title: "Act on the findings",
						body: "Fix what the review found and commit the fix. If it found nothing worth changing, say so in your hand-off rather than silently moving on.",
					},
				],
			},
			{
				id: "summary",
				title: "A README section describing the module",
				body: "One short section. Write it from the hand-off rather than by re-reading the code.",
				after: ["stats"],
				reads: ["stats"],
				tasks: [
					{
						id: "summary-write",
						title: "Add a Statistics section to README.md",
						body: "Describe what the module exports and how the empty case behaves.",
					},
				],
			},
		],
	};
}

function readRun(agentDir: string): Run | null {
	const path = join(plansRoot(agentDir), SLUG, "run.json");
	if (!existsSync(path)) return null;
	try {
		return (JSON.parse(readFileSync(path, "utf8")) as { body: Run }).body;
	} catch {
		// A read that lands mid-rename sees nothing; the next poll sees the file.
		return null;
	}
}

/** Whether a pid is still a live process. Signal 0 tests, it does not kill. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Every worker pi launched under this drive's home, by pid. */
function workerPids(piHome: string): number[] {
	try {
		const out = execFileSync("ps", ["-Ao", "pid=,command="], {
			encoding: "utf8",
		});
		return out
			.split("\n")
			.filter((line) => line.includes(piHome) && line.includes("--session"))
			.map((line) => Number.parseInt(line.trim().split(/\s+/)[0] as string, 10))
			.filter((pid) => Number.isFinite(pid));
	} catch {
		return [];
	}
}

async function main(): Promise<void> {
	const profile = PROD ? buildProdProfile() : await buildSitProfile();
	process.stdout.write(
		`seat model: ${profile.defaultProvider}/${profile.defaultModel}\n`,
	);

	const env = setupLiveEnv({
		localRemote: true,
		keep: process.argv.includes("--keep"),
		defaultProvider: profile.defaultProvider,
		defaultModel: profile.defaultModel,
		modelsJsonContent: profile.modelsJsonContent,
		models: profile.models,
	});
	const agentDir = join(env.piHome, ".pi", "agent");
	const stored = plan(env.repoDir);
	createPlanStore(plansRoot(agentDir)).savePlan(stored);
	process.stdout.write(`repo: ${env.repoDir}\npiHome: ${env.piHome}\n\n`);

	const launch = (tag: string) =>
		launchSut({
			maestroRoot: ROOT,
			repoDir: env.repoDir,
			piHome: env.piHome,
			answerer: new ScriptedAnswerer(),
			env: env.env,
			// Only the rebuilt maestro: the old stack registers `/mode` too.
			extensions: [MAESTRO_EXTENSION],
			extraExtensions: env.extraExtensions,
			transcriptPath: join(env.piHome, `events${tag}.jsonl`),
		});

	let sut = launch("");
	await sut.client.prompt("/mode auto");
	await sut.client.prompt(`/run ${SLUG}`);

	if (RECOVER) {
		// Wait for a worker to be genuinely in flight — a record with an agent
		// on it. Killing before that would prove only that a plan with nothing
		// running restarts, which is not the question.
		const until = Date.now() + 4 * 60_000;
		let flying: string | undefined;
		while (Date.now() < until && !flying) {
			const run = readRun(agentDir);
			flying = Object.entries(run?.deliverables ?? {}).find(
				([, r]) => r.state === "running" && r.agentId,
			)?.[0];
			if (!flying) await new Promise((r) => setTimeout(r, 2000));
		}
		if (!flying) {
			process.stdout.write("no worker ever went in flight — nothing to test\n");
			process.exit(1);
		}

		const orphans = workerPids(env.piHome);
		process.stdout.write(
			`\n─── recovery ───\nin flight: ${flying}\nworker pids: ${orphans.join(", ") || "none found"}\n`,
		);

		// SIGKILL, not SIGTERM: the case worth proving is the one with no
		// chance to clean up — a crash, an OOM, a closed laptop.
		process.kill(sut.child.pid as number, "SIGKILL");
		await new Promise((r) => setTimeout(r, 3000));
		process.stdout.write(
			`maestro killed. workers still alive: ${orphans.filter(alive).join(", ") || "none"}\n`,
		);

		sut = launch("-2");
		await sut.client.prompt("/mode auto");
		await sut.client.prompt(`/run ${SLUG}`);
		process.stdout.write("second maestro started, plan re-run\n\n");
	}

	const deadline = Date.now() + DEADLINE_MS;
	let seen = "";
	let run: Run | null = null;
	while (Date.now() < deadline) {
		const death = sut.died();
		if (death) {
			process.stdout.write(`\nSUT DIED: ${JSON.stringify(death)}\n`);
			break;
		}
		run = readRun(agentDir);
		if (run) {
			const where = [...standings(stored, run)]
				.map(([id, standing]) => `${id}=${standing}`)
				.join(" ");
			if (where !== seen) {
				seen = where;
				process.stdout.write(`${new Date().toISOString()}  ${where}\n`);
			}
			const done = [...standings(stored, run).values()];
			if (
				done.every((s) => s === "shipped" || s === "failed" || s === "stranded")
			)
				break;
		}
		await new Promise((r) => setTimeout(r, 3000));
	}

	process.stdout.write("\n─── result ───\n");
	if (!run) {
		process.stdout.write("no run record was ever written\n");
	} else {
		for (const [id, standing] of standings(stored, run)) {
			const record = run.deliverables[id];
			process.stdout.write(`${id}: ${standing}\n`);
			if (record?.handoff)
				process.stdout.write(`  handoff: ${record.handoff}\n`);
			if (record?.failure)
				process.stdout.write(`  failure: ${record.failure}\n`);
			if (record?.pr) process.stdout.write(`  pr: #${record.pr}\n`);
		}
	}

	for (const branch of ["deliverable/stats", "deliverable/summary"]) {
		try {
			const log = execFileSync("git", ["log", "--oneline", branch], {
				cwd: env.repoDir,
				encoding: "utf8",
			});
			process.stdout.write(`\n${branch}:\n${log}`);
		} catch {
			process.stdout.write(`\n${branch}: never created\n`);
		}
	}

	process.stdout.write(`\ntranscript: ${join(env.piHome, "events.jsonl")}\n`);
	sut.client.close();
	process.exit(0);
}

void main();
