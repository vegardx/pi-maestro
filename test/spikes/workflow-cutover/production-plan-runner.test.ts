import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Plan } from "../../../packages/maestro/src/plan.js";
import type { WorkflowPhaseCheckpointResult } from "../../../packages/maestro/src/workflow/phase-checkpoint.js";
import type { SanitizedFinding } from "../../../packages/maestro/src/workflow/private-artifacts.js";
import {
	createFailClosedWorkflowSeatTaskRunner,
	createProductionWorkflowPlanRunner,
	createWorkflowSeatShipper,
	type ProductionWorkflowPlanRunnerComponents,
	productionWorkflowPlanRunnerLayout,
	UnsupportedWorkflowSeatTasksError,
} from "../../../packages/maestro/src/workflow/production-plan-runner.js";
import type { PreparedWorkflowRepository } from "../../../packages/maestro/src/workflow/repository-preparation.js";
import type { ReviewDecisionLedger } from "../../../packages/maestro/src/workflow/review-decision-ledger.js";

describe("production workflow plan runner composition", () => {
	it("constructs the complete depth-zero dependency graph and preserves the phase call sequence", async () => {
		const paths = fixture();
		const events: string[] = [];
		const privateModel = "private/reviewer-model";
		const rawArtifact = join(paths.root, "review-control.json");
		writeFileSync(rawArtifact, "{}\n");
		let finding: SanitizedFinding | undefined;
		let ledger: ReviewDecisionLedger | undefined;
		let shippingInput: unknown;
		const components: ProductionWorkflowPlanRunnerComponents = {
			createApprovalGate: () => {
				events.push("construct:approval");
				return {
					approveAndLaunch: async ({ launch }) => {
						events.push("approve");
						return {
							status: "launched" as const,
							approval: "new" as const,
							record: {
								version: 1 as const,
								runId: "run-1",
								planSlug: "change-api",
								executionDigest: "a".repeat(64),
								approvalTextDigest: "b".repeat(64),
								approvedAt: "2026-08-08T00:00:00.000Z",
								source: "human" as const,
							},
							launchResult: await launch({} as never),
						};
					},
				};
			},
			createCoordinator: () => {
				events.push("construct:coordinator");
				return {} as never;
			},
			createPhaseLauncher: () => {
				events.push("construct:launcher");
				return {
					runImplementation: async ({ action }) => {
						events.push(`implementation:${action}`);
					},
					runReview: async ({ action, workflow }) => {
						events.push(`review:${action}`);
						const stage = workflow.artifactGraph.stages[0]!;
						return {
							runtimeTasks: [
								{
									stageId: stage.id,
									taskId: "review-task",
									resolvedModel: privateModel,
								},
							],
							submissions: [
								{
									taskId: "review-task",
									findings: [
										{
											claim: "Input is not encoded",
											evidence: [
												{
													repository: "api",
													path: "src/api.ts",
													observation: "Direct interpolation",
												},
											],
										},
									],
								},
							],
							rawArtifactPaths: [rawArtifact],
						};
					},
					runDecision: async ({ action, workflow }) => {
						events.push(`decision:${action}`);
						const id =
							JSON.stringify(workflow).match(/finding-[a-f0-9]{32}/)?.[0];
						if (!id) throw new Error("missing finding ID");
						return {
							decisions: [
								{
									findingId: id,
									decision: "no_change" as const,
									reasoning: "Existing boundary already encodes it",
								},
							],
						};
					},
				};
			},
			createCheckpointer: () => {
				events.push("construct:checkpointer");
				return {
					checkpoint: (input) => {
						events.push(`checkpoint:${input.phase}`);
						return checkpoint(paths.repository, paths.worktree, input.phase);
					},
				};
			},
			createPrivateArtifacts: () => {
				events.push("construct:private");
				return {
					putReviewForRun: (_runId, normalized) => {
						events.push(
							`private:put:${normalized.rawFindings[0]?.resolvedModel}`,
						);
						finding = normalized.sanitizedFindings[0];
						return {
							reference: { id: "c".repeat(32), digest: "d".repeat(64) },
							projection: { findings: normalized.sanitizedFindings },
						};
					},
					joinAfterDecisions: (_reference, decisions) => {
						events.push("private:join");
						return {
							findings: [
								{
									finding: finding!,
									decision: decisions[0]!,
									provenance: {
										findingId: finding!.id,
										contributors: [],
									},
								},
							],
							rawFindings: [],
						};
					},
				};
			},
			createDecisionLedgers: () => {
				events.push("construct:ledger");
				return {
					seal: (input) => {
						events.push("ledger:seal");
						ledger = {
							schema: "maestro-review-decision-ledger-v1",
							runId: input.runId,
							findingIds: input.findings.map(({ id }) => id),
							decisions: input.decisions.map((decision) => ({
								findingId: decision.findingId,
								decision: decision.decision,
								reasoning: decision.reasoning,
								changedPaths: decision.changedPaths ?? [],
								commitRefs: decision.commitRefs ?? [],
							})),
							repositories: input.repositories.map((repository) => ({
								repository: repository.repository,
								expectedBranch: repository.expectedBranch,
								implementationHead: repository.implementationHead,
								finalHead: repository.finalHead,
							})),
						};
						return {
							reference: { runId: input.runId, digest: "e".repeat(64) },
							ledger,
						};
					},
					load: () => {
						events.push("ledger:load");
						return ledger!;
					},
				};
			},
			createShipper: () => {
				events.push("construct:shipper");
				return {
					ship: async (input) => {
						events.push("shipper:ship");
						shippingInput = input;
						return { runId: input.runId, repositories: [] };
					},
				};
			},
			previewRepositories: async () => {
				events.push("repositories:preview");
				return [prepared(paths)];
			},
			prepareRepositories: async () => {
				events.push("repositories:start");
				return [prepared(paths)];
			},
			continueRepositories: async () => {
				events.push("repositories:continue");
				return [prepared(paths)];
			},
		};
		const prInputs: unknown[] = [];
		const composition = createProductionWorkflowPlanRunner({
			coordinatedRunRoot: paths.run,
			maestroStateRoot: paths.state,
			coordinatedRepositoryRoots: [paths.repository],
			runtimeResolver: {} as never,
			pullRequestCopyProducer: {
				produce: (input) => {
					events.push("pr:copy");
					prInputs.push(input);
					return {
						title: "Change API",
						intent: "Encode the input",
						rationale: "Keep route boundaries intact",
						changes: ["Encode the path segment"],
					};
				},
			},
			components,
			depth: () => 0,
		});

		const result = await composition.runner.run({
			runId: "run-1",
			coordinatedRunRoot: paths.run,
			plan: plan(paths.repository),
			implementationModel: "private/implementer-model",
			decisionModel: "private/decision-model",
			asker: {} as never,
		});

		expect(result.status).toBe("launched");
		expect(events).toEqual([
			"construct:approval",
			"construct:coordinator",
			"construct:launcher",
			"construct:checkpointer",
			"construct:private",
			"construct:ledger",
			"construct:shipper",
			"repositories:preview",
			"approve",
			"repositories:start",
			"implementation:start",
			"checkpoint:implementation",
			"review:start",
			`private:put:${privateModel}`,
			"decision:start",
			"checkpoint:decision",
			"ledger:seal",
			"ledger:load",
			"private:join",
			"pr:copy",
			"shipper:ship",
		]);
		expect(prInputs).toEqual([
			{ plan: plan(paths.repository), repository: prepared(paths) },
		]);
		// The approved Plan naturally contains its authored reviewer model. Runtime
		// provenance (task IDs, raw claims, contributor records) never crosses the
		// deliberately narrow Plan + repository PR boundary.
		expect(JSON.stringify(prInputs)).not.toContain("review-task");
		expect(JSON.stringify(prInputs)).not.toContain("Input is not encoded");
		expect(JSON.stringify(shippingInput)).not.toContain(privateModel);
		expect(JSON.stringify(shippingInput)).not.toContain("review-task");
		expect(shippingInput).toEqual({
			runId: "run-1",
			repositories: [
				{
					key: "api",
					worktree: paths.worktree,
					expectedBranch: "maestro/change-api/run-1/api",
					expectedFinalHead: "d".repeat(40),
					baseBranch: "main",
					pullRequest: {
						title: "Change API",
						intent: "Encode the input",
						rationale: "Keep route boundaries intact",
						changes: ["Encode the path segment"],
					},
				},
			],
		});
	});

	it("defines one exact disjoint layout and fails closed for fictional seat work", async () => {
		const paths = fixture();
		const layout = productionWorkflowPlanRunnerLayout({
			coordinatedRunRoot: paths.run,
			maestroStateRoot: paths.state,
		});
		expect(layout.descendantWritableRoots).toEqual([
			join(layout.coordinatedRunRoot, "repos"),
			join(layout.coordinatedRunRoot, "runtime"),
			join(layout.coordinatedRunRoot, "scratch"),
		]);
		expect(() =>
			productionWorkflowPlanRunnerLayout({
				coordinatedRunRoot: paths.run,
				maestroStateRoot: join(paths.run, "seat-state"),
			}),
		).toThrow(/must be disjoint/);

		const tasks = [{ id: "test", title: "Run tests" }];
		const error = new UnsupportedWorkflowSeatTasksError("preflight", tasks);
		expect(error).toMatchObject({
			code: "WORKFLOW_SEAT_TASKS_UNSUPPORTED",
			phase: "preflight",
			taskIds: ["test"],
		});
		expect(error.message).toContain("refusing to pretend");
		await expect(
			createFailClosedWorkflowSeatTaskRunner().run({
				runId: "run-1",
				phase: "preflight",
				tasks,
				repositories: [prepared(paths)],
			}),
		).rejects.toMatchObject({
			code: "WORKFLOW_SEAT_TASKS_UNSUPPORTED",
			taskIds: ["test"],
		});
	});

	it("rejects a checkpoint that is not the exact decision boundary before producing PR copy", async () => {
		const paths = fixture();
		let copyCalls = 0;
		let shippingCalls = 0;
		const shipper = createWorkflowSeatShipper({
			shipper: {
				ship: async () => {
					shippingCalls += 1;
					return { runId: "run-1", repositories: [] };
				},
			},
			pullRequestCopyProducer: {
				produce: () => {
					copyCalls += 1;
					return {} as never;
				},
			},
		});
		await expect(
			shipper.ship({
				runId: "run-1",
				plan: plan(paths.repository),
				repositories: [prepared(paths)],
				finalCheckpoint: {
					...checkpoint(paths.repository, paths.worktree, "decision"),
					repositories: [],
				},
			}),
		).rejects.toThrow(/repository set is incomplete/);
		expect(copyCalls).toBe(0);
		expect(shippingCalls).toBe(0);
	});
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "maestro-production-runner-"));
	const run = join(root, "run");
	const state = join(root, "state");
	const repository = join(root, "source-api");
	const worktree = join(run, "repos", "api");
	for (const directory of [run, state, repository, worktree])
		mkdirSync(directory, { recursive: true });
	return { root, run, state, repository, worktree };
}

