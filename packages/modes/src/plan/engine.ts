// PlanEngineV2 (plan-schema cutover PR-4): the mutation surface over the
// recursive tree, with v1's mutate() discipline verbatim — clone → apply →
// validate → save, one validated write path. What changes is WHICH mutations
// are legal WHEN:
//
//   Before execution (no node beyond "planned"): full CRUD, identical
//   editing freedom to v1.
//   After execution starts, the plan is APPEND-ONLY: appendChild (the ONE
//   dynamic-structure operation, write-ahead: committed to disk before any
//   spawn is attempted), task appends (followup/manual) and toggles, record
//   operations (resolutions, diversity, results, session fields), and status
//   transitions per the unchanged table. Removal is `abandoned`, never
//   splice — a policy tightening over v1, whose any-time removeDeliverable
//   caused a class of wedges.
//
// Unwired until the flip: only tests and the future NodeExecutor import it.

import type {
	DeliveryFailure,
	DiversityRecord,
	NodeAgentType,
	NodeEnvelope,
	NodeResolution,
	NodeStatus,
	NodeTaskKind,
} from "@vegardx/pi-contracts";
import {
	DEFAULT_MAX_DEPTH,
	PLAN_SCHEMA_VERSION_V2,
} from "@vegardx/pi-contracts";
import {
	boundedPreviousSessionPaths,
	canTransition,
	POSTFLIGHT_TASK_ID,
	PREFLIGHT_TASK_ID,
	slugify,
} from "../schema.js";
import {
	effectiveMaxChildren,
	effectiveNodeTaskKind,
	findNodeV2,
	isBranchOwner,
	type NodeTask,
	PARENT_AFTER_TOKEN,
	type PlanNode,
	type PlanV2,
	parentOfNode,
	validatePlanShapeV2,
	walkNodes,
} from "./schema.js";
import type { PlanStoreV2 } from "./storage.js";

export interface NodeInput {
	readonly id?: string;
	readonly agent: NodeAgentType;
	readonly persona: string;
	readonly title?: string;
	readonly tasks?: readonly (string | { title: string; body?: string })[];
	readonly skills?: readonly string[];
	readonly after?: readonly string[];
	readonly branch?: string;
	readonly base?: string;
	readonly repo?: string;
	readonly envelope?: NodeEnvelope;
	readonly diversityWaiver?: string;
}

/** Task kinds an agent may append once execution started (RPC addTask rule). */
const POST_START_TASK_KINDS = new Set<NodeTaskKind>(["followup", "manual"]);

export class PlanEngineV2 {
	private plan: PlanV2;

	constructor(
		plan: PlanV2,
		private readonly store: PlanStoreV2,
		private readonly now: () => string = () => new Date().toISOString(),
	) {
		this.plan = plan;
	}

	static create(
		store: PlanStoreV2,
		input: {
			slug: string;
			title: string;
			repoPath: string;
			profile?: string;
			maxDepth?: number;
			defaultEnvelope?: NodeEnvelope;
		},
		now: () => string = () => new Date().toISOString(),
	): PlanEngineV2 {
		const ts = now();
		const plan: PlanV2 = {
			schemaVersion: PLAN_SCHEMA_VERSION_V2,
			slug: input.slug,
			title: input.title,
			repoPath: input.repoPath,
			...(input.profile ? { profile: input.profile } : {}),
			...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
			...(input.defaultEnvelope
				? { defaultEnvelope: input.defaultEnvelope }
				: {}),
			nodes: [],
			createdAt: ts,
			updatedAt: ts,
		};
		const engine = new PlanEngineV2(plan, store, now);
		store.save(plan);
		return engine;
	}

	get(): PlanV2 {
		return this.plan;
	}

	/** Any node beyond "planned" locks the plan into append-only mode. */
	hasExecutionStarted(): boolean {
		for (const { node } of walkNodes(this.plan))
			if (node.status !== "planned") return true;
		return false;
	}

	// ── Authoring (pre-execution CRUD) ─────────────────────────────────────

