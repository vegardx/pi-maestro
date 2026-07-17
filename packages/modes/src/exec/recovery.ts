// Plan recovery audit: recheck every deliverable's claimed status against
// reality — local worktrees, branches, remote branches, and PRs — so a
// recovered session starts from verified state instead of trusting whatever
// the plan file says happened before the restart.

import { existsSync } from "node:fs";
import { runCommand } from "@vegardx/pi-git";
import { viewPr } from "@vegardx/pi-github";
import type { Plan } from "../schema.js";
import {
	defaultBranchForDeliverable,
	deliverableWorkspace,
	repoFor,
} from "../schema.js";

export interface AuditEntry {
	readonly id: string;
	readonly status: string;
	/** Human-readable check results ("✓ worktree present", "✗ PR #12 closed"). */
	readonly notes: readonly string[];
	/** Set when reality disagrees with the plan — needs human attention. */
	readonly problem?: string;
}

export interface PlanAuditResult {
	readonly entries: readonly AuditEntry[];
	readonly problems: number;
}

/** Injectable seams — defaults hit git + gh. */
export interface AuditDeps {
	pathExists?: (path: string) => boolean;
	/** A local ref resolves in the given repo/worktree. */
	refExists?: (cwd: string, ref: string) => boolean;
	/** The working tree has no uncommitted changes. */
	treeClean?: (cwd: string) => boolean;
	/** PR state by number: "OPEN" | "MERGED" | "CLOSED" | null (not found). */
	prState?: (cwd: string, number: number) => Promise<string | null>;
}

function defaultRefExists(cwd: string, ref: string): boolean {
	return runCommand(
		"git",
		["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
		{ cwd },
	).ok;
}

function defaultTreeClean(cwd: string): boolean {
	const r = runCommand("git", ["status", "--porcelain"], { cwd });
	return r.ok && r.stdout.trim() === "";
}

async function defaultPrState(
	cwd: string,
	number: number,
): Promise<string | null> {
	const view = await viewPr(cwd, number);
	return view.pr?.state ?? null;
}

/**
 * Audit the plan against git/GitHub reality. Read-only: reports what it
 * finds; the caller (/recover) decides what to resume and what to surface.
 */
export async function auditPlan(
	plan: Plan,
	deps: AuditDeps = {},
	deliverableIds?: readonly string[],
): Promise<PlanAuditResult> {
	const pathExists = deps.pathExists ?? existsSync;
	const refExists = deps.refExists ?? defaultRefExists;
	const treeClean = deps.treeClean ?? defaultTreeClean;
	const prState = deps.prState ?? defaultPrState;

	const entries: AuditEntry[] = [];
	const selected = deliverableIds ? new Set(deliverableIds) : undefined;
	for (const g of plan.deliverables) {
		if (selected && !selected.has(g.id)) continue;
		if (
			g.status === "planned" ||
			g.status === "abandoned" ||
			g.status === "superseded"
		) {
			continue; // nothing on disk or remote to verify
		}
		const notes: string[] = [];
		const problems: string[] = [];
		const scratch = deliverableWorkspace(g) === "scratch";
		const repo = repoFor(plan, g);
		const branch = g.branch ?? defaultBranchForDeliverable(g);

		// Workspace (active/failed/complete keep it; shipped may have cleaned it up).
		if (
			g.status === "active" ||
			g.status === "failed" ||
			g.status === "complete"
		) {
			if (g.worktreePath && pathExists(g.worktreePath)) {
				notes.push(`✓ ${scratch ? "workspace" : "worktree"} present`);
				if (!scratch && !treeClean(g.worktreePath)) {
					notes.push("⚠ uncommitted changes in the worktree");
					if (g.status === "complete")
						problems.push("uncommitted changes would block ship");
				}
			} else {
				notes.push(`✗ ${scratch ? "workspace" : "worktree"} missing`);
				if (g.status === "active" || g.status === "failed") {
					notes.push("  (recovery re-provisions it)");
				} else {
					problems.push("workspace gone — its work exists only if pushed");
				}
			}
			if (g.status === "active" || g.status === "failed") {
				notes.push(
					g.sessionPath && pathExists(g.sessionPath)
						? "✓ worker session file — resumable"
						: "✗ no worker session file — respawn starts fresh",
				);
			}
		}

		// Branch (repo-backed only).
		if (!scratch && pathExists(repo.path)) {
			if (g.status === "complete" || g.status === "shipped") {
				if (refExists(repo.path, branch)) notes.push(`✓ branch ${branch}`);
				else if (g.status === "complete") {
					problems.push(`branch ${branch} not found — work may be lost`);
				}
				if (g.status === "shipped") {
					notes.push(
						refExists(repo.path, `origin/${branch}`)
							? `✓ origin/${branch}`
							: `✗ origin/${branch} missing (deleted after merge is normal)`,
					);
				}
			}
		}

		// PR (shipped, repo-backed).
		if (g.status === "shipped" && !scratch) {
			if (g.prNumber !== undefined) {
				const cwd = g.worktreePath ?? repo.path;
				const state = pathExists(cwd) ? await prState(cwd, g.prNumber) : null;
				if (state === "MERGED") notes.push(`✓ PR #${g.prNumber} merged`);
				else if (state === "OPEN") notes.push(`✓ PR #${g.prNumber} open`);
				else if (state === "CLOSED")
					problems.push(`PR #${g.prNumber} was CLOSED without merging`);
				else notes.push(`? PR #${g.prNumber} state unknown (gh unavailable?)`);
			} else if (g.prUrl === undefined) {
				notes.push("✓ shipped without a PR (scratch/none expected)");
			}
		}

		entries.push({
			id: g.id,
			status: g.status,
			notes,
			...(problems.length ? { problem: problems.join("; ") } : {}),
		});
	}
	return {
		entries,
		problems: entries.filter((e) => e.problem !== undefined).length,
	};
}

/** Render the audit as a notify-able report. */
export function renderAudit(audit: PlanAuditResult): string {
	if (audit.entries.length === 0) return "Nothing to verify — no started work.";
	const lines = audit.entries.map((e) => {
		const head = `${e.problem ? "✗" : "✓"} ${e.id} (${e.status})${e.problem ? ` — ${e.problem}` : ""}`;
		const detail = e.notes.map((n) => `    ${n}`).join("\n");
		return detail ? `${head}\n${detail}` : head;
	});
	const summary =
		audit.problems === 0
			? "Plan state matches reality."
			: `${audit.problems} deliverable(s) disagree with reality — review before resuming.`;
	return `${summary}\n${lines.join("\n")}`;
}
