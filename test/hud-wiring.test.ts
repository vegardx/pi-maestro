// HUD data builders: the agents tree (execution workers + subagent runs
// with parent nesting and terminal aging), the watch rows (list + cancel
// only), and the /steer prefill.

import type { RunRecord, WatchRecord } from "@vegardx/pi-contracts";
import { describe, expect, it } from "vitest";
import type { ExecutionAgentSnapshot } from "../packages/modes/src/exec/index.js";
import {
	listAgentTargets,
	stopAgentTarget,
} from "../packages/modes/src/runtime/agent-targets.js";
import {
	buildAgentNodes,
	buildPlanView,
	buildQuestionRows,
	buildWatchNodes,
	steerPrefix,
} from "../packages/modes/src/runtime/hud-wiring.js";

const NOW = 5_000_000;

function execAgent(
	status: string,
	overrides: Partial<ExecutionAgentSnapshot> = {},
): ExecutionAgentSnapshot {
	return {
		status,
		startedAt: NOW - 60_000,
		tokens: { input: 0, output: 0, turns: 0 },
		...overrides,
	};
}

function run(
	id: string,
	status: RunRecord["status"],
	overrides: Partial<RunRecord> & { role?: string } = {},
): RunRecord {
	const { role, ...rest } = overrides;
	return {
		id: id as RunRecord["id"],
		profile: { profile: role ?? "research", role: role ?? "research" },
		status,
		createdAt: NOW - 30_000,
		updatedAt: NOW - 1_000,
		...rest,
	} as RunRecord;
}

describe("buildAgentNodes", () => {
	it("groups execution agents under their worker with statuses mapped to words", () => {
		const nodes = buildAgentNodes(
			{
				agents: new Map([
					["auth/worker", execAgent("working", { model: "fable-5" })],
					["auth/reviewer", execAgent("pending")],
					["billing/worker", execAgent("done")],
				]),
				deliverables: new Map(),
			},
			[],
			NOW,
		);
		expect(nodes.map((n) => n.label)).toEqual([
			"worker · auth",
			"worker · billing",
		]);
		expect(nodes[0].status).toBe("running");
		expect(nodes[0].note).toBe("fable-5");
		expect(nodes[0].children.map((c) => c.label)).toEqual(["reviewer · auth"]);
		expect(nodes[0].children[0].status).toBe("starting");
		expect(nodes[1].status).toBe("done");
	});

	it("marks a worker blocked from the deliverable snapshot", () => {
		const nodes = buildAgentNodes(
			{
				agents: new Map([["auth/worker", execAgent("working")]]),
				deliverables: new Map([["auth", { blocked: "ship gate" }]]),
			},
			[],
			NOW,
		);
		expect(nodes[0].status).toBe("blocked");
	});

	it("propagates immutable completion and cumulative telemetry", () => {
		const nodes = buildAgentNodes(
			{
				agents: new Map([
					[
						"auth/worker",
						execAgent("done", {
							startedAt: NOW - 300_000,
							completedAt: NOW - 120_000,
							tokens: {
								input: 5_000,
								output: 400,
								cacheRead: 20_000,
								cacheWrite: 1_000,
								promptTokens: 26_000,
								totalTokens: 26_400,
								cost: 1,
								turns: 4,
							},
							model: "provider/claude-sonnet-4-20260101",
							effort: "high",
						}),
					],
				]),
				deliverables: new Map(),
			},
			[],
			NOW,
		);
		expect(nodes[0]).toMatchObject({
			completedAt: NOW - 120_000,
			input: 26_000,
			output: 400,
			cacheRead: 20_000,
			cacheWrite: 1_000,
			model: "provider/claude-sonnet-4-20260101",
			effort: "high",
		});
	});

	it("nests runs under their parent run and keeps orphans at root", () => {
		const nodes = buildAgentNodes(
			undefined,
			[
				run("r-parent", "running", { role: "research" }),
				run("r-child", "running", {
					role: "verify",
					parent: "r-parent" as RunRecord["parent"],
				}),
				run("r-solo", "running", { role: "reviewer" }),
			],
			NOW,
		);
		expect(nodes).toHaveLength(2);
		expect(nodes[0].key).toBe("run:r-parent");
		expect(nodes[0].children.map((c) => c.key)).toEqual(["run:r-child"]);
		expect(nodes[1].key).toBe("run:r-solo");
	});

	it("keeps projected usage and completion in confirmed child rows", () => {
		const projected = run("r-child", "succeeded", {
			completedAt: NOW - 5_000,
			profile: {
				profile: "research",
				model: "provider/reviewer",
				thinking: "medium",
				meta: {
					ownerId: "auth/worker",
					confirmed: true,
					usage: {
						input: 1_000,
						output: 200,
						cacheRead: 9_000,
						cacheWrite: 0,
						promptTokens: 10_000,
						totalTokens: 10_200,
						cost: 0.2,
						turns: 2,
					},
				},
			},
		});
		const nodes = buildAgentNodes(
			{
				agents: new Map([["auth/worker", execAgent("working")]]),
				deliverables: new Map(),
			},
			[projected],
			NOW,
		);
		expect(nodes[0].children[0]).toMatchObject({
			key: "run:r-child",
			completedAt: NOW - 5_000,
			input: 10_000,
			output: 200,
			cacheRead: 9_000,
			model: "provider/reviewer",
			effort: "medium",
		});
	});

	it("omits unconfirmed projected children", () => {
		const nodes = buildAgentNodes(
			{
				agents: new Map([["auth/worker", execAgent("working")]]),
				deliverables: new Map(),
			},
			[
				run("stale", "running", {
					profile: {
						profile: "research",
						meta: { ownerId: "auth/worker", confirmed: false },
					},
				}),
			],
			NOW,
		);
		expect(nodes[0].children).toEqual([]);
	});

	it("ages out terminal runs but keeps recent ones with word statuses", () => {
		const nodes = buildAgentNodes(
			undefined,
			[
				run("r-old", "succeeded", { updatedAt: NOW - 600_000 }),
				run("r-fresh", "succeeded", { updatedAt: NOW - 5_000 }),
				run("r-dead", "timed-out", { updatedAt: NOW - 5_000 }),
				run("r-halted", "stopped", { updatedAt: NOW - 5_000 }),
			],
			NOW,
		);
		expect(nodes.map((n) => n.key)).toEqual([
			"run:r-fresh",
			"run:r-dead",
			"run:r-halted",
		]);
		expect(nodes.map((n) => n.status)).toEqual(["done", "failed", "stopped"]);
	});
});

