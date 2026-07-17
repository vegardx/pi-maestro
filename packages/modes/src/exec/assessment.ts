import type { ResolvedAgentAssignment, StructuredFinding } from "@vegardx/pi-contracts";
import type { CommitTarget } from "./commit-target.js";
import { renderCommitTarget } from "./commit-target.js";

export interface VerificationScope {
	readonly findingId: string;
	readonly original: CommitTarget;
	readonly fixHead: string;
	readonly fixCommit: string;
}

export interface FinalDeliveryAssessment {
	readonly complete: boolean;
	readonly assessedHead: string;
	readonly blockers: readonly string[];
	readonly assessedAt: string;
}

export function renderVerificationScope(scope: VerificationScope): string {
	return [
		`Finding: ${scope.findingId}`,
		renderCommitTarget(scope.original),
		`Fix commit: ${scope.fixCommit}`,
		`Fix head: ${scope.fixHead}`,
		`Fix range: ${scope.original.head}..${scope.fixHead}`,
		"Inspect the original evidence and only this fix range. Do not issue an open-ended reviewer verdict.",
	].join("\n");
}

/** Mechanical final authority over canonical workflow reports and findings. */
export function assessDelivery(input: {
	readonly head: string;
	readonly expectedHead: string;
	readonly assignedReviews: readonly ResolvedAgentAssignment[];
	readonly reportedAssignmentIds: ReadonlySet<string>;
	readonly findings: readonly StructuredFinding[];
	readonly resolvedFindingIds: ReadonlySet<string>;
	readonly assessedAt: string;
}): FinalDeliveryAssessment {
	const blockers: string[] = [];
	if (input.head !== input.expectedHead)
		blockers.push(`assessment head ${input.head} differs from frozen stage head ${input.expectedHead}`);
	for (const assignment of input.assignedReviews) {
		if (!input.reportedAssignmentIds.has(assignment.agentId))
			blockers.push(`assigned review ${assignment.agentId} has no valid report`);
	}
	for (const finding of input.findings) {
		if (finding.severity !== "minor" && !input.resolvedFindingIds.has(finding.id))
			blockers.push(`blocking finding ${finding.id} is unresolved`);
	}
	return {
		complete: blockers.length === 0,
		assessedHead: input.head,
		blockers,
		assessedAt: input.assessedAt,
	};
}
