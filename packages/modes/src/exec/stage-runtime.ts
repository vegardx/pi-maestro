// Generic execution for resolved workflow stages. This is deliberately
// orchestration over agents.v1: all members start from one frozen commit, all
// settle, then the reducer publishes exactly one atomic stage report.

import type {
	AgentsCapabilityV1,
	ResolvedAgentAssignment,
	RunResult,
} from "@vegardx/pi-contracts";
import type { WorkflowStageSpec } from "../schema.js";
import {
	captureCommitCheckpoint,
	renderCommitTarget,
	type CommitCheckpointDeps,
	type CommitTarget,
} from "./commit-target.js";

export interface StageMemberResult {
	readonly assignment: ResolvedAgentAssignment;
	readonly runId: string;
	readonly result?: RunResult;
	readonly valid: boolean;
	readonly error?: string;
}

export interface SettledStageReport {
	readonly stageId: string;
	readonly target: CommitTarget;
	readonly members: readonly StageMemberResult[];
	readonly valid: boolean;
	readonly report: string;
}

export interface ExecuteStageInput {
	readonly stage: WorkflowStageSpec;
	readonly assignments: readonly ResolvedAgentAssignment[];
	readonly agents: AgentsCapabilityV1;
	readonly cwd: string;
	readonly base: string;
	readonly previousHead?: string;
	readonly validate: (
		assignment: ResolvedAgentAssignment,
		result: RunResult | undefined,
	) => { readonly valid: boolean; readonly error?: string };
	readonly reduce: (
		stage: WorkflowStageSpec,
		target: CommitTarget,
		members: readonly StageMemberResult[],
	) => string;
	readonly deliver: (report: SettledStageReport) => void | Promise<void>;
	readonly checkpoint?: Partial<CommitCheckpointDeps>;
}

export async function executeWorkflowStage(
	input: ExecuteStageInput,
): Promise<SettledStageReport> {
	const target = captureCommitCheckpoint(
		{
			cwd: input.cwd,
			base: input.base,
			...(input.previousHead ? { previousHead: input.previousHead } : {}),
		},
		input.checkpoint,
	);
	const byId = new Map(
		input.assignments.map((assignment) => [assignment.agentId, assignment]),
	);
	const selected = input.stage.assignmentIds.map((id) => {
		const assignment = byId.get(id);
		if (!assignment) throw new Error(`unknown stage assignment: ${id}`);
		return assignment;
	});

	// Batch starts all members before any result is awaited. Every prompt carries
	// the same immutable target, not a branch name or live worktree state.
	const runs = await input.agents.batch(
		selected.map((assignment) => ({
			kind: assignment.kind,
			prompt: `${assignment.focus}\n\n${renderCommitTarget(target)}`,
			model: assignment.modelId,
			effort: assignment.effort,
			cwd: input.cwd,
			displayName: assignment.agentId,
			meta: {
				stageId: input.stage.id,
				base: target.base,
				head: target.head,
				...(target.previousHead ? { previousHead: target.previousHead } : {}),
			},
		})),
	);
	const members = await Promise.all(
		runs.map(async (run, index): Promise<StageMemberResult> => {
			const assignment = selected[index] as ResolvedAgentAssignment;
			const result = await input.agents.result(run.runId);
			const checked = input.validate(assignment, result);
			return {
				assignment,
				runId: String(run.runId),
				...(result ? { result } : {}),
				valid: checked.valid,
				...(checked.error ? { error: checked.error } : {}),
			};
		}),
	);
	const valid = members.every((member) => member.valid);
	const settled: SettledStageReport = {
		stageId: input.stage.id,
		target,
		members,
		valid,
		report: input.reduce(input.stage, target, members),
	};
	// One delivery after every member settles. Partial member reports are never
	// published as canonical stage output.
	await input.deliver(settled);
	return settled;
}
