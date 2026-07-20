// The v2 plan model (plan-schema cutover PR-3): ONE recursive node type.
// v1's three-way split — Deliverable (persisted) vs WorkerSpec (embedded)
// vs AgentSpec (runtime state in-memory only) — collapses into PlanNode,
// and support agents become first-class ledger entries: every node persists
// its own status, session fields, and resolution. That is what makes the
// plan "the complete truthful record" for recovery/HUD/explain.
//
// Model fields are GONE from authored input (inheritance is the rule); the
// harness writes NodeResolution entries instead. Unwired until the flip PR:
// nothing imports this module except its tests and the v2 engine.

import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import type {
	DeliveryFailure,
	DiversityRecord,
	NodeAgentType,
	NodeEnvelope,
	NodeResolution,
	NodeStatus,
	NodeTaskKind,
	NodeWatchConfig,
	StructuredFinding,
	TransitionGate,
} from "@vegardx/pi-contracts";
import {
	DEFAULT_MAX_DEPTH,
	DELIVERABLE_STATUSES,
	DELIVERABLE_TRANSITIONS,
	NODE_AGENT_TYPES,
	PLAN_SCHEMA_VERSION_V2,
	validateNodeEnvelope,
} from "@vegardx/pi-contracts";

// ─── Tasks ───────────────────────────────────────────────────────────────────

export interface NodeTask {
	id: string;
	title: string;
	body: string;
	done: boolean;
	/** Absent = "task" (v1's effectiveWorkItemKind rule carries over). */
	kind?: NodeTaskKind;
	answer?: string;
	decidedAt?: string;
	createdAt: string;
	updatedAt: string;
}

export function effectiveNodeTaskKind(
	task: Pick<NodeTask, "kind">,
): NodeTaskKind {
	return task.kind ?? "task";
}

/** Kinds that gate node completion: real tasks plus the lifecycle pair. */
const GATING_KINDS = new Set<NodeTaskKind>(["task", "preflight", "postflight"]);

export function gatingNodeTasks(node: Pick<PlanNode, "tasks">): NodeTask[] {
	return node.tasks.filter((task) =>
		GATING_KINDS.has(effectiveNodeTaskKind(task)),
	);
}

// ─── The node ────────────────────────────────────────────────────────────────

export interface PlanNode {
	type: "node";
	/** Plan-UNIQUE id — node ids are RPC agent keys, tmux-name seeds, and
	 *  authoredBy refs, so uniqueness is across the whole tree. */
	id: string;
	agent: NodeAgentType;
	/** Persona name; registration validated against the layered registry. */
	persona: string;
	title?: string;
	/** Assignment prose (v1 Deliverable.body / AgentSpec.focus texture) —
	 *  seeds quote it; tasks carry the itemized work. */
	body?: string;
	tasks: NodeTask[];
	/** Knowledge skills loaded at start (persona frontmatter unioned on top). */
	skills?: string[];
	/**
	 * Sibling-scoped ordering + the reserved token "parent" (the parent's own
	 * gating tasks must be done first). Root nodes: plan-level ordering over
	 * sibling roots. Empty/absent = start when the parent activates.
	 */
	after?: string[];
	/** THE authored workspace fact: this node ships one PR from this branch. */
	branch?: string;
	/**
	 * Base override for branch-owning nodes. Absent = derived (nearest after
	 * dep owning a branch, stackable status — v1 pickBaseBranch verbatim).
	 * "default-branch" = v1's stacked:false.
	 */
	base?: "default-branch" | string;
	/** Repo registry key (multi-repo plans). Absent = the plan default repo. */
	repo?: string;
	envelope?: NodeEnvelope;
	watch?: NodeWatchConfig;
	/** Same-family spawn waiver, recorded into DiversityRecord at the edge. */
	diversityWaiver?: string;
	children?: PlanNode[];

	// ── Ledger provenance ──
	/** "plan" for planner-authored nodes; the authoring node's id for dynamic
	 *  children (written into the plan BEFORE spawn — no invisible spawns). */
	authoredBy: "plan" | string;
	appendedAt?: string;

