// Group execution engine — graph-based spawning and lifecycle management.
// One group = one branch = one PR. Worker + support agents with internal DAG.
//
// Maestro owns the lifecycle:
// 1. Groups activate when their dependsOn are satisfied
// 2. Agents spawn when their `after` deps within the group complete
// 3. Worker done = all tasks toggled
// 4. Support agent done = session exits or idle detected
// 5. Group complete = all agents done
// 6. Terminal groups ship (push + PR)
// 7. Non-terminal groups wait for downstream resolution

import type { PlanEngine } from "./engine.js";
import type { WorkGroup } from "./schema.js";
import {
	defaultBranchForGroup,
	findGroup,
	gatingTasks,
	immediateAgents,
	pickBaseBranch,
	readyGroups,
	shippableGroups,
	unblockedAgents,
} from "./schema.js";

// ─── Agent runtime state ─────────────────────────────────────────────────────

export type AgentStatus =
	| "pending"
	| "spawning"
	| "working"
	| "summarizing"
	| "done"
	| "failed";

export interface AgentState {
	/** "worker" or agent name. */
	name: string;
	groupId: string;
	status: AgentStatus;
	/** Random display name (from agent-names.ts). */
	displayName?: string;
	/** tmux session id. */
	sessionId?: string;
	/** Model resolved at spawn time. */
	model?: string;
	slot?: "default" | "alternate";
	effort?: string;
	/** Produced after completion. */
	summary?: string;
	/** Spawn timestamp. */
	startedAt?: string;
	/** Completion timestamp. */
	completedAt?: string;
	/** Error message if failed. */
	error?: string;
}

// ─── Group runtime state ─────────────────────────────────────────────────────

export interface GroupRunState {
	groupId: string;
	/** All agents (worker + support) and their runtime status. */
	agents: Map<string, AgentState>;
	/** Names of agents that have completed. */
	completed: Set<string>;
	/** Worktree path (if created). */
	worktreePath?: string;
	/** Branch name. */
	branch?: string;
}

// ─── Executor ────────────────────────────────────────────────────────────────

export interface ExecutorDeps {
	/** Spawn a tmux session for an agent. Returns session id. */
	spawnAgent: (opts: SpawnAgentOpts) => Promise<string>;
	/** Kill a tmux session. */
	killSession: (sessionId: string) => Promise<void>;
	/** Create a worktree for a group. */
	createWorktree: (opts: CreateWorktreeOpts) => Promise<string>;
	/** Push branch and create PR. Returns PR URL. */
	shipGroup: (opts: ShipGroupOpts) => Promise<string>;
	/** Request agent summary (sends summarize RPC). */
	requestSummary: (
		sessionId: string,
		consumer: string,
		preamble: string,
	) => Promise<string>;
	/** Repo default branch — the base for unstacked groups. */
	defaultBranch?: string;
	/** Current time. */
	now: () => string;
}

export interface SpawnAgentOpts {
	groupId: string;
	agentName: string;
	displayName: string;
	mode: "full" | "read-only";
	slot: "default" | "alternate";
	effort: string;
	worktreePath: string;
	seed: string;
}

export interface CreateWorktreeOpts {
	groupId: string;
	branch: string;
	baseBranch: string;
	repoPath: string;
}

export interface ShipGroupOpts {
	groupId: string;
	branch: string;
	title: string;
	body: string;
	worktreePath: string;
}

/**
 * The GroupExecutor manages the lifecycle of all groups and their agents.
 * It's driven by `tick()` which advances the state machine.
 */
export class GroupExecutor {
	private readonly groupStates = new Map<string, GroupRunState>();

	constructor(
		private readonly engine: PlanEngine,
		private readonly deps: ExecutorDeps,
	) {
		// Hydrate state for already-active groups (e.g. resumed session)
		for (const g of engine.get().groups) {
			if (g.status === "active" && !this.groupStates.has(g.id)) {
				this.hydrateActiveGroup(g);
			}
		}
	}

