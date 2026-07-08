// The plan model: a flat list of Deliverables. A Deliverable is the atomic unit of
// execution — one branch, one PR. It contains a worker (primary agent), zero or
// more support agents with an internal dependency graph, and a set of tasks.
//
// This replaces the v4 deliverable-tree model. No on-disk migration (dev tool).
// Clean break: deliverables replace deliverables entirely.

import { basename, resolve } from "node:path";
import {
	type AgentMode,
	DELIVERABLE_STATUSES,
	type DeliverableStatus,
	type ModelSlot,
	type ThinkingLevel,
	WORK_ITEM_KINDS,
	type WorkItemKind,
} from "@vegardx/pi-contracts";

export {
	type AgentMode,
	DELIVERABLE_STATUSES,
	type DeliverableStatus,
	type ModelSlot,
	type ThinkingLevel,
	WORK_ITEM_KINDS,
	type WorkItemKind,
};

// ─── Work items ──────────────────────────────────────────────────────────────

export interface WorkItem {
	type: "work-item";
	id: string;
	title: string;
	body: string;
	done: boolean;
	kind?: WorkItemKind;
	/** For `question` items: the decision once made (stamps decidedAt). */
	answer?: string;
	decidedAt?: string;
	createdAt: string;
	updatedAt: string;
}

export function effectiveWorkItemKind(
	item: Pick<WorkItem, "kind">,
): WorkItemKind {
	return item.kind ?? "task";
}

// ─── Agent specification ─────────────────────────────────────────────────────

export interface AgentSpec {
	/** Unique name within the deliverable (also used in `after` references). */
	name: string;
	mode: AgentMode;
	slot: ModelSlot;
	effort: ThinkingLevel;
	/** What this agent should focus on — specific, actionable instructions. */
	focus: string;
	/** Dependencies: "worker" or other agent names. Empty = start immediately. */
	after: string[];
}

// ─── Sub-agent specification (persona panel) ─────────────────────────────────

/**
 * One entry in a deliverable's up-front sub-agent plan (Phase 7). The worker
 * runs these as headless one-shot subagents. Multiple entries may share a
 * `persona` with different `slot`/`model` — that's the multi-model escalation
 * (e.g. security-audit on default AND alternate). `required` review verdicts
 * gate ship at the executor.
 */
export interface SubAgentSpec {
	/** Unique name within the deliverable. */
	name: string;
	/** Persona id from the registry (PERSONAS). */
	persona: string;
	/** Optional per-deliverable specialization of the persona's focus. */
	focus?: string;
	/** Model slot override; defaults to the persona's default. */
	slot?: ModelSlot;
	/** Explicit model override ("provider/id"), for a multi-model panel. */
	model?: string;
	/** Effort override; defaults to the persona's default. */
	effort?: ThinkingLevel;
	/** "review" = verdict-gated; "helper" = info scout. Default "review". */
	kind?: "review" | "helper";
	/** Required reviews must reach SHIPPED before the deliverable ships. */
	required?: boolean;
}

// ─── Worker specification ────────────────────────────────────────────────────

export interface WorkerSpec {
	mode: AgentMode;
	/** Model slot. Defaults to "default" at resolution time. */
	slot?: ModelSlot;
	/** Thinking effort. Defaults to preset default at resolution time. */
	effort?: ThinkingLevel;
	/** Agents that must finish before worker starts. Empty/absent = start first. */
	after?: string[];
}

// ─── Work deliverable ──────────────────────────────────────────────────────────────

export interface Deliverable {
	type: "deliverable";
	id: string;
	title: string;
	/** What ships when this merges — context, criteria. */
	body: string;
	status: DeliverableStatus;
	/** Inter-deliverable dependencies. Empty/absent = no deps (root). */
	dependsOn?: string[];
	/**
	 * Branch from predecessor's tip (stacked PR). Default true.
	 * Set false to branch from main (independent PR).
	 * Only meaningful when dependsOn is non-empty.
	 */
	stacked?: boolean;
	/** The primary agent — always exists, gets the deliverable's tasks. */
	worker: WorkerSpec;
	/** Support agents with an internal dependency graph. */
	agents: AgentSpec[];
	/**
	 * The worker's up-front review/helper panel (Phase 7). Composed from the
	 * persona registry at plan time; the worker runs it. Optional/absent on
	 * older plans, which use `agents` instead.
	 */
	subAgents?: SubAgentSpec[];
	/** Gating work items the worker must complete. */
	tasks: WorkItem[];
	/** Review→fix round cap before the deliverable blocks. Default 2. */
	maxFixRounds?: number;
	// ── Runtime state ──
	/** Git branch (typically feat/<id>). */
	branch?: string;
	/** Worktree path while active; cleared on completion. */
	worktreePath?: string;
	/** Session file path for the worker session. */
	sessionPath?: string;
	/** Combined summary of all agent outputs (produced at deliverable completion). */
	summary?: string;
	/** PR URL once shipped. */
	prUrl?: string;
	prNumber?: number;
	createdAt: string;
	updatedAt: string;
}

