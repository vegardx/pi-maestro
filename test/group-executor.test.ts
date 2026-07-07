import { describe, expect, it, vi } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
import {
	type ExecutorDeps,
	GroupExecutor,
} from "../packages/modes/src/group-executor.js";
import type { Plan } from "../packages/modes/src/schema.js";
import type { PlanStore } from "../packages/modes/src/storage.js";

function memStore(): PlanStore & { last: Plan | null } {
	let saved: Plan | null = null;
	return {
		root: "/tmp/plans",
		save(plan: Plan) {
			saved = plan;
		},
		load(_slug: string): Plan | null {
			return saved;
		},
		exists(_slug: string): boolean {
			return saved !== null;
		},
		remove(_slug: string) {
			saved = null;
		},
		list() {
			return [];
		},
		get last() {
			return saved;
		},
	};
}

function makeDeps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
	return {
		spawnAgent: vi.fn().mockResolvedValue({
			sessionId: "tmux-session-123",
			sessionFile: "/tmp/sessions/agent.jsonl",
		}),
		killSession: vi.fn().mockResolvedValue(undefined),
		createWorktree: vi.fn().mockResolvedValue("/tmp/worktree"),
		shipGroup: vi.fn().mockResolvedValue("https://github.com/org/repo/pull/1"),
		requestSummary: vi.fn().mockResolvedValue("Agent summary here."),
		now: () => "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function setupPlan() {
	const store = memStore();
	const engine = PlanEngine.create(store, {
		slug: "test",
		title: "Test",
		repoPath: "/tmp/repo",
	});
	return engine;
}

describe("GroupExecutor — activation", () => {
	it("activates a ready group on tick", async () => {
		const engine = setupPlan();
		engine.addGroup({ title: "Auth", workerMode: "full" });
		engine.addWorkItem("auth", { title: "Implement login" });

		const deps = makeDeps();
		const executor = new GroupExecutor(engine, deps);
		await executor.tick();

		expect(engine.get().groups[0].status).toBe("active");
		expect(deps.createWorktree).toHaveBeenCalledWith(
			expect.objectContaining({ groupId: "auth", branch: "feat/auth" }),
		);
		expect(deps.spawnAgent).toHaveBeenCalledWith(
			expect.objectContaining({ groupId: "auth", agentName: "worker" }),
		);
	});

	it("does not activate group with unmet deps", async () => {
		const engine = setupPlan();
		engine.addGroup({ title: "Auth", workerMode: "full", dependsOn: [] });
		engine.addWorkItem("auth", { title: "t1" });
		engine.addGroup({ title: "API", workerMode: "full", dependsOn: ["auth"] });
		engine.addWorkItem("api", { title: "t2" });

		const deps = makeDeps();
		const executor = new GroupExecutor(engine, deps);
		await executor.tick();

		// auth activated, api still planned
		expect(engine.get().groups[0].status).toBe("active");
		expect(engine.get().groups[1].status).toBe("planned");
	});

	it("activates downstream group after dep becomes active", async () => {
		const engine = setupPlan();
		engine.addGroup({ title: "Auth", workerMode: "full", dependsOn: [] });
		engine.addWorkItem("auth", { title: "t1" });
		engine.addGroup({ title: "API", workerMode: "full", dependsOn: ["auth"] });
		engine.addWorkItem("api", { title: "t2" });

		const deps = makeDeps();
		const executor = new GroupExecutor(engine, deps);

		// First tick: auth activates
		await executor.tick();
		expect(engine.get().groups[0].status).toBe("active");

		// Second tick: api should now activate (auth is "active" which satisfies deps)
		await executor.tick();
		expect(engine.get().groups[1].status).toBe("active");
	});
});

describe("GroupExecutor — agent graph", () => {
	it("spawns worker immediately when no pre-agents", async () => {
		const engine = setupPlan();
		engine.addGroup({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });
		engine.addAgent("work", {
			name: "review",
			mode: "read-only",
			slot: "alternate",
			effort: "high",
			focus: "security",
			after: ["worker"],
		});

		const deps = makeDeps();
		const executor = new GroupExecutor(engine, deps);
		await executor.tick();

		// Worker spawned immediately, review is pending
		const state = executor.getStates().get("work")!;
		expect(state.agents.get("worker")!.status).toBe("working");
		expect(state.agents.get("review")!.status).toBe("pending");
	});

	it("spawns next agent after dependency completes", async () => {
		const engine = setupPlan();
		engine.addGroup({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });
		engine.addAgent("work", {
			name: "review",
			mode: "read-only",
			slot: "alternate",
			effort: "high",
			focus: "security",
			after: ["worker"],
		});

		const deps = makeDeps();
		const executor = new GroupExecutor(engine, deps);
		await executor.tick();

		// Mark worker done
		await executor.markAgentDone("work", "worker");

		// Tick advances: review should now spawn
		await executor.tick();
		const state = executor.getStates().get("work")!;
		expect(state.agents.get("review")!.status).toBe("working");
	});

	it("spawns parallel agents together", async () => {
		const engine = setupPlan();
		engine.addGroup({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });
		engine.addAgent("work", {
			name: "security",
			mode: "read-only",
			slot: "alternate",
			effort: "high",
			focus: "sec",
			after: ["worker"],
		});
		engine.addAgent("work", {
			name: "perf",
			mode: "read-only",
			slot: "default",
			effort: "low",
			focus: "perf",
			after: ["worker"],
		});

		const deps = makeDeps();
		const executor = new GroupExecutor(engine, deps);
		await executor.tick();

		// Mark worker done
		await executor.markAgentDone("work", "worker");
		await executor.tick();

		// Both should be working
		const state = executor.getStates().get("work")!;
		expect(state.agents.get("security")!.status).toBe("working");
		expect(state.agents.get("perf")!.status).toBe("working");
	});
});