	addNode(parentId: string | null, input: NodeInput): PlanNode {
		if (this.hasExecutionStarted())
			throw new Error(
				"execution has started — the plan is append-only (use appendChild)",
			);
		return this.insertNode(parentId, input, "plan");
	}

	removeNode(id: string): void {
		if (this.hasExecutionStarted())
			throw new Error(
				"execution has started — nodes are abandoned, never removed",
			);
		this.mutate((plan) => {
			const parent = parentOfNode(plan, id);
			const siblings = parent ? (parent.children ?? []) : plan.nodes;
			const index = siblings.findIndex((node) => node.id === id);
			if (index < 0) throw new Error(`unknown node: ${id}`);
			siblings.splice(index, 1);
		});
	}

	// ── Append-only structure (any time — THE dynamic operation) ───────────

	/**
	 * Append a child under `parentId`, authored by `authoredBy` (a node id
	 * for dynamic children). WRITE-AHEAD: the mutation commits to disk
	 * before this returns — the caller spawns only after, so a crash between
	 * append and spawn leaves a planned child recovery can spawn or abandon,
	 * never an invisible agent. Depth/envelope violations throw here — the
	 * runtime steering layer catches and converts them to steers/questions.
	 */
	appendChild(
		parentId: string,
		input: NodeInput,
		authoredBy: "plan" | string,
	): PlanNode {
		const parentVisit = [...walkNodes(this.plan)].find(
			(visit) => visit.node.id === parentId,
		);
		if (!parentVisit) throw new Error(`unknown node: ${parentId}`);
		const maxDepth = this.plan.maxDepth ?? DEFAULT_MAX_DEPTH;
		if (parentVisit.depth + 1 > maxDepth)
			throw new Error(
				`you're at maximum depth (${maxDepth}) — handle this directly`,
			);
		const cap = effectiveMaxChildren(this.plan, parentVisit.node);
		if (cap !== undefined && (parentVisit.node.children?.length ?? 0) + 1 > cap)
			throw new Error(
				`envelope cap ${cap} reached on ${parentId} — escalate instead of spawning`,
			);
		return this.insertNode(parentId, input, authoredBy, this.now());
	}

	// ── Tasks ──────────────────────────────────────────────────────────────

	addTask(
		nodeId: string,
		input: { title: string; body?: string; kind?: NodeTaskKind },
	): NodeTask {
		const kind =
			input.kind ?? (this.hasExecutionStarted() ? "followup" : "task");
		if (this.hasExecutionStarted() && !POST_START_TASK_KINDS.has(kind))
			throw new Error(
				`execution has started — only ${[...POST_START_TASK_KINDS].join("/")} tasks may be appended`,
			);
		const ts = this.now();
		const task: NodeTask = {
			id: this.uniqueTaskId(nodeId, input.title),
			title: input.title,
			body: input.body ?? "",
			done: false,
			...(kind !== "task" ? { kind } : {}),
			createdAt: ts,
			updatedAt: ts,
		};
		this.mutate((plan) => {
			const node = findNodeV2(plan, nodeId);
			if (!node) throw new Error(`unknown node: ${nodeId}`);
			node.tasks.push(task);
			node.updatedAt = ts;
		});
		return task;
	}

	/**
	 * Toggle a task. The postflight toggle carries the downstream handoff:
	 * its summary is persisted onto the node (v1 behavior, unchanged).
	 */
	toggleTask(nodeId: string, taskId: string, summary?: string): void {
		this.mutate((plan) => {
			const node = findNodeV2(plan, nodeId);
			if (!node) throw new Error(`unknown node: ${nodeId}`);
			const task = node.tasks.find((candidate) => candidate.id === taskId);
			if (!task) throw new Error(`unknown task: ${nodeId}/${taskId}`);
			task.done = !task.done;
			task.updatedAt = this.now();
			if (
				task.done &&
				effectiveNodeTaskKind(task) === "postflight" &&
				summary
			) {
				node.handoff = summary;
			}
			node.updatedAt = this.now();
		});
	}

