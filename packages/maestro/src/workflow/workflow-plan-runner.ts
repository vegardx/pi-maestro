// Durable depth-zero orchestration for the three flat workflow phases.
// Package-specific result discovery and publication stay behind typed seat
// adapters; this state machine owns ordering, recovery, commits, and gates.

import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Plan } from "../plan.js";
import { currentDepth } from "../spawn.js";
import type {
	WorkflowPhaseCheckpointInput,
	WorkflowPhaseCheckpointResult,
} from "./phase-checkpoint.js";
import type {
	CompiledDecisionWorkflow,
	CompiledPlanWorkflow,
	PlanCompilerOptions,
	ReviewerRuntimeTask,
} from "./plan-compiler.js";
import {
	bindReviewerRegistry,
	compileDecisionWorkflow,
	compilePlanWorkflow,
	decisionGateInput,
} from "./plan-compiler.js";
import type {
	JoinedPrivateReview,
	PrivateArtifactReference,
	PrivateArtifactStore,
	ReviewDecision,
	SanitizedFinding,
} from "./private-artifacts.js";
import type {
	PreparedWorkflowRepository,
	PrepareWorkflowRepositoriesInput,
} from "./repository-preparation.js";
import type {
	ReviewDecisionLedgerReference,
	ReviewDecisionLedgerStore,
	ReviewFindingDecisionInput,
} from "./review-decision-ledger.js";
import type { ReviewerFindingSubmission } from "./review-findings.js";
import { normalizeRawReviewFindings } from "./review-findings.js";
import type {
	WorkflowApprovalAsker,
	WorkflowApprovalControllerResult,
	WorkflowApprovalGate,
} from "./workflow-approval-gate.js";

export type WorkflowPlanRunnerPhase =
	| "repositories"
	| "preflight"
	| "implementation"
	| "implementation-checkpoint"
	| "review"
	| "review-handoff"
	| "decision"
	| "decision-checkpoint"
	| "decision-gate"
	| "postflight"
	| "shipping";

export interface WorkflowPlanRunnerInput {
	readonly runId: string;
	readonly coordinatedRunRoot: string;
	readonly plan: Plan;
	readonly implementationModel: string;
	readonly decisionModel: string;
	readonly asker: WorkflowApprovalAsker;
	/**
	 * Depth-zero posture transition. The approval gate calls this only after a
	 * durable human approval exists (new or resumed), immediately before the
	 * first autonomous phase is entered.
	 */
	readonly onApproved?: () => void | Promise<void>;
}

export interface WorkflowPhaseLaunchInput<Workflow> {
	readonly runId: string;
	readonly action: "start" | "continue";
	readonly workflow: Workflow;
	readonly repositories: readonly PreparedWorkflowRepository[];
	readonly worktreeAccess: "read" | "write";
	/** Exact reviewer output files hidden from the decision workflow. */
	readonly deniedReadRoots: readonly string[];
}

export interface WorkflowReviewPhaseResult {
	readonly runtimeTasks: readonly ReviewerRuntimeTask[];
	readonly submissions: readonly ReviewerFindingSubmission[];
	/** Exact raw/control artifacts, not an enclosing workflow run directory. */
	readonly rawArtifactPaths: readonly string[];
}

export interface WorkflowDecisionPhaseResult {
	readonly decisions: readonly ReviewFindingDecisionInput[];
}

/** Coordinator-backed in production; faked without model output in unit tests. */
export interface WorkflowPlanPhaseLauncher {
	runImplementation(
		input: WorkflowPhaseLaunchInput<
			CompiledPlanWorkflow["implementationWorkflow"]
		>,
	): Promise<void>;
	runReview(
		input: WorkflowPhaseLaunchInput<
			Extract<
				CompiledPlanWorkflow["reviewPhase"],
				{ status: "required" }
			>["workflow"]
		>,
	): Promise<WorkflowReviewPhaseResult>;
	runDecision(
		input: WorkflowPhaseLaunchInput<CompiledDecisionWorkflow["workflow"]>,
	): Promise<WorkflowDecisionPhaseResult>;
}

