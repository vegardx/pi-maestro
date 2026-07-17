// Deliverable execution engine — graph-based spawning and lifecycle management.
// One deliverable = one branch = one PR. Worker + support agents with internal DAG.
//
// Maestro owns the lifecycle:
// 1. Deliverables activate when their dependsOn are satisfied (deps complete/shipped
//    or terminally non-productive — never merely active)
// 2. Agents spawn when their `after` deps within the deliverable complete
// 3. Worker done = all tasks toggled
// 4. Support agent done = session exits or idle detected
// 5. Deliverable complete = all agents done
// 6. Complete deliverables ship (push + PR) in chain order: a deliverable ships once all
//    its dependsOn deliverables have shipped, so stacked PR bases exist on the remote

import { existsSync } from "node:fs";
import type { PlanEngine } from "./engine.js";
import {
	commitPolicyInstruction,
	detectCommitPolicy,
} from "./exec/commit-policy.js";
import type { AgentMode, Deliverable, WorkerRestartMode } from "./schema.js";
import {
	defaultBranchForDeliverable,
	deliverableWorkspace,
	findDeliverable,
	gatingTasks,
	immediateAgents,
	pickBaseBranch,
	readyDeliverables,
	repoFor,
	shippableDeliverables,
	unblockedAgents,
} from "./schema.js";

// ─── Agent runtime state ─────────────────────────────────────────────────────

export type AgentStatus =
	| "pending"
	| "spawning"
	| "working"
	| "summarizing"
	| "restarting"
	| "done"
	| "failed";

export interface AgentState {
	/** "worker" or agent name. */
	name: string;
	deliverableId: string;
	status: AgentStatus;
	/** Monotonic worker process epoch; absent on legacy/test support state = 0. */
	generation?: number;
	/** Random display name (from agent-names.ts). */
	displayName?: string;
	/** tmux session id. */
	sessionId?: string;
	/** Session JSONL path — retained across kills for resurrection/respawn. */
	sessionFile?: string;
	/** Model resolved at spawn time. */
	model?: string;
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

// ─── Deliverable runtime state ─────────────────────────────────────────────────────

export interface DeliverableRunState {
	deliverableId: string;
	/** All agents (worker + support) and their runtime status. */
	agents: Map<string, AgentState>;
	/** Names of agents that have completed. */
	completed: Set<string>;
	/** Worktree path (if created). */
	worktreePath?: string;
	/** Branch name. */
	branch?: string;
	/** Set when the deliverable can't proceed (e.g. a blocked ship gate). */
	blocked?: string;
}

/** Blocked-reason prefix for deliverables parked by restart hydration. */
export const RESTART_BLOCK_PREFIX = "maestro restarted";

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
	/** Create a worktree for a deliverable. */
	createWorktree: (opts: CreateWorktreeOpts) => Promise<string>;
	/**
	 * Create the plain working directory for a scratch deliverable (no repo,
	 * no branch). Returns its path. Absent → scratch deliverables fail activation.
	 */
	createScratchWorkspace?: (deliverableId: string) => Promise<string>;
	/** Push branch and create PR. Returns PR URL. */
	shipDeliverable: (opts: ShipDeliverableOpts) => Promise<string>;
	/** Request agent summary (sends summarize RPC). */
	requestSummary: (
		sessionId: string,
		consumer: string,
		preamble: string,
	) => Promise<string>;
	/** Repo default branch — the base for unstacked deliverables. */
	defaultBranch?: string;
	/**
	 * Per-repo default branch (multi-repo / late-bound registry). Falls back
	 * to `defaultBranch` when absent — correct for single-repo plans.
	 */
	defaultBranchFor?: (repoPath: string) => string | null;
	/**
	 * New-deliverable activation gate: false defers phase-1 activation (running
	 * deliverables still advance and ship). Absent → always allowed.
	 */
	canActivate?: () => boolean;
	/** Current time. */
	now: () => string;
}

export interface SpawnAgentOpts {
	deliverableId: string;
	agentName: string;
	displayName: string;
	mode: "full" | "read-only";
	/** Persisted exact authored worker-pool choices. */
	model?: string;
	effort?: string;
	worktreePath: string;
	seed: string;
	/** Explicit fresh-restart packet; adapter must use seed verbatim. */
	freshRecovery?: boolean;
	/** Resume an existing session file instead of seeding a fresh one. */
	resumeSessionFile?: string;
	/** Positional kickoff message for the (re)spawned pi process. */
	kickoffMessage?: string;
}

