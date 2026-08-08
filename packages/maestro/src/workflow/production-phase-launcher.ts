// Production adapter from the plan runner's three flat phases to the detached
// workflow coordinator. The seat supplies provider credentials and a pinned
// ambient toolkit through one narrow resolver; this module owns every durable
// artifact and authority decision after that boundary.

import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	type ArtifactGraphWorkflowSpec,
	loadWorkflowSpec,
	refreshRun,
} from "@agwab/pi-workflow";
import type {
	WorkflowCoordinator,
	WorkflowCoordinatorLaunchInput,
	WorkflowCoordinatorLifecycleProjection,
} from "./coordinator.js";
import {
	type ReviewerRuntimeTask,
	WORKFLOW_CONTROL_SCHEMA_ASSETS,
} from "./plan-compiler.js";
import type { PreparedWorkflowRepository } from "./repository-preparation.js";
import type { ReviewFindingDecisionInput } from "./review-decision-ledger.js";
import type { ReviewerFindingSubmission } from "./review-findings.js";
import {
	digestWorkflowExecutionManifest,
	type WorkflowExecutionArtifact,
	type WorkflowExecutionManifest,
} from "./supervisor-execution-manifest.js";
import type {
	MaterializeWorkflowSupervisorRuntimeOptions,
	WorkflowSupervisorRuntimeMaterialization,
} from "./supervisor-runtime.js";
import {
	materializeWorkflowSupervisorState,
	type WorkflowSupervisorStateLayout,
} from "./supervisor-state.js";
import type {
	WorkflowDecisionPhaseResult,
	WorkflowPhaseLaunchInput,
	WorkflowPlanPhaseLauncher,
	WorkflowReviewPhaseResult,
} from "./workflow-plan-runner.js";

export interface WorkflowPhaseRuntimeResolution {
	readonly options: MaterializeWorkflowSupervisorRuntimeOptions;
	/** Materialized before the manifest is sealed; the coordinator re-verifies it. */
	readonly runtime: WorkflowSupervisorRuntimeMaterialization;
}

/**
 * Host binding which may read the seat's Pi auth/models and installed toolkit.
 * It receives only approved concrete model/provider identities and must return a
 * runtime filtered to exactly those providers.
 */
export interface WorkflowPhaseRuntimeResolver {
	resolve(input: {
		readonly coordinatedRunRoot: string;
		readonly runId: string;
		readonly approvedModels: readonly string[];
		readonly approvedProviderIds: readonly string[];
	}): Promise<WorkflowPhaseRuntimeResolution>;
}

interface WorkflowPackageTaskRecord {
	readonly taskId: string;
	readonly stageId?: string;
	readonly status: string;
	readonly runtime?: { readonly model?: string };
	readonly files: { readonly result: string };
}

interface WorkflowPackageRunRecord {
	readonly runId: string;
	readonly status: string;
	readonly tasks: readonly WorkflowPackageTaskRecord[];
}

export interface ProductionWorkflowPlanPhaseLauncherOptions {
	readonly coordinatedRunRoot: string;
	readonly coordinator: Pick<
		WorkflowCoordinator<WorkflowSupervisorRuntimeMaterialization>,
		"start" | "continue"
	>;
	readonly runtimeResolver: WorkflowPhaseRuntimeResolver;
	readonly waitTimeoutMs?: number;
	/** Test seams. Production uses pi-workflow and the managed state layout. */
	readonly inspectRun?: (
		cwd: string,
		runId: string,
	) => Promise<WorkflowPackageRunRecord>;
	readonly materializeState?: (
		coordinatedRunRoot: string,
	) => WorkflowSupervisorStateLayout;
	readonly validateBundleSpec?: (
		specPath: string,
		cwd: string,
	) => Promise<void>;
}

