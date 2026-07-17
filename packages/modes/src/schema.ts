// The plan model: a flat list of Deliverables. A Deliverable is the atomic unit of
// execution — one branch, one PR. It contains a worker (primary agent), zero or
// more support agents with an internal dependency graph, and a set of tasks.
//
// This replaces the v4 deliverable-tree model. No on-disk migration (dev tool).
// Clean break: deliverables replace deliverables entirely.

import { basename, resolve } from "node:path";
import {
	type AgentMode,
	DELIVERABLE_TRANSITIONS as CONTRACT_DELIVERABLE_TRANSITIONS,
	DELIVERABLE_STATUSES,
	type DeliverableStatus,
	type DeliveryFailure,
	PLAN_SCHEMA_VERSION,
	type ResolvedAgentAssignment,
	type StructuredFinding,
	type ThinkingLevel,
	type TransitionGate,
	validateResolvedAgentAssignment,
	validateStructuredFinding,
	validateTransitionGate,
	WORK_ITEM_KINDS,
	type WorkItemKind,
} from "@vegardx/pi-contracts";
import type { ReviewLedger } from "./exec/findings.js";

export {
	type AgentMode,
	DELIVERABLE_STATUSES,
	type DeliverableStatus,
	type DeliveryFailure,
	PLAN_SCHEMA_VERSION,
	type ResolvedAgentAssignment,
	type StructuredFinding,
	type ThinkingLevel,
	type TransitionGate,
	type ModeTransitionGate,
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

// ─── Resolved assignment workflow ───────────────────────────────────────────

/** A stage runs every member concurrently against this one immutable revision. */
export interface WorkflowStageSpec {
	/** Stable plan-scoped stage id. */
	id: string;
	/** Stage ids that must satisfy their barrier before this stage starts. */
	after: string[];
	/** Every assignment appears in exactly one stage and runs once. */
	assignmentIds: string[];
	/** Immutable SHA/revision/digest shared by every member of this stage. */
	inputRevision: string;
	/** Contracts made available to every member at inputRevision. */
	inputContracts: string[];
	/** A worker barrier waits for worker assignments; all waits for every member. */
	barrier: "all" | "workers";
}

export interface AgentWorkflow {
	assignments: ResolvedAgentAssignment[];
	stages: WorkflowStageSpec[];
}

export interface AgentSpec {
	/** Unique name within the deliverable (also used in `after` references). */
	name: string;
	mode: AgentMode;
	/** Optional exact worker-pool model choice, persisted across resume. */
	model?: string;
	/** Optional exact worker-pool effort choice. */
	effort?: ThinkingLevel;
	/** What this agent should focus on — specific, actionable instructions. */
	focus: string;
	/** Dependencies: "worker" or other agent names. Empty = start immediately. */
	after: string[];
}

// ─── Sub-agent specification (persona panel) ─────────────────────────────────

/**
 * One entry in a deliverable's up-front sub-agent plan (Phase 7). The worker
 * runs these as headless one-shot subagents. Reviewers resolve the active
 * `reviewer` role pool; exact optional model/effort choices persist in the spec.
 */
export interface SubAgentSpec {
	/** Unique name within the deliverable. */
	name: string;
	/** Persona id from the registry (PERSONAS). */
	persona: string;
	/** Optional per-deliverable specialization of the persona's focus. */
	focus?: string;
	/** Optional exact reviewer-pool model choice. */
	model?: string;
	/** Required rationale when this persona is intentionally run on another model. */
	modelJustification?: string;
	/** Effort override; defaults through reviewer policy/persona behavior. */
	effort?: ThinkingLevel;
	/** "review" = verdict-gated; "helper" = info scout. Default "review". */
	kind?: "review" | "helper";
	/** Required reviews must reach SHIPPED before the deliverable ships. */
	required?: boolean;
}

// ─── Worker specification ────────────────────────────────────────────────────

export interface WorkerSpec {
	mode: AgentMode;
	/** Optional exact worker-pool model choice, persisted across resume. */
	model?: string;
	/** Thinking effort. Defaults to the worker pool's first compatible effort. */
	effort?: ThinkingLevel;
	/** Agents that must finish before worker starts. Empty/absent = start first. */
	after?: string[];
}

export type WorkerRestartMode = "resume" | "fresh";
export type WorkerRestartState = "idle" | "restarting" | "running" | "blocked";

/** Historical worker transcripts retained when a fresh session replaces one. */
export const MAX_PREVIOUS_WORKER_SESSIONS = 5;

export interface PlanRepairAuditEvent {
	id: string;
	at: string;
	baseFingerprint: string;
	reason: string;
	deliverableIds: string[];
	operations: string[];
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
	/**
	 * Where the worker runs. "repo" (default): a git worktree on a branch,
	 * shipped as a PR. "scratch": a plain directory under the plan dir — for
	 * work not tied to any repo (creating repos, provisioning infra, ops).
	 * A scratch deliverable has no branch and no PR; it "ships" when its
	 * required review verdicts are satisfied and its summary is recorded.
	 */
	workspace?: "repo" | "scratch";
	/**
	 * Repo registry key this deliverable targets (see Plan.repos); absent ⇒
	 * the plan's default repo. Meaningless for scratch deliverables.
	 */
	repo?: string;
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
	/** Fix+verify cycle cap before the deliverable blocks. Default 3. */
	maxFixRounds?: number;
	// ── Runtime state ──
	/** Git branch (typically feat/<id>). */
	branch?: string;
	/** Immutable commit the delivery branch was created from. */
	baseSha?: string;
	/** Last clean committed revision inspected by a completed code stage. */
	lastReviewedHead?: string;
	/** Worktree path while active; cleared on completion. */
	worktreePath?: string;
	/**
	 * Session file path for the worker session. Persisted at spawn so a
	 * restarted maestro can respawn the worker RESUMED (pi appends to the
	 * session file in place — the transcript survives the process).
	 */
	sessionPath?: string;
	/** Worker tmux session name; persisted at spawn for orphan cleanup on recovery. */
	sessionName?: string;
	/**
	 * Monotonic worker replacement epoch. Plans written before epochs existed
	 * omit it and hydrate as generation 0 via workerSessionGeneration().
	 */
	sessionGeneration?: number;
	/** Older durable transcript paths, newest last and bounded. */
	previousSessionPaths?: string[];
	/** Last explicit replacement mode and its durable lifecycle state. */
	restartMode?: WorkerRestartMode;
	restartState?: WorkerRestartState;
	/** Combined summary of all agent outputs (produced at deliverable completion). */
	summary?: string;
	/** PR URL once shipped. */
	prUrl?: string;
	prNumber?: number;
	/**
	 * Human gate overrides, recorded permanently. A waiver is the durable
	 * counterpart of overrideReviewerVerdict's in-memory verdict: /verify
	 * treats waived findings as acknowledged instead of re-flagging them.
	 */
	waivers?: ReviewWaiver[];
	/**
	 * The panel review ledger (minted findings + resolution state across fix
	 * cycles). Persisted so the gate survives worker respawns and maestro
	 * restarts — the in-memory verdict maps are a cache of this, never the
	 * source of truth.
	 */
	reviewLedger?: ReviewLedger;
	/** Recoverable or terminal failure detail when status is `failed`. */
	failure?: DeliveryFailure;
	/** Durable transition evidence; malformed gates fail plan validation. */
	gates?: TransitionGate[];
	/** Canonical cross-workflow findings. */
	findings?: StructuredFinding[];
	/** First completion timestamp; retained if review reopens the delivery. */
	completedAt?: string;
	createdAt: string;
	updatedAt: string;
}

/** A human's recorded acceptance of a blocking review verdict (gate override). */
export interface ReviewWaiver {
	/** Reviewer whose verdict the human overrode. */
	reviewer: string;
	/** The mandatory override note — why the findings don't block. */
	reason: string;
	/**
	 * Canonical ledger id of the waived finding (when the waiver targets one
	 * finding rather than a whole verdict). claim/file carry the durable
	 * identity across systems — panel ids and /verify ids never match, so
	 * cross-loop matching is semantic (claim text), not by id.
	 */
	findingId?: string;
	claim?: string;
	file?: string;
	at: string;
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
	/** Stable key deliverables reference via `Deliverable.repo`. */
	key: string;
	/** Absolute path to the repo. */
	path: string;
	/** Cached default branch; detected at use when absent. */
	defaultBranch?: string;
	/**
	 * Late-bound repo: the deliverable expected to materialize it at `path`
	 * (e.g. a scratch deliverable running `gh repo create` + clone). The path
	 * need not exist at plan time; every deliverable targeting this repo must
	 * (transitively) depend on `createdBy`, so the DAG guarantees the repo
	 * exists before any dependent activates.
	 */
	createdBy?: string;
}

export const DEFAULT_REPO_KEY = "default";

export interface Plan {
	schemaVersion: typeof PLAN_SCHEMA_VERSION;
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
	/** Fully resolved immutable assignments and their explicit stage DAG. */
	workflow?: AgentWorkflow;
	/** All work deliverables in the plan. Flat list — graph structure via dependsOn. */
	deliverables: Deliverable[];
	/** GitHub plan-tracking issue (parent of deliverable issues) after park. */
	parentIssueNumber?: number;
	/** Session file backing this plan's planning session. */
	planSessionPath?: string;
	lastSyncedAt?: string;
	/** Immutable audit trail for narrow, fingerprinted debug repairs. */
	repairAudit?: PlanRepairAuditEvent[];
	/** Restart-safe requests and rulings for mode transition gates. */
	transitionGates?: ModeTransitionGate[];
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

// ─── Workspace / repo resolution ─────────────────────────────────────────────

/** Effective workspace kind; absent means repo-backed (the historical default). */
export function deliverableWorkspace(
	g: Pick<Deliverable, "workspace">,
): "repo" | "scratch" {
	return g.workspace ?? "repo";
}

/** Registry key of the repo a deliverable targets. */
export function deliverableRepoKey(
	deliverable: Pick<Deliverable, "repo">,
): string {
	return deliverable.repo ?? DEFAULT_REPO_KEY;
}

/**
 * Resolve the repo a deliverable targets: its registry entry when it names one,
 * else the plan's default repo. Callers must not assume the path exists on
 * disk — a late-bound entry (`createdBy`) materializes during execution.
 */
export function repoFor(
	plan: Pick<Plan, "repoPath" | "repos">,
	deliverable: Pick<Deliverable, "repo">,
): PlanRepo {
	const key = deliverableRepoKey(deliverable);
	const entry = plan.repos?.find((r) => r.key === key);
	return entry ?? { key: DEFAULT_REPO_KEY, path: plan.repoPath };
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
> = CONTRACT_DELIVERABLE_TRANSITIONS;

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
 * Cross-repo and scratch parents are never stacked on (no shared git
 * history / no branch at all) — those edges are ordering-only.
 */
export function pickBaseBranch(
	plan: Pick<Plan, "deliverables">,
	g: Pick<Deliverable, "id" | "dependsOn" | "stacked" | "repo">,
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
		if (deliverableWorkspace(parent) === "scratch") continue;
		if (deliverableRepoKey(parent) !== deliverableRepoKey(g)) continue;
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

export function workerSessionGeneration(
	deliverable: Pick<Deliverable, "sessionGeneration">,
): number {
	return deliverable.sessionGeneration ?? 0;
}

export function workerRestartState(
	deliverable: Pick<Deliverable, "restartState">,
): WorkerRestartState {
	return deliverable.restartState ?? "idle";
}

export function boundedPreviousSessionPaths(
	paths: readonly string[],
): string[] {
	return [...new Set(paths.filter((path) => path.trim().length > 0))].slice(
		-MAX_PREVIOUS_WORKER_SESSIONS,
	);
}

// ─── Validation ──────────────────────────────────────────────────────────────

export function validateWorkflowGraph(workflow: AgentWorkflow): string[] {
	const problems: string[] = [];
	const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
	const assignments = new Map<string, ResolvedAgentAssignment>();
	for (const assignment of workflow.assignments) {
		if (!idPattern.test(assignment.agentId))
			problems.push(
				`workflow assignment id \`${assignment.agentId}\` is invalid`,
			);
		if (assignments.has(assignment.agentId))
			problems.push(
				`duplicate workflow assignment id \`${assignment.agentId}\``,
			);
		assignments.set(assignment.agentId, assignment);
		for (const problem of validateResolvedAgentAssignment(assignment))
			problems.push(
				`workflow assignment \`${assignment.agentId}\`: ${problem}`,
			);
	}

	const stages = new Map<string, WorkflowStageSpec>();
	for (const stage of workflow.stages) {
		if (!idPattern.test(stage.id))
			problems.push(`workflow stage id \`${stage.id}\` is invalid`);
		if (stages.has(stage.id))
			problems.push(`duplicate workflow stage id \`${stage.id}\``);
		stages.set(stage.id, stage);
		if (!stage.inputRevision.trim())
			problems.push(`workflow stage \`${stage.id}\` inputRevision is empty`);
		if (stage.assignmentIds.length === 0)
			problems.push(`workflow stage \`${stage.id}\` has no assignments`);
		if (new Set(stage.assignmentIds).size !== stage.assignmentIds.length)
			problems.push(`workflow stage \`${stage.id}\` repeats an assignment`);
		if (new Set(stage.after).size !== stage.after.length)
			problems.push(
				`workflow stage \`${stage.id}\` repeats an after dependency`,
			);
		if (new Set(stage.inputContracts).size !== stage.inputContracts.length)
			problems.push(`workflow stage \`${stage.id}\` repeats an input contract`);
	}

	const membership = new Map<string, string>();
	for (const stage of workflow.stages) {
		for (const assignmentId of stage.assignmentIds) {
			if (!assignments.has(assignmentId))
				problems.push(
					`workflow stage \`${stage.id}\` references unknown assignment \`${assignmentId}\``,
				);
			const previous = membership.get(assignmentId);
			if (previous)
				problems.push(
					`workflow assignment \`${assignmentId}\` appears in stages \`${previous}\` and \`${stage.id}\``,
				);
			else membership.set(assignmentId, stage.id);
			const assignment = assignments.get(assignmentId);
			if (assignment) {
				for (const contract of assignment.inputContracts) {
					if (!stage.inputContracts.includes(contract))
						problems.push(
							`workflow stage \`${stage.id}\` does not provide contract \`${contract}\` required by \`${assignmentId}\``,
						);
				}
			}
		}
		if (
			stage.barrier === "workers" &&
			!stage.assignmentIds.some((id) => assignments.get(id)?.kind === "worker")
		)
			problems.push(
				`workflow stage \`${stage.id}\` has a worker barrier but no worker assignment`,
			);
		for (const dependency of stage.after) {
			if (!stages.has(dependency))
				problems.push(
					`workflow stage \`${stage.id}\` after references unknown stage \`${dependency}\``,
				);
		}
	}
	for (const assignmentId of assignments.keys()) {
		if (!membership.has(assignmentId))
			problems.push(
				`workflow assignment \`${assignmentId}\` is not in a stage`,
			);
	}

	const ancestors = (
		stageId: string,
		visiting = new Set<string>(),
	): Set<string> => {
		if (visiting.has(stageId)) {
			problems.push(`workflow stage dependency cycle includes \`${stageId}\``);
			return new Set();
		}
		visiting.add(stageId);
		const result = new Set<string>();
		for (const dependency of stages.get(stageId)?.after ?? []) {
			if (!stages.has(dependency)) continue;
			result.add(dependency);
			for (const ancestor of ancestors(dependency, new Set(visiting)))
				result.add(ancestor);
		}
		return result;
	};
	for (const stage of workflow.stages) {
		const available = new Set<string>();
		for (const ancestorId of ancestors(stage.id)) {
			const ancestor = stages.get(ancestorId);
			for (const contract of ancestor?.inputContracts ?? [])
				available.add(contract);
			for (const assignmentId of ancestor?.assignmentIds ?? []) {
				for (const contract of assignments.get(assignmentId)?.outputContracts ??
					[])
					available.add(contract);
			}
		}
		if (stage.after.length > 0) {
			for (const contract of stage.inputContracts) {
				if (!available.has(contract))
					problems.push(
						`workflow stage \`${stage.id}\` input contract \`${contract}\` is not produced by an ancestor`,
					);
			}
		}
	}
	return [...new Set(problems)];
}

/** Structural invariants enforced before saving. Empty array = valid. */
export function validatePlanShape(
	plan: Pick<Plan, "schemaVersion" | "deliverables" | "repos" | "workflow">,
): string[] {
	const problems: string[] = [];
	if ("workflow" in plan && plan.workflow) {
		problems.push(...validateWorkflowGraph(plan.workflow));
	}
	if (plan.schemaVersion !== PLAN_SCHEMA_VERSION) {
		problems.push(`schemaVersion must be ${PLAN_SCHEMA_VERSION}`);
	}
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
		if (r.createdBy !== undefined && !deliverableIds.has(r.createdBy)) {
			problems.push(
				`repo \`${r.key}\` createdBy references unknown deliverable \`${r.createdBy}\``,
			);
		}
		repoKeys.add(r.key);
	}

	// All deps reachable from a deliverable (memoized; cycles reported separately).
	const reachable = new Map<string, Set<string>>();
	const depsOf = (id: string, seen: Set<string>): Set<string> => {
		const cached = reachable.get(id);
		if (cached) return cached;
		const out = new Set<string>();
		if (!seen.has(id)) {
			seen.add(id);
			for (const dep of findDeliverable(plan, id)?.dependsOn ?? []) {
				out.add(dep);
				for (const d of depsOf(dep, seen)) out.add(d);
			}
		}
		reachable.set(id, out);
		return out;
	};

	for (const g of plan.deliverables) {
		if (!DELIVERABLE_STATUSES.includes(g.status)) {
			problems.push(
				`deliverable \`${g.id}\`: unsupported status \`${String(g.status)}\``,
			);
		}
		if (g.status === "failed" && !g.failure) {
			problems.push(
				`deliverable \`${g.id}\`: failed status requires failure detail`,
			);
		}
		if (g.failure) {
			if (!g.failure.code.trim() || !g.failure.message.trim()) {
				problems.push(
					`deliverable \`${g.id}\`: failure code and message must be non-empty`,
				);
			}
			if (!Number.isFinite(Date.parse(g.failure.failedAt))) {
				problems.push(
					`deliverable \`${g.id}\`: failure.failedAt must be an ISO timestamp`,
				);
			}
			if (!Number.isSafeInteger(g.failure.attempt) || g.failure.attempt < 1) {
				problems.push(
					`deliverable \`${g.id}\`: failure.attempt must be a positive safe integer`,
				);
			}
		}
		if (g.status !== "failed" && g.failure) {
			problems.push(
				`deliverable \`${g.id}\`: only failed status may carry failure detail`,
			);
		}
		if (g.completedAt !== undefined &&
			!Number.isFinite(Date.parse(g.completedAt))
		) {
			problems.push(
				`deliverable \`${g.id}\`: completedAt must be an ISO timestamp`,
			);
		}
		for (const [field, sha] of [
			["baseSha", g.baseSha],
			["lastReviewedHead", g.lastReviewedHead],
		] as const) {
			if (sha !== undefined && !/^[0-9a-f]{40}$/i.test(sha)) {
				problems.push(
					`deliverable \`${g.id}\`: ${field} must be an immutable 40-character commit SHA`,
				);
			}
		}
		for (const [index, finding] of (g.findings ?? []).entries()) {
			for (const problem of validateStructuredFinding(finding)) {
				problems.push(`deliverable \`${g.id}\` finding ${index}: ${problem}`);
			}
		}
		const findingIds = new Set((g.findings ?? []).map((finding) => finding.id));
		for (const [index, gate] of (g.gates ?? []).entries()) {
			for (const problem of validateTransitionGate(gate)) {
				problems.push(`deliverable \`${g.id}\` gate ${index}: ${problem}`);
			}
			for (const findingId of gate.findingIds ?? []) {
				if (!findingIds.has(findingId)) {
					problems.push(
						`deliverable \`${g.id}\` gate ${index}: unknown finding \`${findingId}\``,
					);
				}
			}
		}
		if (
			g.sessionGeneration !== undefined &&
			(!Number.isSafeInteger(g.sessionGeneration) || g.sessionGeneration < 0)
		) {
			problems.push(
				`deliverable \`${g.id}\`: sessionGeneration must be a non-negative safe integer`,
			);
		}
		if (
			g.previousSessionPaths !== undefined &&
			g.previousSessionPaths.length > MAX_PREVIOUS_WORKER_SESSIONS
		) {
			problems.push(
				`deliverable \`${g.id}\`: previousSessionPaths exceeds ${MAX_PREVIOUS_WORKER_SESSIONS}`,
			);
		}
		if (g.sessionPath && g.previousSessionPaths?.includes(g.sessionPath)) {
			problems.push(
				`deliverable \`${g.id}\`: current sessionPath cannot also be historical`,
			);
		}
		if (
			g.previousSessionPaths &&
			new Set(g.previousSessionPaths).size !== g.previousSessionPaths.length
		) {
			problems.push(
				`deliverable \`${g.id}\`: previousSessionPaths contains duplicates`,
			);
		}

		// Workspace / repo coherence
		if (deliverableWorkspace(g) === "scratch") {
			if (g.repo !== undefined) {
				problems.push(
					`deliverable \`${g.id}\` is scratch — it cannot target a repo`,
				);
			}
			if (g.stacked !== undefined) {
				problems.push(
					`deliverable \`${g.id}\` is scratch — stacked is meaningless (no branch)`,
				);
			}
		} else if (g.repo !== undefined && !repoKeys.has(g.repo)) {
			problems.push(
				`deliverable \`${g.id}\` targets unknown repo \`${g.repo}\``,
			);
		} else if (g.repo !== undefined) {
			// Late-bound repo: the creator must finish (transitively) first.
			const entry = (plan.repos ?? []).find((r) => r.key === g.repo);
			if (entry?.createdBy === g.id) {
				problems.push(
					`deliverable \`${g.id}\` targets repo \`${g.repo}\` it is supposed to create — the creator must be a scratch deliverable`,
				);
			} else if (
				entry?.createdBy !== undefined &&
				deliverableIds.has(entry.createdBy) &&
				!depsOf(g.id, new Set()).has(entry.createdBy)
			) {
				problems.push(
					`deliverable \`${g.id}\` targets repo \`${g.repo}\` created by \`${entry.createdBy}\` but does not depend on it (add it to dependsOn so the repo exists before activation)`,
				);
			}
		}

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

		// Review panel identity/model policy.
		const reviewerNames = new Set<string>();
		const personaModels = new Map<string, Set<string>>();
		for (const reviewer of g.subAgents ?? []) {
			if (reviewerNames.has(reviewer.name)) {
				problems.push(
					`deliverable \`${g.id}\`: duplicate reviewer name \`${reviewer.name}\``,
				);
			}
			reviewerNames.add(reviewer.name);
			if (!reviewer.model) continue;
			const models = personaModels.get(reviewer.persona) ?? new Set<string>();
			models.add(reviewer.model);
			personaModels.set(reviewer.persona, models);
		}
		for (const [persona, models] of personaModels) {
			if (models.size > 2) {
				problems.push(
					`deliverable \`${g.id}\`: persona \`${persona}\` uses more than two distinct models`,
				);
			}
			if (
				models.size > 1 &&
				!(g.subAgents ?? []).some(
					(item) => item.persona === persona && item.modelJustification?.trim(),
				)
			) {
				problems.push(
					`deliverable \`${g.id}\`: cross-model persona \`${persona}\` requires modelJustification`,
				);
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
