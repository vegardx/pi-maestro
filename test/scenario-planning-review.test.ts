import type {
	AgentsCapabilityV1,
	AskCapabilityV1,
	ResolvedAgentAssignment,
} from "@vegardx/pi-contracts";
import { canonicalTokenSnapshot } from "@vegardx/pi-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
import { validateWorkflowGraph } from "../packages/modes/src/schema.js";
import type { PlanStore } from "../packages/modes/src/storage.js";
import {
	createDefaultTransitionGates,
	TransitionGateCoordinator,
} from "../packages/modes/src/transition-gates.js";
import {
	applyWorkflowAnalyticsEvent,
	createWorkflowAnalyticsLedger,
} from "../packages/modes/src/workflow-analytics.js";
import {
	runScenario,
	type ScenarioResult,
	scenarioAssertions,
} from "./fixtures/scenario-harness.js";

const SHA = "a".repeat(40);
const FIX_SHA = "b".repeat(40);
const results: ScenarioResult[] = [];
afterEach(() => {
	for (const result of results.splice(0)) result.cleanup();
});

function assignment(
	agentId: string,
	kind: ResolvedAgentAssignment["kind"],
	overrides: Partial<ResolvedAgentAssignment> = {},
): ResolvedAgentAssignment {
	return {
		agentId,
		kind,
		presetId: "release",
		modelSetId: kind === "worker" ? "workers" : "reviewers",
		optionId: kind === "worker" ? "implement" : "inspect",
		modelId: kind === "worker" ? "provider/worker" : "provider/reviewer",
		effort: "high",
		runtime: {
			mode: kind === "worker" ? "full" : "read-only",
			transport: kind === "worker" ? "tmux" : "headless",
			tools: {},
			session: kind === "worker" ? "persistent" : "ephemeral",
			isolation: "strong",
		},
		focus: `${kind} focus`,
		rationale: `${kind} belongs in this scenario`,
		inputContracts: kind === "worker" ? [] : ["implementation"],
		outputContracts: kind === "worker" ? ["implementation"] : ["findings"],
		provenance: {
			source: "preset",
			presetId: "release",
			modelSetId: kind === "worker" ? "workers" : "reviewers",
			optionId: kind === "worker" ? "implement" : "inspect",
			resolvedAt: "2026-01-01T00:00:00.000Z",
		},
		resolvedAt: "2026-01-01T00:00:00.000Z",
		source: "preset",
		...overrides,
	};
}

function inMemoryEngine(now: () => string): PlanEngine {
	const store: PlanStore = {
		root: "/scenario/plans",
		exists: () => false,
		load: () => null,
		save: () => {},
		remove: () => {},
		list: () => [],
	};
	const engine = PlanEngine.create(
		store,
		{ slug: "release", title: "Release", repoPath: "/scenario/repo" },
		now,
	);
	engine.setPhase("structuring");
	engine.addDeliverable({ title: "Runtime", workerMode: "full" });
	engine.addWorkItem("runtime", { title: "Implement runtime" });
	return engine;
}

function planReviewer(summary: string): AgentsCapabilityV1 {
	return {
		run: vi.fn(async () => ({
			runId: "plan-review-run" as never,
			assignment: assignment("plan-reviewer", "plan-review"),
			handle: {
				id: "plan-review-run" as never,
				status: () => "running",
				result: async () => ({ status: "succeeded", summary }),
			},
		})),
	} as unknown as AgentsCapabilityV1;
}

