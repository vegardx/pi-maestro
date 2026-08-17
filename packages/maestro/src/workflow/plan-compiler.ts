import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { ArtifactGraphWorkflowSpec } from "@agwab/pi-workflow";
import type { Plan, Task } from "../plan.js";
import { validatePlan } from "../plan.js";
import type { SanitizedFinding } from "./private-artifacts.js";
import type {
	RepositoryReviewBoundaryInput,
	ReviewFindingDecisionInput,
	SealReviewDecisionLedgerInput,
} from "./review-decision-ledger.js";
import type { ApprovedReviewerTask } from "./review-findings.js";

export const REVIEW_FINDINGS_SCHEMA = "./schemas/review-findings.schema.json";
export const REVIEW_DECISIONS_SCHEMA = "./schemas/review-decisions.schema.json";
export const WORKFLOW_CONTROL_SCHEMA_ASSETS = [
	{
		ref: REVIEW_FINDINGS_SCHEMA,
		sourcePath: fileURLToPath(
			new URL(
				"../../workflow-bundle/schemas/review-findings.schema.json",
				import.meta.url,
			),
		),
	},
	{
		ref: REVIEW_DECISIONS_SCHEMA,
		sourcePath: fileURLToPath(
			new URL(
				"../../workflow-bundle/schemas/review-decisions.schema.json",
				import.meta.url,
			),
		),
	},
] as const;

export interface PlanCompilerOptions {
	readonly implementationModel: string;
	readonly decisionModel: string;
	/** The coordinated umbrella cwd used by every package stage. */
	readonly coordinatedCwd: string;
	/** Seat-resolved worktrees. Keys must exactly cover the authored repositories. */
	readonly repositories: readonly {
		readonly key: string;
		readonly sourceRoot: string;
		readonly worktree: string;
		readonly branch: string;
		readonly baseBranch: string;
		readonly baseSha: string;
	}[];
	/** Optional approval-only labels; never compiled as Pi agent names. */
	readonly routingLabels?: {
		readonly implementation?: string;
		readonly decision?: string;
	};
}

export interface ReviewerRegistryIntent {
	readonly stageId: string;
	readonly lens: string;
	readonly approvedModel: string;
	readonly skill?: string;
}

export interface ReviewerRuntimeTask {
	readonly stageId: string;
	readonly taskId: string;
	readonly resolvedModel: string;
}

export interface PlanApprovalSummary {
	readonly repositories: readonly {
		readonly key: string;
		readonly sourceRoot: string;
		readonly worktree: string;
		readonly branch: string;
		readonly baseBranch: string;
		readonly baseSha: string;
	}[];
	readonly dag: readonly {
		readonly deliverable: string;
		readonly repository: string;
		readonly after: readonly string[];
		readonly reads: readonly string[];
	}[];
	readonly reviewers: readonly ReviewerRegistryIntent[];
	readonly seatTasks: {
		readonly preflight: readonly {
			readonly id: string;
			readonly title: string;
		}[];
		readonly postflight: readonly {
			readonly id: string;
			readonly title: string;
		}[];
	};
	readonly approvedExecution: {
		readonly implementationModel: string;
		readonly decisionModel: string;
		readonly implementationRoutingLabel?: string;
		readonly decisionRoutingLabel?: string;
	};
	readonly authority: {
		readonly workflowAgents: "edit-without-git-authority";
		readonly reviewers: "read-only";
		readonly commitsAndShipping: "seat-only";
	};
	readonly disclosure: {
		readonly implementer: "sanitized-findings-only";
		readonly provenance: "seat-private";
		readonly pullRequest: "intent-rationale-and-changes-no-review-provenance";
	};
}

export interface CompiledPlanWorkflow {
	readonly planSlug: string;
	readonly implementationWorkflow: ArtifactGraphWorkflowSpec;
	readonly reviewPhase:
		| {
				readonly status: "required";
				readonly workflow: ArtifactGraphWorkflowSpec;
		  }
		| { readonly status: "skipped-no-reviewers" };
	readonly reviewerRegistryIntents: readonly ReviewerRegistryIntent[];
	readonly seat: {
		readonly launchCwd: string;
		readonly preflight: readonly Task[];
		readonly afterImplementation: {
			readonly checkpointer: "WorkflowPhaseCheckpointer";
			readonly phase: "implementation";
		};
		readonly reviewHandoff: {
			readonly normalizer: "normalizeRawReviewFindings";
			readonly privateStore: "PrivateArtifactStore";
			readonly submissionArtifact: {
				readonly artifact: "control";
				readonly path: "$.findings";
			};
			readonly implementerProjection: "sanitizedFindings";
		};
		readonly afterDecision: {
			readonly checkpointer: "WorkflowPhaseCheckpointer";
			readonly phase: "decision";
		};
		readonly decisionGate: {
			readonly store: "ReviewDecisionLedgerStore";
			readonly enrichment: "seat-adds-commit-refs-after-commit";
			readonly requiredDecisions: "exactly-one-per-finding";
			readonly commitLineage: "implementation-head-to-final-head";
		};
		readonly postflight: readonly Task[];
	};
	readonly approval: PlanApprovalSummary;
	readonly approvalText: string;
}