export class ProductionWorkflowPlanPhaseLauncher
	implements WorkflowPlanPhaseLauncher
{
	readonly #runRoot: string;
	readonly #coordinator: ProductionWorkflowPlanPhaseLauncherOptions["coordinator"];
	readonly #runtimeResolver: WorkflowPhaseRuntimeResolver;
	readonly #waitTimeoutMs: number;
	readonly #inspectRun: NonNullable<
		ProductionWorkflowPlanPhaseLauncherOptions["inspectRun"]
	>;
	readonly #materializeState: NonNullable<
		ProductionWorkflowPlanPhaseLauncherOptions["materializeState"]
	>;
	readonly #validateBundleSpec: NonNullable<
		ProductionWorkflowPlanPhaseLauncherOptions["validateBundleSpec"]
	>;

	constructor(options: ProductionWorkflowPlanPhaseLauncherOptions) {
		this.#runRoot = canonicalDirectory(
			options.coordinatedRunRoot,
			"coordinated run root",
		);
		this.#coordinator = options.coordinator;
		this.#runtimeResolver = options.runtimeResolver;
		this.#waitTimeoutMs = options.waitTimeoutMs ?? 60_000;
		if (
			!Number.isSafeInteger(this.#waitTimeoutMs) ||
			this.#waitTimeoutMs < 1 ||
			this.#waitTimeoutMs > 14_400_000
		)
			throw new Error("workflow phase wait timeout is invalid");
		this.#inspectRun = options.inspectRun ?? refreshRun;
		this.#materializeState =
			options.materializeState ?? materializeWorkflowSupervisorState;
		this.#validateBundleSpec =
			options.validateBundleSpec ??
			(async (specPath, cwd) => {
				await loadWorkflowSpec(specPath, cwd);
			});
	}

	async runImplementation(
		input: WorkflowPhaseLaunchInput<ArtifactGraphWorkflowSpec>,
	): Promise<void> {
		await this.#run(input, "implementation");
	}

	async runReview(
		input: WorkflowPhaseLaunchInput<ArtifactGraphWorkflowSpec>,
	): Promise<WorkflowReviewPhaseResult> {
		const result = await this.#run(input, "review");
		const runtimeTasks: ReviewerRuntimeTask[] = [];
		const submissions: ReviewerFindingSubmission[] = [];
		const rawArtifactPaths: string[] = [];
		for (const task of result.tasks) {
			const stageId = requiredText(task.stageId, "review stage ID");
			const resolvedModel = requiredText(
				task.runtime?.model,
				`reviewer ${stageId} resolved model`,
			);
			const artifacts = taskArtifacts(
				this.#runRoot,
				result.state.workflowStateRoot,
				input.runId,
				task,
				true,
			);
			const control = await readControlObject(artifacts.control);
			runtimeTasks.push({ stageId, taskId: task.taskId, resolvedModel });
			submissions.push({ taskId: task.taskId, findings: control.findings });
			rawArtifactPaths.push(artifacts.control, artifacts.raw as string);
		}
		return {
			runtimeTasks,
			submissions,
			rawArtifactPaths: canonicalSortedUnique(rawArtifactPaths),
		};
	}

	async runDecision(
		input: WorkflowPhaseLaunchInput<ArtifactGraphWorkflowSpec>,
	): Promise<WorkflowDecisionPhaseResult> {
		const result = await this.#run(input, "decision");
		if (result.tasks.length !== 1)
			throw new Error("decision workflow must resolve exactly one task");
		const artifacts = taskArtifacts(
			this.#runRoot,
			result.state.workflowStateRoot,
			input.runId,
			result.tasks[0] as WorkflowPackageTaskRecord,
			false,
		);
		const control = await readControlObject(artifacts.control);
		if (!Array.isArray(control.decisions))
			throw new Error("decision control output must contain a decisions array");
		return {
			decisions:
				control.decisions as unknown as readonly ReviewFindingDecisionInput[],
		};
	}

	async #run(
		input: WorkflowPhaseLaunchInput<ArtifactGraphWorkflowSpec>,
		phase: "implementation" | "review" | "decision",
	): Promise<{
		readonly state: WorkflowSupervisorStateLayout;
		readonly tasks: readonly WorkflowPackageTaskRecord[];
	}> {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.runId))
			throw new Error("workflow phase run ID is unsafe");
		assertPhaseAuthority(input, phase);
		const repositories = exactRepositories(input.repositories, this.#runRoot);
		const models = approvedModels(input.workflow);
		const providers = approvedProviders(models);
		const state = this.#materializeState(this.#runRoot);
		const resolved = await this.#runtimeResolver.resolve({
			coordinatedRunRoot: this.#runRoot,
			runId: input.runId,
			approvedModels: models,
			approvedProviderIds: providers,
		});
		assertRuntimeResolution(
			this.#runRoot,
			input.runId,
			providers,
			state,
			resolved,
		);
		const execution = materializeExecution({
			runRoot: this.#runRoot,
			runId: input.runId,
			workflow: input.workflow,
			phase,
			repositories,
			worktreeAccess: input.worktreeAccess,
			deniedReadRoots: canonicalSortedUnique(input.deniedReadRoots),
			state,
			runtime: resolved.runtime,
		});
		await this.#validateBundleSpec(execution.specPath, this.#runRoot);
		const launchInput: WorkflowCoordinatorLaunchInput = {
			executionManifest: execution.manifest,
			executionManifestDigest: execution.manifestDigest,
			workflowRequest: {
				version: 1,
				action: input.action,
				runId: input.runId,
				cwd: this.#runRoot,
				specPath: execution.specPath,
				specSha256: execution.specSha256,
				task: execution.task,
				waitTimeoutMs: this.#waitTimeoutMs,
			},
			runtimeOptions: resolved.options,
			sandboxRoots: {
				coordinatedRunRoot: this.#runRoot,
				workflowStateRoot: state.workflowStateRoot,
				coordinatedWorktreeRoots: repositories.map(({ worktree }) => worktree),
				worktreeAccess: input.worktreeAccess,
				...(input.deniedReadRoots.length > 0
					? { deniedReadRoots: execution.deniedReadRoots }
					: {}),
			},
		};
		const lifecycle = await this.#coordinator[input.action](launchInput);
		const projection = await lifecycle.completion;
		if (projection.status !== "completed")
			throw supervisorFailure(input.runId, projection, lifecycle);
		const packageRun = await this.#inspectRun(this.#runRoot, input.runId);
		if (packageRun.runId !== input.runId)
			throw new Error("workflow package returned an unexpected run ID");
		if (packageRun.status !== "completed")
			throw new Error(
				`workflow package run ${input.runId} is authoritatively ${packageRun.status}`,
			);
		const tasks = exactCompletedTasks(input.workflow, packageRun.tasks);
		assertPackageTaskResultBindings(
			this.#runRoot,
			state.workflowStateRoot,
			input.runId,
			tasks,
		);
		return { state, tasks };
	}
}

