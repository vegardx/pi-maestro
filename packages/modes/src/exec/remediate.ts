// Theme-leaders remediation: turn a failing /verify round into reopened
// deliverables whose findings become gating tasks. Cross-cutting themes
// (the same copied broken pattern in many repos) converge on ONE leader
// deliverable first; every other affected deliverable reopens QUEUED with a
// dependsOn edge to its leader, so the executor's ordinary DAG activation
// runs the second wave automatically when the leader re-ships — no human
// action between waves.

import { viewPr } from "@vegardx/pi-github";
import type { PlanEngine } from "../engine.js";
import type { Deliverable, Plan } from "../schema.js";
import { findDeliverable } from "../schema.js";
import type { StructuredFinding, VerifyEntry } from "./verify.js";

/** Categories that never form a theme — they are deliverable-local by nature. */
const LOCAL_CATEGORIES = new Set(["uncategorized"]);

export interface RemediationPlan {
	/** category → the deliverable that establishes the canonical fix. */
	readonly leaders: ReadonlyMap<string, string>;
	/** follower deliverable id → the leader ids it must wait for. */
	readonly edges: ReadonlyMap<string, readonly string[]>;
}

/**
 * Pick theme leaders and follower edges from a round's failed entries. A
 * theme is a category hitting ≥2 deliverables; its leader is the deliverable
 * with the most findings in that category (ties: most findings overall, then
 * id). Leaders never receive edges — anything that leads one theme starts in
 * wave 1 even if it also follows another pattern. Edges are strictly
 * follower → leader, so the added dependencies cannot create cycles among
 * themselves (existing-DAG cycles are the caller's guard).
 */
export function planRemediationWaves(
	failed: readonly VerifyEntry[],
): RemediationPlan {
	const byCategory = new Map<string, Map<string, number>>();
	const totals = new Map<string, number>();
	for (const e of failed) {
		totals.set(e.id, e.structured.length);
		for (const f of e.structured) {
			if (LOCAL_CATEGORIES.has(f.category)) continue;
			const per = byCategory.get(f.category) ?? new Map<string, number>();
			per.set(e.id, (per.get(e.id) ?? 0) + 1);
			byCategory.set(f.category, per);
		}
	}

	const leaders = new Map<string, string>();
	for (const [category, per] of byCategory) {
		if (per.size < 2) continue; // one deliverable is not a pattern
		const leader = [...per.entries()].sort(
			(a, b) =>
				b[1] - a[1] ||
				(totals.get(b[0]) ?? 0) - (totals.get(a[0]) ?? 0) ||
				a[0].localeCompare(b[0]),
		)[0][0];
		leaders.set(category, leader);
	}

	const leaderIds = new Set(leaders.values());
	const edges = new Map<string, string[]>();
	for (const [category, per] of byCategory) {
		const leader = leaders.get(category);
		if (!leader) continue;
		for (const id of per.keys()) {
			if (id === leader || leaderIds.has(id)) continue;
			const current: string[] = edges.get(id) ?? [];
			if (!current.includes(leader)) edges.set(id, [...current, leader]);
		}
	}
	return { leaders, edges };
}

/** True when `ancestorId` is reachable via dependsOn from `fromId`. */
function dependsTransitively(
	plan: Plan,
	fromId: string,
	ancestorId: string,
): boolean {
	const seen = new Set<string>();
	const stack = [fromId];
	while (stack.length > 0) {
		const id = stack.pop() as string;
		if (seen.has(id)) continue;
		seen.add(id);
		const g = findDeliverable(plan, id);
		for (const dep of g?.dependsOn ?? []) {
			if (dep === ancestorId) return true;
			stack.push(dep);
		}
	}
	return false;
}

export interface RemediationResult {
	readonly reopened: Array<{
		id: string;
		wave: 1 | 2;
		leaders: string[];
		tasks: number;
	}>;
	readonly skipped: Array<{ id: string; reason: string }>;
}

export interface RemediateDeps {
	readonly engine: PlanEngine;
	/** PR state by number ("OPEN" | "MERGED" | "CLOSED" | null). */
	readonly prState?: (cwd: string, number: number) => Promise<string | null>;
	/** Verification round the findings came from (task provenance). */
	readonly round?: number;
	/** false → no theme waves: everything reopens immediately. */
	readonly waves?: boolean;
}

async function defaultPrState(
	cwd: string,
	number: number,
): Promise<string | null> {
	const view = await viewPr(cwd, number);
	return view.pr?.state ?? null;
}

/** One gating WorkItem per accepted finding — the plan IS the remediation. */
function findingTaskInput(
	f: StructuredFinding,
	round: number | undefined,
	leaderNote: string | undefined,
): { title: string; body: string; kind: "task" } {
	const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : undefined;
	const title = `fix ${f.id}: ${f.actual.length > 70 ? `${f.actual.slice(0, 69)}…` : f.actual}`;
	const body = [
		`severity: ${f.severity} · category: ${f.category}` +
			`${where ? ` · ${where}` : ""}${round !== undefined ? ` · verify round ${round}` : ""}`,
		...(f.claim ? [`claimed: ${f.claim}`] : []),
		`actual: ${f.actual}`,
		...(f.task ? [`contradicts task: ${f.task}`] : []),
		...(leaderNote ? [leaderNote] : []),
	].join("\n");
	return { title, body, kind: "task" };
}

