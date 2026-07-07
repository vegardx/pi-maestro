// PlanEngine — the mutation surface over a Plan. Every mutation clones the
// plan, applies the change, runs validatePlanShape, and (only if valid) bumps
// timestamps and persists atomically. Invalid mutations throw before touching
// disk, so the in-memory plan and the file never diverge.

import {
	type AgentMode,
	type AgentSpec,
	canTransition,
	DEFAULT_REPO_KEY,
	defaultBranchForGroup,
	findGroup,
	findTask,
	type GroupStatus,
	type ModelSlot,
	type Plan,
	type PlanPhase,
	type PlanRepo,
	slugify,
	type ThinkingLevel,
	validatePlanShape,
	type WorkGroup,
	type WorkItem,
	type WorkItemKind,
} from "./schema.js";
import type { PlanStore } from "./storage.js";

export interface AddGroupInput {
	title: string;
	body?: string;
	dependsOn?: string[];
	stacked?: boolean;
	workerMode: AgentMode;
	workerSlot?: ModelSlot;
	workerEffort?: ThinkingLevel;
	workerAfter?: string[];
}

export interface AddAgentInput {
	name: string;
	mode: AgentMode;
	slot: ModelSlot;
	effort: ThinkingLevel;
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
			groups: [],
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
			groups: [],
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
			Object.assign(plan, patch);
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

	// ── Groups ─────────────────────────────────────────────────────────────

	addGroup(input: AddGroupInput): WorkGroup {
		const ts = this.now();
		const id = this.uniqueGroupId(input.title);
		const group: WorkGroup = {
			type: "group",
			id,
			title: input.title,
			body: input.body ?? "",
			status: "planned",
			dependsOn: input.dependsOn,
			stacked: input.stacked,
			worker: {
				mode: input.workerMode,
				slot: input.workerSlot,
				effort: input.workerEffort,
				after: input.workerAfter,
			},
			agents: [],
			tasks: [],
			branch: defaultBranchForGroup({ id }),
			createdAt: ts,
			updatedAt: ts,
		};
		this.mutate((plan) => {
			plan.groups.push(group);
		});
		return findGroup(this.plan, id) as WorkGroup;
	}

	updateGroup(
		id: string,
		patch: Partial<
			Pick<
				WorkGroup,
				| "title"
				| "body"
				| "dependsOn"
				| "stacked"
				| "branch"
				| "worktreePath"
				| "sessionPath"
				| "summary"
				| "prUrl"
				| "prNumber"
				| "maxFixRounds"
			>
		> & {
			workerMode?: AgentMode;
			workerSlot?: ModelSlot;
			workerEffort?: ThinkingLevel;
			workerAfter?: string[];
		},
	): void {
		this.mutate((plan) => {
			const g = findGroup(plan, id);
			if (!g) throw new Error(`unknown group: ${id}`);
			const {
				workerMode,
				workerSlot,
				workerEffort,
				workerAfter,
				...groupPatch
			} = patch;
			Object.assign(g, groupPatch);
			if (workerMode !== undefined) g.worker.mode = workerMode;
			if (workerSlot !== undefined) g.worker.slot = workerSlot;
			if (workerEffort !== undefined) g.worker.effort = workerEffort;
			if (workerAfter !== undefined) g.worker.after = workerAfter;
			g.updatedAt = this.now();
		});
	}

	setGroupStatus(id: string, status: GroupStatus): void {
		this.mutate((plan) => {
			const g = findGroup(plan, id);
			if (!g) throw new Error(`unknown group: ${id}`);
			if (g.status !== status && !canTransition(g.status, status)) {
				throw new Error(`illegal status transition: ${g.status} → ${status}`);
			}
			g.status = status;
			g.updatedAt = this.now();
		});
	}

	removeGroup(id: string): void {
		this.mutate((plan) => {
			const idx = plan.groups.findIndex((g) => g.id === id);
			if (idx < 0) throw new Error(`unknown group: ${id}`);
			plan.groups.splice(idx, 1);
		});
	}

	// ── Agents ─────────────────────────────────────────────────────────────

