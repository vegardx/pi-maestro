// NodeExecutor (cutover PR-5a): the ported completion lattice driven through
// fake deps — activation ordering, per-worker worktrees (candidates on cand/
// branches), parent-gated children, generation-guarded completion, chain-order
// shipping, restart hydration + recovery. The RPC-level parity twins land
// with the adapter port (PR-5b); this suite owns the state-machine semantics.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanEngineV2 } from "../packages/modes/src/plan/engine.js";
import {
	NodeExecutor,
	type NodeExecutorDeps,
	RESTART_BLOCK_PREFIX,
	type SpawnNodeOpts,
} from "../packages/modes/src/plan/node-executor.js";
import { findNodeV2 } from "../packages/modes/src/plan/schema.js";
import { createPlanStoreV2 } from "../packages/modes/src/plan/storage.js";

let root: string;
let spawns: SpawnNodeOpts[];
let worktrees: Array<{ nodeId: string; branch: string; baseBranch: string }>;
let ships: string[];
let killed: string[];
let shipFails: Set<string>;
let sessionSeq: number;

function deps(): NodeExecutorDeps {
	return {
		spawnAgent: async (opts) => {
			spawns.push(opts);
			sessionSeq++;
			return {
				sessionId: `sess-${opts.nodeId}-${sessionSeq}`,
				sessionFile: `/tmp/${opts.nodeId}.jsonl`,
			};
		},
		killSession: async (sessionId) => {
			killed.push(sessionId);
		},
		createWorktree: async (opts) => {
			worktrees.push({
				nodeId: opts.nodeId,
				branch: opts.branch,
				baseBranch: opts.baseBranch,
			});
			return `/wt/${opts.nodeId}`;
		},
		shipNode: async (opts) => {
			if (shipFails.has(opts.nodeId)) throw new Error("remote rejected");
			ships.push(opts.nodeId);
			return `https://example/pr/${ships.length}`;
		},
		requestSummary: async (_s, _c, preamble) => `## Summary\n${preamble} done.`,
		defaultBranch: "main",
		now: () => "2026-07-20T18:00:00Z",
	};
}