	// ── Runtime state (persisted; formerly Deliverable runtime + AgentState) ──
	status: NodeStatus;
	/** Resolution history, newest last — one entry per session generation. */
	resolutions?: NodeResolution[];
	diversity?: DiversityRecord;
	baseSha?: string;
	lastReviewedHead?: string;
	worktreePath?: string;
	worktreeReapedAt?: string;
	sessionPath?: string;
	sessionName?: string;
	sessionGeneration?: number;
	previousSessionPaths?: string[];
	restartMode?: "resume" | "fresh";
	restartState?: "idle" | "restarting" | "running" | "blocked";
	/** Contract output — opaque envelope; shapes live in the contract system. */
	result?: { contract: string; payload: unknown; recordedAt: string };
	summary?: string;
	/** Downstream handoff written via the postflight toggle. Workers only. */
	handoff?: string;
	prUrl?: string;
	prNumber?: number;
	/** Per-PR provenance ledger (pr-provenance reads it; the shipper writes). */
	workflowAnalytics?: unknown;
	failure?: DeliveryFailure;
	findings?: StructuredFinding[];
	gates?: TransitionGate[];
	completedAt?: string;
	createdAt: string;
	updatedAt: string;
}

export interface PlanRepoV2 {
	key: string;
	path: string;
	createdBy?: string;
}

export interface PlanV2 {
	schemaVersion: typeof PLAN_SCHEMA_VERSION_V2;
	slug: string;
	title: string;
	repoPath: string;
	/** Profile binding BY NAME (profile-binding spike verdict). */
	profile?: string;
	/** The seat is depth 0; authored trees may nest ≤ maxDepth (default 3). */
	maxDepth?: number;
	defaultEnvelope?: NodeEnvelope;
	/** Planning UX phase (v1 PLAN_PHASES carries over; orthogonal to nodes). */
	phase?: "exploring" | "structuring";
	understanding?: string;
	repos?: PlanRepoV2[];
	/** The tree. Roots are v1's top-level deliverables. */
	nodes: PlanNode[];
	planSessionPath?: string;
	parentIssueNumber?: number;
	lastSyncedAt?: string;
	/** Gate RULINGS persist here (policy rows decide when gates RUN). */
	transitionGates?: TransitionGateRuling[];
	/** Fingerprint-pinned debug repairs — the only sanctioned post-start edit
	 *  channel beyond the append-only operations. */
	repairAudit?: PlanRepairAuditV2[];
	createdAt: string;
	updatedAt: string;
}

/** A mode-edge gate ruling (v1 ModeTransitionGate texture, engine-agnostic). */
export interface TransitionGateRuling {
	id: string;
	ruling: string;
	decidedAt: string;
	[key: string]: unknown;
}

export interface PlanRepairAuditV2 {
	id: string;
	reason: string;
	baseFingerprint: string;
	appliedAt: string;
	operations: readonly unknown[];
}

// ─── Traversal ───────────────────────────────────────────────────────────────

export interface NodeVisit {
	readonly node: PlanNode;
	readonly parent: PlanNode | null;
	/** Seat-relative depth: roots are 1 (the seat itself is 0). */
	readonly depth: number;
	/** Root-to-node id path, e.g. ["build-auth", "candidate-b"]. */
	readonly path: readonly string[];
}

/** Depth-first, parents before children, sibling order preserved. */
export function* walkNodes(plan: Pick<PlanV2, "nodes">): Generator<NodeVisit> {
	function* visit(
		node: PlanNode,
		parent: PlanNode | null,
		depth: number,
		path: readonly string[],
	): Generator<NodeVisit> {
		const here = [...path, node.id];
		yield { node, parent, depth, path: here };
		for (const child of node.children ?? [])
			yield* visit(child, node, depth + 1, here);
	}
	for (const root of plan.nodes) yield* visit(root, null, 1, []);
}

export function findNodeV2(
	plan: Pick<PlanV2, "nodes">,
	id: string,
): PlanNode | null {
	for (const { node } of walkNodes(plan)) if (node.id === id) return node;
	return null;
}

export function parentOfNode(
	plan: Pick<PlanV2, "nodes">,
	id: string,
): PlanNode | null {
	for (const { node, parent } of walkNodes(plan))
		if (node.id === id) return parent;
	return null;
}

/** Max seat-relative depth of the authored tree (0 for an empty plan). */
export function treeDepth(plan: Pick<PlanV2, "nodes">): number {
	let max = 0;
	for (const { depth } of walkNodes(plan)) if (depth > max) max = depth;
	return max;
}

/** Candidate branches are transport, never deliverables: they are minted at
 *  activation (cand/<parent>/<id>), recorded on the ledger for recovery and
 *  the HUD, cherry-picked by the parent, and reaped — a candidate must NEVER
 *  ship its own PR (ensemble invariant: zero candidate PRs, one parent PR). */
