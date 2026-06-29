// Markdown projection for plans. This is intentionally pure: commands/tools,
// compaction seeds, PR bodies, and tests all render from the same Plan value.

import { collectDependencySummaries } from "./compaction.js";
import {
	childDeliverables,
	type Deliverable,
	deliverables,
	effectiveWorkItemKind,
	isDeliverable,
	type Plan,
	repoFor,
	topLevelLeaves,
	type WorkItem,
} from "./schema.js";

export interface PlanMarkdownOptions {
	/** Include operational metadata useful for compacted context seeds. */
	readonly includeSeedMetadata?: boolean;
	/**
	 * Omit per-deliverable `Summary:` lines. Seeds set this so unrelated
	 * parallel-branch summaries never leak in via the plan document — only the
	 * dependency-scoped carry-forward section carries summaries.
	 */
	readonly omitSummaries?: boolean;
}

/**
 * Concise plan overview for display after creation or on `/plan`. Shows
 * repos, numbered deliverables with status + deps, and task checklists.
 */
export function renderPlanSummary(plan: Plan): string {
	const lines: string[] = [];
	lines.push(`Plan: ${plan.slug}`);

	// Repos line
	const repoEntries: string[] = [`${repoBasename(plan.repoPath)} (default)`];
	for (const r of plan.repos ?? []) {
		const branch = r.defaultBranch ? `, ${r.defaultBranch}` : "";
		repoEntries.push(`${r.key} (${repoBasename(r.path)}${branch})`);
	}
	if (repoEntries.length > 1) {
		lines.push(`Repos: ${repoEntries.join(", ")}`);
	}
	lines.push("");

	const flat = deliverables(plan).filter((d) => !d.lifecycle);
	const idToNum = new Map<string, number>();
	for (let i = 0; i < flat.length; i++) idToNum.set(flat[i].id, i + 1);

	for (let i = 0; i < flat.length; i++) {
		const d = flat[i];
		const num = i + 1;
		let suffix = "";
		const deps = (d.dependsOn ?? [])
			.map((dep) => idToNum.get(dep))
			.filter(Boolean);
		if (deps.length > 0) {
			suffix = ` \u2192 depends on #${deps.join(", #")}`;
		}
		const repo = repoFor(plan, d);
		const repoTag = repo.key !== "default" ? ` [${repo.key}]` : "";
		lines.push(`${num}. ${d.title ?? d.id} [${d.status}]${repoTag}${suffix}`);

		const items = (d.children ?? []).filter(
			(c): c is WorkItem => c.type === "work-item",
		);
		for (const item of items) {
			const check = item.done ? "\u2611" : "\u2610";
			const kind = effectiveWorkItemKind(item) === "manual" ? " (manual)" : "";
			lines.push(`   ${check} ${item.title}${kind}`);
		}
		if (i < flat.length - 1) lines.push("");
	}

	if (flat.length === 0) {
		lines.push("No deliverables yet.");
	}

	return lines.join("\n");
}

function repoBasename(path: string): string {
	return path.split("/").filter(Boolean).pop() ?? path;
}

export function renderPlanMarkdown(
	plan: Plan,
	options: PlanMarkdownOptions = {},
): string {
	const lines: string[] = [];
	lines.push(`# ${plan.title} (\`${plan.slug}\`)`);
	lines.push("");
	lines.push(`Repo: \`${plan.repoPath}\``);
	if (plan.parentIssueNumber)
		lines.push(`Tracking issue: #${plan.parentIssueNumber}`);
	if (plan.lastSyncedAt) lines.push(`Last synced: ${plan.lastSyncedAt}`);
	if (options.includeSeedMetadata) {
		lines.push(`Updated: ${plan.updatedAt}`);
		if (plan.planSessionPath) {
			lines.push(`Plan session: \`${plan.planSessionPath}\``);
		}
	}
	lines.push("");

	const top = plan.nodes.filter(isDeliverable);
	const pre = top.filter((d) => d.lifecycle === "pre");
	const regular = top.filter((d) => !d.lifecycle);
	const post = top.filter((d) => d.lifecycle === "post");

	if (pre.length > 0) {
		lines.push("## Preflight");
		lines.push("");
		for (const d of pre) renderDeliverable(lines, d, 0, options);
	}
	if (regular.length > 0) {
		lines.push("## Deliverables");
		lines.push("");
		for (const d of regular) renderDeliverable(lines, d, 0, options);
	}
	if (post.length > 0) {
		lines.push("## Handover");
		lines.push("");
		for (const d of post) renderDeliverable(lines, d, 0, options);
	}
	if (top.length === 0) {
		lines.push("_No deliverables yet._");
		lines.push("");
	}

	const loose = topLevelLeaves(plan);
	if (loose.length > 0) {
		lines.push("## Loose items");
		lines.push("");
		renderItems(lines, loose, "");
		lines.push("");
	}

	return lines.join("\n").trimEnd();
}

