import { describe, expect, it, vi } from "vitest";
import type { AgentsCapabilityV1, AskCapabilityV1 } from "@vegardx/pi-contracts";
import { PlanEngine } from "../packages/modes/src/engine.js";
import {
	createDefaultTransitionGates,
	TransitionGateCoordinator,
	TransitionGateRegistry,
} from "../packages/modes/src/transition-gates.js";
import type { PlanStore } from "../packages/modes/src/storage.js";

function fixture() {
	let saved: unknown;
	const store: PlanStore = {
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
	const engine = PlanEngine.create(store, {
		slug: "gate",
		title: "Gate",
		repoPath: "/repo",
	}, now);
	engine.setPhase("structuring");
	engine.addDeliverable({ title: "Runtime", workerMode: "full" });
	engine.addWorkItem("runtime", { title: "Implement runtime" });
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
				runtime: { mode: "read-only", transport: "headless", tools: {}, session: "ephemeral", isolation: "lightweight" },
				resolvedAt: "2026-01-01T00:00:00.000Z",
				source: "preset",
			},
			handle: { id: "run-1", status: () => "running", result: async () => ({ status: "succeeded", summary }) },
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
		expect(() => registry.register({ ...definition, id: "b" })).toThrow(/already registered/);
	});

	it("stays in plan while reviewing, applies selected mutations, then settles", async () => {
		const { engine, now } = fixture();
		let mode: "plan" | "auto" = "plan";
		const commit = vi.fn((next: "auto") => { mode = next; });
		const cap = agents();
		const ask = {
			ask: vi.fn(async (questions) => {
				expect(mode).toBe("plan");
				expect(questions[0]?.multiple).toBe(true);
				return [
					{ questionId: questions[0]!.id, value: "add-required-reviewer:runtime" },
					{ questionId: questions.at(-1)!.id, value: "apply-and-enter" },
				];
			}),
		} as unknown as AskCapabilityV1;
		const coordinator = new TransitionGateCoordinator(createDefaultTransitionGates(), {
			engine: () => engine,
			currentMode: () => mode,
			commit: commit as never,
			agents: () => cap,
			ask: () => ask,
			now,
		});

		await expect(coordinator.request("auto", fakeCtx())).resolves.toBe(true);
		expect(cap.run).toHaveBeenCalledWith(expect.objectContaining({ kind: "plan-review", displayName: "plan-reviewer" }));
		expect(engine.get().deliverables[0]?.subAgents?.[0]).toMatchObject({ persona: "correctness-review", required: true });
		expect(engine.get().transitionGates?.at(-1)?.status).toBe("settled");
		expect(commit).toHaveBeenCalledOnce();
	});

	it("binds settlement to the reviewed plan fingerprint", async () => {
		const { engine, now } = fixture();
		const ask = {
			ask: vi.fn(async (questions) => {
				engine.updateWorkItem("runtime", "implement-runtime", { body: "changed during ruling" });
				return [{ questionId: questions.at(-1)!.id, value: "enter-without" }];
			}),
		} as unknown as AskCapabilityV1;
		const commit = vi.fn();
		const coordinator = new TransitionGateCoordinator(createDefaultTransitionGates(), {
			engine: () => engine,
			currentMode: () => "plan",
			commit,
			agents,
			ask: () => ask,
			now,
		});

		await expect(coordinator.request("hack", fakeCtx())).resolves.toBe(false);
		expect(engine.get().transitionGates?.at(-1)).toMatchObject({ status: "blocked", reason: "plan changed before the ruling could be applied" });
		expect(commit).not.toHaveBeenCalled();
	});
});
