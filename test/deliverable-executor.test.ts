import { describe, expect, it, vi } from "vitest";
import {
	DeliverableExecutor,
	type ExecutorDeps,
} from "../packages/modes/src/deliverable-executor.js";
import { PlanEngine } from "../packages/modes/src/engine.js";
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
		shipDeliverable: vi
			.fn()
			.mockResolvedValue("https://github.com/org/repo/pull/1"),
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

describe("DeliverableExecutor — activation", () => {
	it("parks a deliverable blocked when provisioning fails — never throws", async () => {
		// A provisioning error (e.g. base branch missing after origin's default
		// changed) escaped the tick and crashed the whole maestro as an
		// uncaughtException. It must park the deliverable blocked instead.
		const engine = setupPlan();
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		engine.addWorkItem("auth", { title: "Implement login" });

		const deps = makeDeps();
		deps.createWorktree = vi
			.fn()
			.mockRejectedValue(
				new Error('git worktree add failed: base branch "dev" not found'),
			);
		const executor = new DeliverableExecutor(engine, deps);
		await expect(executor.tick()).resolves.toBeDefined(); // no throw
		expect(deps.spawnAgent).not.toHaveBeenCalled();

		const state = executor.getStates().get("auth");
		expect(state?.blocked).toContain("activation failed");
		expect(state?.blocked).toContain('base branch "dev" not found');
		expect(state?.blocked).toContain("/retry auth");

		// Still blocked on later ticks: no activation retry storm.
		await executor.tick();
		expect(deps.createWorktree).toHaveBeenCalledTimes(1);

		// /retry clears the block; the next tick re-attempts activation.
		deps.createWorktree = vi.fn().mockResolvedValue("/tmp/worktree");
		executor.unblockDeliverable("auth");
		await executor.tick();
		expect(deps.createWorktree).toHaveBeenCalledTimes(1);
		expect(engine.get().deliverables[0].status).toBe("active");
	});

	it("activates a ready deliverable on tick", async () => {
		const engine = setupPlan();
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		engine.addWorkItem("auth", { title: "Implement login" });

		const deps = makeDeps();
		const executor = new DeliverableExecutor(engine, deps);
		await executor.tick();

		expect(engine.get().deliverables[0].status).toBe("active");
		expect(deps.createWorktree).toHaveBeenCalledWith(
			expect.objectContaining({ deliverableId: "auth", branch: "feat/auth" }),
		);
		expect(deps.spawnAgent).toHaveBeenCalledWith(
			expect.objectContaining({ deliverableId: "auth", agentName: "worker" }),
		);
	});

	it("does not activate deliverable with unmet deps", async () => {
		const engine = setupPlan();
		engine.addDeliverable({ title: "Auth", workerMode: "full", dependsOn: [] });
		engine.addWorkItem("auth", { title: "t1" });
		engine.addDeliverable({
			title: "API",
			workerMode: "full",
			dependsOn: ["auth"],
		});
		engine.addWorkItem("api", { title: "t2" });

		const deps = makeDeps();
		const executor = new DeliverableExecutor(engine, deps);
		await executor.tick();

		// auth activated, api still planned
		expect(engine.get().deliverables[0].status).toBe("active");
		expect(engine.get().deliverables[1].status).toBe("planned");
	});

	it("does not activate downstream deliverable while dep is merely active", async () => {
		const engine = setupPlan();
		engine.addDeliverable({ title: "Auth", workerMode: "full", dependsOn: [] });
		engine.addWorkItem("auth", { title: "t1" });
		engine.addDeliverable({
			title: "API",
			workerMode: "full",
			dependsOn: ["auth"],
		});
		engine.addWorkItem("api", { title: "t2" });

		const deps = makeDeps();
		const executor = new DeliverableExecutor(engine, deps);

		// First tick: auth activates
		await executor.tick();
		expect(engine.get().deliverables[0].status).toBe("active");

		// auth's branch tip is still empty — api must keep waiting
		await executor.tick();
		expect(engine.get().deliverables[1].status).toBe("planned");
	});

	it("activates downstream deliverable once dep completes, with dep summary available", async () => {
		const engine = setupPlan();
		engine.addDeliverable({ title: "Auth", workerMode: "full", dependsOn: [] });
		engine.addWorkItem("auth", { title: "t1" });
		engine.addDeliverable({
			title: "API",
			workerMode: "full",
			dependsOn: ["auth"],
		});
		engine.addWorkItem("api", { title: "t2" });

		const requestSummary = vi
			.fn()
			.mockResolvedValue("### Auth summary\nLogin endpoint shipped.");
		const deps = makeDeps({ requestSummary });
		const executor = new DeliverableExecutor(engine, deps);

		await executor.tick(); // auth activates
		await executor.markAgentDone("auth", "worker"); // auth completes
		expect(engine.get().deliverables[0].status).toBe("complete");

		await executor.tick(); // api activates (and auth ships)
		expect(engine.get().deliverables[1].status).toBe("active");

		// api's worker was seeded with auth's real summary
		const call = (deps.spawnAgent as ReturnType<typeof vi.fn>).mock.calls.find(
			(c: unknown[]) =>
				(c[0] as { deliverableId: string }).deliverableId === "api",
		);
		expect(call).toBeDefined();
		expect((call![0] as { seed: string }).seed).toContain("Auth summary");
	});

	it("activates downstream deliverable when its dep is abandoned, based on the default branch", async () => {
		const engine = setupPlan();
		engine.addDeliverable({ title: "Auth", workerMode: "full", dependsOn: [] });
		engine.addWorkItem("auth", { title: "t1" });
		engine.addDeliverable({
			title: "API",
			workerMode: "full",
			dependsOn: ["auth"],
		});
		engine.addWorkItem("api", { title: "t2" });
		engine.setDeliverableStatus("auth", "abandoned");

		const deps = makeDeps({ defaultBranch: "main" });
		const executor = new DeliverableExecutor(engine, deps);
		await executor.tick();

		// A dead parent must not wedge the chain — api activates from main.
		expect(engine.get().deliverables[1].status).toBe("active");
		expect(deps.createWorktree).toHaveBeenCalledWith(
			expect.objectContaining({ deliverableId: "api", baseBranch: "main" }),
		);
	});
});