	addAgent(groupId: string, input: AddAgentInput): AgentSpec {
		const agent: AgentSpec = {
			name: input.name,
			mode: input.mode,
			slot: input.slot,
			effort: input.effort,
			focus: input.focus,
			after: input.after,
		};
		this.mutate((plan) => {
			const g = findGroup(plan, groupId);
			if (!g) throw new Error(`unknown group: ${groupId}`);
			g.agents.push(agent);
			g.updatedAt = this.now();
		});
		const g = findGroup(this.plan, groupId) as WorkGroup;
		return g.agents.find((a) => a.name === input.name) as AgentSpec;
	}

	updateAgent(
		groupId: string,
		name: string,
		patch: Partial<
			Pick<AgentSpec, "mode" | "slot" | "effort" | "focus" | "after">
		>,
	): void {
		this.mutate((plan) => {
			const g = findGroup(plan, groupId);
			if (!g) throw new Error(`unknown group: ${groupId}`);
			const agent = g.agents.find((a) => a.name === name);
			if (!agent) throw new Error(`unknown agent: ${name}`);
			Object.assign(agent, patch);
			g.updatedAt = this.now();
		});
	}

	removeAgent(groupId: string, name: string): void {
		this.mutate((plan) => {
			const g = findGroup(plan, groupId);
			if (!g) throw new Error(`unknown group: ${groupId}`);
			const idx = g.agents.findIndex((a) => a.name === name);
			if (idx < 0) throw new Error(`unknown agent: ${name}`);
			g.agents.splice(idx, 1);
			g.updatedAt = this.now();
		});
	}

	// ── Work items ─────────────────────────────────────────────────────────

	addWorkItem(groupId: string, input: AddWorkItemInput): WorkItem {
		const ts = this.now();
		const id = this.uniqueTaskId(groupId, input.title);
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
			const g = findGroup(plan, groupId);
			if (!g) throw new Error(`unknown group: ${groupId}`);
			if (input.position !== undefined && input.position < g.tasks.length) {
				g.tasks.splice(input.position, 0, item);
			} else {
				g.tasks.push(item);
			}
			g.updatedAt = this.now();
		});
		const g = findGroup(this.plan, groupId) as WorkGroup;
		return findTask(g, id) as WorkItem;
	}

	updateWorkItem(
		groupId: string,
		taskId: string,
		patch: Partial<Pick<WorkItem, "title" | "body" | "kind">> & {
			answer?: string;
		},
	): void {
		this.mutate((plan) => {
			const g = findGroup(plan, groupId);
			if (!g) throw new Error(`unknown group: ${groupId}`);
			const item = findTask(g, taskId);
			if (!item) throw new Error(`unknown task: ${taskId}`);
			const { answer, ...rest } = patch;
			Object.assign(item, rest);
			if (answer !== undefined) {
				item.answer = answer;
				item.decidedAt = this.now();
				item.done = true;
			}
			item.updatedAt = this.now();
			g.updatedAt = this.now();
		});
	}

	toggleWorkItem(groupId: string, taskId: string): boolean {
		let done = false;
		this.mutate((plan) => {
			const g = findGroup(plan, groupId);
			if (!g) throw new Error(`unknown group: ${groupId}`);
			const item = findTask(g, taskId);
			if (!item) throw new Error(`unknown task: ${taskId}`);
			item.done = !item.done;
			item.updatedAt = this.now();
			g.updatedAt = this.now();
			done = item.done;
		});
		return done;
	}

	removeWorkItem(groupId: string, taskId: string): void {
		this.mutate((plan) => {
			const g = findGroup(plan, groupId);
			if (!g) throw new Error(`unknown group: ${groupId}`);
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

	private uniqueGroupId(base: string): string {
		const root = slugify(base) || "group";
		const taken = new Set(this.plan.groups.map((g) => g.id));
		if (!taken.has(root)) return root;
		for (let n = 2; ; n++) {
			const candidate = `${root}-${n}`;
			if (!taken.has(candidate)) return candidate;
		}
	}

	private uniqueTaskId(groupId: string, base: string): string {
		const root = slugify(base) || "task";
		const g = findGroup(this.plan, groupId);
		const taken = new Set(g?.tasks.map((t) => t.id) ?? []);
		if (!taken.has(root)) return root;
		for (let n = 2; ; n++) {
			const candidate = `${root}-${n}`;
			if (!taken.has(candidate)) return candidate;
		}
	}
}