// ─── Plan ────────────────────────────────────────────────────────────────────

/**
 * Planning phases. A plan starts `exploring` — the maestro researches, asks,
 * and iterates; structural tools (deliverable/task/agent/knowledge) are blocked.
 * The `readiness` tool (user-confirmed) or /ready flips it to `structuring`,
 * unlocking plan structure. Plans persisted before phases existed hydrate as
 * `structuring` when they already have deliverables (see planPhase).
 */
export const PLAN_PHASES = ["exploring", "structuring"] as const;
export type PlanPhase = (typeof PLAN_PHASES)[number];

/** A repo a plan can target. The default repo is `plan.repoPath` (key "default"). */
export interface PlanRepo {
	/** Stable key deliverables reference (currently unused but reserved). */
	key: string;
	/** Absolute path to the repo. */
	path: string;
	/** Cached default branch; detected at use when absent. */
	defaultBranch?: string;
}

export const DEFAULT_REPO_KEY = "default";

export interface Plan {
	slug: string;
	title: string;
	repoPath: string;
	/** Planning phase; absent on older plans (see planPhase for the default). */
	phase?: PlanPhase;
	/**
	 * The maestro's summarized understanding, captured when readiness was
	 * confirmed. Source material for the knowledge doc and plan summary.
	 */
	understanding?: string;
	/** Extra repos beyond the default; absent ⇒ single-repo plan. */
	repos?: PlanRepo[];
	/** All work deliverables in the plan. Flat list — graph structure via dependsOn. */
	deliverables: Deliverable[];
	/** GitHub plan-tracking issue (parent of deliverable issues) after park. */
	parentIssueNumber?: number;
	/** Session file backing this plan's planning session. */
	planSessionPath?: string;
	lastSyncedAt?: string;
	createdAt: string;
	updatedAt: string;
}

/**
 * Effective planning phase. Plans persisted before phases existed carry no
 * `phase` field: treat them as `structuring` when they already have deliverables
 * (they were planned under the old flow) and `exploring` when empty.
 */
export function planPhase(
	plan: Pick<Plan, "phase" | "deliverables">,
): PlanPhase {
	if (plan.phase) return plan.phase;
	return plan.deliverables.length > 0 ? "structuring" : "exploring";
}

// ─── Traversal helpers ───────────────────────────────────────────────────────

/** All deliverables in the plan. */
export function deliverables(plan: Pick<Plan, "deliverables">): Deliverable[] {
	return plan.deliverables;
}

/** Find a deliverable by ID. */
export function findDeliverable(
	plan: Pick<Plan, "deliverables">,
	id: string,
): Deliverable | null {
	return plan.deliverables.find((g) => g.id === id) ?? null;
}

/** All tasks in a deliverable. */
export function deliverableTasks(g: Pick<Deliverable, "tasks">): WorkItem[] {
	return g.tasks;
}

/** Gating tasks (kind = "task") that must be completed. */
export function gatingTasks(g: Pick<Deliverable, "tasks">): WorkItem[] {
	return g.tasks.filter((t) => effectiveWorkItemKind(t) === "task");
}

/** Find a task by ID within a deliverable. */
export function findTask(
	g: Pick<Deliverable, "tasks">,
	taskId: string,
): WorkItem | null {
	return g.tasks.find((t) => t.id === taskId) ?? null;
}

/** Find an agent spec by name within a deliverable. */
export function findAgent(
	g: Pick<Deliverable, "agents">,
	name: string,
): AgentSpec | null {
	return g.agents.find((a) => a.name === name) ?? null;
}

// ─── State machine ───────────────────────────────────────────────────────────

export const DELIVERABLE_TRANSITIONS: Record<
	DeliverableStatus,
	readonly DeliverableStatus[]
> = {
	planned: ["active", "abandoned"],
	active: ["complete", "abandoned"],
	complete: ["shipped", "superseded", "abandoned"],
	shipped: [],
	superseded: [],
	abandoned: [],
};