describe("buildPlanView", () => {
	it("maps deliverable statuses to checkbox states and counts done", () => {
		const plan = {
			deliverables: [
				deliverable("d1", "shipped"),
				deliverable("d2", "complete"),
				deliverable("d3", "active", [
					{ id: "t1", title: "do it", done: false, kind: "task" },
					{ id: "q1", title: "a question", done: false, kind: "question" },
				]),
				deliverable("d4", "planned"),
				deliverable("d5", "failed"),
			],
		};
		const view = buildPlanView(plan as never, {
			agents: new Map([["d3", execAgent("working")]]),
		});
		expect(view?.done).toBe(2);
		expect(view?.total).toBe(5);
		expect(view?.rows.map((r) => r.state)).toEqual([
			"shipped",
			"complete",
			"active",
			"queued",
			"failed",
		]);
		// Worker named (with live status) only on the active row.
		expect(view?.rows[2].worker).toBe("worker running");
		expect(view?.rows[0].worker).toBeUndefined();
		// Only kind=task work items surface as checkbox tasks.
		expect(view?.rows[2].tasks).toEqual([
			{ id: "t1", title: "do it", done: false },
		]);
	});

	it("returns undefined without a plan", () => {
		expect(buildPlanView(undefined)).toBeUndefined();
	});
});

function deliverable(
	id: string,
	status: string,
	tasks: unknown[] = [],
): Record<string, unknown> {
	return {
		type: "deliverable",
		id,
		title: `Deliverable ${id}`,
		body: "",
		status,
		worker: { mode: "full" },
		agents: [],
		tasks,
	};
}