export interface CreateWorktreeOpts {
	deliverableId: string;
	branch: string;
	baseBranch: string;
	repoPath: string;
}

export interface ShipDeliverableOpts {
	deliverableId: string;
	branch: string;
	title: string;
	body: string;
	worktreePath: string;
}

/**
 * The DeliverableExecutor manages the lifecycle of all deliverables and their agents.
 * It's driven by `tick()` which advances the state machine.
 */
export class DeliverableExecutor {
	private readonly deliverableStates = new Map<string, DeliverableRunState>();
	/** In-flight markAgentDone per "deliverableId/agentName" — concurrent callers share it. */
	private readonly doneInFlight = new Map<string, Promise<void>>();
	/** Deliverables mid-activation — a concurrent tick must not activate them again. */
	private readonly activating = new Set<string>();

	constructor(
		private readonly engine: PlanEngine,
		private readonly deps: ExecutorDeps,
	) {
		// Hydrate state for already-active deliverables (e.g. resumed session)
		for (const g of engine.get().deliverables) {
			if (g.status === "active" && !this.deliverableStates.has(g.id)) {
				this.hydrateActiveDeliverable(g);
			}
		}
	}

	/**
	 * Hydrate runtime state for a deliverable that's already active (resume).
	 * A maestro restart ends the run: orphaned pi processes may still live in
	 * tmux, so hydrated deliverables come up blocked instead of auto-respawning.
	 */
	private hydrateActiveDeliverable(g: Deliverable): void {
		const deliverableState: DeliverableRunState = {
			deliverableId: g.id,
			agents: new Map(),
			completed: new Set(),
			worktreePath: (g as unknown as { worktreePath?: string }).worktreePath,
			branch:
				deliverableWorkspace(g) === "scratch"
					? undefined
					: (g.branch ?? defaultBranchForDeliverable(g)),
			blocked: `${RESTART_BLOCK_PREFIX} — /recover resumes the interrupted workers`,
		};
		deliverableState.agents.set("worker", {
			name: "worker",
			deliverableId: g.id,
			status: "pending",
			generation: g.sessionGeneration ?? 0,
			// The persisted session file makes the respawn a RESUME — the
			// worker comes back cache-hot with its full transcript instead of
			// being re-seeded from scratch.
			...(g.sessionPath ? { sessionFile: g.sessionPath } : {}),
		});
		for (const agent of g.agents) {
			deliverableState.agents.set(agent.name, {
				name: agent.name,
				deliverableId: g.id,
				status: "pending",
				generation: 0,
			});
		}
		this.deliverableStates.set(g.id, deliverableState);
	}

	/** Get all deliverable runtime states. */
	getStates(): ReadonlyMap<string, DeliverableRunState> {
		return this.deliverableStates;
	}

	/** Get a specific agent's state. */
	getAgentState(
		deliverableId: string,
		agentName: string,
	): AgentState | undefined {
		return this.deliverableStates.get(deliverableId)?.agents.get(agentName);
	}