export function isCandidateBranch(branch: string | undefined): boolean {
	return branch !== undefined && branch.startsWith("cand/");
}

export function isBranchOwner(node: Pick<PlanNode, "branch">): boolean {
	return typeof node.branch === "string" && node.branch.length > 0;
}

/** Effective per-node child cap: node envelope, else plan default. */
export function effectiveMaxChildren(
	plan: Pick<PlanV2, "defaultEnvelope">,
	node: Pick<PlanNode, "envelope">,
): number | undefined {
	return node.envelope?.maxChildren ?? plan.defaultEnvelope?.maxChildren;
}

// ─── Readiness / shipping (v1 semantics over sibling groups) ─────────────────

/**
 * Statuses that satisfy a downstream dependency — v1's rule verbatim: the
 * dep must have finished producing, and terminal non-productive deps count
 * so a chain doesn't wedge (base derivation skips them).
 */
const SATISFIED_STATUSES: readonly NodeStatus[] = [
	"complete",
	"shipped",
	"superseded",
	"abandoned",
];

/** Statuses that end a dep for CHAIN purposes (failed included so a chain
 *  doesn't wedge behind a failed sibling; base derivation skips them). */
const DEP_TERMINAL_STATUSES: readonly NodeStatus[] = [
	"shipped",
	"failed",
	"abandoned",
	"superseded",
];

export const PARENT_AFTER_TOKEN = "parent";

/**
 * The ONE sibling-group scheduler (replaces v1's worker-special-cased
 * topologicalSort/immediateAgents/unblockedAgents pair): a planned node is
 * ready when every `after` entry is satisfied — sibling refs by status,
 * the "parent" token by the parent's own gating tasks being done.
 */
export function nodeReady(
	siblings: readonly PlanNode[],
	node: PlanNode,
	options: { parentGatingDone?: boolean } = {},
): boolean {
	if (node.status !== "planned") return false;
	for (const ref of node.after ?? []) {
		if (ref === PARENT_AFTER_TOKEN) {
			if (!options.parentGatingDone) return false;
			continue;
		}
		const dep = siblings.find((sibling) => sibling.id === ref);
		if (!dep || !SATISFIED_STATUSES.includes(dep.status)) return false;
	}
	return true;
}

/** Ready nodes within one sibling group, authored order preserved. */
export function readyChildren(
	siblings: readonly PlanNode[],
	options: { parentGatingDone?: boolean } = {},
): PlanNode[] {
	return siblings.filter((node) => nodeReady(siblings, node, options));
}

/** Why a node can't activate yet. Null if ready. (v1 blockedReason.) */
export function nodeBlockedReason(
	siblings: readonly PlanNode[],
	node: PlanNode,
	options: { parentGatingDone?: boolean } = {},
): string | null {
	if (node.status !== "planned")
		return `node \`${node.id}\` is ${node.status}, not planned`;
	for (const ref of node.after ?? []) {
		if (ref === PARENT_AFTER_TOKEN) {
			if (!options.parentGatingDone) return "waiting on the parent's own tasks";
			continue;
		}
		const dep = siblings.find((sibling) => sibling.id === ref);
		if (!dep) return `unknown dependency \`${ref}\``;
		if (!SATISFIED_STATUSES.includes(dep.status))
			return `waiting on \`${dep.id}\` (${dep.status})`;
	}
	return null;
}

/**
 * Branch-owning nodes ready to ship: complete, with every sibling `after`
 * dep terminal — shipping follows the chain (v1 shippableDeliverables, now
 * at any depth within the node's own sibling group).
 */
export function shippableNodes(plan: Pick<PlanV2, "nodes">): PlanNode[] {
	const result: PlanNode[] = [];
	for (const { node, parent } of walkNodes(plan)) {
		if (!isBranchOwner(node) || node.status !== "complete") continue;
		// The runtime records minted candidate branches on the ledger, which
		// makes candidates look like branch owners — they still never ship.
		if (isCandidateBranch(node.branch)) continue;
		const siblings = parent ? (parent.children ?? []) : plan.nodes;
		const depsTerminal = (node.after ?? []).every((ref) => {
			if (ref === PARENT_AFTER_TOKEN) return true; // parent gating ≠ ship order
			const dep = siblings.find((sibling) => sibling.id === ref);
			return dep !== undefined && DEP_TERMINAL_STATUSES.includes(dep.status);
		});
		if (depsTerminal) result.push(node);
	}
	return result;
}

// ─── Base derivation ─────────────────────────────────────────────────────────

