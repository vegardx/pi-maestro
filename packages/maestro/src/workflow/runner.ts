import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkflowSpec, waitForRun } from "@agwab/pi-workflow";
import {
	currentBranch,
	detectDefaultBranch,
	gitToplevel,
	workingTreeClean,
} from "@vegardx/pi-git";
import type { Plan } from "../plan.js";
import {
	type CompiledPlanWorkflow,
	compilePlanWorkflow,
	REVIEW_FINDINGS_SCHEMA,
} from "./plan-compiler.js";

const REVIEW_SCHEMA_SOURCE = fileURLToPath(
	new URL(
		"../../workflow-bundle/schemas/review-findings.schema.json",
		import.meta.url,
	),
);

export interface PlanWorkflowRunResult {
	readonly runId: string;
	readonly status: string;
	readonly compiled: CompiledPlanWorkflow;
}

export function compileStoredPlan(input: {
	readonly cwd: string;
	readonly plan: Plan;
	readonly model: string;
}): CompiledPlanWorkflow {
	const repositories = input.plan.repos.map((repository) => {
		const requested = realpathSync(resolve(input.cwd, repository.path));
		const discovered = gitToplevel(requested);
		const path = discovered ? realpathSync(discovered) : null;
		if (!path || path !== requested)
			throw new Error(
				`repository ${repository.key} must name an exact Git working-tree root`,
			);
		const branch = currentBranch(path);
		const baseBranch = detectDefaultBranch(path);
		if (!branch)
			throw new Error(`repository ${repository.key} has detached HEAD`);
		if (!baseBranch)
			throw new Error(
				`repository ${repository.key} has no detectable base branch`,
			);
		if (!workingTreeClean(path))
			throw new Error(
				`repository ${repository.key} must be clean before workflow launch`,
			);
		return { key: repository.key, path, branch, baseBranch };
	});
	const normalizedPlan: Plan = {
		...input.plan,
		repos: input.plan.repos.map((repository) => ({
			...repository,
			path:
				repositories.find(({ key }) => key === repository.key)?.path ??
				repository.path,
		})),
	};
	return compilePlanWorkflow(normalizedPlan, {
		model: input.model,
		launchCwd: input.cwd,
		repositories,
	});
}

export async function runCompiledPlan(input: {
	readonly cwd: string;
	readonly compiled: CompiledPlanWorkflow;
	readonly timeoutMs?: number;
}): Promise<PlanWorkflowRunResult> {
	const specPath = materializeSpec(input.cwd, input.compiled);
	const started = await runWorkflowSpec(specPath, input.cwd, {
		task: input.compiled.approvalText,
	});
	const terminal = await waitForRun(
		input.cwd,
		started.runId,
		input.timeoutMs ?? 4 * 60 * 60 * 1000,
	);
	return {
		runId: terminal.runId,
		status: terminal.status,
		compiled: input.compiled,
	};
}

function materializeSpec(cwd: string, compiled: CompiledPlanWorkflow): string {
	const encoded = `${JSON.stringify(compiled.workflow, null, 2)}\n`;
	const digest = createHash("sha256").update(encoded).digest("hex");
	const root = join(
		cwd,
		".pi",
		"maestro",
		"workflows",
		`${compiled.planSlug}-${digest.slice(0, 12)}`,
	);
	const specPath = join(root, "spec.json");
	const schemaPath = join(root, REVIEW_FINDINGS_SCHEMA.replace(/^\.\//, ""));
	mkdirSync(dirname(schemaPath), { recursive: true, mode: 0o700 });
	writeFileSync(specPath, encoded, { mode: 0o600 });
	copyFileSync(REVIEW_SCHEMA_SOURCE, schemaPath);
	return specPath;
}
