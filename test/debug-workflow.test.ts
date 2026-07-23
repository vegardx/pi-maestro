import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	askAndExecuteDebugRecovery,
	collectDebugSnapshot,
	DebugController,
	DebugEpisodeStore,
	diagnoseDebugSnapshot,
	executeDebugRecovery,
	renderRecoveryQuestion,
	validateWorkerDebugProposal,
} from "../packages/modes/src/debug.js";
import { PlanEngineV2 } from "../packages/modes/src/plan/engine.js";
import {
	type PlanV2,
	planFingerprintV2,
} from "../packages/modes/src/plan/schema.js";
import type { PlanStoreV2 } from "../packages/modes/src/plan/storage.js";

function memStore(): PlanStoreV2 {
	let saved: PlanV2 | null = null;
	return {
		root: "/tmp",
		save: (p) => {
			saved = structuredClone(p);
		},
		load: () => saved,
		exists: () => !!saved,
		remove: () => {
			saved = null;
		},
		list: () => [],
	};
}

function fixture() {
	const engine = PlanEngineV2.create(
		memStore(),
		{ slug: "debug", title: "Debug", repoPath: "/repo" },
		() => "2026-01-01T00:00:00Z",
	);
	engine.addNode(null, { agent: "worker", persona: "coder", title: "Worker" });
	engine.addTask("worker", { title: "Implement fix" });
	engine.setNodeStatus("worker", "active");
	engine.setNodeRuntime("worker", {
		sessionPath: "/home/test/current.jsonl",
		sessionName: "tmux-worker",
		sessionGeneration: 3,
		restartState: "running",
	});
	const runState = {
		nodeId: "worker",
		status: "working",
		generation: 3,
	};
	const execution = {
		questionQueue: { all: () => [] },
		getExecutor: () => ({
			getRunState: (id: string) => (id === "worker" ? runState : undefined),
			unblockNode: vi.fn(),
		}),
		snapshot: () => ({
			agents: new Map([
				[
					"worker",
					{
						status: "working",
						startedAt: 1,
						tokens: { input: 1, output: 1, turns: 2 },
					},
				],
			]),
			deliverables: new Map(),
		}),
		steer: vi.fn(() => true),
	};
	return { engine, execution, runState };
}

