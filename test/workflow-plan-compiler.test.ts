import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArtifactGraphWorkflowSpec } from "@agwab/pi-workflow";
import { afterEach, describe, expect, it } from "vitest";
import { compileWorkflow as compilePackageWorkflow } from "../node_modules/@agwab/pi-workflow/dist/compiler.js";
import type { Plan } from "../packages/maestro/src/plan.js";
import {
	bindReviewerRegistry,
	compileDecisionWorkflow,
	compilePlanWorkflow,
	decisionGateInput,
	WORKFLOW_CONTROL_SCHEMA_ASSETS,
} from "../packages/maestro/src/workflow/plan-compiler.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true })),
	);
});

const authored: Plan = {
	slug: "contract-api",
	title: "Ship contract v2 and its API",
	preflight: [{ id: "confirm-repos", title: "Confirm repositories exist" }],
	postflight: [{ id: "prepare-pr", title: "Prepare the pull request" }],
	repos: [
		{ key: "contracts", path: "/source/contracts" },
		{ key: "api", path: "/source/api" },
	],
	deliverables: [
		{
			id: "contracts",
			title: "Contract v2",
			repo: "contracts",
			after: [],
			reads: [],
			tasks: [{ id: "implement", title: "Add contract v2" }],
		},
		{
			id: "api",
			title: "API client",
			repo: "api",
			after: ["contracts"],
			reads: ["contracts"],
			tasks: [
				{ id: "implement", title: "Consume contract v2" },
				{
					id: "security-opus",
					title: "Review the API boundary",
					by: {
						lens: "security",
						skill: "security-review",
						model: "anthropic/opus-5",
					},
				},
				{
					id: "security-grok",
					title: "Review independently",
					by: { lens: "security", model: "xai/grok-4.5" },
				},
			],
		},
	],
};

const options = {
	implementationModel: "openai/codex-5",
	decisionModel: "openai/codex-5",
	coordinatedCwd: "/approved/run",
	repositories: [
		{
			key: "contracts",
			sourceRoot: "/source/contracts",
			worktree: "/approved/contracts",
			branch: "maestro/contracts",
			baseBranch: "main",
			baseSha: "a".repeat(40),
		},
		{
			key: "api",
			sourceRoot: "/source/api",
			worktree: "/approved/api",
			branch: "maestro/api",
			baseBranch: "main",
			baseSha: "b".repeat(40),
		},
	],
	routingLabels: { implementation: "primary", decision: "primary" },
} as const;

