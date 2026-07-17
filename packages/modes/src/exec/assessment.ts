import type { ResolvedAgentAssignment } from "@vegardx/pi-contracts";
import type { ReviewLedger } from "./findings.js";
import { openBlocking } from "./findings.js";
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

/**
 * Mechanical final authority for the new workflow path. Model verdict prose is
 * deliberately absent: completion derives from reports, canonical findings,
 * scoped checks, and immutable revision identity.
 */
export function assessDelivery(input: {
	readonly head: string;
	readonly expectedHead: string;
	readonly assignedReviews: readonly ResolvedAgentAssignment[];
	readonly ledger?: ReviewLedger;
	readonly waived?: ReadonlySet<string>;
	readonly assessedAt: string;
}): FinalDeliveryAssessment {
	const blockers: string[] = [];
	if (input.head !== input.expectedHead) {
		blockers.push(
			`assessment head ${input.head} differs from frozen stage head ${input.expectedHead}`,
		);
	}
	if (input.assignedReviews.length > 0 && !input.ledger) {
		blockers.push("assigned reviews produced no canonical report");
	}
	if (input.ledger?.pendingRound) blockers.push("review stage is still settling");
	const participants = new Map(
		(input.ledger?.participants ?? []).map((participant) => [
			participant.name,
			participant,
		]),
	);
	for (const assignment of input.assignedReviews) {
		const participant = participants.get(assignment.agentId);
		if (!participant?.ok) {
			blockers.push(`assigned review ${assignment.agentId} has no valid report`);
		}
	}
	for (const entry of input.ledger
		? openBlocking(input.ledger, input.waived ?? new Set())
		: []) {
		blockers.push(`blocking finding ${entry.finding.id} is unresolved`);
	}
	return {
		complete: blockers.length === 0,
		assessedHead: input.head,
		blockers,
		assessedAt: input.assessedAt,
	};
}