	/**
	 * Main tick — advances execution state machine.
	 * Call periodically or on state-change events.
	 * Returns names of deliverables that were shipped this tick.
	 */
	async tick(deliverableIds?: readonly string[]): Promise<string[]> {
		const plan = this.engine.get();
		const shipped: string[] = [];
		const selected = deliverableIds ? new Set(deliverableIds) : undefined;

		// 1. Activate ready deliverables — gated so plan edits outside an
		// autonomous mode never start new work. An explicit selection is used by
		// targeted /start and never broadens into unrelated planned work.
		if (this.deps.canActivate?.() !== false) {
			for (const g of readyDeliverables(plan)) {
				if (!selected || selected.has(g.id)) await this.activateDeliverable(g);
			}
		}

		// 2. For each active deliverable, check agent completion → spawn next
		for (const [deliverableId, state] of this.deliverableStates) {
			const g = findDeliverable(plan, deliverableId);
			if (g?.status !== "active") continue;
			await this.advanceDeliverable(g, state);
		}

		// 3. Ship complete deliverables in chain order. A parent's ship makes its
		// dependents shippable, so re-evaluate until a pass makes no progress;
		// each deliverable is attempted once per tick (a ship failure stays retryable
		// on a later tick without looping here).
		const attempted = new Set<string>();
		let progressed = true;
		while (progressed) {
			progressed = false;
			for (const g of shippableDeliverables(this.engine.get())) {
				if (attempted.has(g.id)) continue;
				attempted.add(g.id);
				// "" = shipped without a PR (scratch); null = not shipped.
				const url = await this.shipDeliverableIfReady(g);
				if (url !== null) {
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
	async markAgentDone(
		deliverableId: string,
		agentName: string,
		expected?: { generation: number; sessionId?: string },
	): Promise<void> {
		const key = `${deliverableId}/${agentName}`;
		const agent = this.getAgentState(deliverableId, agentName);
		if (
			expected &&
			(!agent ||
				(agent.generation ?? 0) !== expected.generation ||
				(expected.sessionId !== undefined &&
					agent.sessionId !== expected.sessionId))
		) {
			return;
		}
		const inFlight = this.doneInFlight.get(key);
		if (inFlight) return inFlight;
		const run = this.runMarkAgentDone(
			deliverableId,
			agentName,
			expected,
		).finally(() => {
			this.doneInFlight.delete(key);
		});
		this.doneInFlight.set(key, run);
		return run;
	}

	private async runMarkAgentDone(
		deliverableId: string,
		agentName: string,
		expected?: { generation: number; sessionId?: string },
	): Promise<void> {
		const state = this.deliverableStates.get(deliverableId);
		if (!state) return;
		const agent = state.agents.get(agentName);
		if (!agent || agent.status === "done" || agent.status === "summarizing")
			return;

		// Capture before any await: if the agent is respawned while we
		// summarize, the stale completion must not kill the fresh session.
		const sessionId = agent.sessionId;
		const generation = agent.generation ?? 0;

		// Request summary
		if (sessionId) {
			const plan = this.engine.get();
			const g = findDeliverable(plan, deliverableId);
			const consumer = this.nextConsumer(g, agentName);
			const preamble = `${agent.displayName ?? agentName} (${agentName}) — ${g?.title ?? deliverableId}`;

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

		// The awaited summary/kill may have crossed a replacement. A stale
		// completion must not mark the fresh generation done.
		if (
			(agent.generation ?? 0) !== generation ||
			agent.sessionId !== sessionId ||
			(expected && expected.generation !== generation)
		) {
			return;
		}

		agent.status = "done";
		agent.completedAt = this.deps.now();
		state.completed.add(agentName);

		// Check if deliverable is complete
		await this.checkDeliverableCompletion(deliverableId);
	}

	/**
	 * Mark an agent as failed.
	 */
	markAgentFailed(
		deliverableId: string,
		agentName: string,
		error: string,
	): void {
		const state = this.deliverableStates.get(deliverableId);
		if (!state) return;
		const agent = state.agents.get(agentName);
		if (!agent) return;
		agent.status = "failed";
		agent.error = error;
		agent.completedAt = this.deps.now();
	}

	/** Block a deliverable with a user-facing reason (surfaced via getStates). */
	blockDeliverable(deliverableId: string, reason: string): void {
		const state = this.deliverableStates.get(deliverableId);
		if (state) state.blocked = reason;
	}

	/** Clear a deliverable's blocked reason (user-driven retry). */
	unblockDeliverable(deliverableId: string): void {
		const state = this.deliverableStates.get(deliverableId);
		if (state) state.blocked = undefined;
	}

	/**
	 * Recover every deliverable parked by restart hydration: re-provision the
	 * workspace when it vanished (idempotent), clear the block, and respawn
	 * pending agents — the worker resumes from its persisted session file.
	 * Failures re-park the deliverable with the cause for audited /recover.
	 */
	async recoverInterrupted(deliverableIds?: readonly string[]): Promise<{
		recovered: string[];
		failed: Array<{ id: string; error: string }>;
	}> {
		const recovered: string[] = [];
		const failed: Array<{ id: string; error: string }> = [];
		const selected = deliverableIds ? new Set(deliverableIds) : undefined;
		for (const [id, state] of this.deliverableStates) {
			if (selected && !selected.has(id)) continue;
			if (!state.blocked?.startsWith(RESTART_BLOCK_PREFIX)) continue;
			const g = findDeliverable(this.engine.get(), id);
			if (g?.status !== "active") continue;
			try {
				if (!state.worktreePath || !existsSync(state.worktreePath)) {
					const { worktreePath, branch } = await this.provisionWorkspace(g);
					state.worktreePath = worktreePath;
					state.branch = branch;
					this.engine.updateDeliverable(id, { branch, worktreePath });
				}
				state.blocked = undefined;
				await this.advanceDeliverable(g, state);
				recovered.push(id);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				state.blocked = `recovery failed: ${message} — fix the cause, then run /recover ${id}`;
				failed.push({ id, error: message });
			}
		}
		return { recovered, failed };
	}

	/** Make a failed replacement retryable without resurrecting the killed process. */
	failWorkerReplacement(deliverableId: string, reason: string): void {
		const state = this.deliverableStates.get(deliverableId);
		const worker = state?.agents.get("worker");
		if (worker) {
			worker.status = "pending";
			worker.sessionId = undefined;
			worker.error = reason;
		}
		if (state) state.blocked = reason;
	}

	/** Re-provision only a missing persisted workspace during validated recovery. */
	async reprovisionWorkspace(
		deliverableId: string,
	): Promise<{ worktreePath: string; branch?: string }> {
		const g = findDeliverable(this.engine.get(), deliverableId);
		const state = this.deliverableStates.get(deliverableId);
		if (!g || !state) throw new Error(`no active deliverable ${deliverableId}`);
		if (state.worktreePath && existsSync(state.worktreePath)) {
			throw new Error(`workspace ${state.worktreePath} still exists`);
		}
		const result = await this.provisionWorkspace(g);
		state.worktreePath = result.worktreePath;
		state.branch = result.branch;
		this.engine.updateDeliverable(deliverableId, result);
		return result;
	}

	/**
	 * Check if all gating tasks for a worker are toggled.
	 */
	isWorkerDone(deliverableId: string): boolean {
		const plan = this.engine.get();
		const g = findDeliverable(plan, deliverableId);
		if (!g) return false;
		return gatingTasks(g).every((t) => t.done);
	}

	/** Respawn a failed agent (reuse spawnAgentInDeliverable with fresh state). */
	async respawnAgent(deliverableId: string, agentName: string): Promise<void> {
		const plan = this.engine.get();
		const g = findDeliverable(plan, deliverableId);
		if (!g) throw new Error(`deliverable ${deliverableId} not found`);
		const state = this.deliverableStates.get(deliverableId);
		if (!state) throw new Error(`no state for deliverable ${deliverableId}`);
		const agentState = state.agents.get(agentName);
		if (!agentState) throw new Error(`no state for agent ${agentName}`);

		// Reset agent state for respawn; sessionFile is kept so the respawn
		// resumes the agent's own transcript instead of starting cold. A worker
		// process replacement advances its epoch even when JSONL is retained.
		agentState.status = "pending";
		if (agentName === "worker")
			agentState.generation = (agentState.generation ?? 0) + 1;
		agentState.sessionId = undefined;
		agentState.error = undefined;
		agentState.completedAt = undefined;

		await this.spawnAgentInDeliverable(g, state, agentName);
	}

	/**
	 * Replace a stopped worker after the adapter has proven the old process is
	 * absent and the workspace is safe. Resume retains JSONL; fresh uses the
	 * supplied recovery seed and allocates a new JSONL in spawnAgent.
	 */
	async replaceWorker(
		deliverableId: string,
		mode: WorkerRestartMode,
		generation: number,
		recoverySeed?: string,
	): Promise<AgentState> {
		const g = findDeliverable(this.engine.get(), deliverableId);
		const state = this.deliverableStates.get(deliverableId);
		const worker = state?.agents.get("worker");
		if (!g || !state || !worker) {
			throw new Error(`no active worker state for ${deliverableId}`);
		}
		if (!state.worktreePath)
			throw new Error(`no workspace for ${deliverableId}`);
		state.blocked = undefined;
		state.completed.delete("worker");
		worker.status = "restarting";
		worker.generation = generation;
		worker.sessionId = undefined;
		worker.summary = undefined;
		worker.error = undefined;
		worker.completedAt = undefined;
		if (mode === "fresh") worker.sessionFile = undefined;
		worker.status = "pending";
		await this.spawnAgentInDeliverable(
			g,
			state,
			"worker",
			mode === "resume"
				? "Your worker process was safely replaced. Review progress and continue."
				: "Continue from the fresh-session recovery seed. Inspect and preserve existing work before editing.",
			recoverySeed,
		);
		if (this.getAgentState(deliverableId, "worker")?.status !== "working") {
			throw new Error(`replacement worker for ${deliverableId} did not spawn`);
		}
		return worker;
	}

	// ─── Internal ──────────────────────────────────────────────────────────

	private async activateDeliverable(g: Deliverable): Promise<void> {
		// Re-entrancy guard: provisioning awaits before the status flips to
		// active, so an overlapping tick would otherwise double-activate.
		if (this.activating.has(g.id)) return;
		const existing = this.deliverableStates.get(g.id);
		if (existing) {
			// Re-attempt only an activation-failure placeholder whose blocked
			// reason an explicit /start cleared; anything else is already live.
			const retryableFailure =
				existing.worktreePath === undefined &&
				existing.agents.size === 0 &&
				!existing.blocked;
			if (!retryableFailure) return;
		}
		this.activating.add(g.id);
		try {
			await this.doActivateDeliverable(g);
		} catch (err) {
			// NEVER let provisioning failures (missing base branch, dirty
			// worktree dir, …) escape the tick — that crashed the whole
			// maestro. Park the deliverable blocked with the reason; the user
			// fixes the cause and explicitly starts that delivery again.
			const message = err instanceof Error ? err.message : String(err);
			this.deliverableStates.set(g.id, {
				deliverableId: g.id,
				agents: new Map(),
				completed: new Set(),
				blocked: `activation failed: ${message} — fix the cause, then /start ${g.id}`,
			});
		} finally {
			this.activating.delete(g.id);
		}
	}

	/**
	 * Provision (or idempotently re-provision) a deliverable's workspace:
	 * a git worktree on its branch, or a plain scratch directory.
	 */
	private async provisionWorkspace(
		g: Deliverable,
	): Promise<{ worktreePath: string; branch?: string }> {
		const plan = this.engine.get();
		const scratch = deliverableWorkspace(g) === "scratch";

		if (scratch) {
			// Scratch: a plain directory, no repo/branch/worktree machinery.
			if (!this.deps.createScratchWorkspace) {
				throw new Error(
					`deliverable ${g.id} is scratch but this runtime cannot provision scratch workspaces`,
				);
			}
			return { worktreePath: await this.deps.createScratchWorkspace(g.id) };
		}
		const repo = repoFor(plan, g);
		// Late-bound repos (createdBy) materialize during execution; the DAG
		// should guarantee existence by now — if not, fail activation with
		// the cause instead of a cryptic git error.
		if (repo.createdBy !== undefined && !existsSync(repo.path)) {
			throw new Error(
				`repo "${repo.key}" (${repo.path}) is not materialized — ` +
					`deliverable "${repo.createdBy}" was expected to create it`,
			);
		}
		const branch = g.branch ?? defaultBranchForDeliverable(g);
		const defaultBranch =
			this.deps.defaultBranchFor?.(repo.path) ??
			this.deps.defaultBranch ??
			"main";
		const baseBranch = pickBaseBranch(plan, g, defaultBranch);
		const worktreePath = await this.deps.createWorktree({
			deliverableId: g.id,
			branch,
			baseBranch,
			repoPath: repo.path,
		});
		return { worktreePath, branch };
	}

	private async doActivateDeliverable(g: Deliverable): Promise<void> {
		const { worktreePath, branch } = await this.provisionWorkspace(g);

		// Initialize runtime state
		const deliverableState: DeliverableRunState = {
			deliverableId: g.id,
			agents: new Map(),
			completed: new Set(),
			worktreePath,
			branch,
		};

		// Register all agents (worker + support)
		deliverableState.agents.set("worker", {
			name: "worker",
			deliverableId: g.id,
			status: "pending",
			generation: 0,
		});
		for (const agent of g.agents) {
			deliverableState.agents.set(agent.name, {
				name: agent.name,
				deliverableId: g.id,
				status: "pending",
				generation: 0,
			});
		}

		this.deliverableStates.set(g.id, deliverableState);

		// Transition to active
		this.engine.setDeliverableStatus(g.id, "active");
		this.engine.updateDeliverable(g.id, { branch, worktreePath });

		// Spawn immediately-startable agents
		const immediate = immediateAgents(g);
		for (const name of immediate) {
			await this.spawnAgentInDeliverable(g, deliverableState, name);
		}
	}

	private async advanceDeliverable(
		g: Deliverable,
		state: DeliverableRunState,
	): Promise<void> {
		// Blocked deliverables (fix-loop stall, maestro restart) need user action
		// before any further spawning.
		if (state.blocked) return;

		// Spawn immediate agents that are still pending (e.g. after hydration)
		const immediate = immediateAgents(g);
		for (const name of immediate) {
			const agent = state.agents.get(name);
			if (agent && agent.status === "pending") {
				await this.spawnAgentInDeliverable(g, state, name);
			}
		}

		// Check for newly-unblocked agents (those with `after` deps)
		const unblocked = unblockedAgents(g, state.completed);
		for (const name of unblocked) {
			const agent = state.agents.get(name);
			if (agent && agent.status === "pending") {
				await this.spawnAgentInDeliverable(g, state, name);
			}
		}
	}

	private async spawnAgentInDeliverable(
		g: Deliverable,
		state: DeliverableRunState,
		name: string,
		kickoffMessage?: string,
		seedOverride?: string,
	): Promise<void> {
		const agentState = state.agents.get(name);
		if (!agentState) return;

		// Never spawn into a blocked deliverable (the user clears `blocked` first).
		if (state.blocked) return;

		const spec =
			name === "worker" ? g.worker : g.agents.find((a) => a.name === name);
		if (!spec) return;

		// Deliverable scheduler invariant: one agent TYPE active per deliverable at a time.
		// Not spawnable now → stays pending; a later tick retries.
		if (!this.canSpawnNow(g, state, spec.mode)) return;

		const mode = spec.mode;
		const model = "model" in spec ? spec.model : undefined;
		const effort = "effort" in spec ? spec.effort : undefined;

		const { agentName: genName } = await import("./agent-names.js");
		const takenNames = new Set(
			[...state.agents.values()]
				.filter((a) => a.displayName)
				.map((a) => a.displayName as string),
		);

		agentState.status = "spawning";
		agentState.displayName ??= genName(g.id, takenNames);
		agentState.effort = effort;
		agentState.startedAt = this.deps.now();

		// Resurrection: an agent with a prior session file resumes its own
		// transcript (cache-hot) instead of being re-seeded from scratch.
		const resumeSessionFile = agentState.sessionFile;
		const seed = resumeSessionFile
			? ""
			: (seedOverride ?? this.buildSeed(g, state, name));

		const spawned = await this.deps.spawnAgent({
			deliverableId: g.id,
			agentName: name,
			displayName: agentState.displayName,
			mode,
			model,
			effort,
			worktreePath: state.worktreePath!,
			seed,
			...(seedOverride !== undefined ? { freshRecovery: true } : {}),
			...(resumeSessionFile
				? {
						resumeSessionFile,
						kickoffMessage: kickoffMessage ?? this.resumeKickoff(state, name),
					}
				: kickoffMessage
					? { kickoffMessage }
					: {}),
		});

		agentState.sessionId = spawned.sessionId;
		agentState.sessionFile = spawned.sessionFile;
		agentState.status = "working";
	}

	/**
	 * Scheduler invariant: within a deliverable, at most one agent type is active at
	 * a time. Full-mode agents run strictly alone; read-only agents may run
	 * concurrently with each other but never alongside a full-mode agent.
	 */
	private canSpawnNow(
		g: Deliverable,
		state: DeliverableRunState,
		mode: AgentMode,
	): boolean {
		const active = [...state.agents.values()].filter(
			(a) =>
				a.status === "spawning" ||
				a.status === "working" ||
				a.status === "summarizing" ||
				a.status === "restarting",
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
	private resumeKickoff(_state: DeliverableRunState, _name: string): string {
		return (
			"Your previous session ended unexpectedly and has been resumed. " +
			"Review your progress, then continue the remaining work."
		);
	}

	private buildSeed(
		g: Deliverable,
		state: DeliverableRunState,
		name: string,
	): string {
		const parts: string[] = [];
		const plan = this.engine.get();

		// 1. Dep summaries from prior deliverables (cache-stable prefix)
		for (const depId of g.dependsOn ?? []) {
			const dep = findDeliverable(plan, depId);
			if (dep?.summary) {
				parts.push(dep.summary);
			}
		}

		// 2. Accumulated sibling summaries (from completed agents in this deliverable)
		for (const [agentName, agentState] of state.agents) {
			if (agentName === name) continue; // Don't include self
			if (agentState.summary) {
				parts.push(agentState.summary);
			}
		}

		// 3. Agent-specific content (last — unique to this agent)
		if (name === "worker") {
			const scratch = deliverableWorkspace(g) === "scratch";
			// Repo commit policy first — a worker committing "Add …" in a
			// semantic-release repo makes the release run green and publish
			// nothing; the ship audit would then block the branch.
			if (!scratch) {
				const policyNote = commitPolicyInstruction(
					detectCommitPolicy(repoFor(plan, g).path),
				);
				if (policyNote) parts.push(policyNote);
			}
			parts.push(`## Deliverable: ${g.title}\n\n${g.body}`);
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
				scratch
					? "\n---\nDo your work in this directory. Toggle tasks when done. " +
							"Exit when complete. There is no git branch or PR here — your " +
							"summary and side effects are the deliverable."
					: "\n---\nDo your work. Commit as you go. Toggle tasks when done. " +
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

	private nextConsumer(g: Deliverable | null, completedAgent: string): string {
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

		// No dependents within deliverable — next consumer is downstream deliverables
		const plan = this.engine.get();
		const downstream = plan.deliverables.filter((other) =>
			other.dependsOn?.includes(g.id),
		);
		if (downstream.length > 0) {
			return downstream
				.map((d) => `deliverable "${d.title}": ${d.body.slice(0, 100)}`)
				.join("; ");
		}

		return "the project completion summary";
	}

	private async checkDeliverableCompletion(
		deliverableId: string,
	): Promise<void> {
		const state = this.deliverableStates.get(deliverableId);
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
			const failedAgent = [...state.agents.values()].find(
				(agent) => agent.status === "failed",
			);
			const current = findDeliverable(this.engine.get(), deliverableId);
			if (current?.status === "active") {
				this.engine.setDeliverableStatus(deliverableId, "failed", {
					code: "agent-failed",
					message: failedAgent?.error ?? "an execution agent failed",
					failedAt: failedAgent?.completedAt ?? this.deps.now(),
					recoverable: true,
					attempt: (current.failure?.attempt ?? 0) + 1,
					...(failedAgent ? { agentId: failedAgent.name } : {}),
				});
			}
			return;
		}

		// Review iteration is the worker's own (it runs `review()` in its live
		// session and fixes findings before it stops); the executor only gates
		// ship on the required panel verdicts. So completion here is final —
		// there is no executor-orchestrated fix round.

		// Assemble deliverable summary from agent summaries
		const summaries = [...state.agents.values()]
			.filter((a) => a.summary)
			.map((a) => a.summary as string);
		const deliverableSummary = summaries.join("\n\n");

		this.engine.setDeliverableStatus(deliverableId, "complete");
		this.engine.updateDeliverable(deliverableId, {
			summary: deliverableSummary,
		});
	}

	private async shipDeliverableIfReady(g: Deliverable): Promise<string | null> {
		const state = this.deliverableStates.get(g.id);
		if (!state) return null;

		// No maestro ship gate: reviewers run worker-side and the worker owns its
		// findings (trust-the-worker model). A `complete` deliverable ships.

		// Scratch deliverables have nothing to push and no PR: shipping is the
		// gate above plus the recorded summary. Terminal status stays `shipped`
		// so dependents unblock through the same DAG rule.
		if (deliverableWorkspace(g) === "scratch") {
			this.engine.setDeliverableStatus(g.id, "shipped");
			return "";
		}

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

		// Ship failure is retryable: leave the deliverable `complete` and let a later
		// tick (or /ship) try again — durable status never advances without a PR.
		let prUrl: string;
		try {
			prUrl = await this.deps.shipDeliverable({
				deliverableId: g.id,
				branch: state.branch ?? defaultBranchForDeliverable(g),
				title: g.title,
				body,
				worktreePath: state.worktreePath!,
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			state.blocked = `shipping failed: ${detail}`;
			return null;
		}

		if (state.blocked?.startsWith("shipping failed:"))
			state.blocked = undefined;
		this.engine.setDeliverableStatus(g.id, "shipped");
		this.engine.updateDeliverable(g.id, { prUrl });

		// Every deliverable ships its own PR — predecessors are never auto-superseded.
		// `superseded` stays a user-driven status (the transition remains legal).

		return prUrl;
	}
}
