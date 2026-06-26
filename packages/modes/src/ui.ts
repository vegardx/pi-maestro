import type { ModeName } from "@vegardx/pi-contracts";
import { renderPlanMarkdown } from "./markdown.js";
import { deliverables, type Plan } from "./schema.js";

export interface ModeFooterInput {
	readonly mode: ModeName;
	readonly planSlug?: string;
	readonly branch?: string;
	readonly contextPercent?: number | null;
	readonly stage?: string;
	/** Pre-formatted context budget breakdown, e.g. `12000/250000 (.../.../...)`. */
	readonly budget?: string;
}

export function renderModeFooter(input: ModeFooterInput): string {
	const parts = [`maestro:${input.mode}`];
	if (input.planSlug) parts.push(`plan:${input.planSlug}`);
	if (input.branch) parts.push(`branch:${input.branch}`);
	if (input.stage) parts.push(input.stage);
	if (input.budget) parts.push(input.budget);
	if (input.contextPercent !== undefined && input.contextPercent !== null) {
		parts.push(`ctx:${Math.round(input.contextPercent)}%`);
	}
	return parts.join("  ");
}

export function renderPlanPanel(plan: Plan, maxLines = 30): string[] {
	const lines = renderPlanMarkdown(plan).split("\n");
	if (lines.length <= maxLines) return lines;
	const head = lines.slice(0, Math.max(0, maxLines - 2));
	return [...head, "…", `${lines.length - head.length} more line(s)`];
}

export function renderPlanSidebar(plan: Plan): string[] {
	const counts = new Map<string, number>();
	for (const d of deliverables(plan))
		counts.set(d.status, (counts.get(d.status) ?? 0) + 1);
	return [
		`Plan: ${plan.title}`,
		`Slug: ${plan.slug}`,
		`Deliverables: ${deliverables(plan).length}`,
		...[...counts].map(([status, count]) => `${status}: ${count}`),
	];
}