export interface WorkflowSeatTaskRunner {
	/** Must be idempotent when re-entered after an unobservable process exit. */
	run(input: {
		readonly runId: string;
		readonly phase: "preflight" | "postflight";
		readonly tasks: Plan["preflight"];
		readonly repositories: readonly PreparedWorkflowRepository[];
	}): Promise<void>;
}

export interface WorkflowSeatShipper {
	/** Must be idempotent because a process can exit after shipping succeeds. */
	ship(input: {
		readonly runId: string;
		readonly plan: Plan;
		readonly repositories: readonly PreparedWorkflowRepository[];
		readonly finalCheckpoint: WorkflowPhaseCheckpointResult;
	}): Promise<void>;
}

export interface WorkflowPlanRunnerDependencies {
	readonly approvalGate: Pick<WorkflowApprovalGate, "approveAndLaunch">;
	readonly previewRepositories: (
		input: PrepareWorkflowRepositoriesInput,
	) => Promise<readonly PreparedWorkflowRepository[]>;
	readonly prepareRepositories: (
		input: PrepareWorkflowRepositoriesInput,
		mode: "start" | "continue",
	) => Promise<readonly PreparedWorkflowRepository[]>;
	readonly phaseLauncher: WorkflowPlanPhaseLauncher;
	readonly seatTasks: WorkflowSeatTaskRunner;
	readonly checkpointer: {
		checkpoint(
			input: WorkflowPhaseCheckpointInput,
		): WorkflowPhaseCheckpointResult;
	};
	readonly privateArtifacts: Pick<
		PrivateArtifactStore,
		"putReviewForRun" | "joinAfterDecisions"
	>;
	readonly decisionLedgers: Pick<ReviewDecisionLedgerStore, "seal" | "load">;
	readonly shipper: WorkflowSeatShipper;
	/** Observability/test hook after the private reference is durable. */
	readonly onReviewHandoffPersisted?: () => void | Promise<void>;
	readonly checkpointMessage?: (input: {
		readonly phase: "implementation" | "decision";
		readonly repository: PreparedWorkflowRepository;
		readonly plan: Plan;
	}) => string;
}

export interface CompletedWorkflowPlanRun {
	readonly runId: string;
	readonly planSlug: string;
	readonly repositories: readonly PreparedWorkflowRepository[];
	readonly implementationCheckpoint: WorkflowPhaseCheckpointResult;
	readonly decisionCheckpoint: WorkflowPhaseCheckpointResult;
	readonly privateReview: PrivateArtifactReference;
	readonly decisionLedger: ReviewDecisionLedgerReference;
	readonly joinedReview: JoinedPrivateReview;
}

export type WorkflowPlanRunnerResult =
	WorkflowApprovalControllerResult<CompletedWorkflowPlanRun>;

interface RunnerJournal {
	readonly version: 1;
	readonly runId: string;
	readonly planSlug: string;
	readonly authoredDigest: string;
	readonly activePhase?: WorkflowPlanRunnerPhase;
	readonly completedPhases: readonly WorkflowPlanRunnerPhase[];
	readonly repositoryPreview?: readonly PreparedWorkflowRepository[];
	readonly repositories?: readonly PreparedWorkflowRepository[];
	readonly executionDigest?: string;
	readonly implementationCheckpoint?: WorkflowPhaseCheckpointResult;
	readonly sanitizedFindings?: readonly SanitizedFinding[];
	readonly privateReview?: PrivateArtifactReference;
	readonly deniedReadRoots?: readonly string[];
	readonly decisions?: readonly ReviewFindingDecisionInput[];
	readonly decisionCheckpoint?: WorkflowPhaseCheckpointResult;
	readonly decisionLedger?: ReviewDecisionLedgerReference;
}

