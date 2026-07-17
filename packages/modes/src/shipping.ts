// Shipping for the deliverable model. The maestro owns shipping — agents never
// push or create PRs. This module provides the concrete implementation of
// the `shipDeliverable` dependency that the DeliverableExecutor calls.

import {
	renderMaestroPrSection,
	updateMaestroPrBody,
} from "./pr-provenance.js";
import type { Deliverable } from "./schema.js";
import { gatingTasks } from "./schema.js";

export interface ShipDeliverableInput {
	deliverable: Deliverable;
	branch: string;
	worktreePath: string;
	/** Agent summaries assembled into PR body sections. */
	agentReports: string[];
}

export interface ShipDeliverableResult {
	prUrl: string;
	prNumber: number;
}

/**
 * Build the PR body for a shipped deliverable.
 */
export function buildPrBody(
	deliverable: Deliverable,
	agentReports: string[],
): string {
	const sections: string[] = [];

	// Deliverable description
	if (deliverable.body) {
		sections.push(deliverable.body);
	}

	// Task checklist
	const tasks = gatingTasks(deliverable);
	if (tasks.length > 0) {
		const list = tasks.map((t) => `- [x] ${t.title}`).join("\n");
		sections.push(`## Tasks\n\n${list}`);
	}

	// Agent reports
	if (agentReports.length > 0) {
		sections.push(`## Agent Reports\n\n${agentReports.join("\n\n")}`);
	}

	const base = sections.join("\n\n");
	if (!deliverable.workflowAnalytics) return base;
	return updateMaestroPrBody(base, renderMaestroPrSection(deliverable));
}

/**
 * Determine if a deliverable needs shipping (complete + terminal).
 * Used by the executor — external callers use shippableDeliverables() from schema.
 */
export function shouldShip(
	deliverable: Deliverable,
	hasDownstreamDeps: boolean,
): boolean {
	return deliverable.status === "complete" && !hasDownstreamDeps;
}