/** Parent statuses a dependent may stack on (v1 STACKABLE_STATUSES). */
const STACKABLE_STATUSES: readonly NodeStatus[] = ["complete", "shipped"];

export function defaultBranchForNode(node: Pick<PlanNode, "id">): string {
	return `feat/${node.id}`;
}

/**
 * The branch a branch-owning node forks from (and its PR targets). v1's
 * pickBaseBranch with `dependsOn` → sibling `after`: an explicit `base`
 * override wins ("default-branch" ≡ v1 stacked:false); else the first
 * sibling dep whose branch holds real work (same repo, stackable status);
 * else the default branch.
 */
export function deriveBase(
	node: Pick<PlanNode, "after" | "base" | "repo">,
	siblings: readonly PlanNode[],
	defaultBranch: string,
): string {
	if (node.base === "default-branch") return defaultBranch;
	if (node.base) return node.base;
	for (const ref of node.after ?? []) {
		if (ref === PARENT_AFTER_TOKEN) continue;
		const dep = siblings.find((sibling) => sibling.id === ref);
		if (!dep?.branch) continue;
		if ((dep.repo ?? "") !== (node.repo ?? "")) continue;
		if (!STACKABLE_STATUSES.includes(dep.status)) continue;
		return dep.branch;
	}
	return defaultBranch;
}

// ─── Authoring-time validation (enforcement site A) ──────────────────────────

export interface ValidatePlanOptions {
	/** Persona registration check (agent type × persona name). Absent skips —
	 *  spawn-time revalidates against the live registry regardless. */
	readonly personaRegistered?: (
		agent: NodeAgentType,
		persona: string,
	) => boolean;
}

const STATUS_SET = new Set<string>(DELIVERABLE_STATUSES);

/**
 * Hard authoring-time rules — a human is in the loop to fix them. Runtime
 * violations (depth/envelope from a live agent) are steered, never thrown;
 * those sites re-use the same predicates.
 */
export function validatePlanShapeV2(
	plan: PlanV2,
	options: ValidatePlanOptions = {},
): string[] {
	const errors: string[] = [];
	if (plan.schemaVersion !== PLAN_SCHEMA_VERSION_V2)
		errors.push(
			`schemaVersion must be ${PLAN_SCHEMA_VERSION_V2} (got ${String(plan.schemaVersion)})`,
		);
	const maxDepth = plan.maxDepth ?? DEFAULT_MAX_DEPTH;
	const seenIds = new Set<string>();
	const seenBranches = new Map<string, string>();
	for (const { node, parent, depth, path } of walkNodes(plan)) {
		const where = path.join("/");
		if (seenIds.has(node.id))
			errors.push(`duplicate node id \`${node.id}\` (ids are plan-unique)`);
		seenIds.add(node.id);
		if (!NODE_AGENT_TYPES.includes(node.agent))
			errors.push(
				`${where}: agent must be one of ${NODE_AGENT_TYPES.join(", ")} (callers are not spawnable)`,
			);
		if (!node.persona || node.persona.trim().length === 0)
			errors.push(`${where}: persona is required`);
		else if (
			options.personaRegistered &&
			NODE_AGENT_TYPES.includes(node.agent) &&
			!options.personaRegistered(node.agent, node.persona)
		)
			errors.push(
				`${where}: persona ${node.persona} is not registered for agent type ${node.agent}`,
			);
		if (depth > maxDepth)
			errors.push(
				`${where}: depth ${depth} exceeds maxDepth ${maxDepth} (the seat is depth 0)`,
			);
		if (!STATUS_SET.has(node.status))
			errors.push(`${where}: unknown status ${String(node.status)}`);
		if (node.envelope)
			for (const err of validateNodeEnvelope(node.envelope))
				errors.push(`${where}: ${err}`);
		const cap = effectiveMaxChildren(plan, node);
		if (cap !== undefined && (node.children?.length ?? 0) > cap)
			errors.push(
				`${where}: ${node.children?.length} children exceed the envelope cap ${cap}`,
			);
		// after: sibling ids ∪ "parent" (never at the root), acyclic.
		const siblings = parent ? (parent.children ?? []) : plan.nodes;
		const siblingIds = new Set(siblings.map((sibling) => sibling.id));
		for (const ref of node.after ?? []) {
			if (ref === PARENT_AFTER_TOKEN) {
				if (!parent)
					errors.push(
						`${where}: after "parent" is invalid on a root node (roots have no parent node)`,
					);
				continue;
			}
			if (ref === node.id) errors.push(`${where}: after references itself`);
			else if (!siblingIds.has(ref))
				errors.push(
					`${where}: after \`${ref}\` does not name a sibling (after is sibling-scoped)`,
				);
		}
		if (node.branch) {
			const owner = seenBranches.get(node.branch);
			if (owner)
				errors.push(
					`${where}: branch ${node.branch} is already owned by \`${owner}\``,
				);
			seenBranches.set(node.branch, node.id);
		} else if (node.base)
			errors.push(`${where}: base is only meaningful on branch-owning nodes`);
		if (
			node.diversityWaiver !== undefined &&
			node.diversityWaiver.trim().length === 0
		)
			errors.push(`${where}: diversityWaiver must carry a reason`);
		const taskIds = new Set<string>();
		for (const task of node.tasks) {
			if (taskIds.has(task.id))
				errors.push(`${where}: duplicate task id ${task.id}`);
			taskIds.add(task.id);
			if (!task.title || task.title.trim().length === 0)
				errors.push(`${where}: task ${task.id} needs a title`);
		}
	}
	// Sibling-group cycle check (Kahn) at every level.
	const checkCycles = (siblings: readonly PlanNode[], scope: string): void => {
		const ids = new Set(siblings.map((node) => node.id));
		const visited = new Set<string>();
		const visiting = new Set<string>();
		const visit = (id: string): void => {
			if (visited.has(id)) return;
			if (visiting.has(id)) {
				errors.push(`${scope}: dependency cycle through \`${id}\``);
				return;
			}
			visiting.add(id);
			const node = siblings.find((sibling) => sibling.id === id);
			for (const ref of node?.after ?? []) if (ids.has(ref)) visit(ref);
			visiting.delete(id);
			visited.add(id);
		};
		for (const node of siblings) visit(node.id);
		for (const node of siblings)
			if (node.children?.length)
				checkCycles(node.children, `${scope}/${node.id}`);
	};
	checkCycles(plan.nodes, "plan");
	return errors;
}

