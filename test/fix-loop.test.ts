// Review→fix loop: reviewer verdicts, findings→tasks, worker/objector
// resurrection, round cap, no-progress guard, and the group scheduler
// invariant (one agent type active per group at a time).

import { describe, expect, it, vi } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
import {
	parseVerdict,
	VERDICT_INSTRUCTION,
} from "../packages/modes/src/exec/verdicts.js";
import {
	type ExecutorDeps,
	GroupExecutor,
	type SpawnAgentOpts,
} from "../packages/modes/src/group-executor.js";
import type { Plan } from "../packages/modes/src/schema.js";
import type { PlanStore } from "../packages/modes/src/storage.js";

function memStore(): PlanStore {
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
	};
}

function setupPlan(): PlanEngine {
	return PlanEngine.create(memStore(), {
		slug: "test",
		title: "Test",
		repoPath: "/tmp/repo",
	});
}

/** Worker + two read-only reviewers (sec, perf) gated on the worker. */
function setupReviewedGroup(): PlanEngine {
	const engine = setupPlan();
	engine.addGroup({ title: "Work", workerMode: "full" });
	engine.addWorkItem("work", { title: "implement it" });
	engine.addAgent("work", {
		name: "sec",
		mode: "read-only",
		slot: "alternate",
		effort: "high",
		focus: "security review",
		after: ["worker"],
	});
	engine.addAgent("work", {
		name: "perf",
		mode: "read-only",
		slot: "default",
		effort: "low",
		focus: "performance review",
		after: ["worker"],
	});
	return engine;
}

/** Deps whose requestSummary serves per-agent summaries (mutable between rounds). */
function makeFixDeps(summaries: Map<string, string>) {
	const spawnAgent = vi.fn(async (opts: SpawnAgentOpts) => ({
		sessionId: `sess-${opts.agentName}`,
		sessionFile: `/tmp/sessions/${opts.agentName}.jsonl`,
	}));
	const requestSummary = vi.fn(
		async (sessionId: string, _consumer: string, _preamble: string) => {
			return summaries.get(sessionId) ?? "did work";
		},
	);
	const deps: ExecutorDeps = {
		spawnAgent,
		killSession: vi.fn().mockResolvedValue(undefined),
		createWorktree: vi.fn().mockResolvedValue("/tmp/worktree"),
		shipGroup: vi.fn().mockResolvedValue("https://github.com/org/repo/pull/1"),
		requestSummary,
		now: () => "2026-01-01T00:00:00Z",
	};
	return { deps, spawnAgent, requestSummary };
}

/** Drive the group to the point where both reviewers have reported. */
async function runInitialRound(
	engine: PlanEngine,
	deps: ExecutorDeps,
): Promise<GroupExecutor> {
	const executor = new GroupExecutor(engine, deps);
	await executor.tick(); // worker spawns
	await executor.markAgentDone("work", "worker");
	await executor.tick(); // reviewers spawn
	await executor.markAgentDone("work", "sec");
	await executor.markAgentDone("work", "perf");
	return executor;
}

describe("parseVerdict", () => {
	it("parses approve", () => {
		expect(parseVerdict("All good.\n\nVERDICT: approve")).toEqual({
			verdict: "approve",
			findings: [],
		});
	});

	it("parses request-changes with findings bullets", () => {
		const summary = [
			"Review done.",
			"VERDICT: request-changes",
			"- auth.ts:12 — missing null check",
			"- db.ts:40 — unclosed connection",
		].join("\n");
		expect(parseVerdict(summary)).toEqual({
			verdict: "request-changes",
			findings: [
				"auth.ts:12 — missing null check",
				"db.ts:40 — unclosed connection",
			],
		});
	});

	it("returns none when no VERDICT line exists", () => {
		expect(parseVerdict("I looked at the code. Seems fine.")).toEqual({
			verdict: "none",
			findings: [],
		});
	});

	it("treats a malformed verdict value as none", () => {
		expect(parseVerdict("VERDICT: banana").verdict).toBe("none");
	});

	it("is case-insensitive and tolerant of spacing", () => {
		expect(parseVerdict("verdict:  Request-Changes\n- a — b").verdict).toBe(
			"request-changes",
		);
		expect(parseVerdict("Verdict: APPROVED").verdict).toBe("approve");
	});

	it("uses the last VERDICT line", () => {
		const summary = [
			"VERDICT: request-changes",
			"- old finding",
			"After re-checking:",
			"VERDICT: approve",
		].join("\n");
		expect(parseVerdict(summary)).toEqual({ verdict: "approve", findings: [] });
	});
});

