// PlanEngine — the mutation surface over a Plan. Every mutation clones the
// plan, applies the change, runs validatePlanShape, and (only if valid) bumps
// timestamps and persists atomically. Invalid mutations throw before touching
// disk, so the in-memory plan and the file never diverge.

import { createHash, randomUUID } from "node:crypto";
import type { ReviewLedger } from "./exec/findings.js";
import {
	type AgentMode,
	type AgentSpec,
	type AgentWorkflow,
	boundedPreviousSessionPaths,
	canTransition,
	DEFAULT_REPO_KEY,
	type Deliverable,
	type DeliverableStatus,
	type DeliveryFailure,
	defaultBranchForDeliverable,
	findDeliverable,
	findTask,
	PLAN_SCHEMA_VERSION,
	type Plan,
	type PlanPhase,
	type PlanRepo,
	type SubAgentSpec,
	slugify,
	type ThinkingLevel,
	validatePlanShape,
	type WorkerRestartMode,
	type WorkerRestartState,
	type WorkflowStageSpec,
	type WorkItem,
	type WorkItemKind,
} from "./schema.js";
import type { PlanStore } from "./storage.js";
import type { WorkflowAnalyticsLedger } from "./workflow-analytics.js";

/**
 * Object.assign that skips undefined values. Tool handlers forward EVERY
 * optional param (present or not) into patches — a plain Object.assign
 * copied the explicit `undefined`s and wiped real fields (a live update
 * nulled a deliverable's title, dependsOn, and stacked).
 */
function assignDefined<T extends object>(target: T, patch: Partial<T>): void {
	for (const [key, value] of Object.entries(patch)) {
		if (value !== undefined) {
			(target as Record<string, unknown>)[key] = value;
		}
	}
}

export interface AddDeliverableInput {
	/** Preferred id. Slugified + de-duped; falls back to the title if absent. */
	id?: string;
	title: string;
	body?: string;
	dependsOn?: string[];
	stacked?: boolean;
	/** "repo" (default, worktree + PR) or "scratch" (plain dir, no PR). */
	workspace?: "repo" | "scratch";
	/** Repo registry key; absent ⇒ the plan's default repo. */
	repo?: string;
	workerMode: AgentMode;
	workerModel?: string;
	workerEffort?: ThinkingLevel;
	workerAfter?: string[];
}

export interface AddAgentInput {
	name: string;
	mode: AgentMode;
	model?: string;
	effort?: ThinkingLevel;
	focus: string;
	after: string[];
}

export interface AddWorkItemInput {
	title: string;
	body?: string;
	kind?: WorkItemKind;
	position?: number;
}

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
	/** Execution-aware caller assertion: each affected deliverable is stopped. */
	stoppedDeliverableIds: readonly string[];
}

/**
 * Stable semantic fingerprint. Repairs and debug proposals are pinned to it,
 * so it must only drift on changes a proposer could have reasoned about:
 * audit history, mutation timestamps, and worker session/process bookkeeping
 * (which churns on every spawn, restart, and status persist) are excluded —
 * otherwise a fingerprint minted at spawn is stale before the worker's first
 * turn. Generation drift is checked separately via expectedGeneration.
 */