describe("GroupExecutor — completion and shipping", () => {
	it("marks group complete when all agents done", async () => {
		const engine = setupPlan();
		engine.addGroup({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });

		const deps = makeDeps();
		const executor = new GroupExecutor(engine, deps);
		await executor.tick();

		// Mark worker done
		await executor.markAgentDone("work", "worker");

		expect(engine.get().groups[0].status).toBe("complete");
	});

	it("ships terminal complete group", async () => {
		const engine = setupPlan();
		engine.addGroup({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });

		const deps = makeDeps();
		const executor = new GroupExecutor(engine, deps);
		await executor.tick();
		await executor.markAgentDone("work", "worker");

		// Tick ships the now-complete terminal group
		const shipped = await executor.tick();
		expect(shipped).toEqual(["work"]);
		expect(engine.get().groups[0].status).toBe("shipped");
		expect(deps.shipGroup).toHaveBeenCalled();
	});

	it("does not ship non-terminal complete group", async () => {
		const engine = setupPlan();
		engine.addGroup({ title: "A", workerMode: "full", dependsOn: [] });
		engine.addWorkItem("a", { title: "t1" });
		engine.addGroup({ title: "B", workerMode: "full", dependsOn: ["a"] });
		engine.addWorkItem("b", { title: "t2" });

		const deps = makeDeps();
		const executor = new GroupExecutor(engine, deps);
		await executor.tick(); // a activates
		await executor.markAgentDone("a", "worker"); // a completes

		// a has a dependent (b) → should NOT ship yet
		const shipped = await executor.tick();
		expect(shipped).toEqual([]);
		expect(engine.get().groups[0].status).toBe("complete");
	});

	it("marks predecessor superseded after downstream ships", async () => {
		const engine = setupPlan();
		engine.addGroup({ title: "A", workerMode: "full", dependsOn: [] });
		engine.addWorkItem("a", { title: "t1" });
		engine.addGroup({ title: "B", workerMode: "full", dependsOn: ["a"] });
		engine.addWorkItem("b", { title: "t2" });

		const deps = makeDeps();
		const executor = new GroupExecutor(engine, deps);

		// Activate both
		await executor.tick(); // a activates
		await executor.tick(); // b activates (a is active → satisfies dep)
		await executor.markAgentDone("a", "worker"); // a completes
		await executor.markAgentDone("b", "worker"); // b completes

		// b is terminal → ship b
		const shipped = await executor.tick();
		expect(shipped).toContain("b");
		expect(engine.get().groups.find((g) => g.id === "b")!.status).toBe(
			"shipped",
		);
		// a should now be superseded (its only dependent shipped)
		expect(engine.get().groups.find((g) => g.id === "a")!.status).toBe(
			"superseded",
		);
	});
});

describe("GroupExecutor — summary extraction", () => {
	it("requests summary from agent on completion", async () => {
		const engine = setupPlan();
		engine.addGroup({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });

		const requestSummary = vi.fn().mockResolvedValue("### summary\nDid stuff.");
		const deps = makeDeps({ requestSummary });
		const executor = new GroupExecutor(engine, deps);
		await executor.tick();
		await executor.markAgentDone("work", "worker");

		expect(requestSummary).toHaveBeenCalled();
		const state = executor.getStates().get("work")!;
		expect(state.agents.get("worker")!.summary).toBe("### summary\nDid stuff.");
	});

	it("kills session after summary extraction", async () => {
		const engine = setupPlan();
		engine.addGroup({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });

		const killSession = vi.fn().mockResolvedValue(undefined);
		const deps = makeDeps({ killSession });
		const executor = new GroupExecutor(engine, deps);
		await executor.tick();
		await executor.markAgentDone("work", "worker");

		expect(killSession).toHaveBeenCalledWith("tmux-session-123");
	});
});

describe("GroupExecutor — worker done detection", () => {
	it("isWorkerDone returns true when all tasks toggled", () => {
		const engine = setupPlan();
		engine.addGroup({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "t1" });
		engine.addWorkItem("work", { title: "t2" });

		const executor = new GroupExecutor(engine, makeDeps());

		expect(executor.isWorkerDone("work")).toBe(false);
		engine.toggleWorkItem("work", "t1");
		expect(executor.isWorkerDone("work")).toBe(false);
		engine.toggleWorkItem("work", "t2");
		expect(executor.isWorkerDone("work")).toBe(true);
	});
});

