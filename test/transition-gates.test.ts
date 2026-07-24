import type {
	AgentsCapabilityV1,
	AskCapabilityV1,
} from "@vegardx/pi-contracts";
import { describe, expect, it, vi } from "vitest";
import { PlanEngineV2 } from "../packages/modes/src/plan/engine.js";
import type { PlanStoreV2 } from "../packages/modes/src/plan/storage.js";
import {
	createDefaultTransitionGates,
	TransitionGateCoordinator,
	TransitionGateRegistry,
} from "../packages/modes/src/transition-gates.js";

function fixture() {
	let saved: unknown;
	const store: PlanStoreV2 = {
		root: "/plans",
		exists: () => true,
		load: () => null,
		save: (plan) => {
			saved = structuredClone(plan);
		},
		remove: () => {},
		list: () => [],
	};
	let tick = 0;
	const now = () => `2026-01-01T00:00:0${tick++}.000Z`;
	const engine = PlanEngineV2.create(
		store,
		{
			slug: "gate",
			title: "Gate",
			repoPath: "/repo",
		},
		now,
	);
	engine.setPhase("structuring");
	engine.addNode(null, { agent: "worker", persona: "coder", title: "Runtime" });
	engine.addTask("runtime", { title: "Implement runtime" });
	return { engine, saved: () => saved, now };
}

function fakeCtx() {
	return { ui: { notify: vi.fn() } } as never;
}

function agents(summary = "Plan is sound; add a required reviewer.") {
	return {
		run: vi.fn(async () => ({
			runId: "run-1",
			assignment: {
				agentId: "assignment-1",
				kind: "plan-review",
				presetId: "plan-review",
				modelSetId: "advisor",
				optionId: "deep",
				modelId: "openai/o3",
				effort: "high",
				runtime: {
					mode: "read-only",
					transport: "headless",
					tools: {},
					session: "ephemeral",
					isolation: "lightweight",
				},
				resolvedAt: "2026-01-01T00:00:00.000Z",
				source: "preset",
			},
			handle: {
				id: "run-1",
				status: () => "running",
				result: async () => ({ status: "succeeded", summary }),
			},
		})),
	} as unknown as AgentsCapabilityV1;
}

describe("transition gate coordinator", () => {
	it("rejects duplicate exact edge registrations", () => {
		const registry = new TransitionGateRegistry();
		const definition = {
			id: "a",
			edges: ["plan->auto" as const],
			validate: () => [],
			prompt: () => "review",
			suggestions: () => [],
		};
		registry.register(definition);
		expect(() => registry.register({ ...definition, id: "b" })).toThrow(
			/already registered/,
		);
	});

	it("stays in plan while reviewing, records the ruling, then settles", async () => {
		const { engine, now } = fixture();
		let mode: "plan" | "auto" = "plan";
		const commit = vi.fn((next: "auto") => {
			mode = next;
		});
		const cap = agents();
		const ask = {
			ask: vi.fn(async (questions) => {
				expect(mode).toBe("plan");
				expect(questions).toHaveLength(1);
				return [{ questionId: questions[0]!.id, value: "enter-without" }];
			}),
		} as unknown as AskCapabilityV1;
		const coordinator = new TransitionGateCoordinator(
			createDefaultTransitionGates(),
			{
				engine: () => engine,
				currentMode: () => mode,
				commit: commit as never,
				agents: () => cap,
				ask: () => ask,
				now,
			},
		);

		await expect(coordinator.request("auto", fakeCtx())).resolves.toBe(true);
		expect(cap.run).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "plan-review",
				displayName: "plan-reviewer",
			}),
		);
		expect(engine.get().transitionGates?.at(-1)?.status).toBe("settled");
		expect(commit).toHaveBeenCalledOnce();
	});

	it("fails fast on a taskless worker deliverable — no reviewer, no ruling", async () => {
		const { engine, now } = fixture();
		// A second worker deliverable with NO tasks: the gate can never settle.
		engine.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "Taskless",
		});
		const commit = vi.fn();
		const cap = agents();
		const ask = { ask: vi.fn(async () => []) } as unknown as AskCapabilityV1;
		const coordinator = new TransitionGateCoordinator(
			createDefaultTransitionGates(),
			{
				engine: () => engine,
				currentMode: () => "plan" as const,
				commit: commit as never,
				agents: () => cap,
				ask: () => ask,
				now,
			},
		);

		await expect(coordinator.request("auto", fakeCtx())).resolves.toBe(false);
		// Blocked BEFORE spending a reviewer or a human ruling.
		expect(cap.run).not.toHaveBeenCalled();
		expect(ask.ask).not.toHaveBeenCalled();
		expect(commit).not.toHaveBeenCalled();
		const gate = engine.get().transitionGates?.at(-1);
		expect(gate?.status).toBe("blocked");
		expect(gate?.reason).toContain("has no gating work items");
	});

	it("binds settlement to the reviewed plan fingerprint", async () => {
		const { engine, now } = fixture();
		const ask = {
			ask: vi.fn(async (questions) => {
				engine.updateTask("runtime", "implement-runtime", {
					body: "changed during ruling",
				});
				return [{ questionId: questions.at(-1)!.id, value: "enter-without" }];
			}),
		} as unknown as AskCapabilityV1;
		const commit = vi.fn();
		const coordinator = new TransitionGateCoordinator(
			createDefaultTransitionGates(),
			{
				engine: () => engine,
				currentMode: () => "plan",
				commit,
				agents,
				ask: () => ask,
				now,
			},
		);

		await expect(coordinator.request("hack", fakeCtx())).resolves.toBe(false);
		expect(engine.get().transitionGates?.at(-1)).toMatchObject({
			status: "blocked",
			reason: "plan changed before the ruling could be applied",
		});
		expect(commit).not.toHaveBeenCalled();
	});
});