interface JournalEnvelope {
	readonly digest: string;
	readonly journal: RunnerJournal;
}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export class WorkflowPlanRunner {
	readonly #root: string;
	readonly #dependencies: WorkflowPlanRunnerDependencies;
	readonly #depth: () => number;

	constructor(options: {
		readonly maestroStateRoot: string;
		readonly descendantWritableRoots: readonly string[];
		readonly dependencies: WorkflowPlanRunnerDependencies;
		readonly depth?: () => number;
	}) {
		this.#depth = options.depth ?? currentDepth;
		if (this.#depth() !== 0)
			throw new Error("workflow plan runner authority belongs to depth 0");
		if (options.descendantWritableRoots.length === 0)
			throw new Error(
				"workflow plan runner requires descendant-writable roots",
			);
		const stateRoot = canonicalDirectory(options.maestroStateRoot, true);
		const root = resolve(stateRoot, "workflow-plan-runs");
		for (const forbidden of options.descendantWritableRoots.map(canonicalPath))
			if (overlaps(root, forbidden))
				throw new Error(
					"workflow plan runner state must be disjoint from descendant-writable roots",
				);
		mkdirSync(root, { recursive: true, mode: 0o700 });
		if (process.platform !== "win32") chmodSync(root, 0o700);
		this.#root = realpathSync(root);
		this.#dependencies = options.dependencies;
	}

	async run(input: WorkflowPlanRunnerInput): Promise<WorkflowPlanRunnerResult> {
		if (this.#depth() !== 0)
			throw new Error("workflow plan runner authority belongs to depth 0");
		assertId(input.runId, "workflow run id");
		if (!isAbsolute(input.coordinatedRunRoot))
			throw new Error("coordinated run root must be absolute");
		const lock = this.#acquireLock(input.runId);
		try {
			let journal = this.#loadOrCreate(input);
			journal = await this.#previewRepositories(input, journal);
			const compiled = this.#compile(input, journal.repositoryPreview ?? []);
			journal = this.#bindExecution(journal, compiled);
			const approved = await this.#dependencies.approvalGate.approveAndLaunch({
				approval: {
					runId: input.runId,
					planSlug: input.plan.slug,
					executionDigest: journal.executionDigest as string,
					approvalText: compiled.approvalText,
				},
				asker: input.asker,
				launch: async () => {
					await input.onApproved?.();
					return this.#execute(input, compiled, journal);
				},
			});
			return approved;
		} finally {
			this.#releaseLock(lock);
		}
	}

	async #previewRepositories(
		input: WorkflowPlanRunnerInput,
		journal: RunnerJournal,
	): Promise<RunnerJournal> {
		if (journal.repositoryPreview) return journal;
		const repositoryPreview = await this.#dependencies.previewRepositories(
			repositoryInput(input),
		);
		const next = { ...journal, repositoryPreview: clone(repositoryPreview) };
		this.#write(next);
		return next;
	}

	#compile(
		input: WorkflowPlanRunnerInput,
		repositories: readonly PreparedWorkflowRepository[],
	): CompiledPlanWorkflow {
		return compilePlanWorkflow(input.plan, {
			implementationModel: input.implementationModel,
			decisionModel: input.decisionModel,
			coordinatedCwd: input.coordinatedRunRoot,
			repositories,
		});
	}

	#bindExecution(
		journal: RunnerJournal,
		compiled: CompiledPlanWorkflow,
	): RunnerJournal {
		const digest = sha256(
			canonicalJson({
				approval: compiled.approval,
				implementationWorkflow: compiled.implementationWorkflow,
				reviewPhase: compiled.reviewPhase,
			}),
		);
		if (journal.executionDigest && journal.executionDigest !== digest)
			throw new Error(
				"workflow plan runner execution changed after preparation",
			);
		if (journal.executionDigest) return journal;
		const next = { ...journal, executionDigest: digest };
		this.#write(next);
		return next;
	}

	async #execute(
		input: WorkflowPlanRunnerInput,
		compiled: CompiledPlanWorkflow,
		initial: RunnerJournal,
	): Promise<CompletedWorkflowPlanRun> {
		let journal = this.#read(input.runId) ?? initial;
		if (!journal.repositories) {
			const continuing = journal.activePhase === "repositories";
			journal = this.#startPhase(journal, "repositories");
			const repositories = await this.#dependencies.prepareRepositories(
				repositoryInput(input, journal.repositoryPreview),
				continuing ? "continue" : "start",
			);
			assertRepositoryPreview(journal.repositoryPreview ?? [], repositories);
			journal = { ...journal, repositories: clone(repositories) };
			journal = this.#completePhase(journal, "repositories");
		}
		const repositories =
			journal.repositories as readonly PreparedWorkflowRepository[];
		journal = await this.#seatTaskPhase(
			input,
			journal,
			"preflight",
			compiled.seat.preflight,
			repositories,
		);

		if (!hasCompleted(journal, "implementation")) {
			const action =
				journal.activePhase === "implementation" ? "continue" : "start";
			journal = this.#startPhase(journal, "implementation");
			await this.#dependencies.phaseLauncher.runImplementation({
				runId: `${input.runId}_implementation`,
				action,
				workflow: compiled.implementationWorkflow,
				repositories,
				worktreeAccess: "write",
				deniedReadRoots: [],
			});
			journal = this.#completePhase(journal, "implementation");
		}

		if (!journal.implementationCheckpoint) {
			journal = this.#startPhase(journal, "implementation-checkpoint");
			const implementationCheckpoint =
				this.#dependencies.checkpointer.checkpoint({
					runId: input.runId,
					phase: "implementation",
					repositories: checkpointRepositories(repositories),
					messages: this.#messages(input.plan, repositories, "implementation"),
				});
			journal = { ...journal, implementationCheckpoint };
			journal = this.#completePhase(journal, "implementation-checkpoint");
		}

		if (!journal.privateReview) {
			let review: WorkflowReviewPhaseResult = {
				runtimeTasks: [],
				submissions: [],
				rawArtifactPaths: [],
			};
			if (compiled.reviewPhase.status === "required") {
				const action = journal.activePhase === "review" ? "continue" : "start";
				journal = this.#startPhase(journal, "review");
				review = await this.#dependencies.phaseLauncher.runReview({
					runId: `${input.runId}_review`,
					action,
					workflow: compiled.reviewPhase.workflow,
					repositories,
					worktreeAccess: "read",
					deniedReadRoots: [],
				});
			}
			const normalized =
				compiled.reviewPhase.status === "skipped-no-reviewers"
					? {
							sanitizedFindings: [],
							rawFindings: [],
							provenance: [],
						}
					: normalizeRawReviewFindings(review.submissions, {
							approvedRepositories: repositories.map(({ key }) => key),
							approvedReviewerTasks: bindReviewerRegistry(
								compiled,
								review.runtimeTasks,
							),
						});
			const stored = this.#dependencies.privateArtifacts.putReviewForRun(
				input.runId,
				normalized,
			);
			const deniedReadRoots = exactArtifactPaths(review.rawArtifactPaths);
			journal = {
				...journal,
				sanitizedFindings: stored.projection.findings,
				privateReview: stored.reference,
				deniedReadRoots,
			};
			this.#write(journal);
			await this.#dependencies.onReviewHandoffPersisted?.();
		}
		if (journal.activePhase === "review")
			journal = this.#completePhase(journal, "review");
		if (journal.activePhase === "review-handoff")
			journal = this.#completePhase(journal, "review-handoff");
		if (!hasCompleted(journal, "review-handoff")) {
			journal = this.#startPhase(journal, "review-handoff");
			journal = this.#completePhase(journal, "review-handoff");
		}

		const compilerOptions: PlanCompilerOptions = {
			implementationModel: input.implementationModel,
			decisionModel: input.decisionModel,
			coordinatedCwd: input.coordinatedRunRoot,
			repositories,
		};
		const decisionWorkflow = compileDecisionWorkflow(
			input.plan,
			compilerOptions,
			journal.sanitizedFindings ?? [],
		);
		if (journal.decisions && journal.activePhase === "decision")
			journal = this.#completePhase(journal, "decision");
		if (!journal.decisions) {
			let decisions: readonly ReviewFindingDecisionInput[] = [];
			if (decisionWorkflow) {
				const action =
					journal.activePhase === "decision" ? "continue" : "start";
				journal = this.#startPhase(journal, "decision");
				const result = await this.#dependencies.phaseLauncher.runDecision({
					runId: `${input.runId}_decision`,
					action,
					workflow: decisionWorkflow.workflow,
					repositories,
					worktreeAccess: "write",
					deniedReadRoots: journal.deniedReadRoots ?? [],
				});
				decisions = result.decisions;
				assertDecisionCoverage(decisionWorkflow, decisions);
				journal = { ...journal, decisions: clone(decisions) };
				this.#write(journal);
				journal = this.#completePhase(journal, "decision");
			}
			if (!journal.decisions) {
				journal = { ...journal, decisions: clone(decisions) };
				this.#write(journal);
			}
		}

		if (!journal.decisionCheckpoint) {
			journal = this.#startPhase(journal, "decision-checkpoint");
			const decisionCheckpoint = this.#dependencies.checkpointer.checkpoint({
				runId: input.runId,
				phase: "decision",
				repositories: checkpointRepositories(repositories),
				messages: this.#messages(input.plan, repositories, "decision"),
				expectedChangedPaths: changedPathsByRepository(
					repositories,
					journal.decisions ?? [],
				),
			});
			journal = { ...journal, decisionCheckpoint };
			journal = this.#completePhase(journal, "decision-checkpoint");
		}

		if (!journal.decisionLedger) {
			journal = this.#startPhase(journal, "decision-gate");
			const enriched = enrichCommitRefs(
				journal.decisions ?? [],
				journal.decisionCheckpoint as WorkflowPhaseCheckpointResult,
			);
			const gateInput = decisionWorkflow
				? decisionGateInput(decisionWorkflow, {
						runId: input.runId,
						decisions: enriched,
						repositories: reviewBoundaries(
							repositories,
							journal.implementationCheckpoint as WorkflowPhaseCheckpointResult,
							journal.decisionCheckpoint as WorkflowPhaseCheckpointResult,
						),
					})
				: {
						runId: input.runId,
						findings: [],
						decisions: [],
						repositories: reviewBoundaries(
							repositories,
							journal.implementationCheckpoint as WorkflowPhaseCheckpointResult,
							journal.decisionCheckpoint as WorkflowPhaseCheckpointResult,
						),
					};
			const sealed = this.#dependencies.decisionLedgers.seal(gateInput);
			journal = { ...journal, decisionLedger: sealed.reference };
			journal = this.#completePhase(journal, "decision-gate");
		}

		journal = await this.#seatTaskPhase(
			input,
			journal,
			"postflight",
			compiled.seat.postflight,
			repositories,
		);
		const ledger = this.#dependencies.decisionLedgers.load(
			journal.decisionLedger as ReviewDecisionLedgerReference,
		);
		// Validate the private reference and provenance join before any remote
		// mutation. On resume this validation is intentionally repeated rather
		// than copying raw joined content into the runner journal.
		const privateReview = journal.privateReview as PrivateArtifactReference;
		const joinedReview = this.#dependencies.privateArtifacts.joinAfterDecisions(
			privateReview,
			ledger.decisions.map(
				(decision): ReviewDecision => ({
					findingId: decision.findingId,
					decision: decision.decision,
					reasoning: decision.reasoning,
					commitRefs: decision.commitRefs.map(
						({ repository, commit }) => `${repository}:${commit}`,
					),
				}),
			),
		);
		if (!hasCompleted(journal, "shipping")) {
			journal = this.#startPhase(journal, "shipping");
			await this.#dependencies.shipper.ship({
				runId: input.runId,
				plan: input.plan,
				repositories,
				finalCheckpoint:
					journal.decisionCheckpoint as WorkflowPhaseCheckpointResult,
			});
			journal = this.#completePhase(journal, "shipping");
		}
		return {
			runId: input.runId,
			planSlug: input.plan.slug,
			repositories,
			implementationCheckpoint:
				journal.implementationCheckpoint as WorkflowPhaseCheckpointResult,
			decisionCheckpoint:
				journal.decisionCheckpoint as WorkflowPhaseCheckpointResult,
			privateReview,
			decisionLedger: journal.decisionLedger as ReviewDecisionLedgerReference,
			joinedReview,
		};
	}

	async #seatTaskPhase(
		input: WorkflowPlanRunnerInput,
		journal: RunnerJournal,
		phase: "preflight" | "postflight",
		tasks: Plan["preflight"],
		repositories: readonly PreparedWorkflowRepository[],
	): Promise<RunnerJournal> {
		if (hasCompleted(journal, phase)) return journal;
		journal = this.#startPhase(journal, phase);
		await this.#dependencies.seatTasks.run({
			runId: input.runId,
			phase,
			tasks,
			repositories,
		});
		return this.#completePhase(journal, phase);
	}

	#messages(
		plan: Plan,
		repositories: readonly PreparedWorkflowRepository[],
		phase: "implementation" | "decision",
	): Record<string, string> {
		return Object.fromEntries(
			repositories.map((repository) => [
				repository.key,
				this.#dependencies.checkpointMessage?.({ phase, repository, plan }) ??
					(phase === "implementation"
						? `Implement ${plan.title}`
						: `Address review decisions for ${plan.title}`),
			]),
		);
	}

	#loadOrCreate(input: WorkflowPlanRunnerInput): RunnerJournal {
		const authoredDigest = sha256(
			canonicalJson({
				coordinatedRunRoot: resolve(input.coordinatedRunRoot),
				plan: input.plan,
				implementationModel: input.implementationModel,
				decisionModel: input.decisionModel,
			}),
		);
		const existing = this.#read(input.runId);
		if (existing) {
			if (
				existing.planSlug !== input.plan.slug ||
				existing.authoredDigest !== authoredDigest
			)
				throw new Error("workflow plan runner resume identity mismatch");
			return existing;
		}
		const journal: RunnerJournal = {
			version: 1,
			runId: input.runId,
			planSlug: input.plan.slug,
			authoredDigest,
			completedPhases: [],
		};
		this.#write(journal);
		return journal;
	}

	#startPhase(
		journal: RunnerJournal,
		phase: WorkflowPlanRunnerPhase,
	): RunnerJournal {
		if (journal.activePhase && journal.activePhase !== phase)
			throw new Error(
				`workflow plan runner cannot enter ${phase} while ${journal.activePhase} is active`,
			);
		const next = { ...journal, activePhase: phase };
		this.#write(next);
		return next;
	}

	#completePhase(
		journal: RunnerJournal,
		phase: WorkflowPlanRunnerPhase,
	): RunnerJournal {
		if (journal.activePhase !== phase)
			throw new Error(`workflow plan runner did not start ${phase}`);
		const next: RunnerJournal = {
			...journal,
			activePhase: undefined,
			completedPhases: [...new Set([...journal.completedPhases, phase])],
		};
		this.#write(next);
		return next;
	}

	#journalPath(runId: string): string {
		return join(this.#root, `${runId}.json`);
	}

	#read(runId: string): RunnerJournal | undefined {
		const path = this.#journalPath(runId);
		if (!existsSync(path)) return undefined;
		if (lstatSync(path).isSymbolicLink())
			throw new Error("workflow plan runner journal cannot be a symlink");
		const envelope = JSON.parse(readFileSync(path, "utf8")) as JournalEnvelope;
		if (envelope.digest !== sha256(canonicalJson(envelope.journal)))
			throw new Error("workflow plan runner journal integrity check failed");
		if (envelope.journal.version !== 1 || envelope.journal.runId !== runId)
			throw new Error("invalid workflow plan runner journal");
		return envelope.journal;
	}

	#write(journal: RunnerJournal): void {
		const path = this.#journalPath(journal.runId);
		const envelope: JournalEnvelope = {
			digest: sha256(canonicalJson(journal)),
			journal,
		};
		atomicPrivateWrite(path, canonicalJson(envelope));
	}

	#acquireLock(runId: string): { readonly path: string; readonly fd: number } {
		const path = join(this.#root, `${runId}.lock`);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				const fd = openSync(path, "wx", 0o600);
				writeSync(fd, `${process.pid}\n`, undefined, "utf8");
				fsyncSync(fd);
				return { path, fd };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const owner = Number.parseInt(readFileSync(path, "utf8"), 10);
				if (Number.isInteger(owner) && isAlive(owner))
					throw new Error(`workflow plan run ${runId} is owned by a live seat`);
				unlinkSync(path);
			}
		}
		throw new Error(`could not acquire workflow plan run ${runId}`);
	}

	#releaseLock(lock: { readonly path: string; readonly fd: number }): void {
		closeSync(lock.fd);
		rmSync(lock.path, { force: true });
	}
}