	// ── Status (transition table unchanged) ────────────────────────────────

	setNodeStatus(
		id: string,
		status: NodeStatus,
		failure?: DeliveryFailure,
	): void {
		this.mutate((plan) => {
			const node = findNodeV2(plan, id);
			if (!node) throw new Error(`unknown node: ${id}`);
			if (node.status !== status && !canTransition(node.status, status))
				throw new Error(
					`illegal status transition: ${node.status} → ${status}`,
				);
			if (status === "failed" && !failure)
				throw new Error("failed delivery requires failure detail");
			node.status = status;
			node.failure = status === "failed" ? failure : undefined;
			if (status === "active") this.injectLifecycleTasks(plan, node);
			if (
				["complete", "failed", "shipped", "superseded", "abandoned"].includes(
					status,
				) &&
				!node.completedAt
			)
				node.completedAt = this.now();
			node.updatedAt = this.now();
		});
	}

	// ── Record operations (append-only ledger writes) ──────────────────────

	recordResolution(id: string, resolution: NodeResolution): void {
		this.mutateNode(id, (node) => {
			node.resolutions = [...(node.resolutions ?? []), resolution];
		});
	}

	recordDiversity(id: string, record: DiversityRecord): void {
		this.mutateNode(id, (node) => {
			node.diversity = record;
		});
	}

	recordResult(
		id: string,
		result: { contract: string; payload: unknown; recordedAt: string },
	): void {
		this.mutateNode(id, (node) => {
			node.result = result;
		});
	}

	setNodeRuntime(
		id: string,
		patch: Partial<
			Pick<
				PlanNode,
				| "baseSha"
				| "lastReviewedHead"
				| "worktreePath"
				| "worktreeReapedAt"
				| "sessionPath"
				| "sessionName"
				| "sessionGeneration"
				| "previousSessionPaths"
				| "restartMode"
				| "restartState"
				| "summary"
				| "handoff"
				| "prUrl"
				| "prNumber"
				| "branch"
			>
		>,
	): void {
		this.mutateNode(id, (node) => {
			for (const [key, value] of Object.entries(patch)) {
				if (value !== undefined)
					(node as unknown as Record<string, unknown>)[key] = value;
			}
			if (patch.previousSessionPaths)
				node.previousSessionPaths = boundedPreviousSessionPaths(
					patch.previousSessionPaths,
				);
		});
	}

	// ── Internals ──────────────────────────────────────────────────────────

	private insertNode(
		parentId: string | null,
		input: NodeInput,
		authoredBy: "plan" | string,
		appendedAt?: string,
	): PlanNode {
		const ts = this.now();
		const node: PlanNode = {
			type: "node",
			id: input.id ?? this.uniqueNodeId(input.title ?? input.persona),
			agent: input.agent,
			persona: input.persona,
			...(input.title ? { title: input.title } : {}),
			tasks: (input.tasks ?? []).map((task, index) => {
				const title = typeof task === "string" ? task : task.title;
				const body = typeof task === "string" ? "" : (task.body ?? "");
				return {
					id: `${slugify(title) || `task-${index + 1}`}`,
					title,
					body,
					done: false,
					createdAt: ts,
					updatedAt: ts,
				};
			}),
			...(input.skills?.length ? { skills: [...input.skills] } : {}),
			...(input.after?.length ? { after: [...input.after] } : {}),
			...(input.branch ? { branch: input.branch } : {}),
			...(input.base ? { base: input.base } : {}),
			...(input.repo ? { repo: input.repo } : {}),
			...(input.envelope ? { envelope: input.envelope } : {}),
			...(input.diversityWaiver
				? { diversityWaiver: input.diversityWaiver }
				: {}),
			authoredBy,
			...(appendedAt ? { appendedAt } : {}),
			status: "planned",
			createdAt: ts,
			updatedAt: ts,
		};
		this.mutate((plan) => {
			if (parentId === null) {
				plan.nodes.push(node);
				return;
			}
			const parent = findNodeV2(plan, parentId);
			if (!parent) throw new Error(`unknown node: ${parentId}`);
			parent.children = [...(parent.children ?? []), node];
		});
		// Return the node as persisted (mutate deep-clones).
		return findNodeV2(this.plan, node.id) ?? node;
	}