describe("policy-row wiring (Phase 4)", () => {
	it("resolves the row tier and passes the model override to the reviewer", async () => {
		const { engine, now } = fixture();
		let mode: "plan" | "auto" = "plan";
		const commit = vi.fn((next: "auto") => {
			mode = next;
		});
		const cap = agents();
		const ask = {
			ask: vi.fn(async (questions) => [
				{ questionId: questions[0]!.id, value: "enter-without" },
			]),
		} as unknown as AskCapabilityV1;
		const coordinator = new TransitionGateCoordinator(
			createDefaultTransitionGates(),
			{
				engine: () => engine,
				currentMode: () => mode,
				commit: commit as never,
				agents: () => cap,
				ask: () => ask,
				now,
				policyRow: (on) =>
					on === "mode:plan->auto"
						? {
								on,
								run: {
									agent: "reviewer",
									persona: "plan-review",
									models: "heavy",
									contract: "plan-gate-report",
								},
							}
						: undefined,
				resolveTierModel: async (tier) => {
					expect(tier).toBe("heavy");
					return { model: "sit-anthropic/claude-opus-4-8", effort: "high" };
				},
			},
		);

		await expect(coordinator.request("auto", fakeCtx())).resolves.toBe(true);
		expect(cap.run).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "plan-review",
				model: "sit-anthropic/claude-opus-4-8",
				effort: "high",
				meta: expect.objectContaining({
					policy: expect.objectContaining({
						models: "heavy",
						persona: "plan-review",
						contract: "plan-gate-report",
					}),
				}),
			}),
		);
		expect(commit).toHaveBeenCalledOnce();
	});

	it("enabled:false skips the LLM review but keeps checks and the ruling", async () => {
		const { engine, now } = fixture();
		let mode: "plan" | "auto" = "plan";
		const commit = vi.fn((next: "auto") => {
			mode = next;
		});
		const cap = agents();
		let rulingContext = "";
		const ask = {
			ask: vi.fn(async (questions) => {
				rulingContext = questions[0]!.context ?? "";
				return [{ questionId: questions[0]!.id, value: "enter-without" }];
			}),
		} as unknown as AskCapabilityV1;
		const coordinator = new TransitionGateCoordinator(
			createDefaultTransitionGates(),
			{
				engine: () => engine,
				currentMode: () => mode,
				commit: commit as never,
				agents: () => cap,
				ask: () => ask,
				now,
				policyRow: (on) => ({
					on,
					run: { models: "heavy", enabled: false },
				}),
			},
		);

		await expect(coordinator.request("auto", fakeCtx())).resolves.toBe(true);
		expect(cap.run).not.toHaveBeenCalled();
		expect(rulingContext).toContain("disabled by policy row");
		expect(engine.get().transitionGates?.at(-1)?.status).toBe("settled");
		expect(commit).toHaveBeenCalledOnce();
	});

	it("falls back to the runner's own selection when the tier override is rejected", async () => {
		const { engine, now } = fixture();
		let mode: "plan" | "auto" = "plan";
		const commit = vi.fn((next: "auto") => {
			mode = next;
		});
		const cap = agents();
		const originalRun = cap.run as unknown as (
			request: unknown,
		) => Promise<unknown>;
		let calls = 0;
		(cap as { run: unknown }).run = vi.fn(
			async (request: { model?: string }) => {
				calls += 1;
				if (calls === 1 && request.model)
					throw new Error("No exact plan-review option matches the override");
				return originalRun(request);
			},
		);
		const ask = {
			ask: vi.fn(async (questions) => [
				{ questionId: questions[0]!.id, value: "enter-without" },
			]),
		} as unknown as AskCapabilityV1;
		const coordinator = new TransitionGateCoordinator(
			createDefaultTransitionGates(),
			{
				engine: () => engine,
				currentMode: () => mode,
				commit: commit as never,
				agents: () => cap,
				ask: () => ask,
				now,
				policyRow: (on) => ({ on, run: { models: "heavy" } }),
				resolveTierModel: async () => ({ model: "sit-openai/gpt-5.6-sol" }),
			},
		);
		await expect(coordinator.request("auto", fakeCtx())).resolves.toBe(true);
		expect(calls).toBe(2);
		// Second call carried no override — the runner's own selection ran.
		expect(
			(cap.run as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]?.model,
		).toBeUndefined();
		expect(commit).toHaveBeenCalledOnce();
	});
});