	/** Hydrate runtime state for a group that's already active (resume). */
	private hydrateActiveGroup(g: WorkGroup): void {
		const groupState: GroupRunState = {
			groupId: g.id,
			agents: new Map(),
			completed: new Set(),
			worktreePath: (g as unknown as { worktreePath?: string }).worktreePath,
			branch: `feat/${g.id}`,
		};
		groupState.agents.set("worker", {
			name: "worker",
			groupId: g.id,
			status: "pending",
		});
		for (const agent of g.agents) {
			groupState.agents.set(agent.name, {
				name: agent.name,
				groupId: g.id,
				status: "pending",
			});
		}
		this.groupStates.set(g.id, groupState);
	}

	/** Get all group runtime states. */
	getStates(): ReadonlyMap<string, GroupRunState> {
		return this.groupStates;
	}

	/** Get a specific agent's state. */
	getAgentState(groupId: string, agentName: string): AgentState | undefined {
		return this.groupStates.get(groupId)?.agents.get(agentName);
	}

	/**
	 * Main tick — advances execution state machine.
	 * Call periodically or on state-change events.
	 * Returns names of groups that were shipped this tick.
	 */
	async tick(): Promise<string[]> {
		const plan = this.engine.get();
		const shipped: string[] = [];

		// 1. Activate ready groups
		for (const g of readyGroups(plan)) {
			await this.activateGroup(g);
		}

		// 2. For each active group, check agent completion → spawn next
		for (const [groupId, state] of this.groupStates) {
			const g = findGroup(plan, groupId);
			if (g?.status !== "active") continue;
			await this.advanceGroup(g, state);
		}

		// 3. Ship terminal complete groups
		for (const g of shippableGroups(plan)) {
			const url = await this.shipGroupIfReady(g);
			if (url) shipped.push(g.id);
		}

		return shipped;
	}

	/**
	 * Mark an agent as done (externally triggered by RPC or idle detection).
	 */
	async markAgentDone(groupId: string, agentName: string): Promise<void> {
		const state = this.groupStates.get(groupId);
		if (!state) return;
		const agent = state.agents.get(agentName);
		if (!agent || agent.status === "done") return;

		// Request summary
		if (agent.sessionId) {
			const plan = this.engine.get();
			const g = findGroup(plan, groupId);
			const consumer = this.nextConsumer(g, agentName);
			const preamble = `${agent.displayName ?? agentName} (${agentName}) — ${g?.title ?? groupId}`;

			try {
				agent.status = "summarizing";
				const summary = await this.deps.requestSummary(
					agent.sessionId,
					consumer,
					preamble,
				);
				agent.summary = summary;
			} catch {
				// Summary extraction failed — continue without it
			}

			await this.deps.killSession(agent.sessionId);
		}

		agent.status = "done";
		agent.completedAt = this.deps.now();
		state.completed.add(agentName);

		// Check if group is complete
		await this.checkGroupCompletion(groupId);
	}

	/**
	 * Mark an agent as failed.
	 */
	markAgentFailed(groupId: string, agentName: string, error: string): void {
		const state = this.groupStates.get(groupId);
		if (!state) return;
		const agent = state.agents.get(agentName);
		if (!agent) return;
		agent.status = "failed";
		agent.error = error;
		agent.completedAt = this.deps.now();
	}

	/**
	 * Check if all gating tasks for a worker are toggled.
	 */
	isWorkerDone(groupId: string): boolean {
		const plan = this.engine.get();
		const g = findGroup(plan, groupId);
		if (!g) return false;
		return gatingTasks(g).every((t) => t.done);
	}

	/** Respawn a failed agent (reuse spawnAgentInGroup with fresh state). */
	async respawnAgent(groupId: string, agentName: string): Promise<void> {
		const plan = this.engine.get();
		const g = findGroup(plan, groupId);
		if (!g) throw new Error(`group ${groupId} not found`);
		const state = this.groupStates.get(groupId);
		if (!state) throw new Error(`no state for group ${groupId}`);
		const agentState = state.agents.get(agentName);
		if (!agentState) throw new Error(`no state for agent ${agentName}`);

		// Reset agent state for respawn
		agentState.status = "pending";
		agentState.sessionId = undefined;
		agentState.error = undefined;
		agentState.completedAt = undefined;

		await this.spawnAgentInGroup(g, state, agentName);
	}

	// ─── Internal ──────────────────────────────────────────────────────────