function makeEngine(): PlanEngineV2 {
	return PlanEngineV2.create(createPlanStoreV2(root), {
		slug: "p",
		title: "P",
		repoPath: "/repo",
	});
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "node-exec-"));
	spawns = [];
	worktrees = [];
	ships = [];
	killed = [];
	shipFails = new Set();
	sessionSeq = 0;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("activation + workspaces", () => {
	it("activates ready roots; branch owners get their branch, candidates get cand/ worktrees, reviewers borrow the parent's", async () => {
		const engine = makeEngine();
		engine.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "Build",
			branch: "feat/build",
			tasks: ["implement"],
		});
		const executor = new NodeExecutor(engine, deps());
		await executor.tick();

		expect(spawns.map((s) => s.nodeId)).toEqual(["build"]);
		expect(spawns[0]).toMatchObject({
			agent: "worker",
			persona: "coder",
			mode: "full",
		});
		expect(worktrees[0]).toMatchObject({
			nodeId: "build",
			branch: "feat/build",
			baseBranch: "main",
		});
		// Session fields persist to the LEDGER (what v1 lost for support agents).
		const node = findNodeV2(engine.get(), "build");
		expect(node?.sessionName).toContain("sess-build");
		expect(node?.sessionPath).toBe("/tmp/build.jsonl");

		// A dynamic candidate child: own worktree on a cand/ branch off the parent.
		engine.appendChild(
			"build",
			{ agent: "worker", persona: "coder", title: "Candidate A" },
			"build",
		);
		await executor.tick();
		expect(worktrees[1]).toMatchObject({
			nodeId: "candidate-a",
			branch: "cand/build/candidate-a",
			baseBranch: "feat/build",
		});

		// A reviewer child borrows the parent's worktree — no provisioning.
		engine.appendChild(
			"build",
			{ agent: "reviewer", persona: "reviewer", title: "Rev" },
			"build",
		);
		await executor.tick();
		expect(worktrees).toHaveLength(2);
		const review = spawns.find((s) => s.nodeId === "rev");
		expect(review).toMatchObject({
			mode: "read-only",
			worktreePath: "/wt/build",
		});
	});

	it("parent-gated children wait for the parent's tasks; deps satisfy in order", async () => {
		const engine = makeEngine();
		engine.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "Build",
			branch: "feat/build",
			tasks: ["implement"],
		});
		const executor = new NodeExecutor(engine, deps());
		await executor.tick();
		engine.appendChild(
			"build",
			{
				agent: "reviewer",
				persona: "reviewer",
				title: "Rev",
				after: ["parent"],
			},
			"build",
		);
		await executor.tick();
		expect(spawns.map((s) => s.nodeId)).toEqual(["build"]); // gated

		engine.toggleTask("build", "implement");
		engine.toggleTask("build", "lifecycle-postflight", "## Handoff\nDone.");
		await executor.tick();
		expect(spawns.map((s) => s.nodeId)).toEqual(["build", "rev"]);
	});

	it("bounds concurrent children by envelope.maxConcurrent (backpressure)", async () => {
		const engine = makeEngine();
		engine.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "Build",
			branch: "feat/build",
			envelope: { maxChildren: 5, maxConcurrent: 2 },
		});
		const executor = new NodeExecutor(engine, deps());
		await executor.tick();
		for (const name of ["C1", "C2", "C3"])
			engine.appendChild(
				"build",
				{ agent: "worker", persona: "coder", title: name },
				"build",
			);
		await executor.tick();
		// Only two live at once; the third waits for capacity.
		expect(spawns.map((s) => s.nodeId)).toEqual(["build", "c1", "c2"]);
		await executor.markAgentDone("c1");
		await executor.tick();
		expect(spawns.map((s) => s.nodeId)).toEqual(["build", "c1", "c2", "c3"]);
	});

	it("parks activation failures blocked instead of crashing the tick", async () => {
		const engine = makeEngine();
		engine.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "Build",
			branch: "feat/build",
		});
		const failing = deps();
		failing.createWorktree = async () => {
			throw new Error("base branch missing");
		};
		const executor = new NodeExecutor(engine, failing);
		await executor.tick(); // must not throw
		expect(executor.getRunState("build")?.blocked).toContain(
			"activation failed: base branch missing",
		);
		expect(findNodeV2(engine.get(), "build")?.status).toBe("planned");
	});
});

describe("completion lattice", () => {
	it("a worker completes only when tasks are toggled AND children are terminal", async () => {
		const engine = makeEngine();
		engine.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "Build",
			branch: "feat/build",
			tasks: ["implement"],
		});
		const executor = new NodeExecutor(engine, deps());
		await executor.tick();
		engine.appendChild(
			"build",
			{ agent: "reviewer", persona: "reviewer", title: "Rev" },
			"build",
		);
		await executor.tick(); // reviewer spawns (no after-gate)

		// Worker reports done — but tasks aren't toggled: no completion.
		await executor.markAgentDone("build");
		expect(findNodeV2(engine.get(), "build")?.status).toBe("active");

		engine.toggleTask("build", "implement");
		engine.toggleTask("build", "lifecycle-postflight", "handoff");
		// Child still active: no completion either.
		await executor.tick();
		expect(findNodeV2(engine.get(), "build")?.status).toBe("active");

		// Child completes → folds into the parent; parent completes on next check.
		await executor.markAgentDone("rev");
		expect(findNodeV2(engine.get(), "rev")?.status).toBe("complete");
		await executor.tick();
		expect(findNodeV2(engine.get(), "build")?.status).toBe("shipped");
		expect(findNodeV2(engine.get(), "build")?.summary).toContain("done.");
	});

	it("generation guards drop stale completions (verbatim staleness rule)", async () => {
		const engine = makeEngine();
		engine.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "Build",
			branch: "feat/build",
			tasks: ["implement"],
		});
		const executor = new NodeExecutor(engine, deps());
		await executor.tick();
		// A stale caller with generation 5 must be ignored entirely.
		await executor.markAgentDone("build", { generation: 5 });
		expect(executor.getRunState("build")?.status).toBe("working");
		expect(killed).toEqual([]);
	});

	it("a failed child fails the parent with the v1 failure record", async () => {
		const engine = makeEngine();
		engine.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "Build",
			branch: "feat/build",
		});
		const executor = new NodeExecutor(engine, deps());
		await executor.tick();
		engine.appendChild(
			"build",
			{ agent: "explorer", persona: "researcher", title: "Probe" },
			"build",
		);
		await executor.tick();
		executor.markAgentFailed("probe", "model unreachable");
		await executor.markAgentDone("build");
		// Child status must reach the ledger as failed before the parent folds.
		engine.setNodeStatus("probe", "failed", {
			code: "agent-failed",
			message: "model unreachable",
			failedAt: "t",
			recoverable: true,
			attempt: 1,
		});
		await executor.tick();
		const parent = findNodeV2(engine.get(), "build");
		expect(parent?.status).toBe("failed");
		expect(parent?.failure?.message).toContain("failed");
	});
});

