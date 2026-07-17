import {
	type AgentKind,
	canonicalTokenSnapshot,
	type ResolvedAgentAssignment,
	type StructuredFinding,
	type TokenSnapshot,
} from "@vegardx/pi-contracts";

/** Durable schema for PR provenance. Bump on incompatible changes. */
export const WORKFLOW_ANALYTICS_VERSION = 1 as const;

export type AnalyticsStatus = "pending" | "running" | "succeeded" | "failed";

export interface WorkflowStageAnalytics {
	readonly stageId: string;
	readonly inputSha: string;
	readonly outputSha?: string;
	readonly status: AnalyticsStatus;
	readonly startedAt: string;
	readonly completedAt?: string;
}

export interface AssignmentAnalytics {
	readonly assignmentId: string;
	readonly stageId: string;
	readonly kind: AgentKind;
	readonly modelId: string;
	readonly effort?: string;
	readonly runId?: string;
	readonly inputSha: string;
	readonly outputSha?: string;
	readonly status: AnalyticsStatus;
	readonly startedAt: string;
	readonly completedAt?: string;
	/** Bounded references or conclusions only; never prompts or transcripts. */
	readonly evidence?: readonly string[];
	/** Cumulative totals for this one run/counter lifetime. */
	readonly usage?: TokenSnapshot;
}

/** One raw assertion before duplicate canonicalization. */
export interface RawFindingAnalytics {
	readonly assertionId: string;
	readonly assignmentId: string;
	readonly stageId: string;
	readonly runId?: string;
	readonly reviewedSha: string;
	readonly reportedAt: string;
	readonly finding: StructuredFinding;
}

export interface CanonicalFindingAnalytics {
	readonly finding: StructuredFinding;
	readonly reviewer: string;
	readonly duplicateIds: readonly string[];
	readonly resolution?: {
		readonly id?: string;
		readonly status: "fixed" | "wont-fix" | "disputed" | "duplicateOf";
		readonly note: string;
		readonly fixCommit?: string;
		readonly canonical?: string;
		readonly at: string;
	};
	readonly verification?: {
		readonly id?: string;
		readonly result: "verified" | "still-open";
		readonly note?: string;
		readonly at: string;
	};
}

export interface FinalVerificationAnalytics {
	readonly assignmentId: string;
	readonly modelId: string;
	readonly effort?: string;
	readonly runId?: string;
	readonly reviewedSha: string;
	readonly status: "passed" | "blocked" | "failed";
	readonly startedAt: string;
	readonly completedAt: string;
	readonly evidence?: readonly string[];
	readonly usage?: TokenSnapshot;
}

