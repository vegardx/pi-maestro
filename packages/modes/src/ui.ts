// Simple UI rendering utilities for the v2 node-tree plan model.

import type { ModeName } from "@vegardx/pi-contracts";
import {
	effectiveNodeTaskKind,
	PARENT_AFTER_TOKEN,
	type PlanV2,
	walkNodes,
} from "./plan/schema.js";

export interface ModeFooterInput {
	readonly mode: ModeName;
	readonly planSlug?: string;
	readonly branch?: string;
	readonly contextPercent?: number | null;
	readonly stage?: string;
}

export function renderModeFooter(input: ModeFooterInput): string {
	const parts = [`maestro:${input.mode}`];
	if (input.planSlug) parts.push(`plan:${input.planSlug}`);
	if (input.branch) parts.push(`branch:${input.branch}`);
	if (input.stage) parts.push(input.stage);
	if (input.contextPercent !== undefined && input.contextPercent !== null) {
		parts.push(`ctx:${Math.round(input.contextPercent)}%`);
	}
	return parts.join("  ");
}

export function renderPlanPanel(plan: PlanV2, maxLines = 30): string[] {
	const lines = renderPlanText(plan).split("\n");
	if (lines.length <= maxLines) return lines;
	const head = lines.slice(0, Math.max(0, maxLines - 2));
	return [...head, "…", `${lines.length - head.length} more line(s)`];
}

export function renderPlanSidebar(plan: PlanV2): string[] {
	const counts = new Map<string, number>();
	let total = 0;
	for (const { node } of walkNodes(plan)) {
		total += 1;
		counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
	}
	return [
		`Plan: ${plan.title}`,
		`Slug: ${plan.slug}`,
		`Nodes: ${total}`,
		...[...counts].map(([status, count]) => `${status}: ${count}`),
	];
}

function renderPlanText(plan: PlanV2): string {
	const lines: string[] = [`# ${plan.title}`, ""];
	for (const { node, depth } of walkNodes(plan)) {
		const indent = "  ".repeat(depth - 1);
		const icon =
			node.status === "shipped" ? "🚀" : node.status === "active" ? "●" : "○";
		const deps = (node.after ?? []).filter((ref) => ref !== PARENT_AFTER_TOKEN);
		const after = deps.length ? ` (after ${deps.join(", ")})` : "";
		lines.push(
			`${indent}${icon} ${node.title ?? node.id} [${node.status}]${after}`,
		);
		for (const item of node.tasks ?? []) {
			if (effectiveNodeTaskKind(item) === "task") {
				lines.push(`${indent}  ${item.done ? "[x]" : "[ ]"} ${item.title}`);
			}
		}
	}
	return lines.join("\n");
}
