// The node-handoff protocol over the v2 tree: activation injects the
// lifecycle pair (preflight only with sibling `after` deps; postflight only
// when the node's handoff is CONSUMED — a dependent sibling or an owned
// branch: v2's generalization of v1's inject-always rule), both gate
// completion, the postflight toggle records the downstream handoff on the
// LEDGER, and dependents' seeds prefer the handoff over the rollup summary.
//
// Ported from v1's deliverable-handoff suite. Behavior that died with v1:
// - postflight was injected unconditionally; v2 injects it only for consumed
//   worker nodes (explorers/reviewers get neither — their contract output IS
//   the handoff).
// - the handoff summary was whitespace-trimmed; PlanEngineV2 stores it
//   verbatim.
// - toggleWorkItem returned the resulting done state; toggleTask is void, so
//   completion is asserted through the ledger.

import { describe, expect, it } from "vitest";
import { PlanEngineV2 } from "../packages/modes/src/plan/engine.js";
import {
	NodeExecutor,
	type NodeExecutorDeps,
	type SpawnNodeOpts,
} from "../packages/modes/src/plan/node-executor.js";
import {
	findNodeV2,
	gatingNodeTasks,
	type PlanV2,
	POSTFLIGHT_TASK_ID,
	PREFLIGHT_TASK_ID,
} from "../packages/modes/src/plan/schema.js";
import type { PlanStoreV2 } from "../packages/modes/src/plan/storage.js";

function memStore(): PlanStoreV2 {
	let saved: PlanV2 | null = null;
	return {
		root: "/tmp/plans",
		save(plan) {
			saved = plan;
		},
		load: () => saved,
		exists: () => saved !== null,
		remove() {
			saved = null;
		},
		list: () => [],
	};
}

function makeEngine(): PlanEngineV2 {
	const engine = PlanEngineV2.create(memStore(), {
		slug: "handoff",
		title: "Handoff Plan",
		repoPath: "/tmp/repo",
	});
	engine.addNode(null, {
		id: "base",
		agent: "worker",
		persona: "coder",
		title: "Base library",
		tasks: ["build it"],
	});
	engine.addNode(null, {
		id: "consumer",
		agent: "worker",
		persona: "coder",
		title: "Consumer feature",
		after: ["base"],
		branch: "feat/consumer",
		tasks: ["use it"],
	});
	return engine;
}

describe("lifecycle task injection", () => {
	it("activation injects postflight for consumed nodes, preflight only with sibling deps", () => {
		const engine = makeEngine();
		// `base` has a dependent sibling (its handoff is consumed) but no deps.
		engine.setNodeStatus("base", "active");
		const base = findNodeV2(engine.get(), "base");
		expect(base?.tasks.map((t) => t.kind ?? "task")).toEqual([
			"task",
			"postflight",
		]);
		expect(base?.tasks.at(-1)?.id).toBe(POSTFLIGHT_TASK_ID);

		// The dependent branch owner gets both: preflight first, postflight last.
		engine.setNodeStatus("consumer", "active");
		const consumer = findNodeV2(engine.get(), "consumer");
		expect(consumer?.tasks.map((t) => t.kind ?? "task")).toEqual([
			"preflight",
			"task",
			"postflight",
		]);
		expect(consumer?.tasks[0]?.id).toBe(PREFLIGHT_TASK_ID);
	});

	it("unconsumed workers and read agents get no lifecycle tasks (v2 generalization)", () => {
		const engine = PlanEngineV2.create(memStore(), {
			slug: "leafy",
			title: "Leafy",
			repoPath: "/tmp/repo",
		});
		// A branchless worker nothing depends on: no one consumes its handoff.
		engine.addNode(null, {
			id: "leaf",
			agent: "worker",
			persona: "coder",
			tasks: ["poke around"],
		});
		// A reviewer: contract output is the handoff; no lifecycle pair. (No
		// `after: ["leaf"]` here — that would make leaf's handoff consumed.)
		engine.addNode(null, {
			id: "rev",
			agent: "reviewer",
			persona: "reviewer",
		});
		engine.setNodeStatus("leaf", "active");
		engine.setNodeStatus("rev", "active");
		expect(
			findNodeV2(engine.get(), "leaf")?.tasks.map((t) => t.kind ?? "task"),
		).toEqual(["task"]);
		expect(findNodeV2(engine.get(), "rev")?.tasks).toEqual([]);
	});

	it("is idempotent across re-activation", () => {
		const engine = makeEngine();
		engine.setNodeStatus("base", "active");
		// Re-assert active (recovery paths re-set status).
		engine.setNodeStatus("base", "active");
		const base = findNodeV2(engine.get(), "base");
		expect(base?.tasks.filter((t) => t.kind === "postflight")).toHaveLength(1);
	});

	it("lifecycle tasks gate completion alongside real tasks", () => {
		const engine = makeEngine();
		engine.setNodeStatus("consumer", "active");
		const consumer = findNodeV2(engine.get(), "consumer");
		const gating = gatingNodeTasks(consumer ?? { tasks: [] });
		expect(gating.map((t) => t.kind ?? "task")).toEqual([
			"preflight",
			"task",
			"postflight",
		]);
	});
});