function checkpointRepositories(
	repositories: readonly PreparedWorkflowRepository[],
) {
	return repositories.map(({ key, worktree, branch }) => ({
		key,
		worktree,
		expectedBranch: branch,
	}));
}

function repositoryInput(
	input: WorkflowPlanRunnerInput,
	expectedRepositories?: readonly PreparedWorkflowRepository[],
): PrepareWorkflowRepositoriesInput {
	return {
		runId: input.runId,
		planSlug: input.plan.slug,
		coordinatedRunRoot: input.coordinatedRunRoot,
		repositories: input.plan.repos.map(({ key, path }) => ({ key, path })),
		...(expectedRepositories ? { expectedRepositories } : {}),
	};
}

function assertRepositoryPreview(
	preview: readonly PreparedWorkflowRepository[],
	prepared: readonly PreparedWorkflowRepository[],
): void {
	if (canonicalJson(preview) !== canonicalJson(prepared))
		throw new Error(
			"prepared workflow repositories differ from the human-approved preview",
		);
}

function changedPathsByRepository(
	repositories: readonly PreparedWorkflowRepository[],
	decisions: readonly ReviewFindingDecisionInput[],
): Record<string, readonly string[]> {
	const paths = new Map(
		repositories.map(({ key }) => [key, new Set<string>()]),
	);
	for (const decision of decisions)
		for (const changed of decision.changedPaths ?? []) {
			const repository = paths.get(changed.repository);
			if (!repository)
				throw new Error(
					`decision names unknown repository ${changed.repository}`,
				);
			repository.add(changed.path);
		}
	return Object.fromEntries(
		[...paths].map(([repository, values]) => [repository, [...values].sort()]),
	);
}

