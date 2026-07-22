// The ensemble authoring on-ramp: `agent(action="ensemble", …)` authors N
// branchless worker CANDIDATES under a branch-owning worker deliverable and
// makes the parent their INTEGRATOR. The executor later provisions each
// candidate on a cand/<parent>/<id> branch; candidates never ship, the parent
// ships the one PR. See docs/design/multi-model-agents.md §5.

import { describe, expect, it } from "vitest";
import { PlanEngineV2 } from "../packages/modes/src/plan/engine.js";
import {
	isBranchOwner,
	type PlanNode,
	type PlanV2,
} from "../packages/modes/src/plan/schema.js";
import type { PlanStoreV2 } from "../packages/modes/src/plan/storage.js";
import { createAgentTool } from "../packages/modes/src/tools.js";

function memStore(): PlanStoreV2 {
	let saved: PlanV2 | null = null;
	return {
		root: "/tmp/plans",
		save: (p: PlanV2) => {
			saved = p;
		},
		load: () => saved,
		exists: () => saved !== null,
		remove: () => {
			saved = null;
		},
		list: () => [],
	};
}

function makeEngine(): PlanEngineV2 {
	return PlanEngineV2.create(memStore(), {
		slug: "ensemble-test",
		title: "Ensemble Test",
		repoPath: "/tmp/repo",
	});
}

type Res = { details?: { error?: string } };

function runAgent(engine: PlanEngineV2, params: unknown): Promise<Res> {
	const tool = createAgentTool({ engine: () => engine });
	return tool.execute(
		"t",
		params as never,
		undefined as never,
		undefined as never,
		{} as never,
	) as Promise<Res>;
}

/** A branch-owning worker deliverable — the integrator-to-be. */
function seedDeliverable(engine: PlanEngineV2, id: string): PlanNode {
	const node = engine.addNode(null, {
		id,
		agent: "worker",
		persona: "coder",
		title: "Build the metrics module",
	});
	engine.updateNode(node.id, { branch: `feat/${id}` });
	return node;
}

function findNode(plan: PlanV2, id: string): PlanNode | undefined {
	const stack = [...plan.nodes];
	while (stack.length) {
		const node = stack.pop();
		if (!node) continue;
		if (node.id === id) return node;
		if (node.children) stack.push(...node.children);
	}
	return undefined;
}

describe("ensemble authoring", () => {
	it("authors branchless worker candidates and makes the parent the integrator", async () => {
		const engine = makeEngine();
		const parent = seedDeliverable(engine, "build-metrics");

		const res = await runAgent(engine, {
			action: "ensemble",
			deliverableId: parent.id,
			candidates: [
				{ name: "candidate A", focus: "Implement src/metrics.ts, approach A" },
				{ name: "candidate B", focus: "Implement src/metrics.ts, approach B" },
			],
		});
		expect(res.details?.error).toBeUndefined();

		const updated = findNode(engine.get(), parent.id);
		expect(updated?.persona).toBe("integrator");
		const children = updated?.children ?? [];
		expect(children).toHaveLength(2);
		for (const child of children) {
			expect(child.agent).toBe("worker");
			expect(child.persona).toBe("coder");
			// Branchless → the executor mints it a cand/ branch; it never ships.
			expect(isBranchOwner(child)).toBe(false);
		}
	});

	it("rejects an ensemble on a non-branch-owning deliverable", async () => {
		const engine = makeEngine();
		// A scratch (branchless) worker deliverable cannot own candidates.
		const scratch = engine.addNode(null, {
			id: "scratch",
			agent: "worker",
			persona: "coder",
			title: "Scratch work",
		});

		const res = await runAgent(engine, {
			action: "ensemble",
			deliverableId: scratch.id,
			candidates: [
				{ name: "a", focus: "x" },
				{ name: "b", focus: "y" },
			],
		});
		expect(res.details?.error).toMatch(/branch-owning/);
	});

	it("requires at least two candidates", async () => {
		const engine = makeEngine();
		const parent = seedDeliverable(engine, "build-metrics");
		const res = await runAgent(engine, {
			action: "ensemble",
			deliverableId: parent.id,
			candidates: [{ name: "solo", focus: "x" }],
		});
		expect(res.details?.error).toMatch(/two candidates/);
	});
});