function materializeExecution(input: {
	readonly runRoot: string;
	readonly runId: string;
	readonly workflow: ArtifactGraphWorkflowSpec;
	readonly phase: "implementation" | "review" | "decision";
	readonly repositories: readonly PreparedWorkflowRepository[];
	readonly worktreeAccess: "read" | "write";
	readonly deniedReadRoots: readonly string[];
	readonly state: WorkflowSupervisorStateLayout;
	readonly runtime: WorkflowSupervisorRuntimeMaterialization;
}): {
	readonly task: string;
	readonly specPath: string;
	readonly specSha256: string;
	readonly deniedReadRoots: readonly string[];
	readonly manifest: WorkflowExecutionManifest;
	readonly manifestDigest: string;
} {
	const bundleRoot = resolve(
		input.runRoot,
		"runtime",
		"workflow-bundles",
		input.runId,
	);
	mkdirPrivate(bundleRoot);
	const specPath = join(bundleRoot, "spec.json");
	writeExact(specPath, jsonFile(input.workflow));
	for (const asset of WORKFLOW_CONTROL_SCHEMA_ASSETS) {
		const destination = resolve(bundleRoot, asset.ref);
		assertStrictChild(destination, bundleRoot, "control schema");
		mkdirPrivate(dirname(destination));
		writeExact(destination, readFileSync(asset.sourcePath));
	}
	const profilePath = join(bundleRoot, "execution-profile.json");
	writeExact(
		profilePath,
		jsonFile({
			version: 1,
			phase: input.phase,
			models: approvedModels(input.workflow),
		}),
	);
	const approvedModelsPath = join(bundleRoot, "approved-models.json");
	writeExact(approvedModelsPath, readFileSync(input.runtime.modelsFile));
	const authorityPath = join(bundleRoot, "authority-policy.json");
	writeExact(
		authorityPath,
		jsonFile({
			version: 1,
			phase: input.phase,
			worktreeAccess: input.worktreeAccess,
			repositories: input.repositories.map(({ key, worktree }) => ({
				key,
				worktree,
			})),
			deniedReadRoots: input.deniedReadRoots,
			gitAuthority: "none",
			publicationAuthority: "none",
		}),
	);
	const inventory = bundleInventory(bundleRoot);
	const artifact = (path: string): WorkflowExecutionArtifact => ({
		path,
		sha256: sha256(readFileSync(path)),
	});
	const writableRoots = canonicalSortedUnique([
		input.state.workflowStateRoot,
		...input.runtime.scratchRoots,
		...(input.worktreeAccess === "write"
			? input.repositories.map(({ worktree }) => worktree)
			: []),
	]);
	const task = `Execute approved ${input.phase} workflow ${input.workflow.name ?? input.runId}`;
	const manifest: WorkflowExecutionManifest = {
		version: 1,
		runId: input.runId,
		launch: { task, executionProfile: null, inputOverrides: {} },
		artifacts: {
			spec: artifact(specPath),
			bundle: { root: realpathSync(bundleRoot), files: inventory },
			helpers: [],
			models: artifact(approvedModelsPath),
			profile: artifact(profilePath),
		},
		repositories: input.repositories.map(({ key, worktree }) => ({
			id: key,
			root: worktree,
		})),
		authorityPolicy: artifact(authorityPath),
		materialization: {
			runtimeRoot: input.runtime.runtimeRoot,
			workflowStateRoot: input.state.workflowStateRoot,
			writableRoots,
			deniedReadRoots: input.deniedReadRoots,
			materializationDigest: input.runtime.materializationDigest,
			agentToolkitDigest: input.runtime.agentToolkitDigest,
			agentToolkitName: "@vegardx/agent-toolkit",
			agentToolkitVersion: input.runtime.agentToolkitVersion,
			agentToolkitSourceRevision: input.runtime.agentToolkitSourceRevision,
		},
	};
	return {
		task,
		specPath,
		specSha256: manifest.artifacts.spec.sha256,
		deniedReadRoots: input.deniedReadRoots,
		manifest,
		manifestDigest: digestWorkflowExecutionManifest(manifest),
	};
}