/** Terminal statuses — the deliverable will not transition again. */
export const TERMINAL_STATUSES: readonly DeliverableStatus[] = [
	"shipped",
	"superseded",
	"abandoned",
];

export function canTransition(
	from: DeliverableStatus,
	to: DeliverableStatus,
): boolean {
	return DELIVERABLE_TRANSITIONS[from].includes(to);
}

// ─── Dependency / activation logic ───────────────────────────────────────────

/**
 * Statuses that satisfy a downstream dependency. A dep must have finished
 * producing (complete/shipped) — an `active` dep has an empty branch tip and
 * no summary yet, so activating on it would stack the dependent on nothing.
 * Terminal non-productive deps (abandoned/superseded) also count as satisfied
 * so a chain doesn't wedge on an abandoned parent; base selection skips them.
 */
const SATISFIED_STATUSES: readonly DeliverableStatus[] = [
	"complete",
	"shipped",
	"superseded",
	"abandoned",
];

/**
 * A deliverable is ready to activate when all its dependsOn deliverables are in a
 * satisfied status (complete, shipped, or terminally non-productive).
 */
export function isDeliverableReady(
	plan: Pick<Plan, "deliverables">,
	g: Pick<Deliverable, "id" | "status" | "dependsOn">,
): boolean {
	if (g.status !== "planned") return false;
	const deps = g.dependsOn ?? [];
	if (deps.length === 0) return true;
	return deps.every((depId) => {
		const dep = findDeliverable(plan, depId);
		if (!dep) return false;
		return SATISFIED_STATUSES.includes(dep.status);
	});
}

/** All deliverables that are ready to be activated. */
export function readyDeliverables(
	plan: Pick<Plan, "deliverables">,
): Deliverable[] {
	return plan.deliverables.filter((g) => isDeliverableReady(plan, g));
}

/** Deliverables that are terminal (no further transitions). */
export function terminalDeliverables(
	plan: Pick<Plan, "deliverables">,
): Deliverable[] {
	return plan.deliverables.filter((g) => TERMINAL_STATUSES.includes(g.status));
}

/**
 * A deliverable is a leaf in the dependency graph (nothing depends on it).
 */
export function isLeafDeliverable(
	plan: Pick<Plan, "deliverables">,
	g: Pick<Deliverable, "id">,
): boolean {
	return !plan.deliverables.some(
		(other) => other.dependsOn?.includes(g.id) ?? false,
	);
}

/**
 * Deliverables ready to ship: complete, with every dependsOn deliverable itself shipped
 * (or terminally non-productive). Shipping follows the chain — in A←B, A
 * ships first so `feat/A` exists on the remote when B's PR targets it.
 */
export function shippableDeliverables(
	plan: Pick<Plan, "deliverables">,
): Deliverable[] {
	return plan.deliverables.filter((g) => {
		if (g.status !== "complete") return false;
		return (g.dependsOn ?? []).every((depId) => {
			const dep = findDeliverable(plan, depId);
			return dep !== null && TERMINAL_STATUSES.includes(dep.status);
		});
	});
}

/** Why a deliverable can't activate yet. Null if ready. */
export function blockedReason(
	plan: Pick<Plan, "deliverables">,
	g: Pick<Deliverable, "id" | "status" | "dependsOn">,
): string | null {
	if (g.status !== "planned") {
		return `deliverable \`${g.id}\` is ${g.status}, not planned`;
	}
	const deps = g.dependsOn ?? [];
	if (deps.length === 0) return null;
	for (const depId of deps) {
		const dep = findDeliverable(plan, depId);
		if (!dep) return `unknown dependency \`${depId}\``;
		if (!SATISFIED_STATUSES.includes(dep.status)) {
			return `waiting on \`${dep.id}\` (${dep.status})`;
		}
	}
	return null;
}

// ─── Internal agent graph ────────────────────────────────────────────────────

/**
 * Topologically sort agents within a deliverable. Returns agent names in execution
 * order. Throws if the graph has cycles.
 */
