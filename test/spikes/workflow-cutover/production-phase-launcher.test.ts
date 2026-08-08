import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { ArtifactGraphWorkflowSpec } from "@agwab/pi-workflow";
import { describe, expect, test } from "vitest";
import {
	ProductionWorkflowPlanPhaseLauncher,
	type WorkflowPhaseRuntimeResolution,
} from "../../../packages/maestro/src/workflow/production-phase-launcher.js";
import type { PreparedWorkflowRepository } from "../../../packages/maestro/src/workflow/repository-preparation.js";
import { materializeWorkflowSupervisorState } from "../../../packages/maestro/src/workflow/supervisor-state.js";

describe("ProductionWorkflowPlanPhaseLauncher", () => {
	test("materializes a real package-valid review bundle and returns runtime-bound raw submissions", async () => {
		const fixture = makeFixture("review_run", reviewWorkflow());
		const launcher = fixture.launcher({
			onLaunch: () =>
				fixture.completeTasks([
					{
						stageId: "security",
						taskId: "task-security",
						model: "anthropic/opus-5",
						control: {
							findings: [
								{
									claim: "Unsafe parsing",
									evidence: [
										{
											repository: "api",
											path: "src/api.ts",
											observation: "Input is not bounded",
										},
									],
								},
							],
						},
					},
				]),
		});

		const result = await launcher.runReview({
			runId: fixture.runId,
			action: "start",
			workflow: fixture.workflow,
			repositories: [fixture.repository],
			worktreeAccess: "read",
			deniedReadRoots: [],
		});

		expect(result.runtimeTasks).toEqual([
			{
				stageId: "security",
				taskId: "task-security",
				resolvedModel: "anthropic/opus-5",
			},
		]);
		expect(result.submissions[0]?.findings).toHaveLength(1);
		expect(
			result.rawArtifactPaths.map((path) => path.split("/").at(-1)),
		).toEqual(["control.json", "raw.md"]);
		expect(fixture.resolverInputs).toEqual([
			{
				coordinatedRunRoot: fixture.runRoot,
				runId: fixture.runId,
				approvedModels: ["anthropic/opus-5"],
				approvedProviderIds: ["anthropic"],
			},
		]);
		const launch = fixture.launches[0]!;
		expect(launch.sandboxRoots.worktreeAccess).toBe("read");
		expect(
			launch.executionManifest.materialization.writableRoots,
		).not.toContain(fixture.repository.worktree);
		expect(
			(
				launch.executionManifest.artifacts.bundle.files as Array<{
					path: string;
				}>
			).map(({ path }) => path),
		).toEqual([
			"approved-models.json",
			"authority-policy.json",
			"execution-profile.json",
			"schemas/review-decisions.schema.json",
			"schemas/review-findings.schema.json",
			"spec.json",
		]);
		expect(launch.executionManifest.artifacts.models.path).toBe(
			join(
				fixture.runRoot,
				"runtime",
				"workflow-bundles",
				fixture.runId,
				"approved-models.json",
			),
		);
	});

	test("continues a write-authorized decision while hiding only exact prior raw artifacts", async () => {
		const fixture = makeFixture("decision_run", decisionWorkflow());
		const prior = join(
			fixture.state.workflowStateRoot,
			"workflows",
			"prior_review",
			"tasks",
			"reviewer",
		);
		mkdirSync(prior, { recursive: true });
		const priorControl = join(prior, "control.json");
		const priorRaw = join(prior, "raw.md");
		writeFileSync(priorControl, "{}\n");
		writeFileSync(priorRaw, "private reviewer output\n");
		const denied = [realpathSync(priorRaw), realpathSync(priorControl)].sort();
		const launcher = fixture.launcher({
			action: "continue",
			onLaunch: () =>
				fixture.completeTasks([
					{
						stageId: "decide",
						taskId: "task-decide",
						model: "openai/gpt-5",
						control: {
							decisions: [
								{
									findingId: "finding-1",
									decision: "no_change",
									reasoning: "Existing bounds are sufficient.",
								},
							],
						},
					},
				]),
		});

		const result = await launcher.runDecision({
			runId: fixture.runId,
			action: "continue",
			workflow: fixture.workflow,
			repositories: [fixture.repository],
			worktreeAccess: "write",
			deniedReadRoots: denied,
		});

		expect(result.decisions).toEqual([
			{
				findingId: "finding-1",
				decision: "no_change",
				reasoning: "Existing bounds are sufficient.",
			},
		]);
		expect(fixture.calls).toEqual(["continue"]);
		const launch = fixture.launches[0]!;
		expect(launch.sandboxRoots.deniedReadRoots).toEqual(denied);
		expect(launch.executionManifest.materialization.deniedReadRoots).toEqual(
			denied,
		);
		expect(launch.executionManifest.materialization.writableRoots).toContain(
			fixture.repository.worktree,
		);
	});

	test("refuses a successful process projection when package state is not completed", async () => {
		const fixture = makeFixture("blocked_run", implementationWorkflow());
		const launcher = fixture.launcher({ packageStatus: "blocked" });
		await expect(
			launcher.runImplementation({
				runId: fixture.runId,
				action: "start",
				workflow: fixture.workflow,
				repositories: [fixture.repository],
				worktreeAccess: "write",
				deniedReadRoots: [],
			}),
		).rejects.toThrow(
			"workflow package run blocked_run is authoritatively blocked",
		);
	});

	test("requires the host runtime resolver to preserve exact provider filtering", async () => {
		const fixture = makeFixture("bad_runtime", implementationWorkflow());
		const launcher = fixture.launcher({ providerIds: [] });
		await expect(
			launcher.runImplementation({
				runId: fixture.runId,
				action: "start",
				workflow: fixture.workflow,
				repositories: [fixture.repository],
				worktreeAccess: "write",
				deniedReadRoots: [],
			}),
		).rejects.toThrow("did not preserve exact provider filtering");
		expect(fixture.launches).toHaveLength(0);
	});

	test.each([
		{
			name: "swapped",
			firstResultTask: "task-correctness",
			secondResultTask: "task-security",
		},
		{
			name: "shared",
			firstResultTask: "task-security",
			secondResultTask: "task-security",
		},
	])(
		"rejects $name package result paths before reviewer attribution",
		async ({ firstResultTask, secondResultTask }) => {
			const fixture = makeFixture("misbound_review", twoReviewerWorkflow());
			const launcher = fixture.launcher({
				onLaunch: () =>
					fixture.completeTasks([
						{
							stageId: "security",
							taskId: "task-security",
							model: "anthropic/opus-5",
							control: { findings: [] },
							resultTaskId: firstResultTask,
						},
						{
							stageId: "correctness",
							taskId: "task-correctness",
							model: "openai/gpt-5",
							control: { findings: [] },
							resultTaskId: secondResultTask,
						},
					]),
			});

			await expect(
				launcher.runReview({
					runId: fixture.runId,
					action: "start",
					workflow: fixture.workflow,
					repositories: [fixture.repository],
					worktreeAccess: "read",
					deniedReadRoots: [],
				}),
			).rejects.toThrow("does not belong to its package task directory");
			expect(fixture.launches).toHaveLength(1);
			expect(fixture.calls).toEqual(["start"]);
		},
	);
});