export interface CompiledDecisionWorkflow {
	readonly workflow: ArtifactGraphWorkflowSpec;
	readonly findingIds: readonly string[];
	readonly decisionArtifact: {
		readonly stageId: string;
		readonly artifact: "control";
		readonly path: "$.decisions";
	};
}

/** Compile authored intent into separately approved flat package phases. */
export function compilePlanWorkflow(
	plan: Plan,
	options: PlanCompilerOptions,
): CompiledPlanWorkflow {
	assertCompilable(plan, options);
	const repos = new Map(options.repositories.map((repo) => [repo.key, repo]));
	const deliverables = new Map(
		plan.deliverables.map((item) => [item.id, item]),
	);
	const implementationIds = new Map(
		plan.deliverables.map((deliverable) => [
			deliverable.id,
			stageName(deliverable.id, "implement"),
		]),
	);
	const previousInRepo = new Map<string, string>();
	const implementationStages: ArtifactGraphWorkflowSpec["artifactGraph"]["stages"] =
		[];
	const reviewStages: ArtifactGraphWorkflowSpec["artifactGraph"]["stages"] = [];
	const reviewerRegistryIntents: ReviewerRegistryIntent[] = [];

	for (const deliverable of plan.deliverables) {
		const repoKey = deliverable.repo ?? (plan.repos[0]?.key as string);
		const repo = repos.get(repoKey);
		if (!repo) throw new Error(`unknown repository for ${deliverable.id}`);
		const id = implementationIds.get(deliverable.id) as string;
		const after = new Set(
			deliverable.after.map(
				(dependency) => implementationIds.get(dependency) as string,
			),
		);
		const prior = previousInRepo.get(repoKey);
		if (prior) after.add(prior);
		implementationStages.push({
			id,
			type: "single",
			model: options.implementationModel,
			readOnly: false,
			worktreePolicy: "off",
			...(after.size > 0 ? { after: [...after] } : {}),
			prompt: implementationPrompt(deliverable, repo.worktree, (dependency) => {
				const predecessor = deliverables.get(dependency);
				if (!predecessor) throw new Error(`unknown dependency ${dependency}`);
				const dependencyRepo = repos.get(
					predecessor.repo ?? (plan.repos[0]?.key as string),
				);
				if (!dependencyRepo)
					throw new Error(`unknown dependency repository ${dependency}`);
				return dependencyRepo.worktree;
			}),
		});
		previousInRepo.set(repoKey, id);

		for (const task of deliverable.tasks.filter((candidate) => candidate.by)) {
			if (!task.by) continue;
			const stageId = stageName(deliverable.id, "review", task.id);
			reviewStages.push({
				id: stageId,
				type: "single",
				after: [],
				model: task.by.model,
				readOnly: true,
				worktreePolicy: "off",
				output: { controlSchema: REVIEW_FINDINGS_SCHEMA },
				prompt: reviewPrompt(task, repo.key, repo.worktree),
			});
			reviewerRegistryIntents.push({
				stageId,
				lens: task.by.lens,
				approvedModel: task.by.model,
				...(task.by.skill ? { skill: task.by.skill } : {}),
			});
		}
	}
	assertUniqueStageNames([
		...implementationStages.map(({ id }) => id),
		...reviewStages.map(({ id }) => id),
	]);
	const implementationWorkflow = workflow(
		`${plan.slug}-implementation`,
		plan.title,
		false,
		implementationStages,
	);
	const reviewPhase =
		reviewStages.length === 0
			? ({ status: "skipped-no-reviewers" } as const)
			: ({
					status: "required",
					workflow: workflow(
						`${plan.slug}-review`,
						`Independent review of ${plan.title}`,
						true,
						reviewStages,
					),
				} as const);
	const approval = approvalSummary(plan, reviewerRegistryIntents, options);
	return {
		planSlug: plan.slug,
		implementationWorkflow,
		reviewPhase,
		reviewerRegistryIntents,
		seat: {
			launchCwd: options.coordinatedCwd,
			preflight: [...plan.preflight],
			afterImplementation: {
				checkpointer: "WorkflowPhaseCheckpointer",
				phase: "implementation",
			},
			reviewHandoff: {
				normalizer: "normalizeRawReviewFindings",
				privateStore: "PrivateArtifactStore",
				submissionArtifact: { artifact: "control", path: "$.findings" },
				implementerProjection: "sanitizedFindings",
			},
			afterDecision: {
				checkpointer: "WorkflowPhaseCheckpointer",
				phase: "decision",
			},
			decisionGate: {
				store: "ReviewDecisionLedgerStore",
				enrichment: "seat-adds-commit-refs-after-commit",
				requiredDecisions: "exactly-one-per-finding",
				commitLineage: "implementation-head-to-final-head",
			},
			postflight: [...plan.postflight],
		},
		approval,
		approvalText: renderApprovalSummary(plan, approval),
	};
}