function plan(repository: string): Plan {
	return {
		slug: "change-api",
		title: "Change API",
		repos: [{ key: "api", path: repository }],
		preflight: [],
		deliverables: [
			{
				id: "api-change",
				title: "Change API",
				repo: "api",
				after: [],
				reads: [],
				tasks: [
					{ id: "implement", title: "Implement the API change" },
					{
						id: "security",
						title: "Review input boundaries",
						by: { lens: "security", model: "private/reviewer-model" },
					},
				],
			},
		],
		postflight: [],
	};
}

function prepared(
	paths: ReturnType<typeof fixture>,
): PreparedWorkflowRepository {
	return {
		key: "api",
		sourceRoot: paths.repository,
		worktree: paths.worktree,
		branch: "maestro/change-api/run-1/api",
		baseBranch: "main",
		baseSha: "a".repeat(40),
	};
}

function checkpoint(
	sourceRoot: string,
	worktree: string,
	phase: "implementation" | "decision",
): WorkflowPhaseCheckpointResult {
	void sourceRoot;
	const head = phase === "implementation" ? "c".repeat(40) : "d".repeat(40);
	return {
		runId: "run-1",
		phase,
		repositories: [
			{
				repository: "api",
				worktree,
				expectedBranch: "maestro/change-api/run-1/api",
				preHead: "b".repeat(40),
				finalHead: head,
				changedPaths: [],
				commit: phase === "implementation" ? head : null,
			},
		],
		commitRefs:
			phase === "implementation" ? [{ repository: "api", commit: head }] : [],
	};
}
