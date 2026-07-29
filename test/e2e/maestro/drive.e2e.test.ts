// The seeded drive: a real `pi` seat runs a real plan with real workers.
//
// Everything below the model is production code. Real `pi` processes, the
// rebuilt maestro extension loaded from disk, the socket, the handshake, the
// worktrees, the commits, the release, and the run record on disk. The one
// substitution is the model itself — a scripted server that keys on which
// tools a session holds, so no phrasing in a persona can quietly change what
// this proves.
//
// It is the acceptance bar minus a live provider: a plan authored elsewhere,
// stored, and executed end to end from a `/run`.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { plansRoot } from "../../../packages/maestro/src/paths.js";
import type { Plan } from "../../../packages/maestro/src/plan.js";
import type { Run } from "../../../packages/maestro/src/run.js";
import { createPlanStore } from "../../../packages/maestro/src/store.js";
import { ScriptedAnswerer } from "../driver/answerer.js";
import { setupCiEnv } from "../driver/env-profile.js";
import { launchSut } from "../driver/launch.js";
import { startScriptedModel } from "./scripted-model.js";

const MAESTRO_ROOT = process.cwd();
const MAESTRO_EXTENSION = join(
	MAESTRO_ROOT,
	"packages",
	"maestro",
	"src",
	"extension.ts",
);
const CI_DIR = join(MAESTRO_ROOT, "test", "e2e", "driver", "ci");
const SLUG = "drive";

const cleanups: (() => void | Promise<void>)[] = [];
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
});

/** The plan the drive runs. Written through the real store, so it is valid. */
function seed(agentDir: string, repoDir: string): Plan {
	const plan: Plan = {
		slug: SLUG,
		title: "Drive",
		preflight: [],
		postflight: [],
		repos: [{ key: "main", path: repoDir }],
		deliverables: [
			{
				id: "base",
				title: "Deliverable base",
				after: [],
				reads: [],
				tasks: [{ id: "base-1", title: "Write the base file" }],
			},
			{
				id: "stacked",
				title: "Deliverable stacked",
				// Waits AND reads: its brief should carry `base`'s hand-off.
				after: ["base"],
				reads: ["base"],
				tasks: [{ id: "stacked-1", title: "Write the stacked file" }],
			},
		],
	};
	createPlanStore(plansRoot(agentDir)).savePlan(plan);
	return plan;
}

function readRun(agentDir: string): Run | null {
	const path = join(plansRoot(agentDir), SLUG, "run.json");
	if (!existsSync(path)) return null;
	return (JSON.parse(readFileSync(path, "utf8")) as { body: Run }).body;
}

describe("a stored plan runs from a real seat", () => {
	it("reaches shipped through worktrees, workers and hand-offs", {
		timeout: 240_000,
	}, async () => {
		const model = await startScriptedModel();
		cleanups.push(() => model.close());

		const profile = setupCiEnv({
			mockBaseUrl: model.url,
			ghShimDir: join(CI_DIR, "gh-shim"),
		});
		cleanups.push(profile.teardown);

		const agentDir = join(profile.piHome, ".pi", "agent");
		seed(agentDir, profile.repoDir);

		const sut = launchSut({
			maestroRoot: MAESTRO_ROOT,
			repoDir: profile.repoDir,
			piHome: profile.piHome,
			answerer: new ScriptedAnswerer(),
			env: profile.env,
			// ONLY the rebuilt maestro. Loading it beside the old stack would
			// mean two extensions registering `/mode`, and the drive would be
			// testing whichever won.
			extensions: [MAESTRO_EXTENSION],
			extraExtensions: profile.extraExtensions,
			transcriptPath: join(profile.piHome, "events.jsonl"),
		});
		cleanups.push(() => sut.client.close());

		// Commands go in the way a human types them. A plan produces workers,
		// so the seat has to be able to write before it can run one.
		await sut.client.prompt("/mode auto");
		await sut.client.prompt(`/run ${SLUG}`);

		const deadline = Date.now() + 180_000;
		let run = readRun(agentDir);
		while (Date.now() < deadline) {
			run = readRun(agentDir);
			if (run?.deliverables.stacked?.state === "done") break;
			if (run?.deliverables.base?.state === "failed") break;
			await new Promise((r) => setTimeout(r, 1000));
		}

		expect(run).not.toBeNull();
		const record = run as Run;

		// Plan preflight is empty, so it lands without asking the model.
		expect(record.preflight?.state).toBe("done");

		// Both deliverables ran, in DAG order, each in its own worktree.
		expect(record.deliverables.base?.state).toBe("done");
		expect(record.deliverables.base?.branch).toBe("deliverable/base");
		expect(record.deliverables.stacked?.state).toBe("done");

		// The hand-off came back over the socket, from a real worker calling
		// `finish` — not from anything this harness wrote.
		expect(record.deliverables.base?.handoff).toContain("built.txt");

		// And `reads` carried it INTO the next worker's brief: `stacked`
		// echoes what it was told it inherits, so this is the plan model's
		// central claim proved from the worker's own side rather than from
		// the maestro that sent it.
		expect(record.deliverables.stacked?.handoff).toContain(
			"inherited from base",
		);

		// And it was committed inside the worktree, by the worker.
		const log = execFileSync("git", ["log", "--oneline", "deliverable/base"], {
			cwd: profile.repoDir,
			encoding: "utf8",
		});
		expect(log).toContain("build base");
	});
});
