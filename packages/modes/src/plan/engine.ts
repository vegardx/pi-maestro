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

import { randomUUID } from "node:crypto";
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
	effectiveMaxChildren,
	effectiveNodeTaskKind,
	findNodeV2,
	isBranchOwner,
	type NodeTask,
	PARENT_AFTER_TOKEN,
	type PlanNode,
	type PlanV2,
	POSTFLIGHT_TASK_ID,
	PREFLIGHT_TASK_ID,
	parentOfNode,
	planFingerprintV2,
	slugify,
	validatePlanShapeV2,
	walkNodes,
} from "./schema.js";
import type { PlanStoreV2 } from "./storage.js";

/** Debug-repair operations (v1 vocabulary; deliverableId carries node ids). */
export type PlanRepairOperation =
	| {
			type: "addCorrectiveTask" | "addManualCheckpoint";
			deliverableId: string;
			task: { id: string; title: string; body?: string };
	  }
	| {
			type: "clarifyTask";
			deliverableId: string;
			taskId: string;
			title?: string;
			body?: string;
	  }
	| {
			type: "reopenTask";
			deliverableId: string;
			taskId: string;
	  };

export interface PlanRepairInput {
	baseFingerprint: string;
	reason: string;
	operations: readonly PlanRepairOperation[];
	/** Execution-aware caller assertion: each affected node is stopped. */
	stoppedDeliverableIds: readonly string[];
}

export interface NodeInput {
	readonly id?: string;
	readonly agent: NodeAgentType;
	readonly persona: string;
	readonly title?: string;
	readonly body?: string;
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
	private draft = false;

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

	/** Draft: held in memory until materialize() names and saves it (v1). */
	static createDraft(
		store: PlanStoreV2,
		input: { slug: string; title: string; repoPath: string },
		now: () => string = () => new Date().toISOString(),
	): PlanEngineV2 {
		const ts = now();
		const engine = new PlanEngineV2(
			{
				schemaVersion: PLAN_SCHEMA_VERSION_V2,
				slug: input.slug,
				title: input.title,
				repoPath: input.repoPath,
				nodes: [],
				createdAt: ts,
				updatedAt: ts,
			},
			store,
			now,
		);
		engine.draft = true;
		return engine;
	}

	isDraft(): boolean {
		return this.draft;
	}

	materialize(slug: string, title: string): void {
		if (!this.draft) return;
		this.plan = { ...this.plan, slug, title, updatedAt: this.now() };
		this.draft = false;
		this.store.save(this.plan);
	}

	updatePlan(
		patch: Partial<
			Pick<
				PlanV2,
				| "title"
				| "profile"
				| "parentIssueNumber"
				| "planSessionPath"
				| "lastSyncedAt"
				| "understanding"
			>
		>,
	): void {
		this.mutate((plan) => {
			for (const [key, value] of Object.entries(patch)) {
				if (value !== undefined)
					(plan as unknown as Record<string, unknown>)[key] = value;
			}
		});
	}

	setTransitionGate(gate: import("./schema.js").TransitionGateRuling): void {
		this.mutate((plan) => {
			const gates = plan.transitionGates ?? [];
			const index = gates.findIndex((candidate) => candidate.id === gate.id);
			plan.transitionGates =
				index < 0
					? [...gates, gate]
					: gates.map((candidate, at) => (at === index ? gate : candidate));
		});
	}

	registerRepo(repo: import("./schema.js").PlanRepoV2): void {
		this.mutate((plan) => {
			if ((plan.repos ?? []).some((existing) => existing.key === repo.key))
				throw new Error(`repo key \`${repo.key}\` is already registered`);
			plan.repos = [...(plan.repos ?? []), repo];
		});
	}