/** Bind package runtime task IDs and actual resolutions to approved author intent. */
export function bindReviewerRegistry(
	compiled: CompiledPlanWorkflow,
	runtimeTasks: readonly ReviewerRuntimeTask[],
): readonly ApprovedReviewerTask[] {
	const intents = new Map(
		compiled.reviewerRegistryIntents.map((intent) => [intent.stageId, intent]),
	);
	if (runtimeTasks.length !== intents.size)
		throw new Error(
			"runtime reviewer tasks must exactly cover approved stages",
		);
	const seenStages = new Set<string>();
	const seenTasks = new Set<string>();
	const runtimeByStage = new Map(
		runtimeTasks.map((task) => [task.stageId, task]),
	);
	if (runtimeByStage.size !== runtimeTasks.length)
		throw new Error("duplicate runtime reviewer stage");
	const approvedReviewerTasks: ApprovedReviewerTask[] = [];
	for (const intent of compiled.reviewerRegistryIntents) {
		const task = runtimeByStage.get(intent.stageId);
		if (!task)
			throw new Error(`missing runtime reviewer stage ${intent.stageId}`);
		if (seenStages.has(task.stageId) || seenTasks.has(task.taskId))
			throw new Error("duplicate runtime reviewer identity");
		if (!task.taskId.trim() || !task.resolvedModel.trim())
			throw new Error("runtime reviewer identity is incomplete");
		if (task.resolvedModel !== intent.approvedModel)
			throw new Error(
				`runtime reviewer ${task.stageId} resolved ${task.resolvedModel}, expected approved model ${intent.approvedModel}`,
			);
		seenStages.add(task.stageId);
		seenTasks.add(task.taskId);
		approvedReviewerTasks.push({
			lens: intent.lens,
			stageId: task.stageId,
			taskId: task.taskId,
			resolvedModel: task.resolvedModel,
		});
	}
	return approvedReviewerTasks;
}

/** Build the final flat phase from the production normalizer's public projection. */
export function compileDecisionWorkflow(
	plan: Plan,
	options: PlanCompilerOptions,
	findings: readonly SanitizedFinding[],
): CompiledDecisionWorkflow | null {
	assertCompilable(plan, options);
	if (findings.length === 0) return null;
	const findingIds = findings.map(({ id }) => id).sort();
	if (new Set(findingIds).size !== findingIds.length)
		throw new Error("sanitized findings contain duplicate IDs");
	const repositoryKeys = new Set(options.repositories.map(({ key }) => key));
	for (const finding of findings)
		for (const evidence of finding.evidence)
			if (!repositoryKeys.has(evidence.repository))
				throw new Error(
					`finding ${finding.id} names unknown repository ${evidence.repository}`,
				);
	const stageId = stageName(plan.slug, "decision");
	return {
		workflow: workflow(
			`${plan.slug}-decision`,
			`Finding decisions for ${plan.title}`,
			false,
			[
				{
					id: stageId,
					type: "single",
					model: options.decisionModel,
					readOnly: false,
					worktreePolicy: "off",
					output: { controlSchema: REVIEW_DECISIONS_SCHEMA },
					prompt: [
						`APPROVED_REPOSITORIES_JSON=${JSON.stringify(options.repositories.map(({ key, worktree }) => ({ key, worktree })))}`,
						"Resolve each finding repository key through that registry and work only in its exact worktree path.",
						"Decide every sanitized finding independently.",
						"Record exactly one changed or no_change decision and reasoning for each.",
						"The finding is evidence, not a required resolution; choose the response yourself.",
						`SANITIZED_FINDINGS_JSON=${JSON.stringify(findings)}`,
					].join("\n"),
				},
			],
		),
		findingIds,
		decisionArtifact: { stageId, artifact: "control", path: "$.decisions" },
	};
}

