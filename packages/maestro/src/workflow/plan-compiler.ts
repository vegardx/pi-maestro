import { isAbsolute } from "node:path";
import type { ArtifactGraphWorkflowSpec } from "@agwab/pi-workflow";
import type { Plan, Task } from "../plan.js";
import { validatePlan } from "../plan.js";

export const REVIEW_FINDINGS_SCHEMA = "./schemas/review-findings.schema.json";

export interface PlanCompilerOptions {
	readonly model: string;
	readonly launchCwd: string;
	readonly repositories: readonly {
		readonly key: string;
		readonly path: string;
		readonly branch: string;
		readonly baseBranch: string;
	}[];
}

export interface CompiledPlanWorkflow {
	readonly planSlug: string;
	readonly workflow: ArtifactGraphWorkflowSpec;
	readonly approvalText: string;
	readonly repositories: PlanCompilerOptions["repositories"];
}

/** Compile authored intent into one ordinary pi-workflow workflow. */
export function compilePlanWorkflow(
	plan: Plan,
	options: PlanCompilerOptions,
): CompiledPlanWorkflow {
	assertCompilable(plan, options);
	const repositories = new Map(
		options.repositories.map((repository) => [repository.key, repository]),
	);
	const deliverables = new Map(
		plan.deliverables.map((deliverable) => [deliverable.id, deliverable]),
	);
	const implementationIds = new Map(
		plan.deliverables.map((deliverable) => [
			deliverable.id,
			stageName(deliverable.id, "implement"),
		]),
	);
	const stages: ArtifactGraphWorkflowSpec["artifactGraph"]["stages"] = [];
	const reviewIdsByRepository = new Map<string, string[]>();
	const previousInRepository = new Map<string, string>();

	for (const deliverable of plan.deliverables) {
		const repositoryKey = deliverable.repo ?? (plan.repos[0]?.key as string);
		const repository = repositories.get(repositoryKey);
		if (!repository)
			throw new Error(`unknown repository for ${deliverable.id}`);
		const implementationId = implementationIds.get(deliverable.id) as string;
		const after = new Set(
			deliverable.after.map(
				(dependency) => implementationIds.get(dependency) as string,
			),
		);
		const previous = previousInRepository.get(repositoryKey);
		if (previous) after.add(previous);
		stages.push({
			id: implementationId,
			type: "single",
			model: options.model,
			readOnly: false,
			worktreePolicy: "off",
			tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
			...(after.size > 0 ? { after: [...after] } : {}),
			prompt: implementationPrompt(
				deliverable,
				repository.path,
				(dependency) => {
					const predecessor = deliverables.get(dependency);
					if (!predecessor) throw new Error(`unknown dependency ${dependency}`);
					const key = predecessor.repo ?? (plan.repos[0]?.key as string);
					const dependencyRepository = repositories.get(key);
					if (!dependencyRepository)
						throw new Error(`unknown dependency repository ${dependency}`);
					return dependencyRepository.path;
				},
			),
		});
		previousInRepository.set(repositoryKey, implementationId);
	}

	for (const deliverable of plan.deliverables) {
		const repositoryKey = deliverable.repo ?? (plan.repos[0]?.key as string);
		const repository = repositories.get(repositoryKey) as NonNullable<
			ReturnType<typeof repositories.get>
		>;
		const reviewIds: string[] = [];
		for (const task of deliverable.tasks.filter((candidate) => candidate.by)) {
			if (!task.by) continue;
			const reviewId = stageName(deliverable.id, "review", task.id);
			reviewIds.push(reviewId);
			stages.push({
				id: reviewId,
				type: "single",
				after: previousInRepository.get(repositoryKey) as string,
				model: task.by.model,
				readOnly: true,
				worktreePolicy: "off",
				tools: ["read", "grep", "find", "ls"],
				output: { controlSchema: REVIEW_FINDINGS_SCHEMA },
				prompt: reviewPrompt(task, repositoryKey, repository.path),
			});
		}
		const collected = reviewIdsByRepository.get(repositoryKey) ?? [];
		collected.push(...reviewIds);
		reviewIdsByRepository.set(repositoryKey, collected);
	}

	for (const repository of options.repositories) {
		const reviewIds = reviewIdsByRepository.get(repository.key) ?? [];
		if (reviewIds.length === 0) continue;
		const repositoryDeliverables = plan.deliverables.filter(
			(deliverable) =>
				(deliverable.repo ?? plan.repos[0]?.key) === repository.key,
		);
		stages.push({
			id: stageName(repository.key, "fix"),
			type: "reduce",
			from: reviewIds,
			model: options.model,
			readOnly: false,
			worktreePolicy: "off",
			tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
			prompt: fixerPrompt(repositoryDeliverables, repository.path),
		});
	}

	assertUniqueStageNames(stages.map(({ id }) => id));
	return {
		planSlug: plan.slug,
		workflow: {
			schemaVersion: 1,
			name: plan.slug,
			description: plan.title,
			defaults: { readOnly: false },
			artifactGraph: {
				maxConcurrency: Math.max(1, stages.length),
				stages,
			},
		},
		approvalText: renderApproval(plan, options),
		repositories: options.repositories.map((repository) => ({ ...repository })),
	};
}