function assertPhaseAuthority(
	input: WorkflowPhaseLaunchInput<ArtifactGraphWorkflowSpec>,
	phase: "implementation" | "review" | "decision",
): void {
	const expected = phase === "review" ? "read" : "write";
	if (input.worktreeAccess !== expected)
		throw new Error(
			`${phase} workflow requires ${expected} worktree authority`,
		);
	if (phase !== "decision" && input.deniedReadRoots.length > 0)
		throw new Error("only the decision workflow may receive denied read roots");
}

function approvedModels(
	workflow: ArtifactGraphWorkflowSpec,
): readonly string[] {
	return canonicalSortedUnique(
		workflow.artifactGraph.stages.map((stage) =>
			requiredText(stage.model, `workflow stage ${stage.id} model`),
		),
	);
}

function approvedProviders(models: readonly string[]): readonly string[] {
	return canonicalSortedUnique(
		models.map((model) => {
			const separator = model.indexOf("/");
			if (separator < 1 || separator === model.length - 1)
				throw new Error(
					`workflow model must be a concrete provider/model: ${model}`,
				);
			return model.slice(0, separator);
		}),
	);
}

function assertRuntimeResolution(
	runRoot: string,
	runId: string,
	providers: readonly string[],
	state: WorkflowSupervisorStateLayout,
	resolution: WorkflowPhaseRuntimeResolution,
): void {
	if (
		canonicalDirectory(
			resolution.options.coordinatedRunRoot,
			"runtime run root",
		) !== runRoot
	)
		throw new Error(
			"workflow runtime resolver changed the coordinated run root",
		);
	if (
		resolution.options.runtimeNamespace !== runId ||
		!resolution.options.runtimeNamespace
	)
		throw new Error(
			"workflow runtime resolver did not bind the phase run namespace",
		);
	if (
		JSON.stringify(
			canonicalSortedUnique(resolution.options.approvedProviderIds),
		) !== JSON.stringify(providers)
	)
		throw new Error(
			"workflow runtime resolver did not preserve exact provider filtering",
		);
	if (
		resolution.runtime.runtimeRoot !==
		resolve(runRoot, "scratch", "workflow-supervisors", runId)
	)
		throw new Error(
			"workflow runtime resolver returned an unexpected runtime root",
		);
	if (!resolution.runtime.scratchRoots.includes(state.workflowStateRoot)) {
		// The workflow state is granted separately, never smuggled into runtime
		// scratch authority. This condition documents and checks that separation.
		for (const root of resolution.runtime.scratchRoots)
			if (pathsOverlap(root, state.workflowStateRoot))
				throw new Error("workflow runtime scratch overlaps package state");
	}
}