/**
 * Reopen a failing round's deliverables. For each fail entry (shipped or
 * complete; open PR when one exists): findings become gating tasks, the
 * deliverable transitions back to `planned` (branch/worktree/PR reused by
 * activation), and second-wave followers gain dependsOn edges to their theme
 * leaders. The caller then runs an ordinary execution tick — wave 1 activates
 * immediately, wave 2 activates automatically as leaders re-land.
 */
export async function applyRemediation(
	entries: readonly VerifyEntry[],
	deps: RemediateDeps,
): Promise<RemediationResult> {
	const engine = deps.engine;
	const prState = deps.prState ?? defaultPrState;

	const reopened: RemediationResult["reopened"] = [];
	const skipped: RemediationResult["skipped"] = [];

	// Pass 1 — eligibility. Leaders must be elected only among entries that
	// actually reopen: an edge to a skipped (or vanished) leader would either
	// be an invalid dependsOn or a dependency that is trivially satisfied by
	// the leader's untouched `shipped` status — the follower would activate
	// without any pattern to follow.
	const eligible: VerifyEntry[] = [];
	for (const entry of entries) {
		if (entry.verdict === "pass") continue;
		if (entry.verdict !== "fail") {
			skipped.push({
				id: entry.id,
				reason: `verification ${entry.verdict} — re-run /verify ${entry.id} first`,
			});
			continue;
		}
		const plan = engine.get();
		const g = findDeliverable(plan, entry.id);
		if (!g) {
			skipped.push({ id: entry.id, reason: "not in the plan anymore" });
			continue;
		}
		if (g.status !== "shipped" && g.status !== "complete") {
			skipped.push({
				id: entry.id,
				reason: `status ${g.status} — /retry or /recover handles in-flight work`,
			});
			continue;
		}
		// A merged PR cannot absorb rework on the same branch — that case
		// needs a follow-up deliverable, deliberately not automated yet.
		if (g.status === "shipped" && g.prNumber !== undefined) {
			const state = await prState(
				g.worktreePath ?? repoPathFor(plan, g),
				g.prNumber,
			);
			if (state !== "OPEN") {
				skipped.push({
					id: entry.id,
					reason: `PR #${g.prNumber} is ${state ?? "unknown"} — reopen manually with a follow-up deliverable`,
				});
				continue;
			}
		}
		eligible.push(entry);
	}

	const waves =
		deps.waves === false ? undefined : planRemediationWaves(eligible);

	// Pass 2 — apply.
	for (const entry of eligible) {
		const myLeaders = (waves?.edges.get(entry.id) ?? [])
			// Never create a cycle against the pre-existing DAG: if the leader
			// already depends (transitively) on this deliverable, drop the edge
			// — the follower simply starts in wave 1.
			.filter((leader) => !dependsTransitively(engine.get(), leader, entry.id));

		const leaderByCategory = new Map<string, string>();
		if (waves) {
			for (const [category, leader] of waves.leaders) {
				if (myLeaders.includes(leader)) leaderByCategory.set(category, leader);
			}
		}

		let tasks = 0;
		for (const f of entry.structured) {
			const leadsThisTheme = waves?.leaders.get(f.category) === entry.id;
			const leader = leaderByCategory.get(f.category);
			const leaderDeliverable = leader
				? findDeliverable(engine.get(), leader)
				: undefined;
			const leaderNote = leadsThisTheme
				? `you establish the canonical ${f.category} fix — the other affected deliverables will follow your approach`
				: leaderDeliverable
					? `theme leader: "${leader}" lands the canonical ${f.category} fix first` +
						`${leaderDeliverable.prUrl ? ` (${leaderDeliverable.prUrl})` : ""} — follow its approach`
					: undefined;
			engine.addWorkItem(entry.id, findingTaskInput(f, deps.round, leaderNote));
			tasks++;
		}
		for (const p of entry.problems) {
			engine.addWorkItem(entry.id, {
				title: `fix: ${p.length > 70 ? `${p.slice(0, 69)}…` : p}`,
				body: `mechanical verification problem${deps.round !== undefined ? ` (verify round ${deps.round})` : ""}: ${p}`,
				kind: "task",
			});
			tasks++;
		}

		if (myLeaders.length > 0) {
			const current = findDeliverable(engine.get(), entry.id);
			engine.updateDeliverable(entry.id, {
				dependsOn: [...new Set([...(current?.dependsOn ?? []), ...myLeaders])],
			});
		}
		engine.setDeliverableStatus(entry.id, "planned");
		reopened.push({
			id: entry.id,
			wave: myLeaders.length > 0 ? 2 : 1,
			leaders: myLeaders,
			tasks,
		});
	}
	return { reopened, skipped };
}

function repoPathFor(plan: Plan, g: Deliverable): string {
	const key = g.repo;
	const entry = plan.repos?.find((r) => r.key === key);
	return entry?.path ?? plan.repoPath;
}

/** Notify-able summary of what the remediation did. */
export function renderRemediation(result: RemediationResult): string {
	const lines: string[] = [];
	const wave1 = result.reopened.filter((r) => r.wave === 1);
	const wave2 = result.reopened.filter((r) => r.wave === 2);
	if (wave1.length > 0) {
		lines.push(
			`Wave 1 (now): ${wave1.map((r) => `${r.id} (${r.tasks} tasks)`).join(", ")}`,
		);
	}
	for (const r of wave2) {
		lines.push(
			`Wave 2 (auto, after ${r.leaders.join(" + ")}): ${r.id} (${r.tasks} tasks)`,
		);
	}
	for (const s of result.skipped) {
		lines.push(`Skipped ${s.id}: ${s.reason}`);
	}
	return lines.length > 0 ? lines.join("\n") : "Nothing to remediate.";
}
