// Group execution engine — graph-based spawning and lifecycle management.
// One group = one branch = one PR. Worker + support agents with internal DAG.
//
// Maestro owns the lifecycle:
// 1. Groups activate when their dependsOn are satisfied (deps complete/shipped
//    or terminally non-productive — never merely active)
// 2. Agents spawn when their `after` deps within the group complete
// 3. Worker done = all tasks toggled
// 4. Support agent done = session exits or idle detected
// 5. Group complete = all agents done
// 6. Complete groups ship (push + PR) in chain order: a group ships once all
//    its dependsOn groups have shipped, so stacked PR bases exist on the remote

import type { PlanEngine } from "./engine.js";
import { parseVerdict, VERDICT_INSTRUCTION } from "./exec/verdicts.js";
import type { AgentMode, WorkGroup } from "./schema.js";
import {
	defaultBranchForGroup,
	findAgent,
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
	/** Session JSONL path — retained across kills for resurrection/respawn. */
	sessionFile?: string;
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
	/** Review→fix round counter. 0 = initial implementation. */
	round: number;
	/** Set when the fix loop stopped without converging; surfaced to the user. */
	blocked?: string;
	/** Findings from each objecting reviewer's last round (no-progress guard). */
	lastFindingsByReviewer?: Map<string, string[]>;
}

// ─── Executor ────────────────────────────────────────────────────────────────

export interface SpawnedAgent {
	/** tmux session id. */
	sessionId: string;
	/** Session JSONL path — the executor threads it for later resurrection. */
	sessionFile: string;
}

export interface ExecutorDeps {
	/** Spawn a tmux session for an agent. */
	spawnAgent: (opts: SpawnAgentOpts) => Promise<SpawnedAgent>;
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
	/** Resume an existing session file instead of seeding a fresh one. */
	resumeSessionFile?: string;
	/** Positional kickoff message for the (re)spawned pi process. */
	kickoffMessage?: string;
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
	/** In-flight markAgentDone per "groupId/agentName" — concurrent callers share it. */
	private readonly doneInFlight = new Map<string, Promise<void>>();
	/** Groups mid-activation — a concurrent tick must not activate them again. */
	private readonly activating = new Set<string>();

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