function exactRepositories(
	repositories: readonly PreparedWorkflowRepository[],
	runRoot: string,
): readonly PreparedWorkflowRepository[] {
	if (repositories.length === 0)
		throw new Error("workflow phase requires prepared repositories");
	const ids = new Set<string>();
	const roots = new Set<string>();
	return repositories.map((repository) => {
		if (ids.has(repository.key))
			throw new Error(`duplicate workflow repository ${repository.key}`);
		const worktree = canonicalDirectory(
			repository.worktree,
			"workflow worktree",
		);
		assertStrictChild(worktree, resolve(runRoot, "repos"), "workflow worktree");
		if (roots.has(worktree)) throw new Error("duplicate workflow worktree");
		ids.add(repository.key);
		roots.add(worktree);
		return { ...repository, worktree };
	});
}

function exactCompletedTasks(
	workflow: ArtifactGraphWorkflowSpec,
	tasks: readonly WorkflowPackageTaskRecord[],
): readonly WorkflowPackageTaskRecord[] {
	const expected = workflow.artifactGraph.stages.map(({ id }) => id).sort();
	const actual = tasks
		.map((task) => requiredText(task.stageId, "runtime stage ID"))
		.sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected))
		throw new Error(
			"workflow runtime tasks do not exactly cover compiled stages",
		);
	if (tasks.some((task) => task.status !== "completed"))
		throw new Error("completed workflow contains a non-completed task");
	if (new Set(tasks.map(({ taskId }) => taskId)).size !== tasks.length)
		throw new Error("workflow runtime contains duplicate task IDs");
	return [...tasks].sort((left, right) =>
		(left.stageId as string).localeCompare(right.stageId as string),
	);
}

function taskArtifacts(
	runRoot: string,
	workflowStateRoot: string,
	runId: string,
	task: WorkflowPackageTaskRecord,
	requireRaw: boolean,
): { readonly control: string; readonly raw?: string } {
	const taskDirectory = exactPackageTaskDirectory(
		workflowStateRoot,
		runId,
		task.taskId,
	);
	const resultPath = canonicalRegularFile(resolve(runRoot, task.files.result));
	if (resultPath !== canonicalRegularFile(join(taskDirectory, "result.json")))
		throw new Error(
			`workflow task ${task.taskId} result does not belong to its package task directory`,
		);
	const control = canonicalRegularFile(join(taskDirectory, "control.json"));
	if (!requireRaw) return { control };
	return {
		control,
		raw: canonicalRegularFile(join(taskDirectory, "raw.md")),
	};
}

function assertPackageTaskResultBindings(
	runRoot: string,
	workflowStateRoot: string,
	runId: string,
	tasks: readonly WorkflowPackageTaskRecord[],
): void {
	const directories = new Set<string>();
	for (const task of tasks) {
		const directory = exactPackageTaskDirectory(
			workflowStateRoot,
			runId,
			task.taskId,
		);
		if (directories.has(directory))
			throw new Error(
				"workflow runtime tasks share a package artifact directory",
			);
		directories.add(directory);
		const declared = canonicalRegularFile(resolve(runRoot, task.files.result));
		const expected = canonicalRegularFile(join(directory, "result.json"));
		if (declared !== expected)
			throw new Error(
				`workflow task ${task.taskId} result does not belong to its package task directory`,
			);
	}
}

