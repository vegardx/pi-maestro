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
import { createDeliverableTool } from "../packages/modes/src/tools.js";

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

describe("an ensemble composed through deliverable", () => {
	// The macro is gone. The shape is now authored like anything else — nested
	// worker candidates, then the parent flipped to integrator — and validation
	// holds it to the same bar. Ordering matters: an integrator with no
	// candidates is not a valid plan, so the children come first.
	it("is authorable without a dedicated action", async () => {
		const { engine, call } = harness();
		await call({
			action: "add",
			id: "metrics",
			title: "Build the metrics module",
			tasks: ["ship metrics"],
		});
		await call({
			action: "add",
			items: [
				{
					id: "cand-a",
					parent: "metrics",
					title: "Approach A",
					tasks: ["do it A-way"],
				},
				{
					id: "cand-b",
					parent: "metrics",
					title: "Approach B",
					tasks: ["do it B-way"],
				},
			],
		});
		const promoted = await call({
			action: "update",
			id: "metrics",
			persona: "integrator",
		});
		expect(promoted.details?.error).toBeUndefined();

		const parent = engine.get().nodes[0];
		expect(parent.persona).toBe("integrator");
		expect(parent.children).toHaveLength(2);
		// Candidates never ship: the executor gives them cand/ branches.
		for (const child of parent.children ?? [])
			expect(isBranchOwner(child)).toBe(false);
		expect(isBranchOwner(parent)).toBe(true);
	});

	it("refuses to promote a parent that has no candidates yet", async () => {
		// The ordering constraint, enforced rather than documented.
		const { call } = harness();
		await call({
			action: "add",
			id: "metrics",
			title: "Build it",
			tasks: ["ship"],
		});
		const promoted = await call({
			action: "update",
			id: "metrics",
			persona: "integrator",
		});
		expect(promoted.details?.error).toContain("at least two worker candidates");
	});
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