describe("workflow plan compiler", () => {
	it("emits separate valid and package-compilable implementation/review phases", async () => {
		const compiled = compilePlanWorkflow(authored, options);
		expect(compiled).toEqual(compilePlanWorkflow(authored, options));
		expect(compiled.reviewPhase.status).toBe("required");
		if (compiled.reviewPhase.status !== "required")
			throw new Error("review missing");
		for (const spec of [
			compiled.implementationWorkflow,
			compiled.reviewPhase.workflow,
		]) {
			expect(() => parseArtifactGraphWorkflowSpec(spec)).not.toThrow();
			await expect(packageCompile(spec)).resolves.toMatchObject({
				schemaVersion: 1,
			});
		}

		const implementation = compiled.implementationWorkflow.artifactGraph.stages;
		expect(implementation.map(({ id }) => id)).toEqual([
			"contracts--implement",
			"api--implement",
		]);
		expect(implementation[1]).toMatchObject({
			after: ["contracts--implement"],
		});
		expect(implementation[0]?.cwd).toBeUndefined();
		expect(compiled.implementationWorkflow.defaults).toEqual({
			readOnly: false,
		});
		expect(compiled.seat.launchCwd).toBe("/approved/run");
		expect(implementation[0]?.prompt).toContain("/approved/contracts");
		expect(implementation[1]?.prompt).toContain("/approved/api");
		expect(compiled.reviewPhase.workflow.artifactGraph.stages).toHaveLength(2);
		expect(
			compiled.reviewPhase.workflow.artifactGraph.stages[0]?.prompt,
		).toContain("Use the available security-review skill.");
		expect(
			compiled.reviewPhase.workflow.artifactGraph.stages[0]?.prompt,
		).toContain("Use repository key api in every evidence item.");
		expect(
			compiled.reviewPhase.workflow.artifactGraph.stages.map(
				({ after }) => after,
			),
		).toEqual([[], []]);
		expect(compiled.reviewPhase.workflow.defaults).toEqual({ readOnly: true });
		expect(JSON.stringify(compiled)).not.toContain('"agent"');
		expect(JSON.stringify(compiled)).not.toContain('"tools":[]');
	});

	it("serializes otherwise-independent implementation stages sharing a repo", () => {
		const sameRepo: Plan = {
			...authored,
			deliverables: [
				{ ...authored.deliverables[0], repo: "api" },
				{ ...authored.deliverables[1], after: [], reads: [] },
			],
		};
		const stages = compilePlanWorkflow(sameRepo, options).implementationWorkflow
			.artifactGraph.stages;
		expect(stages[1]?.after).toEqual(["contracts--implement"]);
	});

	it("binds runtime task IDs and actual models without trusting model output", () => {
		const compiled = compilePlanWorkflow(authored, options);
		expect(compiled.reviewerRegistryIntents).toEqual([
			{
				stageId: "api--review--security-opus",
				lens: "security",
				approvedModel: "anthropic/opus-5",
				skill: "security-review",
			},
			{
				stageId: "api--review--security-grok",
				lens: "security",
				approvedModel: "xai/grok-4.5",
			},
		]);
		expect(() =>
			bindReviewerRegistry(compiled, [
				{
					stageId: "api--review--security-opus",
					taskId: "runtime-task-91",
					resolvedModel: "anthropic/claude-opus-5-20260801",
				},
				{
					stageId: "api--review--security-grok",
					taskId: "runtime-task-92",
					resolvedModel: "xai/grok-4.5",
				},
			]),
		).toThrow(/expected approved model/);
		expect(
			bindReviewerRegistry(compiled, [
				{
					stageId: "api--review--security-opus",
					taskId: "runtime-task-91",
					resolvedModel: "anthropic/opus-5",
				},
				{
					stageId: "api--review--security-grok",
					taskId: "runtime-task-92",
					resolvedModel: "xai/grok-4.5",
				},
			]),
		).toEqual([
			{
				lens: "security",
				stageId: "api--review--security-opus",
				taskId: "runtime-task-91",
				resolvedModel: "anthropic/opus-5",
			},
			{
				lens: "security",
				stageId: "api--review--security-grok",
				taskId: "runtime-task-92",
				resolvedModel: "xai/grok-4.5",
			},
		]);
		expect(() => bindReviewerRegistry(compiled, [])).toThrow(/exactly cover/);
	});

	it("keeps commits, provenance, preflight, and postflight at the seat", () => {
		const compiled = compilePlanWorkflow(authored, options);
		expect(compiled.seat.preflight).toEqual(authored.preflight);
		expect(compiled.seat.postflight).toEqual(authored.postflight);
		expect(compiled.approval.seatTasks).toEqual({
			preflight: [{ id: "confirm-repos", title: "Confirm repositories exist" }],
			postflight: [{ id: "prepare-pr", title: "Prepare the pull request" }],
		});
		expect(compiled.seat.afterImplementation).toEqual({
			checkpointer: "WorkflowPhaseCheckpointer",
			phase: "implementation",
		});
		expect(compiled.seat.reviewHandoff).toMatchObject({
			normalizer: "normalizeRawReviewFindings",
			privateStore: "PrivateArtifactStore",
			implementerProjection: "sanitizedFindings",
		});
		expect(compiled.seat.afterDecision).toEqual({
			checkpointer: "WorkflowPhaseCheckpointer",
			phase: "decision",
		});
		expect(compiled.approval.authority.commitsAndShipping).toBe("seat-only");
		expect(compiled.approval.repositories[0]?.baseBranch).toBe("main");
		expect(compiled.approval.repositories[0]?.baseSha).toBe("a".repeat(40));
		expect(compiled.approvalText).toContain(
			`base branch main; base commit ${"a".repeat(40)}`,
		);
		expect(compiled.approvalText).toContain("runtime identity must match");
		expect(compiled.approvalText).toContain("excluded from pull requests");
		expect(compiled.approvalText).toContain(
			"preflight confirm-repos: Confirm repositories exist",
		);
	});

	it("compiles one decision phase and shapes the production lineage gate", async () => {
		const findings = [
			{
				id: "finding-1",
				claim: "The API accepts an invalid value.",
				evidence: [
					{
						repository: "api",
						path: "src/client.ts",
						observation: "No validation is performed.",
					},
				],
			},
		] as const;
		const decision = compileDecisionWorkflow(authored, options, findings);
		expect(decision).not.toBeNull();
		if (!decision) throw new Error("decision unexpectedly skipped");
		await expect(packageCompile(decision.workflow)).resolves.toMatchObject({
			schemaVersion: 1,
		});
		expect(decision.workflow.defaults).toEqual({ readOnly: false });
		expect(decision.workflow.artifactGraph.stages[0]?.prompt).toContain(
			'"key":"api","worktree":"/approved/api"',
		);
		expect(decision.workflow.artifactGraph.stages[0]?.prompt).toContain(
			"not a required resolution",
		);
		const gate = decisionGateInput(decision, {
			runId: "run-1",
			decisions: [
				{
					findingId: "finding-1",
					decision: "no_change",
					reasoning: "Rejected upstream.",
				},
			],
			repositories: [],
		});
		expect(gate.findings).toEqual([{ id: "finding-1" }]);
		expect(compileDecisionWorkflow(authored, options, [])).toBeNull();
	});

	it("explicitly skips review when no review tasks were authored", () => {
		const noReview = {
			...authored,
			deliverables: authored.deliverables.map((deliverable) => ({
				...deliverable,
				tasks: deliverable.tasks.filter((task) => !task.by),
			})),
		};
		expect(compilePlanWorkflow(noReview, options).reviewPhase).toEqual({
			status: "skipped-no-reviewers",
		});
	});
});

async function packageCompile(spec: unknown) {
	const root = await mkdtemp(join(tmpdir(), "workflow-compile-"));
	roots.push(root);
	await mkdir(join(root, "schemas"));
	for (const asset of WORKFLOW_CONTROL_SCHEMA_ASSETS)
		await cp(asset.sourcePath, join(root, asset.ref));
	const specPath = join(root, "spec.json");
	await writeFile(specPath, `${JSON.stringify(spec)}\n`);
	return compilePackageWorkflow(spec as never, { cwd: root, specPath });
}