function enrichCommitRefs(
	decisions: readonly ReviewFindingDecisionInput[],
	checkpoint: WorkflowPhaseCheckpointResult,
): readonly ReviewFindingDecisionInput[] {
	const commits = new Map(
		checkpoint.commitRefs.map(({ repository, commit }) => [repository, commit]),
	);
	return decisions.map((decision) => {
		if (decision.commitRefs && decision.commitRefs.length > 0)
			throw new Error(
				"decision workflow cannot supply seat-owned commit references",
			);
		const repositories = [
			...new Set(
				(decision.changedPaths ?? []).map(({ repository }) => repository),
			),
		].sort();
		const commitRefs = repositories.map((repository) => {
			const commit = commits.get(repository);
			if (!commit)
				throw new Error(
					`changed decision in ${repository} has no seat checkpoint commit`,
				);
			return { repository, commit };
		});
		return { ...decision, commitRefs };
	});
}

function reviewBoundaries(
	repositories: readonly PreparedWorkflowRepository[],
	implementation: WorkflowPhaseCheckpointResult,
	decision: WorkflowPhaseCheckpointResult,
) {
	const implementationByRepo = new Map(
		implementation.repositories.map((value) => [value.repository, value]),
	);
	const decisionByRepo = new Map(
		decision.repositories.map((value) => [value.repository, value]),
	);
	return repositories.map((repository) => {
		const implementationResult = implementationByRepo.get(repository.key);
		const decisionResult = decisionByRepo.get(repository.key);
		if (!implementationResult || !decisionResult)
			throw new Error(`checkpoint result missing repository ${repository.key}`);
		return {
			repository: repository.key,
			path: repository.worktree,
			expectedBranch: repository.branch,
			implementationHead: implementationResult.finalHead,
			finalHead: decisionResult.finalHead,
		};
	});
}