function makeFixture(runId: string, workflow: ArtifactGraphWorkflowSpec) {
	const temporary = mkdtempSync(join(tmpdir(), "production-phase-launcher-"));
	const runRoot = join(temporary, "run");
	const worktree = join(runRoot, "repos", "api");
	const sourceRoot = join(temporary, "source-api");
	mkdirSync(worktree, { recursive: true });
	mkdirSync(sourceRoot, { recursive: true });
	const state = materializeWorkflowSupervisorState(runRoot);
	const runtimeRoot = join(runRoot, "scratch", "workflow-supervisors", runId);
	const scratchRoot = join(runtimeRoot, "mutable");
	const modelsFile = join(runtimeRoot, "immutable", "pi-agent", "models.json");
	mkdirSync(dirname(modelsFile), { recursive: true });
	mkdirSync(scratchRoot, { recursive: true });
	writeFileSync(modelsFile, '{"providers":{}}\n');
	const repository: PreparedWorkflowRepository = {
		key: "api",
		sourceRoot: realpathSync(sourceRoot),
		worktree: realpathSync(worktree),
		branch: "workflow/api",
		baseBranch: "main",
		baseSha: "a".repeat(40),
	};
	const runtime = {
		runtimeRoot: realpathSync(runtimeRoot),
		homeDir: scratchRoot,
		tmpDir: scratchRoot,
		agentDir: scratchRoot,
		sessionDir: scratchRoot,
		workflowAuthFile: modelsFile,
		settingsFile: modelsFile,
		modelsFile: realpathSync(modelsFile),
		gitConfigFile: modelsFile,
		binDir: scratchRoot,
		piShimFile: modelsFile,
		gitShimFile: modelsFile,
		agentToolkitPackageRoot: runtimeRoot,
		agentToolkitDigest: "b".repeat(64),
		agentToolkitVersion: "1.0.0",
		agentToolkitSourceRevision: "c".repeat(40),
		materializationDigest: "d".repeat(64),
		environment: {},
		scratchRoots: [realpathSync(scratchRoot)],
	} satisfies WorkflowPhaseRuntimeResolution["runtime"];
	const resolverInputs: unknown[] = [];
	const launches: any[] = [];
	const calls: string[] = [];
	let packageTasks: Array<{
		stageId: string;
		taskId: string;
		status: string;
		runtime: { model: string };
		files: { result: string };
	}> = [];
	const completeTasks = (
		tasks: readonly {
			stageId: string;
			taskId: string;
			model: string;
			control: unknown;
			resultTaskId?: string;
		}[],
	) => {
		packageTasks = tasks.map((task) => {
			const directory = join(
				state.workflowStateRoot,
				"workflows",
				runId,
				"tasks",
				task.taskId,
			);
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, "result.json"), "{}\n");
			writeFileSync(
				join(directory, "control.json"),
				`${JSON.stringify(task.control)}\n`,
			);
			writeFileSync(join(directory, "raw.md"), "raw model output\n");
			return {
				stageId: task.stageId,
				taskId: task.taskId,
				status: "completed",
				runtime: { model: task.model },
				files: {
					result: relative(
						realpathSync(runRoot),
						join(
							state.workflowStateRoot,
							"workflows",
							runId,
							"tasks",
							task.resultTaskId ?? task.taskId,
							"result.json",
						),
					),
				},
			};
		});
	};
	return {
		runId,
		runRoot: realpathSync(runRoot),
		workflow,
		state,
		repository,
		resolverInputs,
		launches,
		calls,
		completeTasks,
		launcher(
			options: {
				action?: "start" | "continue";
				onLaunch?: () => void;
				packageStatus?: string;
				providerIds?: readonly string[];
			} = {},
		) {
			const coordinatorMethod = async (input: any) => {
				launches.push(input);
				calls.push(input.workflowRequest.action);
				options.onLaunch?.();
				return {
					runId,
					action: input.workflowRequest.action,
					status: "running" as const,
					pid: 123,
					stdoutPath: join(temporary, "stdout.log"),
					stderrPath: join(temporary, "stderr.log"),
					completion: Promise.resolve({
						runId,
						action: input.workflowRequest.action,
						status: "completed" as const,
						supervisorExit: { code: 0, signal: null, stderr: "" },
					}),
				};
			};
			return new ProductionWorkflowPlanPhaseLauncher({
				coordinatedRunRoot: runRoot,
				coordinator: {
					start: coordinatorMethod,
					continue: coordinatorMethod,
				},
				runtimeResolver: {
					resolve: async (input) => {
						resolverInputs.push(input);
						return {
							options: {
								coordinatedRunRoot: realpathSync(runRoot),
								runtimeNamespace: runId,
								sourceEnvironment: {},
								approvedProviderIds:
									options.providerIds ?? input.approvedProviderIds,
								sourceAuth: {},
								models: { providers: {} },
								agentToolkit: {
									sourceRoot: runtimeRoot,
									expectedDigest: runtime.agentToolkitDigest,
									expectedVersion: runtime.agentToolkitVersion,
									sourceRevision: runtime.agentToolkitSourceRevision,
								},
							},
							runtime,
						};
					},
				},
				inspectRun: async () => ({
					runId,
					status: options.packageStatus ?? "completed",
					tasks: packageTasks,
				}),
			});
		},
	};
}

