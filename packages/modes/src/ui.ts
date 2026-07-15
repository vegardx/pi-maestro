// Simple UI rendering utilities for the deliverable-based plan model.

import type { ModeName } from "@vegardx/pi-contracts";
import type { Plan } from "./schema.js";

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

export function renderPlanPanel(plan: Plan, maxLines = 30): string[] {
	const lines = renderPlanText(plan).split("\n");
	if (lines.length <= maxLines) return lines;
	const head = lines.slice(0, Math.max(0, maxLines - 2));
	return [...head, "…", `${lines.length - head.length} more line(s)`];
}

export function renderPlanSidebar(plan: Plan): string[] {
	const counts = new Map<string, number>();
	for (const g of plan.deliverables)
		counts.set(g.status, (counts.get(g.status) ?? 0) + 1);
	return [
		`Plan: ${plan.title}`,
		`Slug: ${plan.slug}`,
		`Deliverables: ${plan.deliverables.length}`,
		...[...counts].map(([status, count]) => `${status}: ${count}`),
	];
}

function renderPlanText(plan: Plan): string {
	const lines: string[] = [`# ${plan.title}`, ""];
	for (const g of plan.deliverables) {
		const icon =
			g.status === "shipped" ? "🚀" : g.status === "active" ? "●" : "○";
		const deps = g.dependsOn?.length
			? ` (after ${g.dependsOn.join(", ")})`
			: "";
		lines.push(`${icon} ${g.title} [${g.status}]${deps}`);
		for (const item of g.tasks ?? []) {
			if (item.kind === "task") {
				lines.push(`  ${item.done ? "[x]" : "[ ]"} ${item.title}`);
			}
		}
	}
	return lines.join("\n");
}