describe("planning and review scenarios", () => {
	it("persists exact preset assignments and explicit stages, including duplicate semantic kinds", async () => {
		const result = await runScenario({
			name: "assignment graph and duplicate kinds",
			models: {
				"provider/planner": [
					{
						match: "compose workflow",
						response: JSON.stringify({ workers: 1, reviewers: 2 }),
					},
				],
			},
			steps: [
				{
					name: "resolve immutable assignment graph",
					run: async (scenario) => {
						await scenario.models.complete(
							"provider/planner",
							"compose workflow",
						);
						const worker = assignment("runtime-worker", "worker");
						const correctnessA = assignment(
							"correctness-primary",
							"correctness-review",
						);
						const correctnessB = assignment(
							"correctness-independent",
							"correctness-review",
							{
								modelId: "provider/second-reviewer",
								optionId: "independent",
								provenance: {
									source: "explicit",
									presetId: "release",
									modelSetId: "reviewers",
									optionId: "independent",
									resolvedAt: "2026-01-01T00:00:00.000Z",
								},
								source: "explicit",
							},
						);
						const workflow = {
							assignments: [worker, correctnessA, correctnessB],
							stages: [
								{
									id: "implementation",
									after: [],
									assignmentIds: [worker.agentId],
									inputRevision: SHA,
									inputContracts: [],
									barrier: "workers" as const,
								},
								{
									id: "review",
									after: ["implementation"],
									assignmentIds: [correctnessA.agentId, correctnessB.agentId],
									inputRevision: SHA,
									inputContracts: ["implementation"],
									barrier: "all" as const,
								},
							],
						};
						expect(validateWorkflowGraph(workflow)).toEqual([]);
						scenario.state.set("workflow", workflow);
						scenario.emit("workflow.persisted", workflow);
					},
				},
			],
		});
		results.push(result);
		const workflow = (
			result.finalState as {
				state: { workflow: { assignments: ResolvedAgentAssignment[] } };
			}
		).state.workflow;
		expect(
			workflow.assignments.map(({ agentId, kind, modelId, optionId }) => ({
				agentId,
				kind,
				modelId,
				optionId,
			})),
		).toEqual([
			{
				agentId: "runtime-worker",
				kind: "worker",
				modelId: "provider/worker",
				optionId: "implement",
			},
			{
				agentId: "correctness-primary",
				kind: "correctness-review",
				modelId: "provider/reviewer",
				optionId: "inspect",
			},
			{
				agentId: "correctness-independent",
				kind: "correctness-review",
				modelId: "provider/second-reviewer",
				optionId: "independent",
			},
		]);
		scenarioAssertions.hasEvent(result, "workflow.persisted");
	});

	it.each([
		["enter-without", true, "settled", "auto"],
		["stay-in-plan", false, "cancelled", "plan"],
	] as const)(
		"records Plan gate ruling %s while mode remains Plan until settlement",
		async (decision, expected, status, finalMode) => {
			let mode: "plan" | "auto" = "plan";
			const clock = { value: 0 };
			const now = () => `2026-01-01T00:00:0${clock.value++}.000Z`;
			const engine = inMemoryEngine(now);
			const ask = {
				ask: vi.fn(async () => {
					expect(mode).toBe("plan");
					return [{ questionId: expect.any(String), value: decision }];
				}),
			} as unknown as AskCapabilityV1;
			// The real capability receives the generated id; capture it rather than using a matcher value.
			ask.ask = vi.fn(async (questions) => {
				expect(mode).toBe("plan");
				return [{ questionId: questions[0]!.id, value: decision }];
			});
			const coordinator = new TransitionGateCoordinator(
				createDefaultTransitionGates(),
				{
					engine: () => engine,
					currentMode: () => mode,
					commit: (next) => {
						mode = next as "auto";
					},
					agents: () =>
						planReviewer("Plan review inspected exact stages and SHA targets."),
					ask: () => ask,
					now,
				},
			);
			const changed = await coordinator.request("auto", {
				ui: { notify: vi.fn() },
			} as never);
			expect(changed).toBe(expected);
			expect(mode).toBe(finalMode);
			expect(engine.get().transitionGates?.at(-1)).toMatchObject({
				status,
				ruling: { decision },
			});
		},
	);

	it("keeps immutable review targets and canonicalizes duplicate findings through resolution and verification", async () => {
		const result = await runScenario({
			name: "review target and finding resolution",
			steps: [
				{
					name: "record immutable review reports",
					run: (scenario) => {
						let ledger = createWorkflowAnalyticsLedger(
							"runtime",
							scenario.clock.iso(),
						);
						ledger = applyWorkflowAnalyticsEvent(
							ledger,
							{
								type: "stage",
								stage: {
									stageId: "review",
									inputSha: SHA,
									outputSha: SHA,
									status: "succeeded",
									startedAt: scenario.clock.iso(),
									completedAt: scenario.clock.iso(),
								},
							},
							scenario.clock.iso(),
						);
						for (const [assertionId, assignmentId, findingId] of [
							["a1", "correctness-primary", "finding-main"],
							["a2", "correctness-independent", "finding-duplicate"],
						] as const) {
							ledger = applyWorkflowAnalyticsEvent(
								ledger,
								{
									type: "raw-finding",
									finding: {
										assertionId,
										assignmentId,
										stageId: "review",
										runId: assertionId,
										reviewedSha: SHA,
										reportedAt: scenario.clock.iso(),
										finding: {
											id: findingId,
											severity: "major",
											category: "correctness",
											file: "src/runtime.ts",
											line: 42,
											actual: "stale generation mutates state",
										},
									},
								},
								scenario.clock.iso(),
							);
						}
						ledger = {
							...ledger,
							canonicalFindings: [
								{
									finding: ledger.rawFindings[0]!.finding,
									reviewer: "correctness-primary",
									duplicateIds: ["finding-duplicate"],
									resolution: {
										id: "finding-main",
										status: "fixed",
										note: "fence updates by generation",
										fixCommit: FIX_SHA,
										at: scenario.clock.iso(),
									},
									verification: {
										id: "finding-main",
										result: "verified",
										note: "targeted stale-generation regression passes",
										at: scenario.clock.iso(),
									},
								},
							],
							finalVerification: {
								assignmentId: "verifier",
								modelId: "provider/verifier",
								effort: "high",
								runId: "verify-1",
								reviewedSha: FIX_SHA,
								status: "passed",
								startedAt: scenario.clock.iso(),
								completedAt: scenario.clock.iso(),
								usage: canonicalTokenSnapshot({ input: 10, output: 2 }),
							},
						};
						scenario.state.set("analytics", ledger);
						scenario.emit("review.canonicalized", {
							reviewedSha: SHA,
							fixCommit: FIX_SHA,
							duplicateIds: ["finding-duplicate"],
						});
					},
				},
			],
		});
		results.push(result);
		const ledger = (
			result.finalState as {
				state: {
					analytics: ReturnType<typeof createWorkflowAnalyticsLedger> & {
						canonicalFindings: Array<{
							duplicateIds: string[];
							resolution: { fixCommit: string };
							verification: { result: string };
						}>;
						finalVerification: { reviewedSha: string };
					};
				};
			}
		).state.analytics;
		expect(
			new Set(ledger.rawFindings.map((finding) => finding.reviewedSha)),
		).toEqual(new Set([SHA]));
		expect(ledger.canonicalFindings).toHaveLength(1);
		expect(ledger.canonicalFindings[0]).toMatchObject({
			duplicateIds: ["finding-duplicate"],
			resolution: { fixCommit: FIX_SHA },
			verification: { result: "verified" },
		});
		expect(ledger.finalVerification.reviewedSha).toBe(FIX_SHA);
	});
});
