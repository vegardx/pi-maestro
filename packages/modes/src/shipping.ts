// Shipping for the node model. The maestro owns shipping — agents never
// push or create PRs. This module provides the PR-body assembly the
// executor's shipNode dependency uses for branch-owning nodes.

import { gatingNodeTasks, type PlanNode } from "./plan/schema.js";
import {
	renderMaestroPrSection,
	updateMaestroPrBody,
} from "./pr-provenance.js";

export interface ShipNodeInput {
	node: PlanNode;
	branch: string;
	worktreePath: string;
	/** Agent summaries assembled into PR body sections. */
	agentReports: string[];
}

export interface ShipNodeResult {
	prUrl: string;
	prNumber: number;
}

/**
 * Build the PR body for a shipped branch-owning node.
 */
export function buildPrBody(node: PlanNode, agentReports: string[]): string {
	const sections: string[] = [];

	// Node description
	if (node.body) {
		sections.push(node.body);
	}

	// Task checklist
	const tasks = gatingNodeTasks(node);
	if (tasks.length > 0) {
		const list = tasks.map((t) => `- [x] ${t.title}`).join("\n");
		sections.push(`## Tasks\n\n${list}`);
	}

	// Agent reports
	if (agentReports.length > 0) {
		sections.push(`## Agent Reports\n\n${agentReports.join("\n\n")}`);
	}

	const base = sections.join("\n\n");
	if (!node.workflowAnalytics) return base;
	return updateMaestroPrBody(base, renderMaestroPrSection(node));
}

/**
 * Determine if a node needs shipping (complete + terminal).
 * Used by the executor — external callers use shippableNodes() from
 * plan/schema.
 */
export function shouldShip(
	node: PlanNode,
	hasDownstreamDeps: boolean,
): boolean {
	return node.status === "complete" && !hasDownstreamDeps;
}
