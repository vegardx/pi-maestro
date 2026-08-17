import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Plan } from "../../../packages/maestro/src/plan.js";
import type {
	ReviewDecisionLedger,
	SealReviewDecisionLedgerInput,
} from "../../../packages/maestro/src/workflow/review-decision-ledger.js";
import {
	WorkflowPlanRunner,
	type WorkflowPlanRunnerDependencies,
} from "../../../packages/maestro/src/workflow/workflow-plan-runner.js";

describe("WorkflowPlanRunner", () => {
	test("runs the approved multi-repository phases with seat-only checkpoints and shipping", async () => {
		const fixture = makeFixture();
		const result = await fixture.runner.run(fixture.input);

		expect(result.status).toBe("launched");
		if (result.status !== "launched") return;
		expect(fixture.events).toEqual([
			"preview",
			"approve",
			"prepare:start",
			"seat:preflight",
			"implementation:start:write",
			"checkpoint:implementation",
			"review:start:read",
			"private:put",
			"decision:start:write:1",
			"checkpoint:decision",
			"ledger:seal",
			"seat:postflight",
			"ledger:load",
			"private:join",
			"ship",
		]);
		expect(result.launchResult.joinedReview.findings).toHaveLength(1);
		expect(fixture.decisionDeniedRoots).toEqual([
			realpathSync(fixture.rawArtifact),
		]);
		expect(fixture.decisionPrompt).not.toMatch(
			/security|test\/reviewer|task-review/,
		);
		expect(readFileSync(fixture.journalPath, "utf8")).not.toMatch(
			/test\/reviewer|task-review|rawArtifactPaths|resolvedModel/,
		);
		expect(fixture.shippedCheckpoint?.phase).toBe("decision");
	});

	test("continues an interrupted workflow without replaying completed phases", async () => {
		const fixture = makeFixture({ failReviewOnce: true });
		await expect(fixture.runner.run(fixture.input)).rejects.toThrow(
			"review interrupted",
		);
		const result = await fixture.runner.run(fixture.input);
		expect(result.status).toBe("launched");
		expect(
			fixture.events.filter((event) => event.startsWith("implementation:")),
		).toEqual(["implementation:start:write"]);
		expect(
			fixture.events.filter((event) => event.startsWith("review:")),
		).toEqual(["review:start:read", "review:continue:read"]);
		expect(
			fixture.events.filter((event) => event.startsWith("prepare:")),
		).toEqual(["prepare:start"]);
		expect(fixture.events.filter((event) => event === "ship")).toHaveLength(1);
	});

	test("continues partial repository preparation only after approval", async () => {
		const fixture = makeFixture({ failPreparationOnce: true });
		await expect(fixture.runner.run(fixture.input)).rejects.toThrow(
			"preparation interrupted",
		);
		await expect(fixture.runner.run(fixture.input)).resolves.toMatchObject({
			status: "launched",
		});
		expect(
			fixture.events.filter((event) => event.startsWith("prepare:")),
		).toEqual(["prepare:start", "prepare:continue"]);
	});

	test("finalizes a durable private handoff after a crash without rediscovering review output", async () => {
		const fixture = makeFixture({ failAfterPrivateOnce: true });
		await expect(fixture.runner.run(fixture.input)).rejects.toThrow(
			"handoff interrupted",
		);
		await expect(fixture.runner.run(fixture.input)).resolves.toMatchObject({
			status: "launched",
		});
		expect(
			fixture.events.filter((event) => event.startsWith("review:")),
		).toEqual(["review:start:read"]);
		expect(
			fixture.events.filter((event) => event === "private:put"),
		).toHaveLength(1);
	});

	test("refuses non-human approval before any workflow or seat task starts", async () => {
		const fixture = makeFixture({ refuse: true });
		const result = await fixture.runner.run({
			...fixture.input,
			onApproved: () => {
				fixture.events.push("posture:auto");
			},
		});
		expect(result).toEqual({ status: "refused", reason: "not-human" });
		expect(fixture.events).toEqual(["preview", "approve"]);
	});

	test("changes posture after durable approval and before repository mutation", async () => {
		const fixture = makeFixture();
		const result = await fixture.runner.run({
			...fixture.input,
			onApproved: () => {
				fixture.events.push("posture:auto");
			},
		});
		expect(result.status).toBe("launched");
		expect(fixture.events.slice(0, 4)).toEqual([
			"preview",
			"approve",
			"posture:auto",
			"prepare:start",
		]);
	});

	test("fails closed when preparation differs from the approved base preview", async () => {
		const fixture = makeFixture({ preparationDiffers: true });
		await expect(fixture.runner.run(fixture.input)).rejects.toThrow(
			/human-approved preview/,
		);
		expect(fixture.events).toEqual(["preview", "approve", "prepare:start"]);
	});

	test("uses an explicit empty handoff when the plan has no reviewers", async () => {
		const fixture = makeFixture({ noReviewers: true });
		const result = await fixture.runner.run(fixture.input);
		expect(result.status).toBe("launched");
		expect(fixture.events.some((event) => event.startsWith("review:"))).toBe(
			false,
		);
		expect(fixture.events.some((event) => event.startsWith("decision:"))).toBe(
			false,
		);
		expect(fixture.events).toContain("private:put");
		expect(fixture.shippedCheckpoint?.phase).toBe("decision");
	});
});