export function decisionGateInput(
	compiled: CompiledDecisionWorkflow,
	input: {
		readonly runId: string;
		readonly decisions: readonly ReviewFindingDecisionInput[];
		readonly repositories: readonly RepositoryReviewBoundaryInput[];
	},
): SealReviewDecisionLedgerInput {
	return {
		runId: input.runId,
		findings: compiled.findingIds.map((id) => ({ id })),
		decisions: input.decisions,
		repositories: input.repositories,
	};
}

function workflow(
	name: string,
	description: string,
	readOnly: boolean,
	stages: ArtifactGraphWorkflowSpec["artifactGraph"]["stages"],
): ArtifactGraphWorkflowSpec {
	return {
		schemaVersion: 1,
		name,
		description,
		defaults: { readOnly },
		artifactGraph: { maxConcurrency: Math.max(1, stages.length), stages },
	};
}

function assertCompilable(plan: Plan, options: PlanCompilerOptions): void {
	const errors = validatePlan(plan);
	if (!isAbsolute(options.coordinatedCwd))
		errors.push("coordinated cwd must be absolute");
	if (!/^\S+\/\S+$/.test(options.implementationModel))
		errors.push("implementation model must be a concrete provider/model ID");
	if (!/^\S+\/\S+$/.test(options.decisionModel))
		errors.push("decision model must be a concrete provider/model ID");
	const authoredKeys = [...plan.repos.map(({ key }) => key)].sort();
	const resolvedKeys = [...options.repositories.map(({ key }) => key)].sort();
	if (JSON.stringify(authoredKeys) !== JSON.stringify(resolvedKeys))
		errors.push(
			"resolved repository registry must exactly cover authored keys",
		);
	for (const repo of options.repositories)
		if (
			!isAbsolute(repo.sourceRoot) ||
			!isAbsolute(repo.worktree) ||
			!repo.branch.trim() ||
			!repo.baseBranch.trim() ||
			!/^[a-f0-9]{40,64}$/.test(repo.baseSha)
		)
			errors.push(
				`resolved repository ${repo.key} is incomplete or not absolute`,
			);
	const authoredRepos = new Map(plan.repos.map((repo) => [repo.key, repo]));
	for (const repo of options.repositories)
		if (authoredRepos.get(repo.key)?.path !== repo.sourceRoot)
			errors.push(
				`resolved repository ${repo.key} source root does not match the authored path`,
			);
	for (const [phase, tasks] of [
		["preflight", plan.preflight],
		["postflight", plan.postflight],
	] as const)
		if (tasks.some((task) => task.by))
			errors.push(
				`${phase}: delegated reviews are only valid inside deliverables`,
			);
	for (const deliverable of plan.deliverables)
		if (!deliverable.tasks.some((task) => !task.by))
			errors.push(`${deliverable.id}: no implementation task`);
	if (errors.length > 0)
		throw new Error(
			`cannot compile plan:\n${errors.map((e) => `- ${e}`).join("\n")}`,
		);
}

function stageName(...parts: string[]): string {
	const name = parts.join("--");
	if (!/^[A-Za-z0-9_-]+$/.test(name) || name.length > 127)
		throw new Error(`joined workflow stage name is unsafe: ${name}`);
	return name;
}

function assertUniqueStageNames(names: readonly string[]): void {
	const seen = new Set<string>();
	for (const name of names) {
		if (seen.has(name))
			throw new Error(`joined workflow stage name collides: ${name}`);
		seen.add(name);
	}
}

function implementationPrompt(
	deliverable: Plan["deliverables"][number],
	repositoryPath: string,
	dependencyPath: (deliverableId: string) => string,
): string {
	const reads =
		deliverable.reads.length > 0
			? `Read only these predecessor handoffs: ${deliverable.reads.map((id) => `${id} at ${dependencyPath(id)}`).join(", ")}.`
			: undefined;
	return [
		`Implement deliverable ${deliverable.id}: ${deliverable.title}`,
		`Approved repository/worktree path: ${repositoryPath}`,
		"Make all file operations in that exact path. Do not commit or ship.",
		reads,
		...(deliverable.body ? [deliverable.body] : []),
		...deliverable.tasks
			.filter((task) => !task.by)
			.map(
				(task, index) =>
					`${index + 1}. ${task.title}${task.body ? `\n${task.body}` : ""}`,
			),
	]
		.filter((line): line is string => line !== undefined)
		.join("\n\n");
}

