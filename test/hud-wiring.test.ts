// HUD data builders: the agents tree (execution workers + subagent runs
// with parent nesting and terminal aging) and the /steer prefill.

import type { RunRecord } from "@vegardx/pi-contracts";
import { describe, expect, it } from "vitest";
import type { ExecutionAgentSnapshot } from "../packages/modes/src/exec/index.js";
import {
	buildAgentNodes,
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

describe("steerPrefix", () => {
	it("addresses workers, named agents, and runs", () => {
		expect(steerPrefix("worker:auth/worker")).toBe("/steer auth ");
		expect(steerPrefix("worker:auth/reviewer")).toBe("/steer auth reviewer: ");
		expect(steerPrefix("run:r-123")).toBe("/steer r-123 ");
		expect(steerPrefix("host:current")).toBeUndefined();
	});
});