describe("GroupExecutor — lifecycle correctness", () => {
	it("dedupes concurrent markAgentDone calls into one summarize + kill", async () => {
		const engine = setupPlan();
		engine.addGroup({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });

		const requestSummary = vi.fn(async () => {
			await new Promise((r) => setTimeout(r, 25));
			return "## Summary\ndid work";
		});
		const killSession = vi.fn().mockResolvedValue(undefined);
		const deps = makeDeps({ requestSummary, killSession });
		const executor = new GroupExecutor(engine, deps);
		await executor.tick();

		// RPC done and the poll timer race the same completion.
		await Promise.all([
			executor.markAgentDone("work", "worker"),
			executor.markAgentDone("work", "worker"),
		]);

		expect(requestSummary).toHaveBeenCalledTimes(1);
		expect(killSession).toHaveBeenCalledTimes(1);
		expect(executor.getAgentState("work", "worker")!.status).toBe("done");
		expect(engine.get().groups[0].status).toBe("complete");
	});

	it("leaves a summarizing agent alone on a late markAgentDone", async () => {
		const engine = setupPlan();
		engine.addGroup({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });

		const killSession = vi.fn().mockResolvedValue(undefined);
		const deps = makeDeps({ killSession });
		const executor = new GroupExecutor(engine, deps);
		await executor.tick();

		executor.getAgentState("work", "worker")!.status = "summarizing";
		await executor.markAgentDone("work", "worker");

		expect(killSession).not.toHaveBeenCalled();
		expect(executor.getAgentState("work", "worker")!.status).toBe(
			"summarizing",
		);
	});

	it("activates a group exactly once under concurrent ticks", async () => {
		const engine = setupPlan();
		engine.addGroup({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });

		// Provisioning awaits before the status flips to active — the window
		// where an overlapping tick used to double-activate.
		const createWorktree = vi.fn(async () => {
			await new Promise((r) => setTimeout(r, 25));
			return "/tmp/worktree";
		});
		const deps = makeDeps({ createWorktree });
		const executor = new GroupExecutor(engine, deps);

		await Promise.all([executor.tick(), executor.tick()]);

		expect(createWorktree).toHaveBeenCalledTimes(1);
		expect(deps.spawnAgent).toHaveBeenCalledTimes(1);
		expect(engine.get().groups[0].status).toBe("active");
	});

	it("hydrates active groups as blocked and does not respawn agents", async () => {
		const engine = setupPlan();
		engine.addGroup({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });
		engine.setGroupStatus("work", "active");
		engine.updateGroup("work", { worktreePath: "/tmp/worktree" });

		const deps = makeDeps();
		const executor = new GroupExecutor(engine, deps);

		const state = executor.getStates().get("work")!;
		expect(state.blocked).toMatch(/maestro restarted/);

		// Ticks never spawn into the blocked group — orphaned pi processes
		// may still live in its tmux sessions.
		await executor.tick();
		await executor.tick();
		expect(deps.spawnAgent).not.toHaveBeenCalled();

		// A user-driven retry unblocks and resumes spawning.
		executor.unblockGroup("work");
		await executor.tick();
		expect(deps.spawnAgent).toHaveBeenCalledTimes(1);
		expect(deps.spawnAgent).toHaveBeenCalledWith(
			expect.objectContaining({ groupId: "work", agentName: "worker" }),
		);
	});
});

describe("GroupExecutor — seed construction", () => {
	it("includes dep summaries in worker seed", async () => {
		const engine = setupPlan();
		engine.addGroup({ title: "A", workerMode: "full", dependsOn: [] });
		engine.addWorkItem("a", { title: "t1" });
		engine.addGroup({ title: "B", workerMode: "full", dependsOn: ["a"] });
		engine.addWorkItem("b", { title: "t2" });

		// Manually set A's summary (simulating completion)
		engine.updateGroup("a", { summary: "### A summary\nDid auth stuff." });
		engine.setGroupStatus("a", "active");
		engine.setGroupStatus("a", "complete");

		const spawnAgent = vi.fn().mockResolvedValue({
			sessionId: "sess-123",
			sessionFile: "/tmp/sessions/agent.jsonl",
		});
		const deps = makeDeps({ spawnAgent });
		const executor = new GroupExecutor(engine, deps);
		await executor.tick(); // B activates

		// Check the seed passed to B's worker contains A's summary
		const call = spawnAgent.mock.calls.find(
			(c: unknown[]) => (c[0] as { groupId: string }).groupId === "b",
		);
		expect(call).toBeDefined();
		const seed = (call![0] as { seed: string }).seed;
		expect(seed).toContain("A summary");
		expect(seed).toContain("Did auth stuff");
	});
});
