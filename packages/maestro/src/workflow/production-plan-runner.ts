// Depth-zero production composition for an approved workflow plan. This is
// deliberately the only place where the phase runner is connected to Git
// checkpoints, private review state, and publication authority.

import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { UsageLedgerV1 } from "@vegardx/pi-contracts";
import { currentDepth } from "../depth.js";
import type { Plan } from "../plan.js";
import { createWorkflowCoordinator } from "./coordinator.js";
import {
	WorkflowPhaseCheckpointer,
	type WorkflowPhaseCheckpointResult,
} from "./phase-checkpoint.js";
import { PrivateArtifactStore } from "./private-artifacts.js";
import {
	ProductionWorkflowPlanPhaseLauncher,
	type WorkflowPhaseRuntimeResolver,
} from "./production-phase-launcher.js";
import {
	continueWorkflowRepositories,
	type PreparedWorkflowRepository,
	type PrepareWorkflowRepositoriesInput,
	prepareWorkflowRepositories,
	previewWorkflowRepositories,
} from "./repository-preparation.js";
import { ReviewDecisionLedgerStore } from "./review-decision-ledger.js";
import { WorkflowApprovalGate } from "./workflow-approval-gate.js";
import {
	type WorkflowPlanPhaseLauncher,
	WorkflowPlanRunner,
	type WorkflowPlanRunnerDependencies,
	type WorkflowSeatShipper,
	type WorkflowSeatTaskRunner,
} from "./workflow-plan-runner.js";
import {
	type WorkflowPullRequestCopy,
	WorkflowShipper,
	type WorkflowShippingRepository,
} from "./workflow-shipping.js";

export interface ProductionWorkflowPlanRunnerLayout {
	readonly coordinatedRunRoot: string;
	readonly maestroStateRoot: string;
	readonly repositoryWorktreeRoot: string;
	readonly workflowRuntimeRoot: string;
	readonly workflowStateRoot: string;
	readonly supervisorScratchRoot: string;
	readonly descendantWritableRoots: readonly string[];
}

/**
 * Seat-only PR prose boundary. Runtime findings, decisions, task identities,
 * and contributor provenance are intentionally absent from this input. The
 * authored Plan remains visible because it is the source of intent/rationale.
 */
export interface WorkflowPullRequestCopyProducer {
	produce(input: {
		readonly plan: Plan;
		readonly repository: PreparedWorkflowRepository;
	}): WorkflowPullRequestCopy | Promise<WorkflowPullRequestCopy>;
}

export class UnsupportedWorkflowSeatTasksError extends Error {
	readonly code = "WORKFLOW_SEAT_TASKS_UNSUPPORTED";
	readonly phase: "preflight" | "postflight";
	readonly taskIds: readonly string[];

	constructor(phase: "preflight" | "postflight", tasks: Plan["preflight"]) {
		super(
			`autonomous ${phase} seat tasks are not implemented; refusing to pretend ${tasks.length} task(s) ran`,
		);
		this.name = "UnsupportedWorkflowSeatTasksError";
		this.phase = phase;
		this.taskIds = tasks.map(({ id }) => id);
	}
}

export interface ProductionWorkflowPlanRunnerOptions {
	/** Existing, non-Git umbrella directory dedicated to one workflow run. */
	readonly coordinatedRunRoot: string;
	/** Seat-private durable state, disjoint from the coordinated run root. */
	readonly maestroStateRoot: string;
	/** Exact source repository roots which the plan is allowed to prepare. */
	readonly coordinatedRepositoryRoots: readonly string[];
	readonly runtimeResolver: WorkflowPhaseRuntimeResolver;
	readonly pullRequestCopyProducer: WorkflowPullRequestCopyProducer;
	readonly usage?: Pick<UsageLedgerV1, "trackWorkflowRun">;
	/** A real autonomous seat adapter may be supplied; omission fails closed. */
	readonly seatTasks?: WorkflowSeatTaskRunner;
	readonly phaseWaitTimeoutMs?: number;
	readonly depth?: () => number;
	/** Narrow construction seams for unit tests; production leaves these absent. */
	readonly components?: Partial<ProductionWorkflowPlanRunnerComponents>;
}

