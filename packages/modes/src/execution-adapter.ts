// Execution adapter: wraps GroupExecutor with the interface runtime.ts expects.
// This bridges the old TmuxFanout call sites to the new group executor.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { groupBranch } from "./agent-lifecycle.js";
import { agentName } from "./agent-names.js";
import type { PlanEngine } from "./engine.js";
import { type ExecutorDeps, GroupExecutor } from "./group-executor.js";
import { buildPrBody } from "./shipping.js";

export interface ExecutionAdapterOpts {
	engine: PlanEngine;
	ctx: ExtensionContext;
	defaultBranch: string;
	onPlanChanged: () => void;
	onAgentStateChanged?: (
		id: string,
		state: {
			status: string;
			tokens: { input: number; output: number; turns: number };
		},
	) => void;
	onQuestionsReceived?: (id: string, count: number) => void;
	onAllSettled?: () => void;
}

/**
 * ExecutionAdapter wraps GroupExecutor and provides the interface
 * that runtime.ts expects from the old TmuxFanout class.
 */
export class ExecutionAdapter {
	private executor: GroupExecutor;
	private engine: PlanEngine;
	private opts: ExecutionAdapterOpts;
	private _started = false;

	/** Pending questions from agents (placeholder for RPC integration). */
	readonly questionQueue = {
		all: () => [] as { id: string; agentId: string; question: string }[],
	};

	constructor(opts: ExecutionAdapterOpts) {
		this.opts = opts;
		this.engine = opts.engine;

		const deps: ExecutorDeps = {
			spawnAgent: async (spawnOpts) => {
				// TODO: actual tmux+RPC spawning
				const name = agentName(spawnOpts.groupId, new Set());
				console.log(
					`[executor] Would spawn agent: ${spawnOpts.agentName} (${name}) for group ${spawnOpts.groupId}`,
				);
				return `session-${spawnOpts.groupId}-${spawnOpts.agentName}`;
			},
			killSession: async (sessionId) => {
				console.log(`[executor] Would kill session: ${sessionId}`);
			},
			createWorktree: async (worktreeOpts) => {
				const branch = groupBranch(worktreeOpts.groupId);
				console.log(
					`[executor] Would create worktree: ${branch} (base: ${worktreeOpts.baseBranch ?? opts.defaultBranch})`,
				);
				return `/tmp/worktrees/${worktreeOpts.groupId}`;
			},
			shipGroup: async (shipOpts) => {
				const group = this.engine
					.get()
					.groups.find((g) => g.id === shipOpts.groupId);
				if (!group) return `error: group ${shipOpts.groupId} not found`;
				const body = buildPrBody(group, []);
				console.log(
					`[executor] Would ship: ${group.title} → PR (${body.length} chars body)`,
				);
				return `https://github.com/example/repo/pull/999`;
			},
			requestSummary: async (_sessionId) => {
				return "## Summary\nWork completed successfully.";
			},
			now: () => new Date().toISOString(),
		};

		this.executor = new GroupExecutor(this.engine, deps);
	}

	async start(): Promise<void> {
		this._started = true;
	}

	/**
	 * Advance execution: activate ready groups, spawn agents, detect completion.
	 * Returns the number of newly activated groups.
	 */
	async tick(): Promise<number> {
		if (!this._started) return 0;

		const beforeGroups = this.engine
			.get()
			.groups.filter((g) => g.status === "active").length;

		const shipped = await this.executor.tick();

		const afterGroups = this.engine
			.get()
			.groups.filter((g) => g.status === "active").length;

		// Notify on ship
		if (shipped.length > 0) {
			this.opts.onPlanChanged();
		}

		// Check if all groups are terminal
		const plan = this.engine.get();
		const allDone = plan.groups.every(
			(g) =>
				g.status === "shipped" ||
				g.status === "superseded" ||
				g.status === "abandoned",
		);
		if (allDone && plan.groups.length > 0) {
			this.opts.onAllSettled?.();
		}

		// Return count of newly activated groups
		const newlyActivated = afterGroups - beforeGroups;
		return Math.max(0, newlyActivated + shipped.length);
	}

	/** Steer an agent with guidance (placeholder). */
	steer(groupId: string, guidance: string): void {
		console.log(`[executor] Would steer ${groupId}: ${guidance}`);
	}

	/** Snapshot of current agent states for dashboard/footer. */
	snapshot(): {
		agents: Map<
			string,
			{
				status: string;
				startedAt: number;
				tokens: { input: number; output: number; turns: number };
			}
		>;
	} {
		const agents = new Map<
			string,
			{
				status: string;
				startedAt: number;
				tokens: { input: number; output: number; turns: number };
			}
		>();
		const states = this.executor.getStates();

		for (const [groupId, groupState] of states) {
			for (const [agentName, agentState] of groupState.agents) {
				const key = `${groupId}/${agentName}`;
				agents.set(key, {
					status: agentState.status,
					startedAt: Date.now(),
					tokens: { input: 0, output: 0, turns: 0 },
				});
			}
		}

		return { agents };
	}

	/** Mark an agent as done (called when RPC signals completion). */
	async markAgentDone(groupId: string, agentName: string): Promise<void> {
		await this.executor.markAgentDone(groupId, agentName);
		this.opts.onPlanChanged();
	}

	/** Check if a worker is done (all tasks toggled). */
	isWorkerDone(groupId: string): boolean {
		return this.executor.isWorkerDone(groupId);
	}

	/** Get the underlying executor for direct access. */
	getExecutor(): GroupExecutor {
		return this.executor;
	}

	async destroy(): Promise<void> {
		this._started = false;
	}
}