export function planFingerprint(plan: Plan): string {
	const value = structuredClone(plan) as Plan;
	delete value.repairAudit;
	value.updatedAt = "";
	for (const g of value.deliverables) {
		delete g.sessionPath;
		delete g.sessionName;
		delete g.sessionGeneration;
		delete g.previousSessionPaths;
		delete g.restartMode;
		delete g.restartState;
		g.updatedAt = "";
		for (const task of g.tasks) task.updatedAt = "";
	}
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class PlanEngine {
	private plan: Plan;
	private draft = false;

	constructor(
		plan: Plan,
		private readonly store: PlanStore,
		private readonly now: () => string = () => new Date().toISOString(),
	) {
		this.plan = plan;
	}

	static create(
		store: PlanStore,
		input: { slug: string; title: string; repoPath: string },
		now: () => string = () => new Date().toISOString(),
	): PlanEngine {
		const ts = now();
		const plan: Plan = {
			schemaVersion: PLAN_SCHEMA_VERSION,
			slug: input.slug,
			title: input.title,
			repoPath: input.repoPath,
			deliverables: [],
			createdAt: ts,
			updatedAt: ts,
		};
		const engine = new PlanEngine(plan, store, now);
		store.save(plan);
		return engine;
	}

	static createDraft(
		store: PlanStore,
		input: { slug: string; title: string; repoPath: string },
		now: () => string = () => new Date().toISOString(),
	): PlanEngine {
		const ts = now();
		const plan: Plan = {
			schemaVersion: PLAN_SCHEMA_VERSION,
			slug: input.slug,
			title: input.title,
			repoPath: input.repoPath,
			deliverables: [],
			createdAt: ts,
			updatedAt: ts,
		};
		const engine = new PlanEngine(plan, store, now);
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

	get(): Plan {
		return this.plan;
	}

	updatePlan(
		patch: Partial<
			Pick<
				Plan,
				"title" | "parentIssueNumber" | "planSessionPath" | "lastSyncedAt"
			>
		>,
	): void {
		this.mutate((plan) => {
			assignDefined(plan, patch);
		});
	}

	/**
	 * Flip the planning phase. Confirming readiness passes the maestro's
	 * summarized understanding, which is kept as source material for the
	 * knowledge doc and plan summary.
	 */
	setPhase(phase: PlanPhase, understanding?: string): void {
		this.mutate((plan) => {
			plan.phase = phase;
			if (understanding !== undefined) plan.understanding = understanding;
		});
	}

	// ── Repo registry ──────────────────────────────────────────────────────

	registerRepo(repo: PlanRepo): void {
		if (repo.key === DEFAULT_REPO_KEY) {
			throw new Error(`repo key \`${DEFAULT_REPO_KEY}\` is reserved`);
		}
		this.mutate((plan) => {
			plan.repos = [...(plan.repos ?? []), repo];
		});
	}

	unregisterRepo(key: string): void {
		this.mutate((plan) => {
			if (!(plan.repos ?? []).some((r) => r.key === key)) {
				throw new Error(`unknown repo: ${key}`);
			}
			plan.repos = (plan.repos ?? []).filter((r) => r.key !== key);
		});
	}

	// ── Resolved workflow ──────────────────────────────────────────────────

	/** Replace the whole workflow in one validated, atomic plan mutation. */
	setWorkflow(workflow: AgentWorkflow): void {
		this.mutate((plan) => {
			plan.workflow = structuredClone(workflow);
		});
	}

	updateWorkflowStage(
		id: string,
		patch: Partial<
			Pick<
				WorkflowStageSpec,
				| "after"
				| "assignmentIds"
				| "inputRevision"
				| "inputContracts"
				| "barrier"
			>
		>,
	): void {
		this.mutate((plan) => {
			const workflow = plan.workflow;
			if (!workflow) throw new Error("workflow is not configured");
			const stage = workflow.stages.find((candidate) => candidate.id === id);
			if (!stage) throw new Error(`unknown workflow stage: ${id}`);
			assignDefined(stage, patch);
		});
	}

	// ── Deliverables ─────────────────────────────────────────────────────────────

	addDeliverable(input: AddDeliverableInput): Deliverable {
		const ts = this.now();
		// Honor a caller-provided id (slugified + de-duped) so a plan tool that
		// passes `id` gets the id it expects; otherwise derive it from the title.
		const id = this.uniqueDeliverableId(input.id?.trim() || input.title);
		const scratch = input.workspace === "scratch";
		const deliverable: Deliverable = {
			type: "deliverable",
			id,
			title: input.title,
			body: input.body ?? "",
			status: "planned",
			dependsOn: input.dependsOn,
			// Scratch deliverables have no branch and can't be stacked on.
			stacked: scratch ? undefined : input.stacked,
			workspace: input.workspace,
			repo: scratch ? undefined : input.repo,
			worker: {
				mode: input.workerMode,
				model: input.workerModel,
				effort: input.workerEffort,
				after: input.workerAfter,
			},
			agents: [],
			tasks: [],
			branch: scratch ? undefined : defaultBranchForDeliverable({ id }),
			createdAt: ts,
			updatedAt: ts,
		};
		this.mutate((plan) => {
			plan.deliverables.push(deliverable);
		});
		return findDeliverable(this.plan, id) as Deliverable;
	}

	updateDeliverable(
		id: string,
		patch: Partial<
			Pick<
				Deliverable,
				| "title"
				| "body"
				| "dependsOn"
				| "stacked"
				| "workspace"
				| "repo"
				| "branch"
				| "baseSha"
				| "lastReviewedHead"
				| "worktreePath"
				| "sessionPath"
				| "sessionName"
				| "sessionGeneration"
				| "previousSessionPaths"
				| "restartMode"
				| "restartState"
				| "summary"
				| "prUrl"
				| "prNumber"
				| "maxFixRounds"
			>
		> & {
			workerMode?: AgentMode;
			workerModel?: string;
			workerEffort?: ThinkingLevel;
			workerAfter?: string[];
		},
	): void {
		this.mutate((plan) => {
			const g = findDeliverable(plan, id);
			if (!g) throw new Error(`unknown deliverable: ${id}`);
			const {
				workerMode,
				workerModel,
				workerEffort,
				workerAfter,
				...deliverablePatch
			} = patch;
			assignDefined(g, deliverablePatch);
			if (workerMode !== undefined) g.worker.mode = workerMode;
			if (workerModel !== undefined) g.worker.model = workerModel;
			if (workerEffort !== undefined) g.worker.effort = workerEffort;
			if (workerAfter !== undefined) g.worker.after = workerAfter;
			g.updatedAt = this.now();
		});
	}

	updateWorkerSession(
		id: string,
		patch: {
			sessionPath?: string;
			sessionName?: string;
			sessionGeneration?: number;
			previousSessionPaths?: string[];
			restartMode?: WorkerRestartMode;
			restartState?: WorkerRestartState;
		},
	): void {
		this.mutate((plan) => {
			const g = findDeliverable(plan, id);
			if (!g) throw new Error(`unknown deliverable: ${id}`);
			assignDefined(g, patch);
			if (patch.previousSessionPaths) {
				g.previousSessionPaths = boundedPreviousSessionPaths(
					patch.previousSessionPaths,
				);
			}
			g.updatedAt = this.now();
		});
	}

	setDeliverableStatus(
		id: string,
		status: DeliverableStatus,
		failure?: DeliveryFailure,
	): void {
		this.mutate((plan) => {
			const g = findDeliverable(plan, id);
			if (!g) throw new Error(`unknown deliverable: ${id}`);
			if (g.status !== status && !canTransition(g.status, status)) {
				throw new Error(`illegal status transition: ${g.status} → ${status}`);
			}
			if (status === "failed" && !failure) {
				throw new Error("failed delivery requires failure detail");
			}
			g.status = status;
			g.failure = status === "failed" ? failure : undefined;
			if (
				(status === "complete" ||
					status === "failed" ||
					status === "shipped" ||
					status === "superseded" ||
					status === "abandoned") &&
				!g.completedAt
			) {
				g.completedAt = this.now();
			}
			g.updatedAt = this.now();
		});
	}

	removeDeliverable(id: string): void {
		this.mutate((plan) => {
			const idx = plan.deliverables.findIndex((g) => g.id === id);
			if (idx < 0) throw new Error(`unknown deliverable: ${id}`);
			plan.deliverables.splice(idx, 1);
		});
	}

	// ── Agents ─────────────────────────────────────────────────────────────

	addAgent(deliverableId: string, input: AddAgentInput): AgentSpec {
		const agent: AgentSpec = {
			name: input.name,
			mode: input.mode,
			model: input.model,
			effort: input.effort,
			focus: input.focus,
			after: input.after,
		};
		this.mutate((plan) => {
			const g = findDeliverable(plan, deliverableId);
			if (!g) throw new Error(`unknown deliverable: ${deliverableId}`);
			g.agents.push(agent);
			g.updatedAt = this.now();
		});
		const g = findDeliverable(this.plan, deliverableId) as Deliverable;
		return g.agents.find((a) => a.name === input.name) as AgentSpec;
	}

	updateAgent(
		deliverableId: string,
		name: string,
		patch: Partial<
			Pick<AgentSpec, "mode" | "model" | "effort" | "focus" | "after">
		>,
	): void {
		this.mutate((plan) => {
			const g = findDeliverable(plan, deliverableId);
			if (!g) throw new Error(`unknown deliverable: ${deliverableId}`);
			const agent = g.agents.find((a) => a.name === name);
			if (!agent) throw new Error(`unknown agent: ${name}`);
			assignDefined(agent, patch);
			g.updatedAt = this.now();
		});
	}

	removeAgent(deliverableId: string, name: string): void {
		this.mutate((plan) => {
			const g = findDeliverable(plan, deliverableId);
			if (!g) throw new Error(`unknown deliverable: ${deliverableId}`);
			const idx = g.agents.findIndex((a) => a.name === name);
			if (idx < 0) throw new Error(`unknown agent: ${name}`);
			g.agents.splice(idx, 1);
			g.updatedAt = this.now();
		});
	}

	// ── Sub-agent panel (persona reviewers) ──────────────────────────────────

	addSubAgent(deliverableId: string, spec: SubAgentSpec): SubAgentSpec {
		this.mutate((plan) => {
			const g = findDeliverable(plan, deliverableId);
			if (!g) throw new Error(`unknown deliverable: ${deliverableId}`);
			if ((g.subAgents ?? []).some((s) => s.name === spec.name))
				throw new Error(`sub-agent already exists: ${spec.name}`);
			g.subAgents = [...(g.subAgents ?? []), spec];
			g.updatedAt = this.now();
		});
		const g = findDeliverable(this.plan, deliverableId) as Deliverable;
		return (g.subAgents ?? []).find(
			(s) => s.name === spec.name,
		) as SubAgentSpec;
	}

	/** Record a human gate override permanently (see ReviewWaiver). */
	addWaiver(
		deliverableId: string,
		waiver: {
			reviewer: string;
			reason: string;
			findingId?: string;
			claim?: string;
			file?: string;
		},
	): void {
		this.mutate((plan) => {
			const g = findDeliverable(plan, deliverableId);
			if (!g) throw new Error(`unknown deliverable: ${deliverableId}`);
			g.waivers = [...(g.waivers ?? []), { ...waiver, at: this.now() }];
			g.updatedAt = this.now();
		});
	}

	/**
	 * Persist the panel review ledger (source of truth for the ship gate —
	 * survives worker respawns and maestro restarts). Undefined clears it
	 * (fresh review episode after a structural reopen).
	 */
	setReviewLedger(
		deliverableId: string,
		ledger: ReviewLedger | undefined,
	): void {
		this.mutate((plan) => {
			const g = findDeliverable(plan, deliverableId);
			if (!g) throw new Error(`unknown deliverable: ${deliverableId}`);
			if (ledger) g.reviewLedger = ledger;
			else delete g.reviewLedger;
			g.updatedAt = this.now();
		});
	}

	setWorkflowAnalytics(
		deliverableId: string,
		ledger: WorkflowAnalyticsLedger | undefined,
	): void {
		this.mutate((plan) => {
			const g = findDeliverable(plan, deliverableId);
			if (!g) throw new Error(`unknown deliverable: ${deliverableId}`);
			if (ledger) g.workflowAnalytics = structuredClone(ledger);
			else delete g.workflowAnalytics;
			g.updatedAt = this.now();
		});
	}

	removeSubAgent(deliverableId: string, name: string): void {
		this.mutate((plan) => {
			const g = findDeliverable(plan, deliverableId);
			if (!g) throw new Error(`unknown deliverable: ${deliverableId}`);
			const list = g.subAgents ?? [];
			const idx = list.findIndex((s) => s.name === name);
			if (idx < 0) throw new Error(`unknown sub-agent: ${name}`);
			list.splice(idx, 1);
			g.subAgents = list;
			g.updatedAt = this.now();
		});
	}

	// ── Work items ─────────────────────────────────────────────────────────

	addWorkItem(deliverableId: string, input: AddWorkItemInput): WorkItem {
		const ts = this.now();
		const id = this.uniqueTaskId(deliverableId, input.title);
		const item: WorkItem = {
			type: "work-item",
			id,
			title: input.title,
			body: input.body ?? "",
			done: false,
			kind: input.kind ?? "task",
			createdAt: ts,
			updatedAt: ts,
		};
		this.mutate((plan) => {
			const g = findDeliverable(plan, deliverableId);
			if (!g) throw new Error(`unknown deliverable: ${deliverableId}`);
			if (input.position !== undefined && input.position < g.tasks.length) {
				g.tasks.splice(input.position, 0, item);
			} else {
				g.tasks.push(item);
			}
			g.updatedAt = this.now();
		});
		const g = findDeliverable(this.plan, deliverableId) as Deliverable;
		return findTask(g, id) as WorkItem;
	}

	updateWorkItem(
		deliverableId: string,
		taskId: string,
		patch: Partial<Pick<WorkItem, "title" | "body" | "kind">> & {
			answer?: string;
		},
	): void {
		this.mutate((plan) => {
			const g = findDeliverable(plan, deliverableId);
			if (!g) throw new Error(`unknown deliverable: ${deliverableId}`);
			const item = findTask(g, taskId);
			if (!item) throw new Error(`unknown task: ${taskId}`);
			const { answer, ...rest } = patch;
			assignDefined(item, rest);
			if (answer !== undefined) {
				item.answer = answer;
				item.decidedAt = this.now();
				item.done = true;
			}
			item.updatedAt = this.now();
			g.updatedAt = this.now();
		});
	}

	toggleWorkItem(deliverableId: string, taskId: string): boolean {
		let done = false;
		this.mutate((plan) => {
			const g = findDeliverable(plan, deliverableId);
			if (!g) throw new Error(`unknown deliverable: ${deliverableId}`);
			const item = findTask(g, taskId);
			if (!item) throw new Error(`unknown task: ${taskId}`);
			item.done = !item.done;
			item.updatedAt = this.now();
			g.updatedAt = this.now();
			done = item.done;
		});
		return done;
	}

	removeWorkItem(deliverableId: string, taskId: string): void {
		this.mutate((plan) => {
			const g = findDeliverable(plan, deliverableId);
			if (!g) throw new Error(`unknown deliverable: ${deliverableId}`);
			const idx = g.tasks.findIndex((t) => t.id === taskId);
			if (idx < 0) throw new Error(`unknown task: ${taskId}`);
			g.tasks.splice(idx, 1);
			g.updatedAt = this.now();
		});
	}

	/**
	 * Apply the complete, narrow debug repair to one clone/save. The operation
	 * vocabulary cannot express topology, lifecycle, review, or runtime edits.
	 */
	applyTaskRepair(input: PlanRepairInput): {
		fingerprint: string;
		auditId: string;
	} {
		if (!input.reason.trim()) throw new Error("repair reason required");
		if (input.operations.length === 0)
			throw new Error("repair has no operations");
		const actual = planFingerprint(this.plan);
		if (actual !== input.baseFingerprint) {
			throw new Error(
				`plan fingerprint drift: expected ${input.baseFingerprint}, found ${actual}`,
			);
		}
		const stopped = new Set(input.stoppedDeliverableIds);
		const touched = new Set(input.operations.map((op) => op.deliverableId));
		for (const id of touched) {
			const g = findDeliverable(this.plan, id);
			if (!g) throw new Error(`unknown deliverable: ${id}`);
			if (!stopped.has(id)) {
				throw new Error(`deliverable ${id} is not confirmed stopped`);
			}
			if (["shipped", "abandoned", "superseded"].includes(g.status)) {
				throw new Error(`deliverable ${id} is terminal (${g.status})`);
			}
			if (g.restartState === "restarting") {
				throw new Error(`deliverable ${id} is restarting`);
			}
		}
		const ts = this.now();
		const auditId = randomUUID();
		this.mutate((plan) => {
			for (const op of input.operations) {
				const g = findDeliverable(plan, op.deliverableId);
				if (!g) throw new Error(`unknown deliverable: ${op.deliverableId}`);
				switch (op.type) {
					case "addCorrectiveTask":
					case "addManualCheckpoint": {
						if (!op.task.id.trim() || !op.task.title.trim()) {
							throw new Error(`${op.type} requires task id and title`);
						}
						if (findTask(g, op.task.id)) {
							throw new Error(`task already exists: ${op.task.id}`);
						}
						g.tasks.push({
							type: "work-item",
							id: op.task.id,
							title: op.task.title,
							body: op.task.body ?? "",
							done: false,
							// Corrective tasks must gate completion (kind "task"): a repair
							// that the worker can finish without doing is no repair at all.
							kind: op.type === "addManualCheckpoint" ? "manual" : "task",
							createdAt: ts,
							updatedAt: ts,
						});
						break;
					}
					case "clarifyTask": {
						const task = findTask(g, op.taskId);
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
						const task = findTask(g, op.taskId);
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
				g.updatedAt = ts;
			}
			plan.repairAudit = [
				...(plan.repairAudit ?? []),
				{
					id: auditId,
					at: ts,
					baseFingerprint: input.baseFingerprint,
					reason: input.reason,
					deliverableIds: [...touched],
					operations: input.operations.map((op) => op.type),
				},
			];
		});
		return { fingerprint: planFingerprint(this.plan), auditId };
	}

	// ── Internal ───────────────────────────────────────────────────────────

	private mutate(fn: (plan: Plan) => void): void {
		const next = structuredClone(this.plan) as Plan;
		fn(next);
		const problems = validatePlanShape(next);
		if (problems.length > 0) {
			throw new Error(`invalid plan:\n- ${problems.join("\n- ")}`);
		}
		next.updatedAt = this.now();
		if (!this.draft) this.store.save(next);
		this.plan = next;
	}

	private uniqueDeliverableId(base: string): string {
		const root = slugify(base) || "deliverable";
		const taken = new Set(this.plan.deliverables.map((g) => g.id));
		if (!taken.has(root)) return root;
		for (let n = 2; ; n++) {
			const candidate = `${root}-${n}`;
			if (!taken.has(candidate)) return candidate;
		}
	}

	private uniqueTaskId(deliverableId: string, base: string): string {
		const root = slugify(base) || "task";
		const g = findDeliverable(this.plan, deliverableId);
		const taken = new Set(g?.tasks.map((t) => t.id) ?? []);
		if (!taken.has(root)) return root;
		for (let n = 2; ; n++) {
			const candidate = `${root}-${n}`;
			if (!taken.has(candidate)) return candidate;
		}
	}
}
