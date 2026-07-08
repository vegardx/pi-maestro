// UI layer for observability: /steer parsing + routing, /view target
// resolution smoke, the /agents overview rendering, and the /recap output.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type {
	AgentState,
	DeliverableExecutor,
	DeliverableRunState,
} from "../packages/modes/src/deliverable-executor.js";
import { buildRecap } from "../packages/modes/src/deliverable-recap.js";
import { PlanEngine } from "../packages/modes/src/engine.js";
import type {
	ExecutionAgentSnapshot,
	ExecutionDeliverableSnapshot,
	ExecutionHandle,
} from "../packages/modes/src/exec/index.js";
import {
	handleSteerCommand,
	handleViewCommand,
	parseSteerArgs,
	type ViewState,
} from "../packages/modes/src/runtime/agent-commands.js";
import { renderAgentsOverview } from "../packages/modes/src/runtime/dashboard.js";
import type { Plan } from "../packages/modes/src/schema.js";
import type { PlanStore } from "../packages/modes/src/storage.js";

function memStore(): PlanStore {
	let saved: Plan | null = null;
	return {
		root: "/tmp/plans",
		save(plan: Plan) {
			saved = plan;
		},
		load(): Plan | null {
			return saved;
		},
		exists(): boolean {
			return saved !== null;
		},
		remove() {
			saved = null;
		},
		list() {
			return [];
		},
	};
}

function makeHandle(overrides: Partial<ExecutionHandle> = {}): ExecutionHandle {
	return {
		questionQueue: { all: () => [], answer: () => {} },
		start: async () => {},
		tick: async () => 0,
		steer: () => true,
		snapshot: () => ({
			agents: new Map<string, ExecutionAgentSnapshot>(),
			deliverables: new Map<string, ExecutionDeliverableSnapshot>(),
		}),
		resolveSessionName: () => undefined,
		getExecutor: () => {
			throw new Error("not wired in this test");
		},
		markAgentDone: async () => {},
		isWorkerDone: () => false,
		getWorkerSessions: () => [],
		destroy: async () => {},
		...overrides,
	};
}

function makeCtx() {
	const notify = vi.fn();
	const select = vi.fn(async () => undefined);
	const ctx = { ui: { notify, select } } as unknown as ExtensionCommandContext;
	return { ctx, notify, select };
}

describe("parseSteerArgs", () => {
	it("parses deliverable + guidance, defaulting to the worker", () => {
		expect(parseSteerArgs("api-deliverable tighten the tests")).toEqual({
			deliverableId: "api-deliverable",
			guidance: "tighten the tests",
		});
	});

	it("parses an optional agent: prefix", () => {
		expect(
			parseSteerArgs("api-deliverable reviewer-x: check the tests"),
		).toEqual({
			deliverableId: "api-deliverable",
			agentName: "reviewer-x",
			guidance: "check the tests",
		});
	});

	it("does not treat a colon mid-guidance as an agent prefix", () => {
		expect(parseSteerArgs("g1 look at foo.ts: the bug is there")).toEqual({
			deliverableId: "g1",
			guidance: "look at foo.ts: the bug is there",
		});
		expect(parseSteerArgs("g1 fix a:b and c")).toEqual({
			deliverableId: "g1",
			guidance: "fix a:b and c",
		});
	});

	it("rejects missing guidance", () => {
		expect(parseSteerArgs("api-deliverable")).toBeUndefined();
		expect(parseSteerArgs("")).toBeUndefined();
		expect(parseSteerArgs("api-deliverable   ")).toBeUndefined();
	});
});

describe("handleSteerCommand", () => {
	it("routes parsed targets through ExecutionHandle.steer", () => {
		const steer = vi.fn(() => true);
		const { ctx, notify } = makeCtx();
		handleSteerCommand(
			"api-deliverable reviewer-x: check the tests",
			ctx,
			makeHandle({ steer }),
		);
		expect(steer).toHaveBeenCalledWith(
			"api-deliverable",
			"check the tests",
			"reviewer-x",
		);
		expect(notify).toHaveBeenCalledWith(
			"Steered api-deliverable/reviewer-x.",
			"info",
		);
	});

	it("warns when the target agent is not connected", () => {
		const { ctx, notify } = makeCtx();
		handleSteerCommand("g1 do it", ctx, makeHandle({ steer: () => false }));
		expect(notify).toHaveBeenCalledWith(
			"g1/worker is not connected.",
			"warning",
		);
	});

	it("shows usage on unparseable input", () => {
		const steer = vi.fn(() => true);
		const { ctx, notify } = makeCtx();
		handleSteerCommand("just-a-deliverable", ctx, makeHandle({ steer }));
		expect(steer).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			"Usage: /steer <deliverable> [agent:] <guidance>",
			"warning",
		);
	});
});