export interface ProductionWorkflowPlanRunnerComposition {
	readonly runner: WorkflowPlanRunner;
	readonly layout: ProductionWorkflowPlanRunnerLayout;
}

export interface ProductionWorkflowPlanRunnerComponents {
	readonly createApprovalGate: (
		options: ConstructorParameters<typeof WorkflowApprovalGate>[0],
	) => Pick<WorkflowApprovalGate, "approveAndLaunch">;
	readonly createCoordinator: (
		options: Parameters<typeof createWorkflowCoordinator>[0],
	) => Pick<ReturnType<typeof createWorkflowCoordinator>, "start" | "continue">;
	readonly createPhaseLauncher: (
		options: ConstructorParameters<
			typeof ProductionWorkflowPlanPhaseLauncher
		>[0],
	) => WorkflowPlanPhaseLauncher;
	readonly createCheckpointer: (
		options: ConstructorParameters<typeof WorkflowPhaseCheckpointer>[0],
	) => Pick<WorkflowPhaseCheckpointer, "checkpoint">;
	readonly createPrivateArtifacts: (
		options: ConstructorParameters<typeof PrivateArtifactStore>[0],
	) => Pick<PrivateArtifactStore, "putReviewForRun" | "joinAfterDecisions">;
	readonly createDecisionLedgers: (
		options: ConstructorParameters<typeof ReviewDecisionLedgerStore>[0],
	) => Pick<ReviewDecisionLedgerStore, "seal" | "load">;
	readonly createShipper: (
		options: ConstructorParameters<typeof WorkflowShipper>[0],
	) => Pick<WorkflowShipper, "ship">;
	readonly previewRepositories: typeof previewWorkflowRepositories;
	readonly prepareRepositories: typeof prepareWorkflowRepositories;
	readonly continueRepositories: typeof continueWorkflowRepositories;
}

const defaults: ProductionWorkflowPlanRunnerComponents = {
	createApprovalGate: (options) => new WorkflowApprovalGate(options),
	createCoordinator: (options) => createWorkflowCoordinator(options),
	createPhaseLauncher: (options) =>
		new ProductionWorkflowPlanPhaseLauncher(options),
	createCheckpointer: (options) => new WorkflowPhaseCheckpointer(options),
	createPrivateArtifacts: (options) => new PrivateArtifactStore(options),
	createDecisionLedgers: (options) => new ReviewDecisionLedgerStore(options),
	createShipper: (options) => new WorkflowShipper(options),
	previewRepositories: previewWorkflowRepositories,
	prepareRepositories: prepareWorkflowRepositories,
	continueRepositories: continueWorkflowRepositories,
};