	private async activateGroup(g: WorkGroup): Promise<void> {
		const plan = this.engine.get();
		const branch = g.branch ?? defaultBranchForGroup(g);
		const baseBranch = pickBaseBranch(
			plan,
			g,
			this.deps.defaultBranch ?? "main",
		);

		// Create worktree
		const worktreePath = await this.deps.createWorktree({
			groupId: g.id,
			branch,
			baseBranch,
			repoPath: plan.repoPath,
		});

		// Initialize runtime state
		const groupState: GroupRunState = {
			groupId: g.id,
			agents: new Map(),
			completed: new Set(),
			worktreePath,
			branch,
		};

		// Register all agents (worker + support)
		groupState.agents.set("worker", {
			name: "worker",
			groupId: g.id,
			status: "pending",
		});
		for (const agent of g.agents) {
			groupState.agents.set(agent.name, {
				name: agent.name,
				groupId: g.id,
				status: "pending",
			});
		}

		this.groupStates.set(g.id, groupState);

		// Transition to active
		this.engine.setGroupStatus(g.id, "active");
		this.engine.updateGroup(g.id, { branch, worktreePath });

		// Spawn immediately-startable agents
		const immediate = immediateAgents(g);
		for (const name of immediate) {
			await this.spawnAgentInGroup(g, groupState, name);
		}
	}

	private async advanceGroup(
		g: WorkGroup,
		state: GroupRunState,
	): Promise<void> {
		// Spawn immediate agents that are still pending (e.g. after hydration)
		const immediate = immediateAgents(g);
		for (const name of immediate) {
			const agent = state.agents.get(name);
			if (agent && agent.status === "pending") {
				await this.spawnAgentInGroup(g, state, name);
			}
		}

		// Check for newly-unblocked agents (those with `after` deps)
		const unblocked = unblockedAgents(g, state.completed);
		for (const name of unblocked) {
			const agent = state.agents.get(name);
			if (agent && agent.status === "pending") {
				await this.spawnAgentInGroup(g, state, name);
			}
		}
	}

	private async spawnAgentInGroup(
		g: WorkGroup,
		state: GroupRunState,
		name: string,
	): Promise<void> {
		const agentState = state.agents.get(name);
		if (!agentState) return;

		const spec =
			name === "worker" ? g.worker : g.agents.find((a) => a.name === name);
		if (!spec) return;

		const mode = spec.mode;
		const slot = ("slot" in spec ? spec.slot : undefined) ?? "default";
		const effort = ("effort" in spec ? spec.effort : undefined) ?? "low";

		const { agentName: genName } = await import("./agent-names.js");
		const takenNames = new Set(
			[...state.agents.values()]
				.filter((a) => a.displayName)
				.map((a) => a.displayName as string),
		);

		agentState.status = "spawning";
		agentState.displayName = genName(g.id, takenNames);
		agentState.slot = slot;
		agentState.effort = effort;
		agentState.startedAt = this.deps.now();

		const seed = this.buildSeed(g, state, name);

		const sessionId = await this.deps.spawnAgent({
			groupId: g.id,
			agentName: name,
			displayName: agentState.displayName,
			mode,
			slot,
			effort,
			worktreePath: state.worktreePath!,
			seed,
		});

		agentState.sessionId = sessionId;
		agentState.status = "working";
	}

	private buildSeed(g: WorkGroup, state: GroupRunState, name: string): string {
		const parts: string[] = [];
		const plan = this.engine.get();

		// 1. Dep summaries from prior groups (cache-stable prefix)
		for (const depId of g.dependsOn ?? []) {
			const dep = findGroup(plan, depId);
			if (dep?.summary) {
				parts.push(dep.summary);
			}
		}

		// 2. Accumulated sibling summaries (from completed agents in this group)
		for (const [agentName, agentState] of state.agents) {
			if (agentName === name) continue; // Don't include self
			if (agentState.summary) {
				parts.push(agentState.summary);
			}
		}

		// 3. Agent-specific content (last — unique to this agent)
		if (name === "worker") {
			parts.push(`## Group: ${g.title}\n\n${g.body}`);
			const tasks = gatingTasks(g);
			if (tasks.length > 0) {
				parts.push("\n## Tasks\n");
				for (const t of tasks) {
					const check = t.done ? "x" : " ";
					parts.push(`- [${check}] **${t.title}**`);
					if (t.body) parts.push(`  ${t.body}`);
				}
			}
			parts.push(
				"\n---\nDo your work. Commit as you go. Toggle tasks when done. " +
					"Exit when complete. The maestro handles pushing and opening the PR.",
			);
		} else {
			const spec = g.agents.find((a) => a.name === name);
			if (spec) {
				parts.push(`## Focus: ${spec.focus}`);
			}
		}

		return parts.join("\n\n");
	}