describe("postflight toggle records the handoff", () => {
	it("stores the summary on the node ledger when toggling done", () => {
		const engine = makeEngine();
		engine.setNodeStatus("base", "active");
		engine.toggleTask(
			"base",
			POSTFLIGHT_TASK_ID,
			"Built libbase. API: init()/run(). Gotcha: init is async.",
		);
		expect(findNodeV2(engine.get(), "base")?.handoff).toBe(
			"Built libbase. API: init()/run(). Gotcha: init is async.",
		);
	});

	it("ignores a summary on ordinary task toggles", () => {
		const engine = makeEngine();
		engine.setNodeStatus("base", "active");
		engine.toggleTask("base", "build-it", "not a handoff");
		const base = findNodeV2(engine.get(), "base");
		expect(base?.tasks.find((t) => t.id === "build-it")?.done).toBe(true);
		expect(base?.handoff).toBeUndefined();
	});

	it("toggling postflight without a summary completes but records nothing", () => {
		const engine = makeEngine();
		engine.setNodeStatus("base", "active");
		engine.toggleTask("base", POSTFLIGHT_TASK_ID);
		const base = findNodeV2(engine.get(), "base");
		expect(base?.tasks.find((t) => t.id === POSTFLIGHT_TASK_ID)?.done).toBe(
			true,
		);
		expect(base?.handoff).toBeUndefined();
	});
});

describe("dependents' seeds prefer the handoff", () => {
	function executorDeps(seeds: Map<string, string>): NodeExecutorDeps {
		return {
			spawnAgent: async (opts: SpawnNodeOpts) => {
				seeds.set(opts.nodeId, opts.seed);
				return {
					sessionId: `sess-${opts.nodeId}`,
					sessionFile: `/tmp/${opts.nodeId}.jsonl`,
				};
			},
			killSession: async () => {},
			createWorktree: async (opts) => `/wt/${opts.nodeId}`,
			shipNode: async () => "https://example/pr/1",
			requestSummary: async () => "## Summary\ncombined rollup summary.",
			defaultBranch: "main",
			now: () => "2026-07-20T18:00:00Z",
		};
	}

	async function seedForConsumer(postflightSummary?: string): Promise<string> {
		const engine = makeEngine();
		const seeds = new Map<string, string>();
		const executor = new NodeExecutor(engine, executorDeps(seeds));
		await executor.tick(); // activates base only (consumer waits on the dep)
		engine.toggleTask("base", "build-it");
		engine.toggleTask("base", POSTFLIGHT_TASK_ID, postflightSummary);
		await executor.markAgentDone("base"); // base completes with the rollup summary
		await executor.tick(); // dep satisfied — consumer spawns with its seed
		expect(seeds.has("consumer")).toBe(true);
		return seeds.get("consumer") as string;
	}

	it("the upstream handoff leads the seed, ahead of the rollup summary", async () => {
		const seed = await seedForConsumer("HANDOFF: call init() before run().");
		expect(seed.startsWith("HANDOFF: call init() before run().")).toBe(true);
	});

	it("falls back to the dependency's summary when no handoff was recorded", async () => {
		const seed = await seedForConsumer();
		expect(seed.startsWith("## Summary\ncombined rollup summary.")).toBe(true);
	});
});