export function createProductionWorkflowPlanRunner(
	options: ProductionWorkflowPlanRunnerOptions,
): ProductionWorkflowPlanRunnerComposition {
	const depth = options.depth ?? currentDepth;
	if (depth() !== 0)
		throw new Error("production workflow plan runner belongs to depth 0");
	const layout = productionWorkflowPlanRunnerLayout({
		coordinatedRunRoot: options.coordinatedRunRoot,
		maestroStateRoot: options.maestroStateRoot,
	});
	if (options.coordinatedRepositoryRoots.length === 0)
		throw new Error("production workflow runner requires repository roots");
	const repositoryRoots = canonicalUniqueDirectories(
		options.coordinatedRepositoryRoots,
		"coordinated repository root",
	);
	for (const root of repositoryRoots) {
		if (overlaps(root, layout.coordinatedRunRoot))
			throw new Error(
				"source repositories must be disjoint from the coordinated run root",
			);
		if (overlaps(root, layout.maestroStateRoot))
			throw new Error(
				"source repositories must be disjoint from maestro state",
			);
	}
	const components = { ...defaults, ...options.components };
	const authorityOptions = {
		maestroStateRoot: layout.maestroStateRoot,
		descendantWritableRoots: layout.descendantWritableRoots,
		depth,
	};
	const approvalGate = components.createApprovalGate(authorityOptions);
	const coordinator = components.createCoordinator({
		...(options.usage ? { usage: options.usage } : {}),
		depth,
	});
	const phaseLauncher = components.createPhaseLauncher({
		coordinatedRunRoot: layout.coordinatedRunRoot,
		coordinator,
		runtimeResolver: options.runtimeResolver,
		...(options.phaseWaitTimeoutMs === undefined
			? {}
			: { waitTimeoutMs: options.phaseWaitTimeoutMs }),
	});
	const checkpointer = components.createCheckpointer(authorityOptions);
	const privateArtifacts = components.createPrivateArtifacts({
		maestroStateRoot: layout.maestroStateRoot,
		coordinatedRepositoryRoots: [
			...repositoryRoots,
			layout.repositoryWorktreeRoot,
		],
		sharedWorkflowRoots: [layout.workflowStateRoot],
	});
	const decisionLedgers = components.createDecisionLedgers({
		maestroStateRoot: layout.maestroStateRoot,
		forbiddenRoots: [
			...repositoryRoots,
			layout.repositoryWorktreeRoot,
			layout.workflowStateRoot,
		],
	});
	const workflowShipper = components.createShipper(authorityOptions);
	const shipper = createWorkflowSeatShipper({
		shipper: workflowShipper,
		pullRequestCopyProducer: options.pullRequestCopyProducer,
	});
	const seatTasks =
		options.seatTasks ?? createFailClosedWorkflowSeatTaskRunner();
	const assertRepositoryInput = (input: PrepareWorkflowRepositoriesInput) => {
		if (
			canonicalDirectory(
				input.coordinatedRunRoot,
				false,
				"workflow input run root",
			) !== layout.coordinatedRunRoot
		)
			throw new Error(
				"workflow input run root differs from the production composition",
			);
		assertExactRepositoryRoots(input, repositoryRoots);
	};
	const dependencies: WorkflowPlanRunnerDependencies = {
		approvalGate,
		previewRepositories: async (input) => {
			assertRepositoryInput(input);
			return components.previewRepositories(input);
		},
		prepareRepositories: async (input, mode) => {
			assertRepositoryInput(input);
			return mode === "start"
				? components.prepareRepositories(input)
				: components.continueRepositories(input);
		},
		phaseLauncher,
		seatTasks,
		checkpointer,
		privateArtifacts,
		decisionLedgers,
		shipper,
	};
	return {
		layout,
		runner: new WorkflowPlanRunner({
			maestroStateRoot: layout.maestroStateRoot,
			descendantWritableRoots: layout.descendantWritableRoots,
			dependencies,
			depth,
		}),
	};
}

export function productionWorkflowPlanRunnerLayout(input: {
	readonly coordinatedRunRoot: string;
	readonly maestroStateRoot: string;
}): ProductionWorkflowPlanRunnerLayout {
	const coordinatedRunRoot = canonicalDirectory(
		input.coordinatedRunRoot,
		false,
		"coordinated run root",
	);
	const maestroStateRoot = canonicalDirectory(
		input.maestroStateRoot,
		true,
		"maestro state root",
	);
	if (overlaps(coordinatedRunRoot, maestroStateRoot))
		throw new Error(
			"maestro state must be disjoint from the coordinated run root",
		);
	const repositoryWorktreeRoot = join(coordinatedRunRoot, "repos");
	const workflowRuntimeRoot = join(coordinatedRunRoot, "runtime");
	const workflowStateRoot = join(workflowRuntimeRoot, ".pi");
	const supervisorScratchRoot = join(coordinatedRunRoot, "scratch");
	return Object.freeze({
		coordinatedRunRoot,
		maestroStateRoot,
		repositoryWorktreeRoot,
		workflowRuntimeRoot,
		workflowStateRoot,
		supervisorScratchRoot,
		descendantWritableRoots: Object.freeze([
			repositoryWorktreeRoot,
			workflowRuntimeRoot,
			supervisorScratchRoot,
		]),
	});
}