export function topologicalSort(
	g: Pick<Deliverable, "agents" | "worker">,
): string[] {
	const allNames = new Set(["worker", ...g.agents.map((a) => a.name)]);

	// Build adjacency: name → names that must complete before it
	const deps = new Map<string, string[]>();
	deps.set(
		"worker",
		(g.worker.after ?? []).filter((n) => allNames.has(n)),
	);
	for (const agent of g.agents) {
		deps.set(
			agent.name,
			agent.after.filter((n) => allNames.has(n)),
		);
	}

	const sorted: string[] = [];
	const visited = new Set<string>();
	const visiting = new Set<string>();

	const visit = (name: string): void => {
		if (visited.has(name)) return;
		if (visiting.has(name)) {
			throw new Error(
				`cycle in agent graph: ${name} is part of a dependency cycle`,
			);
		}
		visiting.add(name);
		for (const dep of deps.get(name) ?? []) {
			visit(dep);
		}
		visiting.delete(name);
		visited.add(name);
		sorted.push(name);
	};

	for (const name of allNames) {
		visit(name);
	}

	return sorted;
}

/**
 * Get agents (and/or worker) that can start immediately — those with no
 * unmet `after` dependencies.
 */
export function immediateAgents(
	g: Pick<Deliverable, "agents" | "worker">,
): string[] {
	const result: string[] = [];
	if ((g.worker.after ?? []).length === 0) {
		result.push("worker");
	}
	for (const agent of g.agents) {
		if (agent.after.length === 0) {
			result.push(agent.name);
		}
	}
	return result;
}

/**
 * Given a set of completed agent names, return which agents are now unblocked.
 */
export function unblockedAgents(
	g: Pick<Deliverable, "agents" | "worker">,
	completed: ReadonlySet<string>,
): string[] {
	const result: string[] = [];

	// Check worker
	const workerAfter = g.worker.after ?? [];
	if (
		!completed.has("worker") &&
		workerAfter.length > 0 &&
		workerAfter.every((dep) => completed.has(dep))
	) {
		result.push("worker");
	}

	// Check agents
	for (const agent of g.agents) {
		if (completed.has(agent.name)) continue;
		if (agent.after.length === 0) continue; // Already started immediately
		if (agent.after.every((dep) => completed.has(dep))) {
			result.push(agent.name);
		}
	}

	return result;
}

// ─── Branch logic ────────────────────────────────────────────────────────────

export function defaultBranchForDeliverable(
	g: Pick<Deliverable, "id">,
): string {
	return `feat/${g.id}`;
}

/**
 * Parent statuses a dependent may stack on: the parent's branch tip actually
 * holds its work (shipped, or complete and awaiting ship).
 */
const STACKABLE_STATUSES: readonly DeliverableStatus[] = [
	"complete",
	"shipped",
];

/**
 * Pick the base branch a deliverable forks from (and its PR targets).
 * Stacked (default): the first dependency that actually produced work —
 * non-productive parents (abandoned/superseded) and parents that haven't
 * completed yet are skipped, falling through to the next dep and finally
 * the default branch.
 * Independent (stacked: false): the default branch.
 */
export function pickBaseBranch(
	plan: Pick<Plan, "deliverables">,
	g: Pick<Deliverable, "id" | "dependsOn" | "stacked">,
	defaultBranch: string,
): string {
	const deps = g.dependsOn ?? [];
	if (deps.length === 0) return defaultBranch;

	// Explicit opt-out of stacking
	if (g.stacked === false) return defaultBranch;

	// Stacked: base off the first dependency whose branch holds real work
	for (const depId of deps) {
		const parent = findDeliverable(plan, depId);
		if (!parent?.branch) continue;
		if (!STACKABLE_STATUSES.includes(parent.status)) continue;
		return parent.branch;
	}
	return defaultBranch;
}

// ─── IDs ─────────────────────────────────────────────────────────────────────

export function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/, "");
}

/**
 * Derive a plan slug + title from seed text (typically the first planning
 * message), falling back to `fallback` (typically the repo name) when the seed
 * is empty or slugifies to nothing.
 */
export function derivePlanName(
	seed: string | undefined,
	fallback: string,
): { slug: string; title: string } {
	const source = ((seed ?? "").trim() || fallback).trim();
	const firstLine = source.split(/\r?\n/)[0]?.trim() ?? "";
	const words = firstLine.split(/\s+/).filter(Boolean);
	const title = words.slice(0, 8).join(" ") || fallback;
	const slug =
		slugify(words.slice(0, 6).join(" ")) || slugify(fallback) || "plan";
	return { slug, title };
}

export function repoNameFromPath(path: string): string {
	const name = basename(resolve(path));
	return name === "" ? "repo" : name;
}

// ─── Validation ──────────────────────────────────────────────────────────────