	private nextConsumer(g: WorkGroup | null, completedAgent: string): string {
		if (!g) return "the next step in the workflow";

		// Find next agent in the graph that depends on this one
		if (completedAgent === "worker") {
			const dependents = g.agents.filter((a) => a.after.includes("worker"));
			if (dependents.length > 0) {
				return dependents.map((a) => a.focus).join("; ");
			}
		} else {
			const dependents = g.agents.filter((a) =>
				a.after.includes(completedAgent),
			);
			if (dependents.length > 0) {
				return dependents.map((a) => a.focus).join("; ");
			}
		}

		// No dependents within group — next consumer is downstream groups
		const plan = this.engine.get();
		const downstream = plan.groups.filter((other) =>
			other.dependsOn?.includes(g.id),
		);
		if (downstream.length > 0) {
			return downstream
				.map((d) => `group "${d.title}": ${d.body.slice(0, 100)}`)
				.join("; ");
		}

		return "the project completion summary";
	}

	private async checkGroupCompletion(groupId: string): Promise<void> {
		const state = this.groupStates.get(groupId);
		if (!state) return;

		// All agents must be done
		const allDone = [...state.agents.values()].every(
			(a) => a.status === "done" || a.status === "failed",
		);
		if (!allDone) return;

		// Any failures?
		const anyFailed = [...state.agents.values()].some(
			(a) => a.status === "failed",
		);
		if (anyFailed) {
			// Leave as active — requires manual intervention
			return;
		}

		// Assemble group summary from agent summaries
		const summaries = [...state.agents.values()]
			.filter((a) => a.summary)
			.map((a) => a.summary as string);
		const groupSummary = summaries.join("\n\n");

		this.engine.setGroupStatus(groupId, "complete");
		this.engine.updateGroup(groupId, { summary: groupSummary });
	}

	private async shipGroupIfReady(g: WorkGroup): Promise<string | null> {
		const state = this.groupStates.get(g.id);
		if (!state) return null;

		// Assemble PR body
		const tasks = gatingTasks(g);
		const taskList = tasks.map((t) => `- [x] ${t.title}`).join("\n");
		const agentSummaries = [...state.agents.values()]
			.filter((a) => a.summary)
			.map((a) => `### ${a.displayName ?? a.name} (${a.name})\n${a.summary}`)
			.join("\n\n");

		const body = [
			g.body,
			taskList ? `## Tasks\n${taskList}` : "",
			agentSummaries ? `## Agent Reports\n${agentSummaries}` : "",
		]
			.filter(Boolean)
			.join("\n\n");

		// Ship failure is retryable: leave the group `complete` and let a later
		// tick (or /ship) try again — durable status never advances without a PR.
		let prUrl: string;
		try {
			prUrl = await this.deps.shipGroup({
				groupId: g.id,
				branch: state.branch ?? defaultBranchForGroup(g),
				title: g.title,
				body,
				worktreePath: state.worktreePath!,
			});
		} catch {
			return null;
		}

		this.engine.setGroupStatus(g.id, "shipped");
		this.engine.updateGroup(g.id, { prUrl });

		// Mark superseded predecessors (non-terminal that have shipped all dependents)
		await this.markSuperseded(g);

		return prUrl;
	}

	private async markSuperseded(shipped: WorkGroup): Promise<void> {
		const plan = this.engine.get();
		for (const depId of shipped.dependsOn ?? []) {
			const dep = findGroup(plan, depId);
			if (dep?.status !== "complete") continue;
			// Check if ALL dependents of this dep are now shipped/superseded
			const dependents = plan.groups.filter((other) =>
				other.dependsOn?.includes(depId),
			);
			const allResolved = dependents.every(
				(d) => d.status === "shipped" || d.status === "superseded",
			);
			if (allResolved) {
				this.engine.setGroupStatus(depId, "superseded");
			}
		}
	}
}
