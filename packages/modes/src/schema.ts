// The plan model: a flat list of WorkGroups. A WorkGroup is the atomic unit of
// execution — one branch, one PR. It contains a worker (primary agent), zero or
// more support agents with an internal dependency graph, and a set of tasks.
//
// This replaces the v4 deliverable-tree model. No on-disk migration (dev tool).
// Clean break: groups replace deliverables entirely.

import { basename, resolve } from "node:path";
import {
	type AgentMode,
	GROUP_STATUSES,
	type GroupStatus,
	type ModelSlot,
	type ThinkingLevel,
	WORK_ITEM_KINDS,
	type WorkItemKind,
} from "@vegardx/pi-contracts";

export {
	type AgentMode,
	GROUP_STATUSES,
	type GroupStatus,
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
	/** Unique name within the group (also used in `after` references). */
	name: string;
	mode: AgentMode;
	slot: ModelSlot;
	effort: ThinkingLevel;
	/** What this agent should focus on — specific, actionable instructions. */
	focus: string;
	/** Dependencies: "worker" or other agent names. Empty = start immediately. */
	after: string[];
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

// ─── Work group ──────────────────────────────────────────────────────────────

export interface WorkGroup {
	type: "group";
	id: string;
	title: string;
	/** What ships when this merges — context, criteria. */
	body: string;
	status: GroupStatus;
	/** Inter-group dependencies. Empty/absent = no deps (root). */
	dependsOn?: string[];
	/**
	 * Branch from predecessor's tip (stacked PR). Default true.
	 * Set false to branch from main (independent PR).
	 * Only meaningful when dependsOn is non-empty.
	 */
	stacked?: boolean;
	/** The primary agent — always exists, gets the group's tasks. */
	worker: WorkerSpec;
	/** Support agents with an internal dependency graph. */
	agents: AgentSpec[];
	/** Gating work items the worker must complete. */
	tasks: WorkItem[];
	/** Review→fix round cap before the group blocks. Default 2. */
	maxFixRounds?: number;
	// ── Runtime state ──
	/** Git branch (typically feat/<id>). */
	branch?: string;
	/** Worktree path while active; cleared on completion. */
	worktreePath?: string;
	/** Session file path for the worker session. */
	sessionPath?: string;
	/** Combined summary of all agent outputs (produced at group completion). */
	summary?: string;
	/** PR URL once shipped. */
	prUrl?: string;
	prNumber?: number;
	createdAt: string;
	updatedAt: string;
}

// ─── Plan ────────────────────────────────────────────────────────────────────

/** A repo a plan can target. The default repo is `plan.repoPath` (key "default"). */
export interface PlanRepo {
	/** Stable key groups reference (currently unused but reserved). */
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
	/** Extra repos beyond the default; absent ⇒ single-repo plan. */
	repos?: PlanRepo[];
	/** All work groups in the plan. Flat list — graph structure via dependsOn. */
	groups: WorkGroup[];
	/** GitHub plan-tracking issue (parent of group issues) after park. */
	parentIssueNumber?: number;
	/** Session file backing this plan's planning session. */
	planSessionPath?: string;
	lastSyncedAt?: string;
	createdAt: string;
	updatedAt: string;
}

// ─── Traversal helpers ───────────────────────────────────────────────────────

/** All groups in the plan. */
export function groups(plan: Pick<Plan, "groups">): WorkGroup[] {
	return plan.groups;
}

/** Find a group by ID. */
export function findGroup(
	plan: Pick<Plan, "groups">,
	id: string,
): WorkGroup | null {
	return plan.groups.find((g) => g.id === id) ?? null;
}

/** All tasks in a group. */
export function groupTasks(g: Pick<WorkGroup, "tasks">): WorkItem[] {
	return g.tasks;
}

/** Gating tasks (kind = "task") that must be completed. */
export function gatingTasks(g: Pick<WorkGroup, "tasks">): WorkItem[] {
	return g.tasks.filter((t) => effectiveWorkItemKind(t) === "task");
}

/** Find a task by ID within a group. */
export function findTask(
	g: Pick<WorkGroup, "tasks">,
	taskId: string,
): WorkItem | null {
	return g.tasks.find((t) => t.id === taskId) ?? null;
}

/** Find an agent spec by name within a group. */
export function findAgent(
	g: Pick<WorkGroup, "agents">,
	name: string,
): AgentSpec | null {
	return g.agents.find((a) => a.name === name) ?? null;
}

// ─── State machine ───────────────────────────────────────────────────────────

export const GROUP_TRANSITIONS: Record<GroupStatus, readonly GroupStatus[]> = {
	planned: ["active", "abandoned"],
	active: ["complete", "abandoned"],
	complete: ["shipped", "superseded", "abandoned"],
	shipped: [],
	superseded: [],
	abandoned: [],
};

/** Terminal statuses — the group will not transition again. */
export const TERMINAL_STATUSES: readonly GroupStatus[] = [
	"shipped",
	"superseded",
	"abandoned",
];

export function canTransition(from: GroupStatus, to: GroupStatus): boolean {
	return GROUP_TRANSITIONS[from].includes(to);
}

// ─── Dependency / activation logic ───────────────────────────────────────────

/** Statuses that satisfy a downstream dependency. */
const SATISFIED_STATUSES: readonly GroupStatus[] = [
	"active",
	"complete",
	"shipped",
];

/**
 * A group is ready to activate when all its dependsOn groups are in a
 * satisfied status (active, complete, or shipped).
 */
export function isGroupReady(
	plan: Pick<Plan, "groups">,
	g: Pick<WorkGroup, "id" | "status" | "dependsOn">,
): boolean {
	if (g.status !== "planned") return false;
	const deps = g.dependsOn ?? [];
	if (deps.length === 0) return true;
	return deps.every((depId) => {
		const dep = findGroup(plan, depId);
		if (!dep) return false;
		return SATISFIED_STATUSES.includes(dep.status);
	});
}

/** All groups that are ready to be activated. */
export function readyGroups(plan: Pick<Plan, "groups">): WorkGroup[] {
	return plan.groups.filter((g) => isGroupReady(plan, g));
}

/** Groups that are terminal (no further transitions). */
export function terminalGroups(plan: Pick<Plan, "groups">): WorkGroup[] {
	return plan.groups.filter((g) => TERMINAL_STATUSES.includes(g.status));
}

/**
 * A group is terminal in the dependency graph (nothing depends on it).
 * Terminal groups ship immediately when complete.
 */
export function isLeafGroup(
	plan: Pick<Plan, "groups">,
	g: Pick<WorkGroup, "id">,
): boolean {
	return !plan.groups.some((other) => other.dependsOn?.includes(g.id) ?? false);
}

/**
 * Groups that have completed and are ready to ship (complete + no dependents).
 */
export function shippableGroups(plan: Pick<Plan, "groups">): WorkGroup[] {
	return plan.groups.filter(
		(g) => g.status === "complete" && isLeafGroup(plan, g),
	);
}

/** Why a group can't activate yet. Null if ready. */
export function blockedReason(
	plan: Pick<Plan, "groups">,
	g: Pick<WorkGroup, "id" | "status" | "dependsOn">,
): string | null {
	if (g.status !== "planned") {
		return `group \`${g.id}\` is ${g.status}, not planned`;
	}
	const deps = g.dependsOn ?? [];
	if (deps.length === 0) return null;
	for (const depId of deps) {
		const dep = findGroup(plan, depId);
		if (!dep) return `unknown dependency \`${depId}\``;
		if (!SATISFIED_STATUSES.includes(dep.status)) {
			return `waiting on \`${dep.id}\` (${dep.status})`;
		}
	}
	return null;
}

// ─── Internal agent graph ────────────────────────────────────────────────────

/**
 * Topologically sort agents within a group. Returns agent names in execution
 * order. Throws if the graph has cycles.
 */
export function topologicalSort(
	g: Pick<WorkGroup, "agents" | "worker">,
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
	g: Pick<WorkGroup, "agents" | "worker">,
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
	g: Pick<WorkGroup, "agents" | "worker">,
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

export function defaultBranchForGroup(g: Pick<WorkGroup, "id">): string {
	return `feat/${g.id}`;
}

/**
 * Pick the base branch a group should fork from.
 * Stacked (default): fork from first dependency's branch tip.
 * Independent (stacked: false): fork from defaultBranch.
 */
export function pickBaseBranch(
	plan: Pick<Plan, "groups">,
	g: Pick<WorkGroup, "id" | "dependsOn" | "stacked">,
	defaultBranch: string,
): string {
	const deps = g.dependsOn ?? [];
	if (deps.length === 0) return defaultBranch;

	// Explicit opt-out of stacking
	if (g.stacked === false) return defaultBranch;

	// Stacked: base off the first dependency's branch
	const parent = findGroup(plan, deps[0]);
	if (!parent?.branch) return defaultBranch;
	return parent.branch;
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
	plan: Pick<Plan, "groups" | "repos">,
): string[] {
	const problems: string[] = [];
	const groupIds = new Set(plan.groups.map((g) => g.id));

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

	for (const g of plan.groups) {
		// dependsOn references exist
		for (const dep of g.dependsOn ?? []) {
			if (!groupIds.has(dep)) {
				problems.push(`group \`${g.id}\` depends on unknown group \`${dep}\``);
			}
		}

		// Worker must have tasks (for full-mode workers that are active)
		if (
			g.worker.mode === "full" &&
			g.status !== "planned" &&
			gatingTasks(g).length === 0
		) {
			problems.push(
				`group \`${g.id}\` has a full-mode worker but no gating tasks`,
			);
		}

		// Agent name uniqueness
		const agentNames = new Set<string>();
		for (const agent of g.agents) {
			if (agent.name === "worker") {
				problems.push(`group \`${g.id}\`: agent name "worker" is reserved`);
			}
			if (agentNames.has(agent.name)) {
				problems.push(
					`group \`${g.id}\`: duplicate agent name \`${agent.name}\``,
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
					`group \`${g.id}\`: worker after references unknown agent \`${ref}\``,
				);
			}
		}
		for (const agent of g.agents) {
			for (const ref of agent.after) {
				if (!validRefs.has(ref)) {
					problems.push(
						`group \`${g.id}\`: agent \`${agent.name}\` after references unknown \`${ref}\``,
					);
				}
			}
		}

		// Cycle check within agent graph
		try {
			topologicalSort(g);
		} catch {
			problems.push(`group \`${g.id}\`: agent dependency graph has a cycle`);
		}

		// stacked only meaningful with dependsOn
		if (g.stacked === false && (g.dependsOn ?? []).length === 0) {
			problems.push(
				`group \`${g.id}\`: stacked=false is meaningless without dependsOn`,
			);
		}
	}

	// Cross-group cycle check
	const colour = new Map<string, "visiting" | "done">();
	const visit = (id: string, trail: string[]): void => {
		const state = colour.get(id);
		if (state === "done") return;
		if (state === "visiting") {
			problems.push(`dependsOn cycle: ${[...trail, id].join(" → ")}`);
			return;
		}
		colour.set(id, "visiting");
		const g = findGroup(plan, id);
		for (const dep of g?.dependsOn ?? []) {
			if (groupIds.has(dep)) visit(dep, [...trail, id]);
		}
		colour.set(id, "done");
	};
	for (const g of plan.groups) visit(g.id, []);

	return problems;
}

/**
 * True once any group in the plan has moved beyond "planned" status.
 */
export function hasExecutionStarted(plan: Pick<Plan, "groups">): boolean {
	return plan.groups.some((g) => g.status !== "planned");
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

/** Default token budget for cross-group summaries before compression kicks in. */
export const SUMMARY_TOKEN_BUDGET = 5000;