function exactPackageTaskDirectory(
	workflowStateRoot: string,
	runId: string,
	taskId: string,
): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId))
		throw new Error(`workflow runtime task ID is unsafe: ${taskId}`);
	const runRoot = resolve(workflowStateRoot, "workflows", runId);
	const declaredDirectory = join(runRoot, "tasks", taskId);
	const declaredInfo = lstatSync(declaredDirectory);
	if (!declaredInfo.isDirectory() || declaredInfo.isSymbolicLink())
		throw new Error(
			`workflow package task path is not a real directory: ${declaredDirectory}`,
		);
	const directory = realpathSync(declaredDirectory);
	assertStrictChild(directory, runRoot, "workflow package task directory");
	return directory;
}

async function readControlObject(
	path: string,
): Promise<Record<string, unknown>> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new Error(`workflow control output is not valid JSON: ${path}`, {
			cause: error,
		});
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`workflow control output is not an object: ${path}`);
	return value as Record<string, unknown>;
}

function supervisorFailure(
	runId: string,
	projection: Awaited<WorkflowCoordinatorLifecycleProjection["completion"]>,
	lifecycle: WorkflowCoordinatorLifecycleProjection,
): Error {
	return new Error(
		`workflow supervisor ${runId} ended ${projection.status}; inspect ${lifecycle.stderrPath}`,
	);
}

function bundleInventory(
	root: string,
): Array<{ path: string; sha256: string }> {
	const files: Array<{ path: string; sha256: string }> = [];
	const visit = (directory: string) => {
		for (const name of readdirSync(directory).sort()) {
			const absolute = join(directory, name);
			const info = lstatSync(absolute);
			if (info.isSymbolicLink())
				throw new Error(`workflow bundle contains a symlink: ${absolute}`);
			if (info.isDirectory()) visit(absolute);
			else if (info.isFile())
				files.push({
					path: relative(root, absolute),
					sha256: sha256(readFileSync(absolute)),
				});
			else
				throw new Error(`workflow bundle contains a special file: ${absolute}`);
		}
	};
	visit(root);
	return files.sort((left, right) => left.path.localeCompare(right.path));
}

function writeExact(path: string, contents: string | Buffer): void {
	if (existsSync(path)) {
		const info = lstatSync(path);
		if (!info.isFile() || info.isSymbolicLink())
			throw new Error(
				`workflow bundle artifact is not a regular file: ${path}`,
			);
		if (!readFileSync(path).equals(Buffer.from(contents)))
			throw new Error(`workflow bundle artifact conflicts on resume: ${path}`);
		return;
	}
	writeFileSync(path, contents, { mode: 0o600, flag: "wx" });
}

function mkdirPrivate(path: string): void {
	if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
	const info = lstatSync(path);
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new Error(`workflow bundle path is not a directory: ${path}`);
	if (process.platform !== "win32") chmodSync(path, 0o700);
}

function jsonFile(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function canonicalSortedUnique(values: readonly string[]): string[] {
	const canonical = values.map((value) =>
		isAbsolute(value) && existsSync(value) ? realpathSync(value) : value,
	);
	return [...new Set(canonical)].sort();
}

function canonicalDirectory(path: string, label: string): string {
	if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
	const canonical = realpathSync(path);
	if (!lstatSync(canonical).isDirectory())
		throw new Error(`${label} must be a directory`);
	return canonical;
}

function canonicalRegularFile(path: string): string {
	const info = lstatSync(path);
	if (!info.isFile() || info.isSymbolicLink())
		throw new Error(`workflow artifact is not a regular file: ${path}`);
	return realpathSync(path);
}

function assertStrictChild(
	candidate: string,
	parent: string,
	label: string,
): void {
	const child = relative(parent, candidate);
	if (!child || child.startsWith("..") || isAbsolute(child))
		throw new Error(`${label} escaped its approved root`);
}

function pathsOverlap(left: string, right: string): boolean {
	const child = relative(left, right);
	const parent = relative(right, left);
	return (
		!child ||
		(!child.startsWith("..") && !isAbsolute(child)) ||
		(!parent.startsWith("..") && !isAbsolute(parent))
	);
}

function requiredText(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim())
		throw new Error(`${label} is missing`);
	return value;
}