	unregisterRepo(key: string): void {
		this.mutate((plan) => {
			const repos = plan.repos ?? [];
			if (!repos.some((repo) => repo.key === key))
				throw new Error(`unknown repo: ${key}`);
			if ([...walkNodes(plan)].some((visit) => visit.node.repo === key))
				throw new Error(`repo ${key} is referenced by nodes`);
			plan.repos = repos.filter((repo) => repo.key !== key);
		});
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

	/**
	 * Update a node's authored fields. Structural fields (after/branch/base/
	 * agent/persona) are pre-start only; title/body edits stay legal (they do
	 * not change execution semantics for a running agent's plan view).
	 */
	updateNode(
		id: string,
		patch: Partial<
			Pick<
				PlanNode,
				| "title"
				| "body"
				| "persona"
				| "after"
				| "branch"
				| "base"
				| "repo"
				| "skills"
				| "envelope"
				| "diversityWaiver"
			>
		>,
	): void {
		// `persona` is authored metadata, not structural — freely updatable
		// (e.g. an ensemble makes its parent the integrator before execution).
		const structural = ["after", "branch", "base", "repo", "envelope"] as const;
		if (
			this.hasExecutionStarted() &&
			structural.some((key) => patch[key] !== undefined)
		)
			throw new Error(
				"execution has started — structural node fields are frozen (append children or abandon instead)",
			);
		this.mutateNode(id, (node) => {
			for (const [key, value] of Object.entries(patch)) {
				if (value !== undefined)
					(node as unknown as Record<string, unknown>)[key] = value;
			}
		});
	}

	updateTask(
		nodeId: string,
		taskId: string,
		patch: Partial<Pick<NodeTask, "title" | "body" | "answer">>,
	): void {
		this.mutateNode(nodeId, (node) => {
			const task = node.tasks.find((candidate) => candidate.id === taskId);
			if (!task) throw new Error(`unknown task: ${nodeId}/${taskId}`);
			if (patch.title !== undefined) task.title = patch.title;
			if (patch.body !== undefined) task.body = patch.body;
			if (patch.answer !== undefined) {
				task.answer = patch.answer;
				task.decidedAt = this.now();
				task.done = true;
			}
			task.updatedAt = this.now();
		});
	}

	/**
	 * Apply the complete, narrow debug repair to one clone/save (v1 verbatim,
	 * node-keyed: `deliverableId` fields carry node ids — the debug channel's
	 * wire vocabulary is unchanged). The operation vocabulary cannot express
	 * topology, lifecycle, review, or runtime edits.
	 */
	applyTaskRepair(input: PlanRepairInput): {
		fingerprint: string;
		auditId: string;
	} {
		if (!input.reason.trim()) throw new Error("repair reason required");
		if (input.operations.length === 0)
			throw new Error("repair has no operations");
		const actual = planFingerprintV2(this.plan);
		if (actual !== input.baseFingerprint) {
			throw new Error(
				`plan fingerprint drift: expected ${input.baseFingerprint}, found ${actual}`,
			);
		}
		const stopped = new Set(input.stoppedDeliverableIds);
		const touched = new Set(input.operations.map((op) => op.deliverableId));
		for (const id of touched) {
			const node = findNodeV2(this.plan, id);
			if (!node) throw new Error(`unknown deliverable: ${id}`);
			if (!stopped.has(id)) {
				throw new Error(`deliverable ${id} is not confirmed stopped`);
			}
			if (["shipped", "abandoned", "superseded"].includes(node.status)) {
				throw new Error(`deliverable ${id} is terminal (${node.status})`);
			}
			if (node.restartState === "restarting") {
				throw new Error(`deliverable ${id} is restarting`);
			}
		}
		const ts = this.now();
		const auditId = randomUUID();
		this.mutate((plan) => {
			const findTask = (node: PlanNode, taskId: string): NodeTask | undefined =>
				node.tasks.find((candidate) => candidate.id === taskId);
			for (const op of input.operations) {
				const node = findNodeV2(plan, op.deliverableId);
				if (!node) throw new Error(`unknown deliverable: ${op.deliverableId}`);
				switch (op.type) {
					case "addCorrectiveTask":
					case "addManualCheckpoint": {
						if (!op.task.id.trim() || !op.task.title.trim()) {
							throw new Error(`${op.type} requires task id and title`);
						}
						if (findTask(node, op.task.id)) {
							throw new Error(`task already exists: ${op.task.id}`);
						}
						// Corrective tasks must gate completion (kind "task"): a
						// repair the worker can finish without doing is no repair.
						node.tasks.push({
							id: op.task.id,
							title: op.task.title,
							body: op.task.body ?? "",
							done: false,
							...(op.type === "addManualCheckpoint"
								? { kind: "manual" as const }
								: {}),
							createdAt: ts,
							updatedAt: ts,
						});
						break;
					}
					case "clarifyTask": {
						const task = findTask(node, op.taskId);
						if (!task) throw new Error(`unknown task: ${op.taskId}`);
						if (task.done || task.answer !== undefined) {
							throw new Error(`task ${op.taskId} was already acted upon`);
						}
						if (op.title === undefined && op.body === undefined) {
							throw new Error(`clarifyTask ${op.taskId} has no text change`);
						}
						if (op.title !== undefined) task.title = op.title;
						if (op.body !== undefined) task.body = op.body;
						task.updatedAt = ts;
						break;
					}
					case "reopenTask": {
						const task = findTask(node, op.taskId);
						if (!task) throw new Error(`unknown task: ${op.taskId}`);
						if (task.answer !== undefined || task.decidedAt !== undefined) {
							throw new Error(`cannot reopen decided task ${op.taskId}`);
						}
						// Idempotent: retries leave an already-open task open.
						task.done = false;
						task.updatedAt = ts;
						break;
					}
				}
				node.updatedAt = ts;
			}
			plan.repairAudit = [
				...(plan.repairAudit ?? []),
				{
					id: auditId,
					reason: input.reason,
					baseFingerprint: input.baseFingerprint,
					appliedAt: ts,
					operations: input.operations.map((op) => op.type),
				},
			];
		});
		return { fingerprint: planFingerprintV2(this.plan), auditId };
	}

	removeTask(nodeId: string, taskId: string): void {
		if (this.hasExecutionStarted())
			throw new Error(
				"execution has started — tasks are toggled or answered, never removed",
			);
		this.mutateNode(nodeId, (node) => {
			const index = node.tasks.findIndex(
				(candidate) => candidate.id === taskId,
			);
			if (index < 0) throw new Error(`unknown task: ${nodeId}/${taskId}`);
			node.tasks.splice(index, 1);
		});
	}

	setWorkflowAnalytics(nodeId: string, ledger: unknown): void {
		this.mutateNode(nodeId, (node) => {
			node.workflowAnalytics = ledger;
		});
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
	 * Toggle a task. The postflight toggle carries the downstream handoff
	 * (summary → node.handoff); a question toggle carries the answer, which
	 * stamps decidedAt (v1 behavior, unchanged).
	 */
	toggleTask(
		nodeId: string,
		taskId: string,
		summary?: string,
		answer?: string,
	): void {
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
			if (task.done && answer !== undefined) {
				task.answer = answer;
				task.decidedAt = this.now();
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
				| "baseBranch"
				| "stacked"
				| "blocked"
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
			...(input.body ? { body: input.body } : {}),
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

	/** v1's mutate discipline verbatim: clone → apply → validate → save.
	 *  Drafts mutate in memory only — materialize() names and persists. */
	private mutate(fn: (plan: PlanV2) => void): void {
		const next = structuredClone(this.plan) as PlanV2;
		fn(next);
		const problems = validatePlanShapeV2(next);
		if (problems.length > 0)
			throw new Error(`invalid plan:\n- ${problems.join("\n- ")}`);
		next.updatedAt = this.now();
		if (!this.draft) this.store.save(next);
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