describe("debug diagnosis and recovery", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	it("collects bounded provenance facts and redacts failures", () => {
		const { engine, execution } = fixture();
		const entries = [
			{
				type: "custom_message",
				customType: "maestro.crash.snapshot",
				details: {
					at: "now",
					error: "token=secret-value-which-is-long-enough-to-redact",
				},
			},
		] as never;
		const snapshot = collectDebugSnapshot({
			cwd: "/repo",
			mode: "auto",
			executionStage: "executing",
			activeDeliverableId: "worker",
			sessionPath: "/session.jsonl",
			entries,
			engine,
			execution: execution as never,
			planRoot: "/plans",
			now: () => "now",
		});
		expect(snapshot.sessionPath?.source).toBe("session-manager");
		expect(snapshot.worker?.generation).toBe(3);
		expect(snapshot.worker?.sessionName).toBe("tmux-worker");
		expect(snapshot.recentFailures[0]?.error).toContain("[redacted]");
		expect(JSON.stringify(snapshot)).not.toContain("secret-value");
	});

	it("normalizes home paths so episodes never leak the user directory", () => {
		const { engine, execution } = fixture();
		const home = homedir();
		const snapshot = collectDebugSnapshot({
			cwd: join(home, "src", "repo"),
			mode: "agent",
			executionStage: "executing",
			sessionPath: join(home, "sessions", "current.jsonl"),
			entries: [],
			engine,
			execution: execution as never,
			planRoot: join(home, "plans"),
			agentId: "worker",
			now: () => "now",
		});
		expect(snapshot.cwd.value).toBe("~/src/repo");
		expect(snapshot.sessionPath?.value).toBe("~/sessions/current.jsonl");
		expect(snapshot.plan?.path).toBe("~/plans/debug/plan.json");
		// The agent id, not a guess from the plan, identifies the worker.
		expect(snapshot.role).toEqual({ value: "worker", source: "environment" });
		expect(JSON.stringify(snapshot)).not.toContain(home);
	});

	it("preselects a single recovery but executes nothing merely from recommendation", () => {
		const { engine, execution } = fixture();
		const snapshot = collectDebugSnapshot({
			cwd: "/repo",
			mode: "auto",
			executionStage: "executing",
			activeDeliverableId: "worker",
			entries: [],
			engine,
			execution: execution as never,
			now: () => "now",
		});
		const diagnosis = diagnoseDebugSnapshot(snapshot, "worker is confused");
		const controller = new DebugController();
		const episode = controller.begin(snapshot, diagnosis)!;
		const question = renderRecoveryQuestion(episode);
		expect(question.multiple).not.toBe(true);
		// The consent gate is mandatory — recovery can replace a worker.
		expect(question.blocking).toBe(true);
		expect(question.recommendation).toBe(diagnosis.recommendation);
		expect(execution.steer).not.toHaveBeenCalled();
	});

	it("dispatches the submitted action once and survives controller rehydration", async () => {
		const { engine, execution } = fixture();
		const dir = mkdtempSync(join(tmpdir(), "debug-episode-"));
		dirs.push(dir);
		const store = new DebugEpisodeStore(join(dir, "active.json"));
		const snapshot = collectDebugSnapshot({
			cwd: "/repo",
			mode: "auto",
			executionStage: "executing",
			activeDeliverableId: "worker",
			entries: [],
			engine,
			execution: execution as never,
			now: () => "now",
		});
		const diagnosis = diagnoseDebugSnapshot(snapshot, "guide it");
		const controller = new DebugController(store);
		const episode = controller.begin(snapshot, diagnosis)!;
		const selected = diagnosis.recoveries.find((r) => r.kind === "steer")!;
		const ask = {
			ask: vi.fn(async () => [
				{ questionId: `debug-recovery-${episode.id}`, value: selected.id },
			]),
		};
		const result = await askAndExecuteDebugRecovery(controller, ask as never, {
			engine,
			execution: execution as never,
			now: () => "later",
		});
		expect(result?.ok).toBe(true);
		expect(execution.steer).toHaveBeenCalledOnce();
		const rehydrated = new DebugController(store);
		rehydrated.setStore(store);
		const again = await askAndExecuteDebugRecovery(rehydrated, ask as never, {
			engine,
			execution: execution as never,
		});
		expect(again).toBeUndefined();
		expect(execution.steer).toHaveBeenCalledOnce();
		expect(
			JSON.parse(readFileSync(join(dir, "active.json"), "utf8")).result.ok,
		).toBe(true);
	});

	it("fails closed on stale generation and fingerprint", async () => {
		const { engine, execution } = fixture();
		const staleGeneration = await executeDebugRecovery(
			{
				id: "x",
				kind: "steer",
				targetDeliverableId: "worker",
				expectedGeneration: 2,
				basePlanFingerprint: planFingerprintV2(engine.get()),
				guidance: "x",
				confidence: 1,
				rationale: "x",
			},
			{ engine, execution: execution as never },
		);
		expect(staleGeneration.ok).toBe(false);
		const stalePlan = await executeDebugRecovery(
			{
				id: "y",
				kind: "steer",
				targetDeliverableId: "worker",
				expectedGeneration: 3,
				basePlanFingerprint: "stale",
				guidance: "x",
				confidence: 1,
				rationale: "x",
			},
			{ engine, execution: execution as never },
		);
		expect(stalePlan.ok).toBe(false);
		expect(execution.steer).not.toHaveBeenCalled();
	});

	it("validates worker identity, generation, target, and fingerprint", () => {
		const { engine, execution } = fixture();
		const message = {
			type: "debugProposal",
			id: "rpc",
			proposalId: "p",
			agentId: "worker",
			generation: 3,
			planFingerprint: planFingerprintV2(engine.get()),
			observed: [],
			likelyCause: "x",
			recovery: { kind: "restart-resume", confidence: 0.8, rationale: "x" },
		} as const;
		expect(
			validateWorkerDebugProposal({
				message,
				authenticatedAgentId: "worker",
				engine,
				execution: execution as never,
			}).ok,
		).toBe(true);
		expect(
			validateWorkerDebugProposal({
				message,
				authenticatedAgentId: "other",
				engine,
				execution: execution as never,
			}).ok,
		).toBe(false);
	});

	it("accepts proposals pinned before session bookkeeping and timestamp churn", () => {
		const { engine, execution } = fixture();
		const pinned = planFingerprintV2(engine.get());
		// The spawn path persists session facts AFTER the env fingerprint is
		// minted — bookkeeping churn must not reject the worker's proposals.
		engine.setNodeRuntime("worker", {
			sessionName: "tmux-respawned",
			sessionPath: "/home/test/respawned.jsonl",
			restartState: "running",
		});
		const result = validateWorkerDebugProposal({
			message: {
				type: "debugProposal",
				id: "rpc",
				proposalId: "p2",
				agentId: "worker",
				generation: 3,
				planFingerprint: pinned,
				observed: [],
				likelyCause: "x",
			},
			authenticatedAgentId: "worker",
			engine,
			execution: execution as never,
		});
		expect(result.ok).toBe(true);
		// Semantic drift still rejects: the plan the proposal reasoned about is gone.
		engine.addTask("worker", { title: "New scope" });
		expect(
			validateWorkerDebugProposal({
				message: {
					type: "debugProposal",
					id: "rpc2",
					proposalId: "p3",
					agentId: "worker",
					generation: 3,
					planFingerprint: pinned,
					observed: [],
					likelyCause: "x",
				},
				authenticatedAgentId: "worker",
				engine,
				execution: execution as never,
			}).ok,
		).toBe(false);
	});

	it("worker-local diagnosis proposes real recoveries from the authenticated identity", () => {
		const snapshot = collectDebugSnapshot({
			cwd: "/workspace",
			mode: "agent",
			executionStage: "executing",
			entries: [],
			sessionPath: "/sessions/auth-worker.jsonl",
			agentId: "auth",
			workerGeneration: 2,
			now: () => "now",
		});
		expect(snapshot.execution.activeDeliverableId).toBe("auth");
		expect(snapshot.worker?.agentId).toBe("auth");
		expect(snapshot.worker?.generation).toBe(2);
		const diagnosis = diagnoseDebugSnapshot(snapshot, "worker is stuck");
		const kinds = diagnosis.recoveries.map((r) => r.kind);
		expect(kinds).toContain("restart-resume");
		expect(kinds).toContain("restart-fresh");
		const recommended = diagnosis.recoveries.find(
			(r) => r.id === diagnosis.recommendation,
		);
		expect(recommended?.kind).not.toBe("none");
		expect(recommended?.targetDeliverableId).toBe("auth");
		expect(recommended?.expectedGeneration).toBe(2);
	});

	it("persists redacted review state across rehydration without repeating recovery", () => {
		const { engine, execution } = fixture();
		const dir = mkdtempSync(join(tmpdir(), "debug-review-rehydrate-"));
		dirs.push(dir);
		const store = new DebugEpisodeStore(join(dir, "active.json"));
		const snapshot = collectDebugSnapshot({
			cwd: "/repo",
			mode: "auto",
			executionStage: "executing",
			activeDeliverableId: "worker",
			entries: [],
			engine,
			execution: execution as never,
			now: () => "now",
		});
		const controller = new DebugController(store);
		const episode = controller.begin(
			snapshot,
			diagnoseDebugSnapshot(snapshot),
		)!;
		controller.selectOnce(episode.diagnosis.recommendation, "attempted");
		controller.record({
			action: "steer",
			attemptedAt: "attempted",
			ok: true,
			detail: "sent",
		});
		controller.startIssueReview({
			version: 1,
			model: {
				title: "Debug",
				summary: "Summary",
				stepsToReproduce: ["Run"],
				expectedBehavior: "Expected",
				actualBehavior: "Actual",
				recoveryWorkaround: "Recovery",
				suggestedFix: "Fix",
			},
			mechanical: {
				observedFacts: ["Fact"],
				runtimeContext: [{ label: "Mode", value: "auto", source: "runtime" }],
				recoveryOutcome: {
					attemptedAction: "steer",
					attemptedAt: "attempted",
					status: "succeeded",
					detail: "sent",
				},
			},
		});
		const rehydrated = new DebugController(store);
		rehydrated.setStore(store);
		expect(rehydrated.getIssueReview()?.draft.model.title).toBe("Debug");
		expect(rehydrated.get()?.result?.detail).toBe("sent");
		expect(execution.steer).not.toHaveBeenCalled();
	});

	it("cancellation clears persisted transient state without action", async () => {
		const { engine, execution } = fixture();
		const dir = mkdtempSync(join(tmpdir(), "debug-cancel-"));
		dirs.push(dir);
		const store = new DebugEpisodeStore(join(dir, "active.json"));
		const snapshot = collectDebugSnapshot({
			cwd: "/repo",
			mode: "auto",
			executionStage: "executing",
			activeDeliverableId: "worker",
			entries: [],
			engine,
			execution: execution as never,
		});
		const controller = new DebugController(store);
		controller.begin(snapshot, diagnoseDebugSnapshot(snapshot));
		const result = await askAndExecuteDebugRecovery(
			controller,
			{ ask: async () => [] } as never,
			{ engine, execution: execution as never },
		);
		expect(result).toBeUndefined();
		expect(store.exists()).toBe(false);
		expect(execution.steer).not.toHaveBeenCalled();
	});
});