describe("buildQuestionRows", () => {
	it("merges engine asks and worker-queue questions, blocking first", () => {
		const rows = buildQuestionRows(
			[
				{ id: "posted", question: "posted first" },
				{ id: "urgent", question: "the gate question", blocking: true },
			],
			[
				{
					agentId: "auth/worker",
					agentName: "worker",
					deliverableTitle: "Auth",
					questions: [{ id: "wq", question: "keep endpoint?" }],
					draft: [],
					resolve: () => {},
					receivedAt: 10,
				},
			],
		);
		expect(rows.map((r) => r.key)).toEqual([
			"ask:urgent",
			"ask:posted",
			"queue:auth/worker:wq",
		]);
		expect(rows[0].blocking).toBe(true);
		expect(rows[2].asker).toBe("worker · auth");
	});
});

function watch(
	id: string,
	status: WatchRecord["status"],
	overrides: Partial<WatchRecord> = {},
): WatchRecord {
	return {
		id,
		goal: "watch PR #271's CI; raise when it completes or fails",
		lifetime: "one-shot",
		caps: {
			maxDurationMs: 3_600_000,
			minIntervalMs: 15_000,
			maxRaises: 10,
			maxRefinements: 5,
		},
		probe: {
			command: "gh pr checks 271",
			intervalMs: 30_000,
			canonicalizer: "",
		},
		status,
		refinements: [],
		raises: 0,
		createdAt: new Date(NOW - 120_000).toISOString(),
		updatedAt: new Date(NOW - 1_000).toISOString(),
		...overrides,
	};
}

describe("watch rows", () => {
	it("projects watches into the agents tab with status word, goal, probe, refinements", () => {
		const nodes = buildWatchNodes(
			[
				watch("w1", "active", {
					refinements: [
						{
							at: "t",
							rationale: "ignore timestamps",
							previousCanonicalizer: "",
						},
					],
				}),
			],
			NOW,
		);
		expect(nodes).toHaveLength(1);
		expect(nodes[0].key).toBe("watch:w1");
		expect(nodes[0].label).toBe(
			"watch · watch PR #271's CI; raise when it completes or …",
		);
		expect(nodes[0].status).toBe("running");
		expect(nodes[0].note).toBe("active · probe 30s · 1 refinement");
		// List + cancel only: no attach, no steer, no kill.
		expect(nodes[0].capabilities).toEqual({
			view: false,
			steer: false,
			interrupt: true,
			kill: false,
		});
	});

	it("ages out settled watches on the terminal-run clock", () => {
		const fresh = watch("w1", "cancelled", {
			endedAt: new Date(NOW - 30_000).toISOString(),
		});
		const stale = watch("w2", "triggered", {
			endedAt: new Date(NOW - 600_000).toISOString(),
		});
		const nodes = buildWatchNodes([fresh, stale], NOW);
		expect(nodes.map((n) => n.key)).toEqual(["watch:w1"]);
		expect(nodes[0].status).toBe("stopped");
		expect(nodes[0].capabilities?.interrupt).toBe(false);
	});

	it("rides the agent target registry as watch:<id> and cancels via the manager", async () => {
		const cancelled: string[] = [];
		const watches = {
			list: () => [watch("w1", "active")],
			cancel: (id: string) => {
				cancelled.push(id);
				return true;
			},
		};
		const targets = listAgentTargets({ watches });
		expect(targets).toHaveLength(1);
		expect(targets[0].id).toBe("watch:w1");
		expect(targets[0].kind).toBe("watch");
		expect(targets[0].status).toBe("active");
		expect(targets[0].capabilities).toMatchObject({
			view: false,
			steer: false,
			interrupt: false,
			shutdown: true,
		});
		await expect(
			stopAgentTarget(targets[0], undefined, undefined, "done", watches),
		).resolves.toBe(true);
		expect(cancelled).toEqual(["w1"]);
	});
});

describe("steerPrefix", () => {
	it("addresses workers, named agents, and runs", () => {
		expect(steerPrefix("worker:auth/worker")).toBe("/steer auth ");
		expect(steerPrefix("worker:auth/reviewer")).toBe("/steer auth reviewer: ");
		expect(steerPrefix("run:r-123")).toBe("/steer r-123 ");
		expect(steerPrefix("host:current")).toBeUndefined();
	});
});