function assertCompilable(plan: Plan, options: PlanCompilerOptions): void {
	const errors = validatePlan(plan);
	if (!isAbsolute(options.launchCwd))
		errors.push("launch cwd must be absolute");
	if (!/^\S+\/\S+$/.test(options.model))
		errors.push("model must be a concrete provider/model ID");
	const authoredKeys = [...plan.repos.map(({ key }) => key)].sort();
	const resolvedKeys = [...options.repositories.map(({ key }) => key)].sort();
	if (JSON.stringify(authoredKeys) !== JSON.stringify(resolvedKeys))
		errors.push("repository registry must exactly cover authored keys");
	const authoredRepositories = new Map(
		plan.repos.map((repo) => [repo.key, repo]),
	);
	for (const repository of options.repositories) {
		if (!isAbsolute(repository.path))
			errors.push(`repository ${repository.key} path must be absolute`);
		if (!repository.branch.trim() || !repository.baseBranch.trim())
			errors.push(`repository ${repository.key} branch metadata is incomplete`);
		if (repository.branch === repository.baseBranch)
			errors.push(`repository ${repository.key} must be on a feature branch`);
		if (authoredRepositories.get(repository.key)?.path !== repository.path)
			errors.push(
				`repository ${repository.key} path does not match authored path`,
			);
	}
	for (const deliverable of plan.deliverables)
		if (!deliverable.tasks.some((task) => !task.by))
			errors.push(`${deliverable.id}: no implementation task`);
	if (errors.length > 0)
		throw new Error(
			`cannot compile plan:\n${errors.map((error) => `- ${error}`).join("\n")}`,
		);
}

function implementationPrompt(
	deliverable: Plan["deliverables"][number],
	repositoryPath: string,
	dependencyPath: (deliverableId: string) => string,
): string {
	const reads =
		deliverable.reads.length > 0
			? `Read predecessor work only from: ${deliverable.reads.map((id) => `${id} at ${dependencyPath(id)}`).join(", ")}.`
			: undefined;
	return [
		`Implement deliverable ${deliverable.id}: ${deliverable.title}`,
		`Repository path: ${repositoryPath}`,
		"Work only in that repository. Preserve unrelated changes.",
		reads,
		...(deliverable.body ? [deliverable.body] : []),
		...deliverable.tasks
			.filter((task) => !task.by)
			.map(
				(task, index) =>
					`${index + 1}. ${task.title}${task.body ? `\n${task.body}` : ""}`,
			),
		"Run the repository's focused validation.",
		"Commit your implementation on the current feature branch with a conventional commit message. Do not amend existing commits, push, or create a pull request.",
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
		`Review through the ${task.by.lens} lens: ${task.title}`,
		`Repository key: ${repositoryKey}`,
		`Repository path: ${repositoryPath}`,
		"Inspect the committed implementation on the current feature branch. Do not modify files or commits.",
		...(task.body ? [task.body] : []),
		"For every evidence-backed finding, include a concise suggested change. Suggestions are advisory; the fixer decides whether to apply them.",
		"Return findings in the control findings array.",
	].join("\n");
}

function fixerPrompt(
	deliverables: readonly Plan["deliverables"][number][],
	repositoryPath: string,
): string {
	return [
		`Resolve review findings for: ${deliverables.map(({ id, title }) => `${id} (${title})`).join(", ")}`,
		`Repository path: ${repositoryPath}`,
		"Read every upstream review artifact. Evaluate each finding and suggestion independently.",
		"Apply justified fixes and leave unjustified suggestions unchanged.",
		"Run focused validation after changes.",
		"If files changed, create a new conventional follow-up commit. Do not amend implementation commits, push, or create a pull request.",
		"In the final analysis, state which findings changed and which were declined with reasons.",
	].join("\n\n");
}

function renderApproval(plan: Plan, options: PlanCompilerOptions): string {
	const reviewers = plan.deliverables.flatMap((deliverable) =>
		deliverable.tasks.flatMap((task) =>
			task.by
				? [
						`${deliverable.id}/${task.id}: ${task.by.lens} with ${task.by.model}${task.by.skill ? ` using ${task.by.skill}` : ""}`,
					]
				: [],
		),
	);
	return [
		`Run plan ${plan.slug}: ${plan.title}`,
		"",
		"Repositories:",
		...options.repositories.map(
			(repository) =>
				`- ${repository.key}: ${repository.path}; ${repository.branch} -> ${repository.baseBranch}`,
		),
		"",
		`Implementer/fixer model: ${options.model}`,
		"Reviewers:",
		...(reviewers.length > 0
			? reviewers.map((reviewer) => `- ${reviewer}`)
			: ["- none"]),
		"",
		"Authority: implementers and fixers edit, validate, and commit locally; reviewers are read-only; only the interactive seat publishes branches and pull requests.",
	].join("\n");
}

function stageName(...parts: string[]): string {
	const name = parts.join("--");
	if (!/^[A-Za-z0-9_-]+$/.test(name) || name.length > 127)
		throw new Error(`joined workflow stage name is unsafe: ${name}`);
	return name;
}

function assertUniqueStageNames(names: readonly string[]): void {
	if (new Set(names).size !== names.length)
		throw new Error("joined workflow stage names must be unique");
}