/** Deterministic compact context for starting/continuing a deliverable. */
export function renderPlanSeed(
	plan: Plan,
	activeDeliverableId?: string,
): string {
	const lines: string[] = [];
	lines.push("# Maestro plan context");
	lines.push("");
	lines.push(`Plan: ${plan.title} (${plan.slug})`);
	lines.push(`Repo: ${plan.repoPath}`);
	if (activeDeliverableId)
		lines.push(`Active deliverable: ${activeDeliverableId}`);
	lines.push("");
	lines.push("## Status");
	for (const d of deliverables(plan)) {
		const marker = d.id === activeDeliverableId ? "→" : "-";
		const deps = d.dependsOn?.length
			? ` depends on ${d.dependsOn.join(", ")}`
			: "";
		lines.push(`${marker} ${d.id}: ${d.status}${deps} — ${d.title}`);
	}
	// Carry-forward: inject ONLY the distilled summaries of this deliverable's
	// dependency closure, verbatim for cache stability. Independent parallel
	// branches are never pulled in. Omitted entirely when there is no active
	// deliverable (e.g. plain plan context) or no dependency has a summary.
	if (activeDeliverableId) {
		const depSummaries = collectDependencySummaries(plan, activeDeliverableId);
		if (depSummaries.length > 0) {
			lines.push("");
			lines.push("## Carry-forward from dependencies");
			for (const dep of depSummaries) {
				lines.push("");
				lines.push(`### \`${dep.id}\` — ${dep.title}`);
				lines.push(dep.summary);
			}
		}
	}
	lines.push("");
	lines.push("## Plan document");
	lines.push(
		renderPlanMarkdown(plan, {
			includeSeedMetadata: true,
			omitSummaries: true,
		}),
	);
	return lines.join("\n").trimEnd();
}

function renderDeliverable(
	lines: string[],
	d: Deliverable,
	depth: number,
	options: PlanMarkdownOptions,
): void {
	const heading = "#".repeat(Math.min(3 + depth, 6));
	const lifecycle = d.lifecycle ? ` [${d.lifecycle}]` : "";
	const grouping = childDeliverables(d).length > 0 ? " _(grouping)_" : "";
	const refs = [
		d.issueNumber ? `#${d.issueNumber}` : "",
		d.prNumber ? `PR #${d.prNumber}` : "",
	]
		.filter(Boolean)
		.join(" — ");
	const refSuffix = refs ? ` — ${refs}` : "";
	lines.push(
		`${heading} ${d.title} \`${d.id}\`${lifecycle} [${d.status}]${refSuffix}${grouping}`,
	);
	if (d.dependsOn && d.dependsOn.length > 0) {
		lines.push("");
		lines.push(
			`depends on: ${d.dependsOn.map((id) => `\`${id}\``).join(", ")}`,
		);
	}
	if (d.branch || d.worktreePath || d.sessionPath) {
		lines.push("");
		if (d.branch) lines.push(`branch: \`${d.branch}\``);
		if (options.includeSeedMetadata && d.worktreePath) {
			lines.push(`worktree: \`${d.worktreePath}\``);
		}
		if (options.includeSeedMetadata && d.sessionPath) {
			lines.push(`session: \`${d.sessionPath}\``);
		}
	}
	if (d.body.trim()) {
		lines.push("");
		for (const line of d.body.split("\n")) lines.push(`> ${line}`);
	}
	if (d.summary && !options.omitSummaries) {
		lines.push("");
		lines.push(`Summary: ${d.summary}`);
	}
	const items = d.children.filter((n): n is WorkItem => n.type === "work-item");
	if (items.length > 0) {
		lines.push("");
		renderItems(lines, items, "");
	}
	lines.push("");
	for (const child of childDeliverables(d)) {
		renderDeliverable(lines, child, depth + 1, options);
	}
}

function renderItems(
	lines: string[],
	items: readonly WorkItem[],
	indent: string,
): void {
	for (const item of items) {
		lines.push(`${indent}${renderItemBullet(item)}`);
		if (item.body.trim()) {
			for (const line of item.body.split("\n"))
				lines.push(`${indent}  ${line}`);
		}
		if (item.answer !== undefined) {
			lines.push(`${indent}  → answer: ${item.answer}`);
		}
	}
}

function renderItemBullet(item: WorkItem): string {
	const kind = effectiveWorkItemKind(item);
	if (kind === "task")
		return `- [${item.done ? "x" : " "}] **${item.title}** \`${item.id}\``;
	const marker =
		kind === "question" ? "[?]" : kind === "manual" ? "[!]" : "[~]";
	const answered =
		kind === "question" && item.answer !== undefined ? " _(answered)_" : "";
	const checked = item.done ? " _(done)_" : "";
	return `- ${marker} **${item.title}** \`${item.id}\` _(${kind})_${answered}${checked}`;
}