function implementationWorkflow(): ArtifactGraphWorkflowSpec {
	return {
		schemaVersion: 1,
		name: "implementation",
		defaults: { readOnly: false },
		artifactGraph: {
			stages: [
				{
					id: "implement",
					type: "single",
					model: "openai/gpt-5",
					prompt: "Implement without committing.",
				},
			],
		},
	};
}

function reviewWorkflow(): ArtifactGraphWorkflowSpec {
	return {
		schemaVersion: 1,
		name: "review",
		defaults: { readOnly: true },
		artifactGraph: {
			stages: [
				{
					id: "security",
					type: "single",
					model: "anthropic/opus-5",
					prompt: "Use the available security skill.",
					output: {
						controlSchema: "./schemas/review-findings.schema.json",
					},
				},
			],
		},
	};
}

function decisionWorkflow(): ArtifactGraphWorkflowSpec {
	return {
		schemaVersion: 1,
		name: "decision",
		defaults: { readOnly: false },
		artifactGraph: {
			stages: [
				{
					id: "decide",
					type: "single",
					model: "openai/gpt-5",
					prompt: "Decide each finding.",
					output: {
						controlSchema: "./schemas/review-decisions.schema.json",
					},
				},
			],
		},
	};
}

function twoReviewerWorkflow(): ArtifactGraphWorkflowSpec {
	const workflow = reviewWorkflow();
	return {
		...workflow,
		artifactGraph: {
			...workflow.artifactGraph,
			stages: [
				...workflow.artifactGraph.stages,
				{
					id: "correctness",
					type: "single",
					after: [],
					model: "openai/gpt-5",
					prompt: "Use the available correctness skill.",
					output: {
						controlSchema: "./schemas/review-findings.schema.json",
					},
				},
			],
		},
	};
}