function assertDecisionCoverage(
	compiled: CompiledDecisionWorkflow,
	decisions: readonly ReviewFindingDecisionInput[],
): void {
	const actual = decisions.map(({ findingId }) => findingId).sort();
	if (
		new Set(actual).size !== actual.length ||
		JSON.stringify(actual) !== JSON.stringify([...compiled.findingIds].sort())
	)
		throw new Error("decision output must exactly cover sanitized findings");
	for (const decision of decisions) {
		if (!decision.reasoning.trim())
			throw new Error(`decision ${decision.findingId} requires reasoning`);
		if (decision.commitRefs && decision.commitRefs.length > 0)
			throw new Error(
				"decision workflow cannot supply seat-owned commit references",
			);
		const changedPaths = decision.changedPaths ?? [];
		if (decision.decision === "changed" && changedPaths.length === 0)
			throw new Error(
				`changed decision ${decision.findingId} requires changed paths`,
			);
		if (decision.decision === "no_change" && changedPaths.length > 0)
			throw new Error(
				`no-change decision ${decision.findingId} cannot name changed paths`,
			);
		if (decision.decision !== "changed" && decision.decision !== "no_change")
			throw new Error(`decision ${decision.findingId} has an invalid outcome`);
	}
}

function exactArtifactPaths(paths: readonly string[]): readonly string[] {
	const resolved = paths.map((path) => {
		if (!isAbsolute(path))
			throw new Error("review artifact path must be absolute");
		if (!existsSync(path) || lstatSync(path).isDirectory())
			throw new Error("review artifact path must name an existing file");
		return realpathSync(path);
	});
	const sorted = [...new Set(resolved)].sort();
	if (sorted.length !== paths.length)
		throw new Error("review artifact paths must be exact and unique");
	return sorted;
}

function hasCompleted(journal: RunnerJournal, phase: WorkflowPlanRunnerPhase) {
	return journal.completedPhases.includes(phase);
}

function atomicPrivateWrite(path: string, payload: string): void {
	const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(temporary, "wx", 0o600);
		writeSync(fd, payload, undefined, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporary, path);
		const directory = openSync(dirname(path), "r");
		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(temporary, { force: true });
	}
}

function canonicalDirectory(path: string, create: boolean): string {
	if (!isAbsolute(path)) throw new Error("state root must be absolute");
	if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
	if (lstatSync(path).isSymbolicLink())
		throw new Error("state root cannot be a symlink");
	return realpathSync(path);
}

function canonicalPath(path: string): string {
	if (!isAbsolute(path)) throw new Error("forbidden root must be absolute");
	return existsSync(path) ? realpathSync(path) : resolve(path);
}

function overlaps(left: string, right: string): boolean {
	const a = resolve(left);
	const b = resolve(right);
	return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}

function assertId(value: string, label: string): void {
	if (!ID.test(value)) throw new Error(`invalid ${label}`);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, child]) => child !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, sortValue(child)]),
		);
	return value;
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