describe("handleViewCommand", () => {
	it("warns when no session matches the target", async () => {
		const { ctx, notify } = makeCtx();
		const viewState: ViewState = { viewPaneId: undefined };
		await handleViewCommand("ghost", ctx, makeHandle(), viewState);
		expect(notify).toHaveBeenCalledWith(
			'No agent session matches "ghost".',
			"warning",
		);
		expect(viewState.viewPaneId).toBeUndefined();
	});

	it("notifies when there are no agents to pick from", async () => {
		const { ctx, notify } = makeCtx();
		await handleViewCommand("", ctx, makeHandle(), { viewPaneId: undefined });
		expect(notify).toHaveBeenCalledWith("No agents to view.", "info");
	});

	it("closes an open view pane when called with no target", async () => {
		const { ctx, notify } = makeCtx();
		const viewState: ViewState = { viewPaneId: "%99" };
		await handleViewCommand("", ctx, makeHandle(), viewState);
		expect(viewState.viewPaneId).toBeUndefined();
		expect(notify).toHaveBeenCalledWith("View pane closed.", "info");
	});
});

describe("renderAgentsOverview", () => {
	function planWithDeliverable(): PlanEngine {
		const engine = PlanEngine.create(memStore(), {
			slug: "t",
			title: "T",
			repoPath: "/tmp/repo",
		});
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		engine.addAgent("auth", {
			name: "sec",
			mode: "read-only",
			slot: "default",
			effort: "low",
			focus: "security",
			after: ["worker"],
		});
		return engine;
	}

	it("renders live status, tokens, and blocked reason", () => {
		const engine = planWithDeliverable();
		const handle = makeHandle({
			snapshot: () => ({
				agents: new Map<string, ExecutionAgentSnapshot>([
					[
						"auth/worker",
						{
							status: "working",
							startedAt: Date.now(),
							tokens: { input: 5000, output: 120, turns: 9 },
						},
					],
				]),
				deliverables: new Map<string, ExecutionDeliverableSnapshot>([
					["auth", { blocked: "ship gate: security-audit requested changes" }],
				]),
			}),
		});
		const out = renderAgentsOverview(engine.get(), handle);
		expect(out).toContain("worker (full) — working · 5000in/120out · 9 turns");
		expect(out).toContain(
			"Blocked: ship gate: security-audit requested changes",
		);
		// Spec-only agent (not spawned yet) renders without a live suffix.
		expect(out).toContain("sec (read-only, default, after: worker)");
	});

	it("renders without execution state (planning view)", () => {
		const engine = planWithDeliverable();
		const out = renderAgentsOverview(engine.get());
		expect(out).toContain("Auth (planned)");
		expect(out).not.toContain("worker (full) —");
	});
});

describe("buildRecap", () => {
	it("includes blocked reason, PR url, and agent summaries", () => {
		const engine = PlanEngine.create(memStore(), {
			slug: "t",
			title: "T",
			repoPath: "/tmp/repo",
		});
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		engine.addWorkItem("auth", { title: "do it", kind: "task" });
		engine.updateDeliverable("auth", {
			prUrl: "https://github.com/org/repo/pull/7",
			summary: "shipped the auth flow",
		});

		const agents = new Map<string, AgentState>([
			[
				"worker",
				{
					name: "worker",
					deliverableId: "auth",
					status: "done",
					displayName: "ada",
					summary: "implemented login",
				},
			],
		]);
		const state: DeliverableRunState = {
			deliverableId: "auth",
			agents,
			completed: new Set(["worker"]),
			blocked: "ship gate: security-audit requested changes",
		};
		const executor = {
			getStates: () => new Map([["auth", state]]),
		} as unknown as DeliverableExecutor;

		const recap = buildRecap(engine, executor, { includeSummaries: true });
		expect(recap).toContain("## Auth [planned]");
		expect(recap).toContain("PR: https://github.com/org/repo/pull/7");
		expect(recap).toContain(
			"Blocked: ship gate: security-audit requested changes",
		);
		expect(recap).toContain("ada: done");
		expect(recap).toContain("shipped the auth flow");
	});
});