export interface WorkflowAnalyticsLedger {
	readonly version: typeof WORKFLOW_ANALYTICS_VERSION;
	readonly deliverableId: string;
	/** Monotonic revision for durable last-writer fencing. */
	readonly revision: number;
	readonly stages: readonly WorkflowStageAnalytics[];
	readonly assignments: readonly AssignmentAnalytics[];
	readonly rawFindings: readonly RawFindingAnalytics[];
	readonly canonicalFindings: readonly CanonicalFindingAnalytics[];
	readonly finalVerification?: FinalVerificationAnalytics;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export function createWorkflowAnalyticsLedger(
	deliverableId: string,
	now: string,
): WorkflowAnalyticsLedger {
	return {
		version: WORKFLOW_ANALYTICS_VERSION,
		deliverableId,
		revision: 0,
		stages: [],
		assignments: [],
		rawFindings: [],
		canonicalFindings: [],
		createdAt: now,
		updatedAt: now,
	};
}

export type WorkflowAnalyticsEvent =
	| { readonly type: "stage"; readonly stage: WorkflowStageAnalytics }
	| {
			readonly type: "assignment";
			readonly assignment: AssignmentAnalytics;
	  }
	| { readonly type: "raw-finding"; readonly finding: RawFindingAnalytics }
	| {
			readonly type: "final-verification";
			readonly verification: FinalVerificationAnalytics;
	  };

/**
 * Apply one analytics checkpoint immutably. Stable identities are replaced,
 * not appended, so retrying a stage/run report is idempotent.
 */
export function applyWorkflowAnalyticsEvent(
	current: WorkflowAnalyticsLedger,
	event: WorkflowAnalyticsEvent,
	now: string,
): WorkflowAnalyticsLedger {
	const next: WorkflowAnalyticsLedger = structuredClone(current);
	switch (event.type) {
		case "stage":
			return bump(
				{
					...next,
					stages: upsert(next.stages, event.stage, (item) => item.stageId),
				},
				now,
			);
		case "assignment":
			return bump(
				{
					...next,
					assignments: upsert(
						next.assignments,
						event.assignment,
						(item) => `${item.stageId}\u0000${item.assignmentId}`,
					),
				},
				now,
			);
		case "raw-finding":
			return bump(
				{
					...next,
					rawFindings: upsert(
						next.rawFindings,
						event.finding,
						(item) => item.assertionId,
					),
				},
				now,
			);
		case "final-verification":
			return bump(
				{ ...next, finalVerification: structuredClone(event.verification) },
				now,
			);
	}
}

export function assignmentAnalytics(input: {
	readonly assignment: ResolvedAgentAssignment;
	readonly stageId: string;
	readonly inputSha: string;
	readonly outputSha?: string;
	readonly runId?: string;
	readonly status: AnalyticsStatus;
	readonly startedAt: string;
	readonly completedAt?: string;
	readonly evidence?: readonly string[];
	readonly usage?: TokenSnapshot;
}): AssignmentAnalytics {
	return {
		assignmentId: input.assignment.agentId,
		stageId: input.stageId,
		kind: input.assignment.kind,
		modelId: input.assignment.modelId,
		...(input.assignment.effort ? { effort: input.assignment.effort } : {}),
		...(input.runId ? { runId: input.runId } : {}),
		inputSha: input.inputSha,
		...(input.outputSha ? { outputSha: input.outputSha } : {}),
		status: input.status,
		startedAt: input.startedAt,
		...(input.completedAt ? { completedAt: input.completedAt } : {}),
		...(input.evidence ? { evidence: [...input.evidence] } : {}),
		...(input.usage ? { usage: { ...input.usage } } : {}),
	};
}

/** Aggregate disjoint token buckets, provider cost, and wall-clock duration. */
export function workflowAnalyticsTotals(ledger: WorkflowAnalyticsLedger): {
	readonly usage: TokenSnapshot;
	readonly durationMs: number;
} {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let turns = 0;
	let durationMs = 0;
	for (const assignment of ledger.assignments) {
		if (assignment.usage) {
			input += assignment.usage.input;
			output += assignment.usage.output;
			cacheRead += assignment.usage.cacheRead;
			cacheWrite += assignment.usage.cacheWrite;
			cost += assignment.usage.cost;
			turns += assignment.usage.turns;
		}
		durationMs += elapsed(assignment.startedAt, assignment.completedAt);
	}
	if (ledger.finalVerification) {
		const verification = ledger.finalVerification;
		if (verification.usage) {
			input += verification.usage.input;
			output += verification.usage.output;
			cacheRead += verification.usage.cacheRead;
			cacheWrite += verification.usage.cacheWrite;
			cost += verification.usage.cost;
			turns += verification.usage.turns;
		}
		durationMs += elapsed(verification.startedAt, verification.completedAt);
	}
	return {
		usage: canonicalTokenSnapshot({
			input,
			output,
			cacheRead,
			cacheWrite,
			cost,
			turns,
		}),
		durationMs,
	};
}

function elapsed(startedAt: string, completedAt?: string): number {
	if (!completedAt) return 0;
	const start = Date.parse(startedAt);
	const end = Date.parse(completedAt);
	return Number.isFinite(start) && Number.isFinite(end)
		? Math.max(0, end - start)
		: 0;
}

function upsert<T>(
	items: readonly T[],
	value: T,
	key: (item: T) => string,
): readonly T[] {
	const identity = key(value);
	const index = items.findIndex((item) => key(item) === identity);
	if (index < 0) return [...items, structuredClone(value)];
	const next = [...items];
	next[index] = structuredClone(value);
	return next;
}

function bump(
	ledger: WorkflowAnalyticsLedger,
	now: string,
): WorkflowAnalyticsLedger {
	return { ...ledger, revision: ledger.revision + 1, updatedAt: now };
}