function reviewPrompt(
	task: Task,
	repositoryKey: string,
	repositoryPath: string,
): string {
	if (!task.by) throw new Error("review prompt requires delegated work");
	return [
		...(task.by.skill ? [`Use the available ${task.by.skill} skill.`] : []),
		`Review only through the ${task.by.lens} lens: ${task.title}`,
		`Use repository key ${repositoryKey} in every evidence item.`,
		`Approved repository/worktree path: ${repositoryPath}`,
		"Inspect that exact path. It contains the seat-committed implementation checkpoint.",
		...(task.body ? [task.body] : []),
		"Report evidence-backed claims only. Do not prescribe or require a resolution.",
		"Return them in the findings control array.",
	].join("\n");
}

function approvalSummary(
	plan: Plan,
	reviewers: readonly ReviewerRegistryIntent[],
	options: PlanCompilerOptions,
): PlanApprovalSummary {
	return {
		repositories: options.repositories.map((repo) => ({ ...repo })),
		dag: plan.deliverables.map((deliverable) => ({
			deliverable: deliverable.id,
			repository: deliverable.repo ?? (plan.repos[0]?.key as string),
			after: [...deliverable.after],
			reads: [...deliverable.reads],
		})),
		reviewers,
		seatTasks: {
			preflight: plan.preflight.map(({ id, title }) => ({ id, title })),
			postflight: plan.postflight.map(({ id, title }) => ({ id, title })),
		},
		approvedExecution: {
			implementationModel: options.implementationModel,
			decisionModel: options.decisionModel,
			...(options.routingLabels?.implementation
				? { implementationRoutingLabel: options.routingLabels.implementation }
				: {}),
			...(options.routingLabels?.decision
				? { decisionRoutingLabel: options.routingLabels.decision }
				: {}),
		},
		authority: {
			workflowAgents: "edit-without-git-authority",
			reviewers: "read-only",
			commitsAndShipping: "seat-only",
		},
		disclosure: {
			implementer: "sanitized-findings-only",
			provenance: "seat-private",
			pullRequest: "intent-rationale-and-changes-no-review-provenance",
		},
	};
}

function renderApprovalSummary(
	plan: Plan,
	approval: PlanApprovalSummary,
): string {
	return [
		`Approve workflow \`${plan.slug}\` — ${plan.title}`,
		"",
		"Repositories:",
		...approval.repositories.map(
			(repo) =>
				`- ${repo.key}: worktree ${repo.worktree}; source ${repo.sourceRoot}; branch ${repo.branch}; base branch ${repo.baseBranch}; base commit ${repo.baseSha}`,
		),
		"",
		"DAG:",
		...approval.dag.map(
			(node) =>
				`- ${node.deliverable} (${node.repository}); after: ${node.after.join(", ") || "none"}; reads: ${node.reads.join(", ") || "none"}`,
		),
		"",
		"Approved review cohort (runtime identity must match):",
		...(approval.reviewers.length > 0
			? approval.reviewers.map(
					(review) =>
						`- ${review.lens}: ${review.approvedModel}${review.skill ? `; skill: ${review.skill}` : ""}`,
				)
			: ["- skipped: no reviewers authored"]),
		"",
		"Seat tasks:",
		...(approval.seatTasks.preflight.length > 0
			? approval.seatTasks.preflight.map(
					(task) => `- preflight ${task.id}: ${task.title}`,
				)
			: ["- preflight: none"]),
		...(approval.seatTasks.postflight.length > 0
			? approval.seatTasks.postflight.map(
					(task) => `- postflight ${task.id}: ${task.title}`,
				)
			: ["- postflight: none"]),
		"",
		`Approved implementation model: ${approval.approvedExecution.implementationModel}`,
		`Approved decision model: ${approval.approvedExecution.decisionModel}`,
		"Authority: workflow implementers edit without Git authority; reviewers are read-only; only the seat commits and ships.",
		"Disclosure: implementers receive sanitized findings only. Reviewer provenance stays seat-private and is excluded from pull requests.",
	].join("\n");
}