// ─── Fingerprint ─────────────────────────────────────────────────────────────

/**
 * Semantic tree fingerprint (v1 planFingerprint's exclusion discipline):
 * session/process bookkeeping and timestamps churn on every spawn/restart
 * and are excluded so a fingerprint minted at spawn isn't stale before the
 * agent's first turn.
 */
export function planFingerprintV2(plan: PlanV2): string {
	const value = structuredClone(plan) as PlanV2;
	// Audit/gate ledgers are bookkeeping, not plan semantics (v1 verbatim):
	// persisting a gate row must not invalidate the fingerprint it pinned.
	value.repairAudit = undefined;
	value.transitionGates = undefined;
	value.updatedAt = "";
	for (const { node } of walkNodes(value)) {
		node.sessionPath = undefined;
		node.sessionName = undefined;
		node.sessionGeneration = undefined;
		node.previousSessionPaths = undefined;
		node.restartMode = undefined;
		node.restartState = undefined;
		node.updatedAt = "";
		for (const task of node.tasks) task.updatedAt = "";
	}
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// ─── v1 survivors (moved here at the flip; verbatim) ─────────────────────────

/** Terminal statuses — the node will not transition again (v1 semantics:
 *  failed is RECOVERABLE and therefore not terminal for retention/compaction
 *  consumers). */
export const TERMINAL_STATUSES: readonly NodeStatus[] = [
	"shipped",
	"superseded",
	"abandoned",
];

export function canTransition(from: NodeStatus, to: NodeStatus): boolean {
	return (DELIVERABLE_TRANSITIONS[from] as readonly NodeStatus[]).includes(to);
}

/** Planning UX phases (recon → plan structure unlock). */
export const PLAN_PHASES = ["exploring", "structuring"] as const;
export type PlanPhase = (typeof PLAN_PHASES)[number];

/** Reserved task ids for the injected lifecycle pair. */
export const PREFLIGHT_TASK_ID = "lifecycle-preflight";
export const POSTFLIGHT_TASK_ID = "lifecycle-postflight";

/** Default token budget for cross-node summaries before compression kicks in. */
export const SUMMARY_TOKEN_BUDGET = 5000;

export const MAX_PREVIOUS_WORKER_SESSIONS = 5;

export function boundedPreviousSessionPaths(
	paths: readonly string[],
): string[] {
	return [...new Set(paths.filter((path) => path.trim().length > 0))].slice(
		-MAX_PREVIOUS_WORKER_SESSIONS,
	);
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
