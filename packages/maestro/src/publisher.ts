import {
	currentBranch,
	detectDefaultBranch,
	headSha,
	isAncestor,
	pushBranch,
	revParse,
	workingTreeClean,
} from "@vegardx/pi-git";
import { createPr, editPr, findOpenPr } from "@vegardx/pi-github";
import type { Plan } from "./plan.js";

export interface PublisherOperations {
	currentBranch(cwd: string): string | null;
	detectDefaultBranch(cwd: string): string | null;
	workingTreeClean(cwd: string): boolean;
	headSha(cwd: string): string | null;
	revParse(cwd: string, ref: string): string | null;
	isAncestor(cwd: string, ref: string): boolean;
	pushBranch(cwd: string, branch: string): ReturnType<typeof pushBranch>;
	findOpenPr(cwd: string, branch: string): ReturnType<typeof findOpenPr>;
	createPr(
		cwd: string,
		args: Parameters<typeof createPr>[1],
	): ReturnType<typeof createPr>;
	editPr(
		cwd: string,
		number: number,
		args: Parameters<typeof editPr>[2],
	): ReturnType<typeof editPr>;
}

const DEFAULT_OPERATIONS: PublisherOperations = {
	currentBranch,
	detectDefaultBranch,
	workingTreeClean,
	headSha,
	revParse,
	isAncestor,
	pushBranch,
	findOpenPr,
	createPr,
	editPr,
};

export interface PublishedRepository {
	readonly key: string;
	readonly branch: string;
	readonly url: string;
}

export async function publishPlan(input: {
	readonly plan: Plan;
	readonly repositories: readonly {
		readonly key: string;
		readonly path: string;
		readonly branch: string;
	}[];
	readonly operations?: PublisherOperations;
}): Promise<readonly PublishedRepository[]> {
	const operations = input.operations ?? DEFAULT_OPERATIONS;
	const published: PublishedRepository[] = [];
	for (const repository of input.repositories) {
		const branch = operations.currentBranch(repository.path);
		const base = operations.detectDefaultBranch(repository.path);
		if (!branch || !base)
			throw new Error(
				`${repository.key}: branch or default branch is unavailable`,
			);
		if (branch !== repository.branch)
			throw new Error(
				`${repository.key}: checked-out branch changed after workflow completion`,
			);
		if (branch === base)
			throw new Error(
				`${repository.key}: refusing to publish the default branch`,
			);
		if (!operations.workingTreeClean(repository.path))
			throw new Error(`${repository.key}: working tree is not clean`);
		const head = operations.headSha(repository.path);
		const baseSha = operations.revParse(repository.path, `origin/${base}`);
		if (!head || !baseSha || head === baseSha)
			throw new Error(`${repository.key}: branch has no commits to publish`);
		if (!operations.isAncestor(repository.path, `origin/${base}`))
			throw new Error(
				`${repository.key}: branch is not based on origin/${base}`,
			);
		const pushed = await operations.pushBranch(repository.path, branch);
		if (!pushed.ok)
			throw new Error(
				`${repository.key}: push failed: ${pushed.stderr.trim() || pushed.exitCode}`,
			);
		const copy = pullRequestCopy(input.plan, repository.key);
		const existing = await operations.findOpenPr(repository.path, branch);
		if (existing.error) throw new Error(`${repository.key}: ${existing.error}`);
		let url: string | null;
		if (existing.pr) {
			const edited = await operations.editPr(
				repository.path,
				existing.pr.number,
				{
					title: copy.title,
					body: copy.body,
					base,
				},
			);
			if (!edited.ok)
				throw new Error(
					`${repository.key}: ${edited.error ?? "PR update failed"}`,
				);
			url = existing.pr.url;
		} else {
			const created = await operations.createPr(repository.path, {
				title: copy.title,
				body: copy.body,
				base,
			});
			if (created.error || !created.url)
				throw new Error(
					`${repository.key}: ${created.error ?? "PR creation returned no URL"}`,
				);
			url = created.url;
		}
		published.push({ key: repository.key, branch, url });
	}
	return published;
}

function pullRequestCopy(
	plan: Plan,
	repositoryKey: string,
): { readonly title: string; readonly body: string } {
	const deliverables = plan.deliverables.filter(
		(deliverable) => (deliverable.repo ?? plan.repos[0]?.key) === repositoryKey,
	);
	const changes = deliverables.flatMap((deliverable) =>
		deliverable.tasks
			.filter((task) => !task.by)
			.map((task) => `- ${task.title}`),
	);
	const rationale = deliverables
		.map((deliverable) => deliverable.body)
		.filter((body): body is string => Boolean(body?.trim()));
	if (changes.length === 0)
		throw new Error(`${repositoryKey}: plan has no implementation changes`);
	return {
		title: plan.title,
		body: [
			"## Intent",
			`Implement the approved \`${plan.slug}\` plan for ${repositoryKey}.`,
			...(rationale.length > 0 ? ["", "## Rationale", ...rationale] : []),
			"",
			"## Changes",
			...changes,
		].join("\n"),
	};
}