/** Structural invariants enforced before saving. Empty array = valid. */
export function validatePlanShape(
	plan: Pick<Plan, "deliverables" | "repos">,
): string[] {
	const problems: string[] = [];
	const deliverableIds = new Set(plan.deliverables.map((g) => g.id));

	// Repo key validation
	const repoKeys = new Set<string>([DEFAULT_REPO_KEY]);
	for (const r of plan.repos ?? []) {
		if (repoKeys.has(r.key)) {
			problems.push(`duplicate repo key \`${r.key}\``);
		}
		if (!r.path) {
			problems.push(`repo \`${r.key}\` has an empty path`);
		}
		repoKeys.add(r.key);
	}

	for (const g of plan.deliverables) {
		// dependsOn references exist
		for (const dep of g.dependsOn ?? []) {
			if (!deliverableIds.has(dep)) {
				problems.push(
					`deliverable \`${g.id}\` depends on unknown deliverable \`${dep}\``,
				);
			}
		}

		// Worker must have tasks (for full-mode workers that are active)
		if (
			g.worker.mode === "full" &&
			g.status !== "planned" &&
			gatingTasks(g).length === 0
		) {
			problems.push(
				`deliverable \`${g.id}\` has a full-mode worker but no gating tasks`,
			);
		}

		// Agent name uniqueness
		const agentNames = new Set<string>();
		for (const agent of g.agents) {
			if (agent.name === "worker") {
				problems.push(
					`deliverable \`${g.id}\`: agent name "worker" is reserved`,
				);
			}
			if (agentNames.has(agent.name)) {
				problems.push(
					`deliverable \`${g.id}\`: duplicate agent name \`${agent.name}\``,
				);
			}
			agentNames.add(agent.name);
		}

		// Agent `after` references valid
		const validRefs = new Set(["worker", ...agentNames]);
		const workerAfter = g.worker.after ?? [];
		for (const ref of workerAfter) {
			if (!agentNames.has(ref)) {
				problems.push(
					`deliverable \`${g.id}\`: worker after references unknown agent \`${ref}\``,
				);
			}
		}
		for (const agent of g.agents) {
			for (const ref of agent.after) {
				if (!validRefs.has(ref)) {
					problems.push(
						`deliverable \`${g.id}\`: agent \`${agent.name}\` after references unknown \`${ref}\``,
					);
				}
			}
		}

		// Cycle check within agent graph
		try {
			topologicalSort(g);
		} catch {
			problems.push(
				`deliverable \`${g.id}\`: agent dependency graph has a cycle`,
			);
		}

		// stacked only meaningful with dependsOn
		if (g.stacked === false && (g.dependsOn ?? []).length === 0) {
			problems.push(
				`deliverable \`${g.id}\`: stacked=false is meaningless without dependsOn`,
			);
		}
	}

	// Cross-deliverable cycle check
	const colour = new Map<string, "visiting" | "done">();
	const visit = (id: string, trail: string[]): void => {
		const state = colour.get(id);
		if (state === "done") return;
		if (state === "visiting") {
			problems.push(`dependsOn cycle: ${[...trail, id].join(" → ")}`);
			return;
		}
		colour.set(id, "visiting");
		const g = findDeliverable(plan, id);
		for (const dep of g?.dependsOn ?? []) {
			if (deliverableIds.has(dep)) visit(dep, [...trail, id]);
		}
		colour.set(id, "done");
	};
	for (const g of plan.deliverables) visit(g.id, []);

	return problems;
}

/**
 * True once any deliverable in the plan has moved beyond "planned" status.
 */
export function hasExecutionStarted(plan: Pick<Plan, "deliverables">): boolean {
	return plan.deliverables.some((g) => g.status !== "planned");
}

/**
 * Guard against acting on the wrong repo.
 */
export function planRepoMismatch(
	planTop: string | null,
	sessionTop: string | null,
	planRepoPath: string,
	sessionCwd: string,
): string | null {
	if (sessionTop === null) {
		return `session cwd is not inside a git repo: ${sessionCwd}`;
	}
	if (planTop === null) {
		return `plan repo is not a git repo: ${planRepoPath}`;
	}
	if (resolve(sessionTop) !== resolve(planTop)) {
		return (
			`session repo (${sessionTop}) is not the plan's repo (${planTop}); ` +
			"refusing to act on the wrong repo — re-run from the plan's checkout"
		);
	}
	return null;
}

// ─── Summary budget ──────────────────────────────────────────────────────────

/** Default token budget for cross-deliverable summaries before compression kicks in. */
export const SUMMARY_TOKEN_BUDGET = 5000;
