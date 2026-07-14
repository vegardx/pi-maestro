// PlanEngine — the mutation surface over a Plan. Every mutation clones the
// plan, applies the change, runs validatePlanShape, and (only if valid) bumps
// timestamps and persists atomically. Invalid mutations throw before touching
// disk, so the in-memory plan and the file never diverge.

import type { ReviewLedger } from "./exec/findings.js";
import {
	type AgentMode,
	type AgentSpec,
	canTransition,
	DEFAULT_REPO_KEY,
	type Deliverable,
	type DeliverableStatus,
	defaultBranchForDeliverable,
	findDeliverable,
	findTask,
	type Plan,
	type PlanPhase,
	type PlanRepo,
	type SubAgentSpec,
	slugify,
	type ThinkingLevel,
	validatePlanShape,
	type WorkItem,
	type WorkItemKind,
} from "./schema.js";
import type { PlanStore } from "./storage.js";

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
				| "worktreePath"
				| "sessionPath"
				| "sessionName"
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

	setDeliverableStatus(id: string, status: DeliverableStatus): void {
		this.mutate((plan) => {
			const g = findDeliverable(plan, id);
			if (!g) throw new Error(`unknown deliverable: ${id}`);
			if (g.status !== status && !canTransition(g.status, status)) {
				throw new Error(`illegal status transition: ${g.status} → ${status}`);
			}
			g.status = status;
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