describe("DeliverableExecutor — agent graph", () => {
	it("spawns worker immediately when no pre-agents", async () => {
		const engine = setupPlan();
		engine.addDeliverable({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });
		engine.addAgent("work", {
			name: "review",
			mode: "read-only",
			effort: "high",
			focus: "security",
			after: ["worker"],
		});

		const deps = makeDeps();
		const executor = new DeliverableExecutor(engine, deps);
		await executor.tick();

		// Worker spawned immediately, review is pending
		const state = executor.getStates().get("work")!;
		expect(state.agents.get("worker")!.status).toBe("working");
		expect(state.agents.get("review")!.status).toBe("pending");
	});

	it("spawns next agent after dependency completes", async () => {
		const engine = setupPlan();
		engine.addDeliverable({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });
		engine.addAgent("work", {
			name: "review",
			mode: "read-only",
			effort: "high",
			focus: "security",
			after: ["worker"],
		});

		const deps = makeDeps();
		const executor = new DeliverableExecutor(engine, deps);
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
		engine.addDeliverable({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });
		engine.addAgent("work", {
			name: "security",
			mode: "read-only",
			effort: "high",
			focus: "sec",
			after: ["worker"],
		});
		engine.addAgent("work", {
			name: "perf",
			mode: "read-only",
			effort: "low",
			focus: "perf",
			after: ["worker"],
		});

		const deps = makeDeps();
		const executor = new DeliverableExecutor(engine, deps);
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

describe("DeliverableExecutor — completion and shipping", () => {
	it("marks deliverable complete when all agents done", async () => {
		const engine = setupPlan();
		engine.addDeliverable({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });

		const deps = makeDeps();
		const executor = new DeliverableExecutor(engine, deps);
		await executor.tick();

		// Mark worker done
		await executor.markAgentDone("work", "worker");

		expect(engine.get().deliverables[0].status).toBe("complete");
	});

	it("ships a complete deliverable", async () => {
		const engine = setupPlan();
		engine.addDeliverable({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });

		const deps = makeDeps();
		const executor = new DeliverableExecutor(engine, deps);
		await executor.tick();
		await executor.markAgentDone("work", "worker");

		// Tick ships the now-complete deliverable
		const shipped = await executor.tick();
		expect(shipped).toEqual(["work"]);
		expect(engine.get().deliverables[0].status).toBe("shipped");
		expect(deps.shipDeliverable).toHaveBeenCalled();
	});

	it("holds ship and surfaces a blocked reason when the panel gate fails", async () => {
		const engine = setupPlan();
		engine.addDeliverable({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });

		const deps = makeDeps({
			panelGate: () => false,
			panelGateDetail: () => "security-audit requested changes",
		});
		const executor = new DeliverableExecutor(engine, deps);
		await executor.tick();
		await executor.markAgentDone("work", "worker");

		const shipped = await executor.tick();
		// The worker is done but the gate blocks: no ship, deadlock surfaced.
		expect(shipped).toEqual([]);
		expect(engine.get().deliverables[0].status).toBe("complete");
		expect(deps.shipDeliverable).not.toHaveBeenCalled();
		expect(executor.getStates().get("work")?.blocked).toBe(
			"ship gate: security-audit requested changes",
		);
	});

	it("ships once the gate opens, clearing the stale gate-block note", async () => {
		const engine = setupPlan();
		engine.addDeliverable({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });

		let gateOpen = false;
		const deps = makeDeps({
			panelGate: () => gateOpen,
			panelGateDetail: () => "correctness-review not yet reviewed",
		});
		const executor = new DeliverableExecutor(engine, deps);
		await executor.tick();
		await executor.markAgentDone("work", "worker");

		await executor.tick(); // blocked
		expect(engine.get().deliverables[0].status).toBe("complete");
		expect(executor.getStates().get("work")?.blocked).toContain("ship gate:");

		gateOpen = true; // worker's next panel round passed
		const shipped = await executor.tick();
		expect(shipped).toEqual(["work"]);
		expect(engine.get().deliverables[0].status).toBe("shipped");
		expect(executor.getStates().get("work")?.blocked).toBeUndefined();
	});

	it("ships a complete deliverable even when it has dependents — the chain needs its branch on the remote", async () => {
		const engine = setupPlan();
		engine.addDeliverable({ title: "A", workerMode: "full", dependsOn: [] });
		engine.addWorkItem("a", { title: "t1" });
		engine.addDeliverable({ title: "B", workerMode: "full", dependsOn: ["a"] });
		engine.addWorkItem("b", { title: "t2" });

		const deps = makeDeps();
		const executor = new DeliverableExecutor(engine, deps);
		await executor.tick(); // a activates
		await executor.markAgentDone("a", "worker"); // a completes

		const shipped = await executor.tick();
		expect(shipped).toEqual(["a"]);
		expect(engine.get().deliverables[0].status).toBe("shipped");
	});

	it("ships an A←B chain in order and never auto-supersedes the predecessor", async () => {
		const engine = setupPlan();
		engine.addDeliverable({ title: "A", workerMode: "full", dependsOn: [] });
		engine.addWorkItem("a", { title: "t1" });
		engine.addDeliverable({ title: "B", workerMode: "full", dependsOn: ["a"] });
		engine.addWorkItem("b", { title: "t2" });

		const deps = makeDeps();
		const executor = new DeliverableExecutor(engine, deps);

		await executor.tick(); // a activates
		await executor.markAgentDone("a", "worker"); // a completes
		const firstShipped = await executor.tick(); // a ships, b activates
		expect(firstShipped).toEqual(["a"]);

		// b's worktree stacks on a's real branch tip
		expect(deps.createWorktree).toHaveBeenCalledWith(
			expect.objectContaining({ deliverableId: "b", baseBranch: "feat/a" }),
		);

		await executor.markAgentDone("b", "worker"); // b completes
		const secondShipped = await executor.tick();
		expect(secondShipped).toEqual(["b"]);

		// Both PRs stand: a stays shipped — superseding is a user decision.
		expect(engine.get().deliverables.find((g) => g.id === "a")!.status).toBe(
			"shipped",
		);
		expect(engine.get().deliverables.find((g) => g.id === "b")!.status).toBe(
			"shipped",
		);
	});

	it("retries a failed ship and ships the unblocked chain in one tick", async () => {
		const engine = setupPlan();
		engine.addDeliverable({ title: "A", workerMode: "full", dependsOn: [] });
		engine.addWorkItem("a", { title: "t1" });
		engine.addDeliverable({ title: "B", workerMode: "full", dependsOn: ["a"] });
		engine.addWorkItem("b", { title: "t2" });

		const shipDeliverable = vi
			.fn()
			.mockRejectedValueOnce(new Error("push failed"))
			.mockResolvedValue("https://github.com/org/repo/pull/1");
		const deps = makeDeps({ shipDeliverable });
		const executor = new DeliverableExecutor(engine, deps);

		await executor.tick(); // a activates
		await executor.markAgentDone("a", "worker"); // a completes

		// Ship fails → a stays complete (retryable), b still activates
		const failedShip = await executor.tick();
		expect(failedShip).toEqual([]);
		expect(engine.get().deliverables[0].status).toBe("complete");
		expect(engine.get().deliverables[1].status).toBe("active");

		await executor.markAgentDone("b", "worker"); // b completes

		// Both complete → one tick ships a, then b (a's ship unblocks b)
		const shipped = await executor.tick();
		expect(shipped).toEqual(["a", "b"]);
		expect(engine.get().deliverables[0].status).toBe("shipped");
		expect(engine.get().deliverables[1].status).toBe("shipped");
	});
});

describe("DeliverableExecutor — summary extraction", () => {
	it("requests summary from agent on completion", async () => {
		const engine = setupPlan();
		engine.addDeliverable({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });

		const requestSummary = vi.fn().mockResolvedValue("### summary\nDid stuff.");
		const deps = makeDeps({ requestSummary });
		const executor = new DeliverableExecutor(engine, deps);
		await executor.tick();
		await executor.markAgentDone("work", "worker");

		expect(requestSummary).toHaveBeenCalled();
		const state = executor.getStates().get("work")!;
		expect(state.agents.get("worker")!.summary).toBe("### summary\nDid stuff.");
	});

	it("kills session after summary extraction", async () => {
		const engine = setupPlan();
		engine.addDeliverable({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });

		const killSession = vi.fn().mockResolvedValue(undefined);
		const deps = makeDeps({ killSession });
		const executor = new DeliverableExecutor(engine, deps);
		await executor.tick();
		await executor.markAgentDone("work", "worker");

		expect(killSession).toHaveBeenCalledWith("tmux-session-123");
	});
});

describe("DeliverableExecutor — worker done detection", () => {
	it("isWorkerDone returns true when all tasks toggled", () => {
		const engine = setupPlan();
		engine.addDeliverable({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "t1" });
		engine.addWorkItem("work", { title: "t2" });

		const executor = new DeliverableExecutor(engine, makeDeps());

		expect(executor.isWorkerDone("work")).toBe(false);
		engine.toggleWorkItem("work", "t1");
		expect(executor.isWorkerDone("work")).toBe(false);
		engine.toggleWorkItem("work", "t2");
		expect(executor.isWorkerDone("work")).toBe(true);
	});
});

describe("DeliverableExecutor — lifecycle correctness", () => {
	it("dedupes concurrent markAgentDone calls into one summarize + kill", async () => {
		const engine = setupPlan();
		engine.addDeliverable({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });

		const requestSummary = vi.fn(async () => {
			await new Promise((r) => setTimeout(r, 25));
			return "## Summary\ndid work";
		});
		const killSession = vi.fn().mockResolvedValue(undefined);
		const deps = makeDeps({ requestSummary, killSession });
		const executor = new DeliverableExecutor(engine, deps);
		await executor.tick();

		// RPC done and the poll timer race the same completion.
		await Promise.all([
			executor.markAgentDone("work", "worker"),
			executor.markAgentDone("work", "worker"),
		]);

		expect(requestSummary).toHaveBeenCalledTimes(1);
		expect(killSession).toHaveBeenCalledTimes(1);
		expect(executor.getAgentState("work", "worker")!.status).toBe("done");
		expect(engine.get().deliverables[0].status).toBe("complete");
	});

	it("leaves a summarizing agent alone on a late markAgentDone", async () => {
		const engine = setupPlan();
		engine.addDeliverable({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });

		const killSession = vi.fn().mockResolvedValue(undefined);
		const deps = makeDeps({ killSession });
		const executor = new DeliverableExecutor(engine, deps);
		await executor.tick();

		executor.getAgentState("work", "worker")!.status = "summarizing";
		await executor.markAgentDone("work", "worker");

		expect(killSession).not.toHaveBeenCalled();
		expect(executor.getAgentState("work", "worker")!.status).toBe(
			"summarizing",
		);
	});

	it("activates a deliverable exactly once under concurrent ticks", async () => {
		const engine = setupPlan();
		engine.addDeliverable({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });

		// Provisioning awaits before the status flips to active — the window
		// where an overlapping tick used to double-activate.
		const createWorktree = vi.fn(async () => {
			await new Promise((r) => setTimeout(r, 25));
			return "/tmp/worktree";
		});
		const deps = makeDeps({ createWorktree });
		const executor = new DeliverableExecutor(engine, deps);

		await Promise.all([executor.tick(), executor.tick()]);

		expect(createWorktree).toHaveBeenCalledTimes(1);
		expect(deps.spawnAgent).toHaveBeenCalledTimes(1);
		expect(engine.get().deliverables[0].status).toBe("active");
	});

	it("hydrates active deliverables as blocked and does not respawn agents", async () => {
		const engine = setupPlan();
		engine.addDeliverable({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });
		engine.setDeliverableStatus("work", "active");
		engine.updateDeliverable("work", { worktreePath: "/tmp/worktree" });

		const deps = makeDeps();
		const executor = new DeliverableExecutor(engine, deps);

		const state = executor.getStates().get("work")!;
		expect(state.blocked).toMatch(/maestro restarted/);

		// Ticks never spawn into the blocked deliverable — orphaned pi processes
		// may still live in its tmux sessions.
		await executor.tick();
		await executor.tick();
		expect(deps.spawnAgent).not.toHaveBeenCalled();

		// A user-driven retry unblocks and resumes spawning.
		executor.unblockDeliverable("work");
		await executor.tick();
		expect(deps.spawnAgent).toHaveBeenCalledTimes(1);
		expect(deps.spawnAgent).toHaveBeenCalledWith(
			expect.objectContaining({ deliverableId: "work", agentName: "worker" }),
		);
	});
});

describe("DeliverableExecutor — seed construction", () => {
	it("includes dep summaries in worker seed", async () => {
		const engine = setupPlan();
		engine.addDeliverable({ title: "A", workerMode: "full", dependsOn: [] });
		engine.addWorkItem("a", { title: "t1" });
		engine.addDeliverable({ title: "B", workerMode: "full", dependsOn: ["a"] });
		engine.addWorkItem("b", { title: "t2" });

		// Manually set A's summary (simulating completion)
		engine.updateDeliverable("a", {
			summary: "### A summary\nDid auth stuff.",
		});
		engine.setDeliverableStatus("a", "active");
		engine.setDeliverableStatus("a", "complete");

		const spawnAgent = vi.fn().mockResolvedValue({
			sessionId: "sess-123",
			sessionFile: "/tmp/sessions/agent.jsonl",
		});
		const deps = makeDeps({ spawnAgent });
		const executor = new DeliverableExecutor(engine, deps);
		await executor.tick(); // B activates

		// Check the seed passed to B's worker contains A's summary
		const call = spawnAgent.mock.calls.find(
			(c: unknown[]) =>
				(c[0] as { deliverableId: string }).deliverableId === "b",
		);
		expect(call).toBeDefined();
		const seed = (call![0] as { seed: string }).seed;
		expect(seed).toContain("A summary");
		expect(seed).toContain("Did auth stuff");
	});
});

describe("DeliverableExecutor — scratch deliverables", () => {
	function addScratch(engine: PlanEngine, title: string, id: string) {
		engine.addDeliverable({ title, workerMode: "full", workspace: "scratch" });
		engine.addWorkItem(id, { title: "do the thing" });
	}

	it("activates in a scratch workspace — no worktree, no branch", async () => {
		const engine = setupPlan();
		addScratch(engine, "Bootstrap", "bootstrap");

		const createScratchWorkspace = vi
			.fn()
			.mockResolvedValue("/tmp/plans/test/workspaces/bootstrap");
		const deps = makeDeps({ createScratchWorkspace });
		const executor = new DeliverableExecutor(engine, deps);
		await executor.tick();

		expect(createScratchWorkspace).toHaveBeenCalledWith("bootstrap");
		expect(deps.createWorktree).not.toHaveBeenCalled();
		expect(engine.get().deliverables[0].status).toBe("active");
		expect(engine.get().deliverables[0].branch).toBeUndefined();
		expect(executor.getStates().get("bootstrap")?.branch).toBeUndefined();
		expect(deps.spawnAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				worktreePath: "/tmp/plans/test/workspaces/bootstrap",
			}),
		);
	});

	it("parks scratch activation blocked when the runtime lacks scratch support", async () => {
		const engine = setupPlan();
		addScratch(engine, "Bootstrap", "bootstrap");

		const deps = makeDeps(); // no createScratchWorkspace
		const executor = new DeliverableExecutor(engine, deps);
		await executor.tick();

		expect(executor.getStates().get("bootstrap")?.blocked).toContain(
			"cannot provision scratch workspaces",
		);
	});

	it("ships without push or PR — status shipped, no prUrl, dependents unblock", async () => {
		const engine = setupPlan();
		addScratch(engine, "Bootstrap", "bootstrap");
		engine.addDeliverable({
			title: "Impl",
			workerMode: "full",
			dependsOn: ["bootstrap"],
		});
		engine.addWorkItem("impl", { title: "t" });

		const createScratchWorkspace = vi.fn().mockResolvedValue("/tmp/ws");
		const deps = makeDeps({ createScratchWorkspace });
		const executor = new DeliverableExecutor(engine, deps);
		await executor.tick();
		await executor.markAgentDone("bootstrap", "worker");

		const shipped = await executor.tick();
		expect(shipped).toContain("bootstrap");
		const bootstrap = engine.get().deliverables[0];
		expect(bootstrap.status).toBe("shipped");
		expect(bootstrap.prUrl).toBeUndefined();
		expect(deps.shipDeliverable).not.toHaveBeenCalled();
		// The dependent activated through the normal DAG rule in the same tick.
		expect(engine.get().deliverables[1].status).toBe("active");
	});

	it("the ship gate still gates a scratch deliverable", async () => {
		const engine = setupPlan();
		addScratch(engine, "Bootstrap", "bootstrap");

		const deps = makeDeps({
			createScratchWorkspace: vi.fn().mockResolvedValue("/tmp/ws"),
			panelGate: () => false,
			panelGateDetail: () => "security-audit requested changes",
		});
		const executor = new DeliverableExecutor(engine, deps);
		await executor.tick();
		await executor.markAgentDone("bootstrap", "worker");

		const shipped = await executor.tick();
		expect(shipped).toEqual([]);
		expect(engine.get().deliverables[0].status).toBe("complete");
		expect(executor.getStates().get("bootstrap")?.blocked).toBe(
			"ship gate: security-audit requested changes",
		);
	});

	it("scratch worker seed has no commit/PR instructions", async () => {
		const engine = setupPlan();
		addScratch(engine, "Bootstrap", "bootstrap");

		const spawnAgent = vi.fn().mockResolvedValue({
			sessionId: "sess",
			sessionFile: "/tmp/s.jsonl",
		});
		const deps = makeDeps({
			spawnAgent,
			createScratchWorkspace: vi.fn().mockResolvedValue("/tmp/ws"),
		});
		const executor = new DeliverableExecutor(engine, deps);
		await executor.tick();

		const seed = (spawnAgent.mock.calls[0][0] as { seed: string }).seed;
		expect(seed).toContain("no git branch or PR here");
		expect(seed).not.toContain("Commit as you go");
	});
});

describe("DeliverableExecutor — late-bound repos", () => {
	it("activation fails with the creator named when the repo is not materialized", async () => {
		const engine = setupPlan();
		// The creator first (createdBy must reference an existing deliverable),
		// then the registry entry, then the dependent targeting the repo.
		engine.addDeliverable({
			title: "Bootstrap",
			workerMode: "full",
			workspace: "scratch",
		});
		engine.addWorkItem("bootstrap", { title: "create the repo" });
		engine.registerRepo({
			key: "svc",
			path: "/nonexistent/svc-repo",
			createdBy: "bootstrap",
		});
		engine.addDeliverable({
			title: "Impl",
			workerMode: "full",
			repo: "svc",
			dependsOn: ["bootstrap"],
		});
		engine.addWorkItem("impl", { title: "t" });

		const deps = makeDeps({
			createScratchWorkspace: vi.fn().mockResolvedValue("/tmp/ws"),
		});
		const executor = new DeliverableExecutor(engine, deps);
		await executor.tick();
		await executor.markAgentDone("bootstrap", "worker");
		await executor.tick(); // bootstrap ships; impl tries to activate

		const state = executor.getStates().get("impl");
		expect(state?.blocked).toContain('repo "svc"');
		expect(state?.blocked).toContain("not materialized");
		expect(state?.blocked).toContain('"bootstrap"');
		expect(deps.createWorktree).not.toHaveBeenCalled();
	});

	it("routes worktree creation through the deliverable's registry repo", async () => {
		const engine = setupPlan();
		// Registry repo that exists on disk (any real dir works for the check).
		engine.registerRepo({ key: "svc", path: "/tmp" });
		engine.addDeliverable({ title: "Impl", workerMode: "full", repo: "svc" });
		engine.addWorkItem("impl", { title: "t" });

		const deps = makeDeps({ defaultBranchFor: () => "develop" });
		const executor = new DeliverableExecutor(engine, deps);
		await executor.tick();

		expect(deps.createWorktree).toHaveBeenCalledWith(
			expect.objectContaining({ repoPath: "/tmp", baseBranch: "develop" }),
		);
	});
});