describe("fix loop — verdict instruction", () => {
	it("appends VERDICT_INSTRUCTION to reviewer summarize preambles only", async () => {
		const engine = setupReviewedGroup();
		const summaries = new Map<string, string>([
			["sess-sec", "fine\nVERDICT: approve"],
			["sess-perf", "fine\nVERDICT: approve"],
		]);
		const { deps, requestSummary } = makeFixDeps(summaries);
		await runInitialRound(engine, deps);

		const preambleFor = (session: string) =>
			requestSummary.mock.calls.find((c) => c[0] === session)?.[2] ?? "";
		expect(preambleFor("sess-worker")).not.toContain("VERDICT");
		expect(preambleFor("sess-sec")).toContain(VERDICT_INSTRUCTION);
		expect(preambleFor("sess-perf")).toContain(VERDICT_INSTRUCTION);
	});
});

describe("fix loop — rounds", () => {
	it("completes with no extra round when all reviewers approve", async () => {
		const engine = setupReviewedGroup();
		const summaries = new Map<string, string>([
			["sess-sec", "clean\nVERDICT: approve"],
			["sess-perf", "no verdict either way"], // none → does not block
		]);
		const { deps, spawnAgent } = makeFixDeps(summaries);
		const executor = await runInitialRound(engine, deps);

		expect(engine.get().groups[0].status).toBe("complete");
		const state = executor.getStates().get("work")!;
		expect(state.round).toBe(0);
		expect(state.blocked).toBeUndefined();
		// worker + 2 reviewers, nothing respawned
		expect(spawnAgent).toHaveBeenCalledTimes(3);
	});

	it("starts a fix round on request-changes: tasks, resurrection, re-pending", async () => {
		const engine = setupReviewedGroup();
		const summaries = new Map<string, string>([
			[
				"sess-sec",
				"issues\nVERDICT: request-changes\n- auth.ts:12 — missing null check\n- db.ts:40 — leaked handle",
			],
			["sess-perf", "fast enough\nVERDICT: approve"],
		]);
		const { deps, spawnAgent } = makeFixDeps(summaries);
		const executor = await runInitialRound(engine, deps);

		const group = engine.get().groups[0];
		expect(group.status).toBe("active");

		// Findings became tagged gating tasks
		const roundTasks = group.tasks.filter((t) =>
			t.title.startsWith("[round 1, sec]"),
		);
		expect(roundTasks).toHaveLength(2);
		expect(roundTasks.every((t) => t.kind === "task" && !t.done)).toBe(true);

		// Worker resurrected from its own session with a findings kickoff
		const resurrect = spawnAgent.mock.calls.at(-1)![0];
		expect(resurrect.agentName).toBe("worker");
		expect(resurrect.resumeSessionFile).toBe("/tmp/sessions/worker.jsonl");
		expect(resurrect.kickoffMessage).toContain("[round 1]");
		expect(resurrect.kickoffMessage).toContain(
			"auth.ts:12 — missing null check",
		);
		expect(resurrect.kickoffMessage).toContain("db.ts:40 — leaked handle");

		const state = executor.getStates().get("work")!;
		expect(state.round).toBe(1);
		expect(state.agents.get("worker")!.status).toBe("working");
		expect(state.agents.get("sec")!.status).toBe("pending");
		expect(state.agents.get("sec")!.summary).toBeUndefined();
		expect(state.agents.get("perf")!.status).toBe("done");
		expect(state.completed.has("worker")).toBe(false);
		expect(state.completed.has("sec")).toBe(false);
		expect(state.completed.has("perf")).toBe(true);
	});

	it("completes at round 1 after the objector re-approves", async () => {
		const engine = setupReviewedGroup();
		const summaries = new Map<string, string>([
			["sess-sec", "issues\nVERDICT: request-changes\n- auth.ts:12 — bug"],
			["sess-perf", "VERDICT: approve"],
		]);
		const { deps, spawnAgent } = makeFixDeps(summaries);
		const executor = await runInitialRound(engine, deps);

		// Worker finishes the fix round; only the objector re-runs
		await executor.markAgentDone("work", "worker");
		await executor.tick();
		const secResume = spawnAgent.mock.calls.at(-1)![0];
		expect(secResume.agentName).toBe("sec");
		expect(secResume.resumeSessionFile).toBe("/tmp/sessions/sec.jsonl");
		expect(secResume.kickoffMessage).toContain("auth.ts:12 — bug");

		// Approver was not respawned
		expect(
			spawnAgent.mock.calls.filter((c) => c[0].agentName === "perf"),
		).toHaveLength(1);

		summaries.set("sess-sec", "fixed\nVERDICT: approve");
		await executor.markAgentDone("work", "sec");

		expect(engine.get().groups[0].status).toBe("complete");
		const state = executor.getStates().get("work")!;
		expect(state.round).toBe(1);
		expect(state.blocked).toBeUndefined();
	});

	it("blocks on byte-identical findings instead of looping", async () => {
		const engine = setupReviewedGroup();
		const summaries = new Map<string, string>([
			["sess-sec", "issues\nVERDICT: request-changes\n- auth.ts:12 — bug"],
			["sess-perf", "VERDICT: approve"],
		]);
		const { deps } = makeFixDeps(summaries);
		const executor = await runInitialRound(engine, deps);

		await executor.markAgentDone("work", "worker");
		await executor.tick(); // sec resurrected
		// sec re-raises the exact same findings
		await executor.markAgentDone("work", "sec");

		const state = executor.getStates().get("work")!;
		expect(state.blocked).toBe("review findings unchanged after fix round");
		expect(state.round).toBe(1); // no third round started
		expect(engine.get().groups[0].status).toBe("active");
		const roundTwoTasks = engine
			.get()
			.groups[0].tasks.filter((t) => t.title.startsWith("[round 2"));
		expect(roundTwoTasks).toHaveLength(0);
	});

	it("blocks without corrupting state when adding fix tasks fails", async () => {
		const engine = setupReviewedGroup();
		const summaries = new Map<string, string>([
			["sess-sec", "issues\nVERDICT: request-changes\n- auth.ts:12 — bug"],
			["sess-perf", "VERDICT: approve"],
		]);
		const { deps, spawnAgent } = makeFixDeps(summaries);
		const executor = new GroupExecutor(engine, deps);
		await executor.tick();
		await executor.markAgentDone("work", "worker");
		await executor.tick();
		await executor.markAgentDone("work", "sec");

		// The last completion triggers the fix round; task creation blows up.
		const addSpy = vi.spyOn(engine, "addWorkItem").mockImplementation(() => {
			throw new Error("validation failed");
		});
		await executor.markAgentDone("work", "perf");
		addSpy.mockRestore();

		const state = executor.getStates().get("work")!;
		expect(state.blocked).toBe("fix round failed: validation failed");
		expect(state.round).toBe(0); // restored — no half-armed round
		// No agent was re-pended, and no findings were recorded for the
		// no-progress guard to false-trip on later.
		expect(state.agents.get("worker")!.status).toBe("done");
		expect(state.agents.get("sec")!.status).toBe("done");
		expect(state.completed.has("worker")).toBe(true);
		expect(state.lastFindingsByReviewer?.get("sec")).toBeUndefined();
		// Worker was not resurrected and no round tasks landed.
		expect(spawnAgent).toHaveBeenCalledTimes(3);
		expect(
			engine.get().groups[0].tasks.filter((t) => t.title.startsWith("[round")),
		).toHaveLength(0);
		expect(engine.get().groups[0].status).toBe("active");
	});

	it("holds dependent groups back while the group churns through fix rounds", async () => {
		const engine = setupReviewedGroup();
		engine.addGroup({
			title: "Downstream",
			workerMode: "full",
			dependsOn: ["work"],
		});
		engine.addWorkItem("downstream", { title: "build on work" });
		const summaries = new Map<string, string>([
			["sess-sec", "issues\nVERDICT: request-changes\n- auth.ts:12 — bug"],
			["sess-perf", "VERDICT: approve"],
		]);
		const { deps } = makeFixDeps(summaries);
		const executor = await runInitialRound(engine, deps);

		// work is mid fix round (active) — downstream must not activate yet
		expect(engine.get().groups[0].status).toBe("active");
		await executor.tick();
		expect(engine.get().groups.find((g) => g.id === "downstream")!.status).toBe(
			"planned",
		);

		// Fix round converges → work completes → downstream activates
		await executor.markAgentDone("work", "worker");
		await executor.tick(); // sec resurrected
		summaries.set("sess-sec", "fixed\nVERDICT: approve");
		await executor.markAgentDone("work", "sec");
		expect(engine.get().groups[0].status).toBe("complete");

		await executor.tick();
		expect(engine.get().groups.find((g) => g.id === "downstream")!.status).toBe(
			"active",
		);
	});

	it("blocks when the fix-round cap is reached", async () => {
		const engine = setupReviewedGroup();
		engine.updateGroup("work", { maxFixRounds: 1 });
		const summaries = new Map<string, string>([
			["sess-sec", "issues\nVERDICT: request-changes\n- auth.ts:12 — bug"],
			["sess-perf", "VERDICT: approve"],
		]);
		const { deps } = makeFixDeps(summaries);
		const executor = await runInitialRound(engine, deps);

		await executor.markAgentDone("work", "worker");
		await executor.tick(); // sec resurrected
		// Different findings (progress) but the cap is 1
		summaries.set(
			"sess-sec",
			"more issues\nVERDICT: request-changes\n- auth.ts:99 — new bug",
		);
		await executor.markAgentDone("work", "sec");

		const state = executor.getStates().get("work")!;
		expect(state.blocked).toBe("fix-round cap reached; 1 findings outstanding");
		expect(state.round).toBe(1);
		expect(engine.get().groups[0].status).toBe("active");
	});
});

