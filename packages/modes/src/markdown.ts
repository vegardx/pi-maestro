// Markdown projection for plans. This is intentionally pure: commands/tools,
// compaction seeds, PR bodies, and tests all render from the same Plan value.

import { collectDependencySummaries } from "./compaction.js";
import {
	childDeliverables,
	type Deliverable,
	deliverables,
	effectiveWorkItemKind,
	findDeliverable,
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

	// Header
	const repoCount = 1 + (plan.repos?.length ?? 0);
	const flat = deliverables(plan).filter((d) => !d.lifecycle);
	const repoPart = repoCount > 1 ? ` \u00b7 ${repoCount} repos` : "";
	lines.push(
		`${plan.title} \u00b7 ${flat.length} deliverable${flat.length !== 1 ? "s" : ""}${repoPart}`,
	);
	lines.push("");

	// Build number map for blocked-by references
	const idToNum = new Map<string, number>();
	for (let i = 0; i < flat.length; i++) idToNum.set(flat[i].id, i + 1);

	for (let i = 0; i < flat.length; i++) {
		const d = flat[i];
		const num = i + 1;
		const repo = repoFor(plan, d);
		const repoName = repoBasename(repo.path);
		lines.push(`${num}. ${d.title} [${repoName}] (${d.id})`);

		// Body (deliverable description) — first line only if short
		if (d.body.trim()) {
			const bodyLine = d.body.trim().split("\n")[0];
			lines.push(`   ${bodyLine}`);
		}

		// Blocked-by
		const deps = (d.dependsOn ?? [])
			.map((dep) => idToNum.get(dep))
			.filter(Boolean);
		if (deps.length > 0) {
			lines.push(`   (blocked by: ${deps.join(", ")})`);
		}

		// Gating tasks only
		const items = (d.children ?? []).filter(
			(c): c is WorkItem =>
				c.type === "work-item" &&
				(effectiveWorkItemKind(c) === "task" ||
					effectiveWorkItemKind(c) === "manual"),
		);
		for (const item of items) {
			const mark = item.done ? "\u2713" : "\u00b7";
			lines.push(`   ${mark} ${item.title}`);
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

// ─── Agent-focused plan view ─────────────────────────────────────────────────

/**
 * Render a focused seed for an agent. Shorter than renderPlanSeed — includes
 * only the active deliverable's tasks and dependency summaries. Used as the
 * cache-prefix-stable content injected at spawn time.
 *
 * For live state, agents call `plan` tool which uses `renderPlanForAgent`.
 */
export function renderAgentSeed(
	plan: Plan,
	activeDeliverableId: string,
): string {
	const lines: string[] = [];
	const active = findDeliverable(plan, activeDeliverableId);

	lines.push("[AUTO MODE — executing plan]");
	lines.push("");

	if (active) {
		lines.push(`Active deliverable: \`${active.id}\` — ${active.title}`);
		if (active.body.trim()) {
			lines.push("");
			lines.push(`> ${active.body.trim().split("\n").join("\n> ")}`);
		}
		lines.push("");
		lines.push("Your tasks:");
		const items = (active.children ?? []).filter(
			(c): c is WorkItem => c.type === "work-item",
		);
		for (const item of items) {
			const kind = effectiveWorkItemKind(item);
			if (kind === "task" || kind === "manual") {
				lines.push(`- [ ] ${item.title} \`${item.id}\``);
				if (item.body.trim()) {
					lines.push(`      ${item.body.trim().split("\n")[0]}`);
				}
			}
		}
	}

	// Carry-forward from dependencies
	const depSummaries = collectDependencySummaries(plan, activeDeliverableId);
	if (depSummaries.length > 0) {
		lines.push("");
		lines.push("From completed dependencies:");
		for (const dep of depSummaries) {
			lines.push(`- ${dep.id}: ${dep.summary}`);
		}
	}

	lines.push("");
	lines.push(
		"Call `plan` for full current state. Work through tasks. Commit incrementally. Ship when done.",
	);

	return lines.join("\n");
}

/**
 * Render a focused plan view for an agent. Shows the agent's own deliverable
 * in detail (tasks with checkboxes) plus a concise overview of the rest of
 * the plan. Used as the response to `planRead` RPC.
 */
export function renderPlanForAgent(
	plan: Plan,
	activeDeliverableId: string,
	opts?: { toggledLocally?: ReadonlySet<string> },
): string {
	const lines: string[] = [];
	const active = findDeliverable(plan, activeDeliverableId);

	if (active) {
		lines.push(
			`## Your deliverable: ${active.id} — ${active.title} [${active.status}]`,
		);
		if (active.body.trim()) {
			lines.push("");
			lines.push(`> ${active.body.trim().split("\n").join("\n> ")}`);
		}
		lines.push("");
		lines.push("### Tasks");
		const items = (active.children ?? []).filter(
			(c): c is WorkItem => c.type === "work-item",
		);
		for (const item of items) {
			const done = item.done || (opts?.toggledLocally?.has(item.id) ?? false);
			const kind = effectiveWorkItemKind(item);
			if (kind === "task" || kind === "manual") {
				lines.push(`- [${done ? "x" : " "}] ${item.title} \`${item.id}\``);
			} else {
				const marker = kind === "question" ? "[?]" : "[~]";
				lines.push(`- ${marker} ${item.title} \`${item.id}\` _(${kind})_`);
			}
			if (item.body.trim()) {
				lines.push(`      ${item.body.trim().split("\n")[0]}`);
			}
		}
	}

	// Carry-forward from dependencies
	const depSummaries = collectDependencySummaries(plan, activeDeliverableId);
	if (depSummaries.length > 0) {
		lines.push("");
		lines.push("### From completed dependencies");
		for (const dep of depSummaries) {
			lines.push(`- **${dep.id}**: ${dep.summary}`);
		}
	}

	// Plan overview (other deliverables — one line each)
	const all = deliverables(plan);
	if (all.length > 1) {
		lines.push("");
		lines.push("### Plan overview");
		for (const d of all) {
			if (d.id === activeDeliverableId) {
				lines.push(`→ ${d.id} [${d.status}] ← you are here`);
			} else {
				const summary = d.summary ? ` — ${d.summary.split("\n")[0]}` : "";
				lines.push(`- ${d.id} [${d.status}]${summary}`);
			}
		}
	}

	lines.push("");
	lines.push("---");
	lines.push("Toggle tasks when done. Commit incrementally. Ship when ready.");

	return lines.join("\n");
}