export function createWorkflowSeatShipper(options: {
	readonly shipper: Pick<WorkflowShipper, "ship">;
	readonly pullRequestCopyProducer: WorkflowPullRequestCopyProducer;
}): WorkflowSeatShipper {
	return {
		ship: async ({ runId, plan, repositories, finalCheckpoint }) => {
			const checkpoint = exactFinalCheckpoint(
				runId,
				repositories,
				finalCheckpoint,
			);
			const shippingRepositories: WorkflowShippingRepository[] = [];
			for (const repository of repositories) {
				const final = checkpoint.get(repository.key) as NonNullable<
					ReturnType<typeof checkpoint.get>
				>;
				const pullRequest = await options.pullRequestCopyProducer.produce({
					plan,
					repository,
				});
				shippingRepositories.push({
					key: repository.key,
					worktree: repository.worktree,
					expectedBranch: repository.branch,
					expectedFinalHead: final.finalHead,
					baseBranch: repository.baseBranch,
					pullRequest,
				});
			}
			await options.shipper.ship({
				runId,
				repositories: shippingRepositories,
			});
		},
	};
}

function exactFinalCheckpoint(
	runId: string,
	repositories: readonly PreparedWorkflowRepository[],
	checkpoint: WorkflowPhaseCheckpointResult,
) {
	if (checkpoint.runId !== runId || checkpoint.phase !== "decision")
		throw new Error("shipping requires this run's decision checkpoint");
	if (checkpoint.repositories.length !== repositories.length)
		throw new Error("final checkpoint repository set is incomplete");
	const expected = new Map(
		repositories.map((repository) => [repository.key, repository]),
	);
	const actual = new Map<
		string,
		WorkflowPhaseCheckpointResult["repositories"][number]
	>();
	for (const result of checkpoint.repositories) {
		const repository = expected.get(result.repository);
		if (
			!repository ||
			actual.has(result.repository) ||
			resolve(result.worktree) !== repository.worktree ||
			result.expectedBranch !== repository.branch
		)
			throw new Error(
				`final checkpoint does not match repository ${result.repository}`,
			);
		actual.set(result.repository, result);
	}
	if (actual.size !== expected.size)
		throw new Error("final checkpoint repository set is incomplete");
	return actual;
}

export function createFailClosedWorkflowSeatTaskRunner(): WorkflowSeatTaskRunner {
	return {
		run: async ({ phase, tasks }) => {
			if (tasks.length > 0)
				throw new UnsupportedWorkflowSeatTasksError(phase, tasks);
		},
	};
}

function assertExactRepositoryRoots(
	input: PrepareWorkflowRepositoriesInput,
	approvedRoots: readonly string[],
): void {
	const actual = canonicalUniqueDirectories(
		input.repositories.map(({ path }) => path),
		"plan repository root",
	);
	if (JSON.stringify(actual) !== JSON.stringify(approvedRoots))
		throw new Error(
			"plan repositories differ from the production composition boundary",
		);
}

function canonicalUniqueDirectories(
	paths: readonly string[],
	label: string,
): readonly string[] {
	const canonical = paths.map((path) => canonicalDirectory(path, false, label));
	const unique = [...new Set(canonical)].sort();
	if (unique.length !== paths.length) throw new Error(`duplicate ${label}`);
	return unique;
}

function canonicalDirectory(
	path: string,
	create: boolean,
	label: string,
): string {
	if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
	if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
	if (!existsSync(path)) throw new Error(`${label} must exist`);
	const info = lstatSync(path);
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new Error(`${label} must be a real directory`);
	return realpathSync(path);
}

function overlaps(left: string, right: string): boolean {
	const contains = (from: string, to: string) => {
		const value = relative(resolve(from), resolve(to));
		return value === "" || (!value.startsWith(`..${sep}`) && value !== "..");
	};
	return contains(left, right) || contains(right, left);
}