	/**
	 * Hydrate runtime state for a group that's already active (resume).
	 * A maestro restart ends the run: orphaned pi processes may still live in
	 * tmux, so hydrated groups come up blocked instead of auto-respawning.
	 */
	private hydrateActiveGroup(g: WorkGroup): void {
		const groupState: GroupRunState = {
			groupId: g.id,
			agents: new Map(),
			completed: new Set(),
			worktreePath: (g as unknown as { worktreePath?: string }).worktreePath,
			branch: `feat/${g.id}`,
			round: 0,
			blocked:
				"maestro restarted — agents may still be running in tmux; /retry after inspecting",
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

		// 3. Ship complete groups in chain order. A parent's ship makes its
		// dependents shippable, so re-evaluate until a pass makes no progress;
		// each group is attempted once per tick (a ship failure stays retryable
		// on a later tick without looping here).
		const attempted = new Set<string>();
		let progressed = true;
		while (progressed) {
			progressed = false;
			for (const g of shippableGroups(this.engine.get())) {
				if (attempted.has(g.id)) continue;
				attempted.add(g.id);
				const url = await this.shipGroupIfReady(g);
				if (url) {
					shipped.push(g.id);
					progressed = true;
				}
			}
		}

		return shipped;
	}

	/**
	 * Mark an agent as done (externally triggered by RPC or idle detection).
	 * Idempotent: concurrent callers (RPC done + poll timer) share one run;
	 * agents already summarizing or done are left alone.
	 */
	async markAgentDone(groupId: string, agentName: string): Promise<void> {
		const key = `${groupId}/${agentName}`;
		const inFlight = this.doneInFlight.get(key);
		if (inFlight) return inFlight;
		const run = this.runMarkAgentDone(groupId, agentName).finally(() => {
			this.doneInFlight.delete(key);
		});
		this.doneInFlight.set(key, run);
		return run;
	}

	private async runMarkAgentDone(
		groupId: string,
		agentName: string,
	): Promise<void> {
		const state = this.groupStates.get(groupId);
		if (!state) return;
		const agent = state.agents.get(agentName);
		if (!agent || agent.status === "done" || agent.status === "summarizing")
			return;

		// Capture before any await: if the agent is respawned while we
		// summarize, the stale completion must not kill the fresh session.
		const sessionId = agent.sessionId;

		// Request summary
		if (sessionId) {
			const plan = this.engine.get();
			const g = findGroup(plan, groupId);
			const consumer = this.nextConsumer(g, agentName);
			let preamble = `${agent.displayName ?? agentName} (${agentName}) — ${g?.title ?? groupId}`;
			// Read-only reviewers must end their summary with a verdict.
			const spec = g ? findAgent(g, agentName) : null;
			if (spec?.mode === "read-only") {
				preamble += `\n\n${VERDICT_INSTRUCTION}`;
			}

			try {
				agent.status = "summarizing";
				const summary = await this.deps.requestSummary(
					sessionId,
					consumer,
					preamble,
				);
				agent.summary = summary;
			} catch {
				// Summary extraction failed — continue without it
			}

			await this.deps.killSession(sessionId);
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

	/** Block a group with a user-facing reason (surfaced via getStates). */
	blockGroup(groupId: string, reason: string): void {
		const state = this.groupStates.get(groupId);
		if (state) state.blocked = reason;
	}

	/** Clear a group's blocked reason (user-driven retry). */
	unblockGroup(groupId: string): void {
		const state = this.groupStates.get(groupId);
		if (state) state.blocked = undefined;
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

		// Reset agent state for respawn; sessionFile is kept so the respawn
		// resumes the agent's own transcript instead of starting cold.
		agentState.status = "pending";
		agentState.sessionId = undefined;
		agentState.error = undefined;
		agentState.completedAt = undefined;

		await this.spawnAgentInGroup(g, state, agentName);
	}

	// ─── Internal ──────────────────────────────────────────────────────────

	private async activateGroup(g: WorkGroup): Promise<void> {
		// Re-entrancy guard: provisioning awaits before the status flips to
		// active, so an overlapping tick would otherwise double-activate.
		if (this.activating.has(g.id) || this.groupStates.has(g.id)) return;
		this.activating.add(g.id);
		try {
			await this.doActivateGroup(g);
		} finally {
			this.activating.delete(g.id);
		}
	}

	private async doActivateGroup(g: WorkGroup): Promise<void> {
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
			round: 0,
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
		// Blocked groups (fix-loop stall, maestro restart) need user action
		// before any further spawning.
		if (state.blocked) return;

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
		kickoffMessage?: string,
	): Promise<void> {
		const agentState = state.agents.get(name);
		if (!agentState) return;

		// Never spawn into a blocked group (fix rounds clear `blocked` first).
		if (state.blocked) return;

		const spec =
			name === "worker" ? g.worker : g.agents.find((a) => a.name === name);
		if (!spec) return;

		// Group scheduler invariant: one agent TYPE active per group at a time.
		// Not spawnable now → stays pending; a later tick retries.
		if (!this.canSpawnNow(g, state, spec.mode)) return;

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
		agentState.displayName ??= genName(g.id, takenNames);
		agentState.slot = slot;
		agentState.effort = effort;
		agentState.startedAt = this.deps.now();

		// Resurrection: an agent with a prior session file resumes its own
		// transcript (cache-hot) instead of being re-seeded from scratch.
		const resumeSessionFile = agentState.sessionFile;
		const seed = resumeSessionFile ? "" : this.buildSeed(g, state, name);

		const spawned = await this.deps.spawnAgent({
			groupId: g.id,
			agentName: name,
			displayName: agentState.displayName,
			mode,
			slot,
			effort,
			worktreePath: state.worktreePath!,
			seed,
			...(resumeSessionFile
				? {
						resumeSessionFile,
						kickoffMessage: kickoffMessage ?? this.resumeKickoff(state, name),
					}
				: {}),
		});

		agentState.sessionId = spawned.sessionId;
		agentState.sessionFile = spawned.sessionFile;
		agentState.status = "working";
	}

	/**
	 * Scheduler invariant: within a group, at most one agent type is active at
	 * a time. Full-mode agents run strictly alone; read-only agents may run
	 * concurrently with each other but never alongside a full-mode agent.
	 */
	private canSpawnNow(
		g: WorkGroup,
		state: GroupRunState,
		mode: AgentMode,
	): boolean {
		const active = [...state.agents.values()].filter(
			(a) =>
				a.status === "spawning" ||
				a.status === "working" ||
				a.status === "summarizing",
		);
		if (active.length === 0) return true;
		if (mode === "full") return false;
		return active.every((a) => {
			const spec =
				a.name === "worker"
					? g.worker
					: g.agents.find((x) => x.name === a.name);
			return (spec?.mode ?? "read-only") === "read-only";
		});
	}

	/** Default kickoff for a resumed session when the caller supplies none. */
	private resumeKickoff(state: GroupRunState, name: string): string {
		const findings = state.lastFindingsByReviewer?.get(name);
		if (findings && findings.length > 0) {
			return (
				`The worker completed fix round ${state.round} addressing your ` +
				`findings. Verify each is resolved and finish with a fresh verdict:\n` +
				findings.map((f) => `- ${f}`).join("\n")
			);
		}
		return (
			"Your previous session ended unexpectedly and has been resumed. " +
			"Review your progress, then continue the remaining work."
		);
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

		// Review verdicts: any read-only reviewer requesting changes starts a
		// fix round (bounded); a missing verdict does not block.
		const g = findGroup(this.engine.get(), groupId);
		if (g) {
			const objections: { name: string; findings: string[] }[] = [];
			for (const spec of g.agents) {
				if (spec.mode !== "read-only") continue;
				const reviewer = state.agents.get(spec.name);
				if (!reviewer?.summary) continue;
				const parsed = parseVerdict(reviewer.summary);
				if (parsed.verdict === "request-changes") {
					objections.push({ name: spec.name, findings: parsed.findings });
				}
			}
			if (objections.length > 0) {
				await this.startFixRound(g, state, objections);
				return;
			}
		}

		// Assemble group summary from agent summaries
		const summaries = [...state.agents.values()]
			.filter((a) => a.summary)
			.map((a) => a.summary as string);
		const groupSummary = summaries.join("\n\n");

		this.engine.setGroupStatus(groupId, "complete");
		this.engine.updateGroup(groupId, { summary: groupSummary });
	}

	/**
	 * Start a review→fix round: findings become tagged gating tasks, the
	 * worker is resurrected from its own session to fix them, and objecting
	 * reviewers re-run once the worker completes (their "worker" dep becomes
	 * unsatisfied again). Bounded by the round cap and a no-progress guard;
	 * either stop leaves the group active with `blocked` set for the user.
	 */
	private async startFixRound(
		g: WorkGroup,
		state: GroupRunState,
		objections: { name: string; findings: string[] }[],
	): Promise<void> {
		// No-progress guard: a reviewer re-raising byte-identical findings
		// means fix rounds aren't converging.
		for (const o of objections) {
			const prev = state.lastFindingsByReviewer?.get(o.name);
			if (prev && JSON.stringify(prev) === JSON.stringify(o.findings)) {
				state.blocked = "review findings unchanged after fix round";
				return;
			}
		}

		const maxFixRounds = g.maxFixRounds ?? 2;
		if (state.round >= maxFixRounds) {
			const outstanding = objections.reduce((n, o) => n + o.findings.length, 0);
			state.blocked = `fix-round cap reached; ${outstanding} findings outstanding`;
			return;
		}

		state.round += 1;
		state.blocked = undefined;

		// Add all work items before mutating any agent state: a mid-loop
		// validation failure must not leave a half-armed round (round bumped
		// but nobody re-pended → the group would wedge silently).
		const allFindings: string[] = [];
		try {
			for (const o of objections) {
				for (const finding of o.findings) {
					this.engine.addWorkItem(g.id, {
						title: `[round ${state.round}, ${o.name}] ${finding}`,
						kind: "task",
					});
					allFindings.push(finding);
				}
			}
		} catch (e) {
			state.round -= 1;
			state.blocked = `fix round failed: ${e instanceof Error ? e.message : String(e)}`;
			return;
		}

		state.lastFindingsByReviewer ??= new Map();
		for (const o of objections) {
			state.lastFindingsByReviewer.set(o.name, o.findings);
		}

		// Re-pend the worker and every objecting reviewer; approving reviewers
		// stay done. Dropping them from `completed` re-arms the after-DAG.
		for (const name of ["worker", ...objections.map((o) => o.name)]) {
			const a = state.agents.get(name);
			if (!a) continue;
			a.status = "pending";
			a.summary = undefined;
			a.completedAt = undefined;
			a.sessionId = undefined;
			state.completed.delete(name);
		}

		const kickoff =
			`Reviewers found issues with your changes — address each, commit, ` +
			`and toggle the new [round ${state.round}] tasks:\n` +
			allFindings.map((f) => `- ${f}`).join("\n");
		await this.spawnAgentInGroup(g, state, "worker", kickoff);
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

		// Every group ships its own PR — predecessors are never auto-superseded.
		// `superseded` stays a user-driven status (the transition remains legal).

		return prUrl;
	}
}