	/**
	 * Lifecycle injection, generalized (spike §1.2): WORKER nodes only —
	 * preflight iff the node has sibling `after` deps (upstream handoffs to
	 * absorb; the "parent" token is ordering, not a handoff), postflight iff
	 * any sibling lists it in `after` OR it owns a branch (someone consumes
	 * its handoff). Explorer/reviewer nodes get neither — their contract
	 * output IS the handoff.
	 */
	private injectLifecycleTasks(plan: PlanV2, node: PlanNode): void {
		if (node.agent !== "worker") return;
		const ts = this.now();
		const has = (kind: NodeTaskKind) =>
			node.tasks.some((task) => task.kind === kind);
		const siblingDeps = (node.after ?? []).filter(
			(ref) => ref !== PARENT_AFTER_TOKEN,
		);
		if (siblingDeps.length > 0 && !has("preflight")) {
			node.tasks.unshift({
				id: PREFLIGHT_TASK_ID,
				title: "Preflight: review upstream handoffs",
				body:
					"Your seed's Prior Work section carries the handoff summaries from " +
					"the nodes this one depends on — decisions, interfaces, and " +
					"gotchas you must build on. Read them first; toggle this task once " +
					"absorbed.",
				done: false,
				kind: "preflight",
				createdAt: ts,
				updatedAt: ts,
			});
		}
		const parent = parentOfNode(plan, node.id);
		const siblings = parent ? (parent.children ?? []) : plan.nodes;
		const consumed =
			isBranchOwner(node) ||
			siblings.some((sibling) => sibling.after?.includes(node.id));
		if (consumed && !has("postflight")) {
			node.tasks.push({
				id: POSTFLIGHT_TASK_ID,
				title: "Postflight: write the downstream handoff",
				body:
					"Final step: toggle this task passing `summary` — a concise handoff " +
					"(under 500 words) for nodes that build on this one. Cover what you " +
					"built, public interfaces, key decisions, invariants, and gotchas. " +
					"Keep it short and dense; only what a downstream agent genuinely " +
					"needs.",
				done: false,
				kind: "postflight",
				createdAt: ts,
				updatedAt: ts,
			});
		}
	}

	private mutateNode(id: string, fn: (node: PlanNode) => void): void {
		this.mutate((plan) => {
			const node = findNodeV2(plan, id);
			if (!node) throw new Error(`unknown node: ${id}`);
			fn(node);
			node.updatedAt = this.now();
		});
	}

	/** v1's mutate discipline verbatim: clone → apply → validate → save. */
	private mutate(fn: (plan: PlanV2) => void): void {
		const next = structuredClone(this.plan) as PlanV2;
		fn(next);
		const problems = validatePlanShapeV2(next);
		if (problems.length > 0)
			throw new Error(`invalid plan:\n- ${problems.join("\n- ")}`);
		next.updatedAt = this.now();
		this.store.save(next);
		this.plan = next;
	}

	private uniqueNodeId(base: string): string {
		const root = slugify(base) || "node";
		const taken = new Set(
			[...walkNodes(this.plan)].map((visit) => visit.node.id),
		);
		if (!taken.has(root)) return root;
		for (let n = 2; ; n++) {
			const candidate = `${root}-${n}`;
			if (!taken.has(candidate)) return candidate;
		}
	}

	private uniqueTaskId(nodeId: string, base: string): string {
		const root = slugify(base) || "task";
		const node = findNodeV2(this.plan, nodeId);
		const taken = new Set(node?.tasks.map((task) => task.id) ?? []);
		if (!taken.has(root)) return root;
		for (let n = 2; ; n++) {
			const candidate = `${root}-${n}`;
			if (!taken.has(candidate)) return candidate;
		}
	}
}