describe("fix loop — group scheduler", () => {
	it("never spawns a read-only reviewer while the full-mode worker is active", async () => {
		const engine = setupPlan();
		engine.addGroup({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });
		// Reviewer with no deps — spawnable immediately by the DAG alone
		engine.addAgent("work", {
			name: "sec",
			mode: "read-only",
			slot: "alternate",
			effort: "high",
			focus: "security review",
			after: [],
		});
		const { deps, spawnAgent } = makeFixDeps(
			new Map([["sess-sec", "VERDICT: approve"]]),
		);
		const executor = new GroupExecutor(engine, deps);

		await executor.tick();
		const state = executor.getStates().get("work")!;
		expect(state.agents.get("worker")!.status).toBe("working");
		expect(state.agents.get("sec")!.status).toBe("pending");
		expect(spawnAgent).toHaveBeenCalledTimes(1);

		// More ticks while the worker runs still don't spawn the reviewer
		await executor.tick();
		expect(state.agents.get("sec")!.status).toBe("pending");

		// Worker done → reviewer becomes spawnable
		await executor.markAgentDone("work", "worker");
		await executor.tick();
		expect(state.agents.get("sec")!.status).toBe("working");
	});

	it("runs read-only reviewers concurrently but holds the worker back", async () => {
		const engine = setupPlan();
		engine.addGroup({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });
		engine.addAgent("work", {
			name: "sec",
			mode: "read-only",
			slot: "alternate",
			effort: "high",
			focus: "scout security",
			after: [],
		});
		engine.addAgent("work", {
			name: "perf",
			mode: "read-only",
			slot: "default",
			effort: "low",
			focus: "scout performance",
			after: [],
		});
		engine.updateGroup("work", { workerAfter: ["sec", "perf"] });
		const { deps } = makeFixDeps(new Map());
		const executor = new GroupExecutor(engine, deps);

		await executor.tick();
		const state = executor.getStates().get("work")!;
		expect(state.agents.get("sec")!.status).toBe("working");
		expect(state.agents.get("perf")!.status).toBe("working");
		expect(state.agents.get("worker")!.status).toBe("pending");

		await executor.markAgentDone("work", "sec");
		await executor.tick();
		// One reviewer still active → full-mode worker still held back
		expect(state.agents.get("worker")!.status).toBe("pending");

		await executor.markAgentDone("work", "perf");
		await executor.tick();
		expect(state.agents.get("worker")!.status).toBe("working");
	});
});
