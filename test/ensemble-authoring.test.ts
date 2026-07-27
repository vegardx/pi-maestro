// The ensemble authoring on-ramp: `agent(action="ensemble", …)` authors N
// branchless worker CANDIDATES under a branch-owning worker deliverable and
// makes the parent their INTEGRATOR. The executor later provisions each
// candidate on a cand/<parent>/<id> branch; candidates never ship, the parent
// ships the one PR. See docs/design/multi-model-agents.md §5.

import { describe, expect, it } from "vitest";
import { PLAN_SCHEMA_VERSION } from "../packages/contracts/src/plan-schema.js";
import { PlanEngine } from "../packages/modes/src/plan/engine.js";
import {
	isBranchOwner,
	type Plan,
	type PlanNode,
	validatePlanShape,
} from "../packages/modes/src/plan/schema.js";
import type { PlanStore } from "../packages/modes/src/plan/storage.js";
import {
	createAuthorTool,
	createDeliverableTool,
} from "../packages/modes/src/tools.js";

function memStore(): PlanStore {
	let saved: Plan | null = null;
	return {
		root: "/tmp/plans",
		save: (p: Plan) => {
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

function makeEngine(): PlanEngine {
	return PlanEngine.create(memStore(), {
		slug: "ensemble-test",
		title: "Ensemble Test",
		repoPath: "/tmp/repo",
	});
}

type Res = { details?: { error?: string } };

function runAgent(engine: PlanEngine, params: unknown): Promise<Res> {
	const tool = createAuthorTool({ engine: () => engine });
	return tool.execute(
		"t",
		params as never,
		undefined as never,
		undefined as never,
		{} as never,
	) as Promise<Res>;
}

/** A branch-owning worker deliverable — the integrator-to-be. */
function seedDeliverable(engine: PlanEngine, id: string): PlanNode {
	const node = engine.addNode(null, {
		id,
		agent: "worker",
		persona: "coder",
		title: "Build the metrics module",
	});
	engine.updateNode(node.id, { branch: `feat/${id}` });
	return node;
}

function findNode(plan: Plan, id: string): PlanNode | undefined {
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

const TS = "2026-07-27T00:00:00.000Z";
const basePlan = () => ({
	schemaVersion: PLAN_SCHEMA_VERSION,
	slug: "demo",
	title: "Demo",
	repoPath: "/tmp/demo",
	nodes: [],
	createdAt: TS,
	updatedAt: TS,
});
const baseNode = (id: string) => ({
	id,
	agent: "worker",
	persona: "coder",
	title: id,
	tasks: [
		{
			id: `${id}-t1`,
			title: "do it",
			done: false,
			createdAt: TS,
			updatedAt: TS,
		},
	],
	status: "planned",
	createdAt: TS,
	updatedAt: TS,
});

describe("the ensemble SHAPE is enforced by validation, not by the action", () => {
	it("refuses an integrator with fewer than two candidates", () => {
		// However the shape was built — hand-composed, seeded, repaired — a lone
		// candidate is not a bake-off. Enforcing it in validatePlanShape means the
		// dedicated action is convenience, never the only guard.
		const errors = validatePlanShape({
			...basePlan(),
			nodes: [
				{
					...baseNode("solo"),
					persona: "integrator",
					branch: "feat/solo",
					children: [{ ...baseNode("cand-a"), agent: "worker" }],
				},
			],
		} as unknown as Plan);
		expect(errors.join("\n")).toContain("at least two worker candidates");
	});

	it("refuses an integrator that owns no branch", () => {
		// It has nothing to integrate onto and nothing to ship from.
		const errors = validatePlanShape({
			...basePlan(),
			nodes: [
				{
					...baseNode("branchless"),
					persona: "integrator",
					children: [
						{ ...baseNode("cand-a"), agent: "worker" },
						{ ...baseNode("cand-b"), agent: "worker" },
					],
				},
			],
		} as unknown as Plan);
		expect(errors.join("\n")).toContain("must own a branch");
	});

	it("accepts a well-formed ensemble", () => {
		const errors = validatePlanShape({
			...basePlan(),
			nodes: [
				{
					...baseNode("metrics"),
					persona: "integrator",
					branch: "feat/metrics",
					children: [
						{ ...baseNode("cand-a"), agent: "worker" },
						{ ...baseNode("cand-b"), agent: "worker" },
					],
				},
			],
		} as unknown as Plan);
		expect(errors.filter((e) => e.includes("integrator"))).toEqual([]);
	});
});

describe("deliverable authors the whole tree", () => {
	/** The tool under test, over a real engine on a temp store. */
	function harness() {
		const plans = new Map<string, Plan>();
		const store = {
			save: (p: Plan) => void plans.set(p.slug, p),
			load: (slug: string) => plans.get(slug),
			exists: (slug: string) => plans.has(slug),
			root: "/tmp",
		} as unknown as PlanStore;
		const engine = PlanEngine.create(
			store,
			{ slug: "demo", title: "Demo", repoPath: "/tmp/demo" },
			() => TS,
		);
		const tool = createDeliverableTool({
			engine: () => engine,
			onPlanChanged: () => {},
			mode: () => "plan",
		} as never);
		const call = async (params: unknown) =>
			(await tool.execute(
				"t",
				params as never,
				undefined as never,
				undefined as never,
				{} as never,
			)) as { details?: { error?: string } };
		return { engine, call };
	}

	it("authors a deliverable WITH its tasks in one call", async () => {
		// The half-authored plan is the failure this prevents: deliverables with
		// no gating work can never enter execution, and a second call is a second
		// chance to stop early. Seen live on Opus.
		const { engine, call } = harness();
		await call({
			action: "add",
			id: "validate",
			title: "Add validation utilities",
			tasks: ["implement isPositive", "add tests"],
		});
		expect(engine.get().nodes[0].tasks).toHaveLength(2);
	});

	it("nests a reviewer under a deliverable", async () => {
		const { engine, call } = harness();
		await call({
			action: "add",
			id: "validate",
			title: "Validate",
			tasks: ["x"],
		});
		await call({
			action: "add",
			parent: "validate",
			id: "security-audit",
			agent: "reviewer",
			persona: "security-audit",
			title: "Security audit",
			tasks: ["NaN/Infinity edge cases"],
			multiModal: true,
		});
		const parent = engine.get().nodes[0];
		expect(parent.children).toHaveLength(1);
		const child = (parent.children ?? [])[0];
		expect(child.agent).toBe("reviewer");
		expect(child.persona).toBe("security-audit");
		expect(child.multiModal).toBe(true);
	});

	it("leaves nested nodes branchless — they report, they never ship", async () => {
		const { engine, call } = harness();
		await call({
			action: "add",
			id: "validate",
			title: "Validate",
			tasks: ["x"],
		});
		await call({
			action: "add",
			parent: "validate",
			agent: "reviewer",
			title: "Review",
			tasks: ["look"],
		});
		const child = (engine.get().nodes[0].children ?? [])[0];
		expect(isBranchOwner(child)).toBe(false);
		expect(isBranchOwner(engine.get().nodes[0])).toBe(true);
	});

	it("refuses an unknown parent instead of silently rooting the node", async () => {
		const { call } = harness();
		const result = await call({
			action: "add",
			parent: "nope",
			title: "Orphan",
		});
		expect(result.details?.error).toContain("unknown parent");
	});
});