describe("shipping", () => {
	it("ships chain-order within one tick and parks ship failures retryably", async () => {
		const engine = makeEngine();
		engine.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "A",
			branch: "feat/a",
			tasks: ["a1"],
		});
		engine.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "B",
			branch: "feat/b",
			after: ["a"],
			tasks: ["b1"],
		});
		const executor = new NodeExecutor(engine, deps());
		await executor.tick();
		engine.toggleTask("a", "a1");
		engine.toggleTask("a", "lifecycle-postflight", "handoff A");
		await executor.markAgentDone("a");
		// A completes and ships; B then activates on the satisfied dep.
		let shipped = await executor.tick();
		expect(shipped).toEqual(["a"]);
		expect(worktrees.find((w) => w.nodeId === "b")?.baseBranch).toBe("feat/a"); // stacked
		engine.toggleTask("b", "b1");
		engine.toggleTask("b", "lifecycle-preflight");
		engine.toggleTask("b", "lifecycle-postflight", "handoff B");
		await executor.markAgentDone("b");
		shipped = await executor.tick();
		expect(shipped).toEqual(["b"]); // chain order: same-tick re-evaluation
		expect(findNodeV2(engine.get(), "b")?.prUrl).toContain("/pr/");
	});

	it("a ship failure blocks the node and stays retryable", async () => {
		const engine = makeEngine();
		engine.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "A",
			branch: "feat/a",
			tasks: ["a1"],
		});
		const executor = new NodeExecutor(engine, deps());
		shipFails.add("a");
		await executor.tick();
		engine.toggleTask("a", "a1");
		engine.toggleTask("a", "lifecycle-postflight", "h");
		await executor.markAgentDone("a");
		expect(await executor.tick()).toEqual([]);
		expect(executor.getRunState("a")?.blocked).toContain("shipping failed");
		expect(findNodeV2(engine.get(), "a")?.status).toBe("complete");
		// The cause fixed, the next tick ships (v1 retryability).
		shipFails.delete("a");
		executor.unblockNode("a");
		expect(await executor.tick()).toEqual(["a"]);
	});
});

describe("restart hydration + recovery", () => {
	it("hydrates active nodes blocked, then recoverInterrupted resumes them", async () => {
		const engine = makeEngine();
		engine.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "Build",
			branch: "feat/build",
			tasks: ["implement"],
		});
		const first = new NodeExecutor(engine, deps());
		await first.tick(); // spawned; session fields persisted on the ledger

		// A fresh executor over the same engine = a restarted maestro.
		const revived = new NodeExecutor(engine, deps());
		const state = revived.getRunState("build");
		expect(state?.blocked).toContain(RESTART_BLOCK_PREFIX);
		// The persisted session file makes the respawn a RESUME.
		expect(state?.sessionFile).toBe("/tmp/build.jsonl");

		spawns = [];
		const result = await revived.recoverInterrupted();
		expect(result.recovered).toEqual(["build"]);
		expect(spawns[0]).toMatchObject({
			nodeId: "build",
			resumeSessionFile: "/tmp/build.jsonl",
		});
		expect(spawns[0].kickoffMessage).toContain("resumed");
	});

	it("replaceWorker advances the generation on the ledger and proves the spawn", async () => {
		const engine = makeEngine();
		engine.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "Build",
			branch: "feat/build",
		});
		const executor = new NodeExecutor(engine, deps());
		await executor.tick();
		const replaced = await executor.replaceWorker("build", "resume", 3);
		expect(replaced.generation).toBe(3);
		expect(findNodeV2(engine.get(), "build")?.sessionGeneration).toBe(3);
		expect(executor.getRunState("build")?.status).toBe("working");
	});
});