function makeFixture(
	options: {
		failReviewOnce?: boolean;
		refuse?: boolean;
		noReviewers?: boolean;
		failAfterPrivateOnce?: boolean;
		preparationDiffers?: boolean;
		failPreparationOnce?: boolean;
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "workflow-plan-runner-"));
	const state = join(root, "seat-state");
	const runRoot = join(root, "run");
	const sourceContracts = join(root, "source-contracts");
	const sourceApi = join(root, "source-api");
	const contracts = join(runRoot, "repos", "contracts");
	const api = join(runRoot, "repos", "api");
	const workflowState = join(runRoot, "runtime", ".pi", "workflows");
	for (const directory of [
		state,
		runRoot,
		sourceContracts,
		sourceApi,
		contracts,
		api,
		workflowState,
	])
		mkdirSync(directory, { recursive: true });
	const rawArtifact = join(workflowState, "review", "raw.md");
	mkdirSync(join(workflowState, "review"), { recursive: true });
	writeFileSync(rawArtifact, "private reviewer output\n");
	const repositories = [
		{
			key: "contracts",
			sourceRoot: sourceContracts,
			worktree: contracts,
			branch: "workflow/contracts",
			baseBranch: "main",
			baseSha: "a".repeat(40),
		},
		{
			key: "api",
			sourceRoot: sourceApi,
			worktree: api,
			branch: "workflow/api",
			baseBranch: "main",
			baseSha: "b".repeat(40),
		},
	] as const;
	const plan: Plan = {
		slug: "two-repos",
		title: "Change a shared contract",
		repos: [
			{ key: "contracts", path: sourceContracts },
			{ key: "api", path: sourceApi },
		],
		preflight: [{ id: "preflight", title: "Check both repositories" }],
		deliverables: [
			{
				id: "contract",
				title: "Change contract",
				repo: "contracts",
				after: [],
				reads: [],
				tasks: [{ id: "implement", title: "Write the contract" }],
			},
			{
				id: "consumer",
				title: "Update consumer",
				repo: "api",
				after: ["contract"],
				reads: ["contract"],
				tasks: [
					{ id: "implement", title: "Update the consumer" },
					...(options.noReviewers
						? []
						: [
								{
									id: "security",
									title: "Review trust boundaries",
									by: { lens: "security", model: "test/reviewer" },
								},
							]),
				],
			},
		],
		postflight: [{ id: "postflight", title: "Check final state" }],
	};
	const events: string[] = [];
	let failReview = options.failReviewOnce ?? false;
	let failAfterPrivate = options.failAfterPrivateOnce ?? false;
	let failPreparation = options.failPreparationOnce ?? false;
	let storedNormalized: Parameters<
		WorkflowPlanRunnerDependencies["privateArtifacts"]["putReviewForRun"]
	>[1];
	let ledger: ReviewDecisionLedger | undefined;
	let shippedCheckpoint:
		| import("../../../packages/maestro/src/workflow/phase-checkpoint.js").WorkflowPhaseCheckpointResult
		| undefined;
	let decisionDeniedRoots: readonly string[] = [];
	let decisionPrompt = "";
	const dependencies: WorkflowPlanRunnerDependencies = {
		approvalGate: {
			approveAndLaunch: async ({ launch }) => {
				events.push("approve");
				if (options.refuse)
					return { status: "refused" as const, reason: "not-human" as const };
				return {
					status: "launched" as const,
					approval: "new" as const,
					record: {
						version: 1 as const,
						runId: "run-1",
						planSlug: plan.slug,
						executionDigest: "e".repeat(64),
						approvalTextDigest: "f".repeat(64),
						approvedAt: "2026-08-08T00:00:00.000Z",
						source: "human" as const,
					},
					launchResult: await launch({} as never),
				};
			},
		},
		previewRepositories: async () => {
			events.push("preview");
			return repositories;
		},
		prepareRepositories: async (_input, mode) => {
			events.push(`prepare:${mode}`);
			if (failPreparation) {
				failPreparation = false;
				throw new Error("preparation interrupted");
			}
			return options.preparationDiffers
				? repositories.map((repository, index) =>
						index === 0
							? { ...repository, baseSha: "9".repeat(40) }
							: repository,
					)
				: repositories;
		},
		phaseLauncher: {
			runImplementation: async ({ action, worktreeAccess }) => {
				events.push(`implementation:${action}:${worktreeAccess}`);
			},
			runReview: async ({ action, worktreeAccess }) => {
				events.push(`review:${action}:${worktreeAccess}`);
				if (failReview) {
					failReview = false;
					throw new Error("review interrupted");
				}
				return {
					runtimeTasks: [
						{
							stageId: "consumer--review--security",
							taskId: "task-review",
							resolvedModel: "test/reviewer",
						},
					],
					submissions: [
						{
							taskId: "task-review",
							findings: [
								{
									claim: "The route accepts an unencoded path segment",
									evidence: [
										{
											repository: "api",
											path: "src/client.ts",
											line: 4,
											observation: "The segment is interpolated directly",
										},
									],
								},
							],
						},
					],
					rawArtifactPaths: [rawArtifact],
				};
			},
			runDecision: async ({
				action,
				worktreeAccess,
				deniedReadRoots,
				workflow,
			}) => {
				decisionDeniedRoots = deniedReadRoots;
				decisionPrompt = JSON.stringify(workflow);
				const findingId = decisionPrompt.match(/finding-[a-f0-9]{32}/)?.[0];
				if (!findingId) throw new Error("decision prompt omitted finding ID");
				events.push(`decision:${action}:${worktreeAccess}:1`);
				return {
					decisions: [
						{
							findingId,
							decision: "changed",
							reasoning: "Encoding preserves path segment boundaries",
							changedPaths: [{ repository: "api", path: "src/client.ts" }],
						},
					],
				};
			},
		},
		seatTasks: {
			run: async ({ phase }) => {
				events.push(`seat:${phase}`);
			},
		},
		checkpointer: {
			checkpoint: (checkpointInput) => {
				events.push(`checkpoint:${checkpointInput.phase}`);
				const final = checkpointInput.phase === "implementation" ? "c" : "d";
				return {
					runId: checkpointInput.runId,
					phase: checkpointInput.phase,
					repositories: repositories.map((repository) => ({
						repository: repository.key,
						worktree: repository.worktree,
						expectedBranch: repository.branch,
						preHead: "b".repeat(40),
						finalHead: final.repeat(40),
						changedPaths:
							checkpointInput.phase === "decision" && repository.key === "api"
								? ["src/client.ts"]
								: [],
						commit:
							checkpointInput.phase === "decision" && repository.key === "api"
								? "d".repeat(40)
								: checkpointInput.phase === "implementation"
									? "c".repeat(40)
									: null,
					})),
					commitRefs:
						checkpointInput.phase === "decision"
							? [{ repository: "api", commit: "d".repeat(40) }]
							: repositories.map(({ key }) => ({
									repository: key,
									commit: "c".repeat(40),
								})),
				};
			},
		},
		privateArtifacts: {
			putReviewForRun: (_runId, normalized) => {
				events.push("private:put");
				storedNormalized = normalized;
				return {
					reference: { id: "1".repeat(32), digest: "2".repeat(64) },
					projection: { findings: normalized.sanitizedFindings },
				};
			},
			joinAfterDecisions: (_reference, decisions) => {
				events.push("private:join");
				return {
					findings: storedNormalized.sanitizedFindings.map((finding) => ({
						finding,
						decision: decisions[0]!,
						provenance: storedNormalized.provenance[0]!,
					})),
					rawFindings: storedNormalized.rawFindings,
				};
			},
		},
		decisionLedgers: {
			seal: (input: SealReviewDecisionLedgerInput) => {
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
					reference: { runId: input.runId, digest: "3".repeat(64) },
					ledger,
				};
			},
			load: () => {
				events.push("ledger:load");
				if (!ledger) throw new Error("ledger not sealed");
				return ledger;
			},
		},
		shipper: {
			ship: async ({ finalCheckpoint }) => {
				events.push("ship");
				shippedCheckpoint = finalCheckpoint;
			},
		},
		onReviewHandoffPersisted: () => {
			if (failAfterPrivate) {
				failAfterPrivate = false;
				throw new Error("handoff interrupted");
			}
		},
	};
	const runner = new WorkflowPlanRunner({
		maestroStateRoot: state,
		descendantWritableRoots: [runRoot],
		dependencies,
		depth: () => 0,
	});
	return {
		runner,
		input: {
			runId: "run-1",
			coordinatedRunRoot: runRoot,
			plan,
			implementationModel: "test/implementer",
			decisionModel: "test/implementer",
			asker: { ask: async () => [] },
		},
		events,
		rawArtifact,
		get decisionDeniedRoots() {
			return decisionDeniedRoots;
		},
		get decisionPrompt() {
			return decisionPrompt;
		},
		get shippedCheckpoint() {
			return shippedCheckpoint;
		},
		journalPath: join(state, "workflow-plan-runs", "run-1.json"),
	};
}
