// NodeExecutionAdapter (plan-schema cutover PR-5b): the v2-keyed port of the
// execution adapter's RPC/completion surface — the seams the parity twins
// exercise (scripted worker over REAL RPC + stub tmux, v1's hermetic-e2e
// texture). Agent keys ARE node ids (no deliverableId/agentName split).
//
// Ported VERBATIM (risk R1): the hello token/generation gate, status→idle
// counting with IDLE_DONE_THRESHOLD re-fed evaluation, the zero-gating-task
// idle rule, stuck-steer at 5 idles, done handling behind workerMayComplete,
// the dirty-worktree completion hold (#234: cadence steers → escalation to
// failed agent + blocked node — a silent hold once wedged the pipeline for
// hours), summarize with budget/timeout and the placeholder fallback, and
// events.jsonl logging with the SAME event vocabulary.
//
// Deliberately deferred to PR-6 (periphery): the 5s poll timer (twins drive
// idle reports explicitly), session-file assembly/resurrection, crash tails,
// restart barriers, questions/debug/child-run projections, and the real
// tmux/worktree/ship wiring — the deps seam stays injectable exactly so the
// twins pin the state machine first.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { workingTreeClean } from "@vegardx/pi-git";
import { MaestroRpcServer, type PlanMutateMessage } from "@vegardx/pi-rpc";
import { createRpcRouter, type RpcRouter } from "../exec/rpc-router.js";
import { SUMMARY_TOKEN_BUDGET } from "../schema.js";
import type { PlanEngineV2 } from "./engine.js";
import {
	NodeExecutor,
	type NodeExecutorDeps,
	type SpawnNodeOpts,
} from "./node-executor.js";
import { findNodeV2, gatingNodeTasks } from "./schema.js";

const IDLE_DONE_THRESHOLD = 2;
const DIRTY_HOLD_MAX_STEERS = 3;
const DIRTY_HOLD_RESTEER_MS = 2 * 60_000;
const SUMMARY_TIMEOUT_MS = 120_000;
const NO_SUMMARY_PLACEHOLDER = "## Summary\n(agent produced no summary)";

export interface TmuxLikeApi {
	spawn(name: string, opts?: unknown): Promise<void>;
	hasSession(name: string): Promise<boolean>;
	kill(name: string): Promise<void>;
}

export interface NodeAdapterOptions {
	readonly engine: PlanEngineV2;
	readonly planDir: string;
	readonly tmux: TmuxLikeApi;
	readonly token: string;
	readonly socketPath: string;
	readonly onPlanChanged: () => void;
	readonly canActivate?: () => boolean;
	readonly defaultBranch?: string;
	readonly dirtyHoldMaxSteers?: number;
	readonly dirtyHoldResteerMs?: number;
	readonly pollIntervalMs?: number;
	/** Injectable spawn seam — tests/live wiring override the tmux default. */
	readonly spawnAgent?: NodeExecutorDeps["spawnAgent"];
	readonly createWorktree?: NodeExecutorDeps["createWorktree"];
	readonly shipNode?: NodeExecutorDeps["shipNode"];
}

export class NodeExecutionAdapter {
	private readonly engine: PlanEngineV2;
	private readonly executor: NodeExecutor;
	private readonly rpcServer: MaestroRpcServer;
	private readonly router: RpcRouter;
	private started = false;
	private tickChain: Promise<unknown> = Promise.resolve();
	private pollTimer: ReturnType<typeof setInterval> | undefined;

	private readonly idleCount = new Map<string, number>();
	private readonly stuckSteerSent = new Set<string>();
	private readonly lastRpcStatus = new Map<string, string>();
	private readonly connectionGenerations = new Map<string, number>();
	private readonly completionHolds = new Map<
		string,
		{ steers: number; lastSteerAt: number; escalated: boolean }
	>();
	private requestSeq = 0;

	constructor(private readonly opts: NodeAdapterOptions) {
		this.engine = opts.engine;
		this.rpcServer = new MaestroRpcServer();
		this.router = createRpcRouter({
			server: this.rpcServer,
			token: opts.token,
			handlers: {
				status: (agentId, msg) => this.handleStatus(agentId, msg.status),
				done: (agentId, msg) => {
					this.router.send(agentId, { type: "doneAck", id: msg.id });
					this.handleDone(agentId);
				},
				planMutate: (agentId, msg) => this.handlePlanMutate(agentId, msg),
			},
			onConnect: (agentId, hello) => {
				// Generation gate (verbatim): a hello from a superseded process
				// generation is ignored — its messages must not act on the fresh one.
				const current = this.executor.getRunState(agentId)?.generation;
				if (current !== undefined && hello.generation !== current) return;
				this.connectionGenerations.set(agentId, hello.generation);
			},
			onDisconnect: (agentId) => {
				this.connectionGenerations.delete(agentId);
				this.idleCount.delete(agentId);
			},
		});

		this.executor = new NodeExecutor(this.engine, {
			spawnAgent:
				opts.spawnAgent ?? (async (spawn) => this.defaultSpawn(spawn)),
			killSession: async (sessionId) => {
				await opts.tmux.kill(sessionId).catch(() => {});
			},
			createWorktree:
				opts.createWorktree ??
				(async (wt) => {
					throw new Error(
						`worktree provisioning is not wired in this runtime (node ${wt.nodeId})`,
					);
				}),
			shipNode:
				opts.shipNode ??
				(async (ship) => {
					throw new Error(
						`shipping is not wired in this runtime (node ${ship.nodeId})`,
					);
				}),
			requestSummary: (sessionId, consumer, preamble) =>
				this.requestSummary(sessionId, consumer, preamble),
			defaultBranch: opts.defaultBranch,
			canActivate: opts.canActivate,
			now: () => new Date().toISOString(),
		});
	}

	getExecutor(): NodeExecutor {
		return this.executor;
	}

	async start(): Promise<void> {
		mkdirSync(this.opts.planDir, { recursive: true });
		await this.rpcServer.listen(this.opts.socketPath);
		// The 5s poll (verbatim): re-feeds idle observations — a finished agent
		// reports idle exactly once, so sustained-idle gates (reviewer
		// completion, zero-task workers, the dirty-hold cadence) are re-fed
		// here — and checks tmux liveness: a vanished session while "working"
		// is a crashed agent, failed visibly rather than waited on forever.
		// Never let a rejection escape the interval — it would crash the maestro.
		this.pollTimer = setInterval(() => {
			this.pollSessions().catch((err) => {
				this.logEvent("error", {
					scope: "pollSessions",
					message: err instanceof Error ? err.message : String(err),
				});
			});
		}, this.opts.pollIntervalMs ?? 5000);
		this.started = true;
	}

	async destroy(): Promise<void> {
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.router.dispose();
		await this.rpcServer.close().catch(() => {});
		this.started = false;
	}

	private async pollSessions(): Promise<void> {
		if (!this.started) return;
		for (const [nodeId, run] of this.executor.getStates()) {
			if (run.status !== "working" || !run.sessionId) continue;
			if (this.lastRpcStatus.get(nodeId) === "idle") {
				this.evaluateIdle(nodeId);
				continue;
			}
			const alive = await this.opts.tmux
				.hasSession(run.sessionId)
				.catch(() => true); // a tmux hiccup must not fail agents
			if (!alive && this.connectionGenerations.get(nodeId) === undefined) {
				// Session gone AND no live RPC connection: the process crashed.
				this.executor.markAgentFailed(
					nodeId,
					"agent session vanished (process crashed or was killed externally)",
				);
				this.logEvent("agent-vanished", { agent: nodeId });
				this.opts.onPlanChanged();
			}
		}
	}

	/** Serialized tick (verbatim mutex shape): never two ticks concurrently. */
	async tick(nodeIds?: readonly string[]): Promise<string[]> {
		const run = this.tickChain.then(() => this.tickOnce(nodeIds));
		this.tickChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run as Promise<string[]>;
	}

	private async tickOnce(nodeIds?: readonly string[]): Promise<string[]> {
		if (!this.started) return [];
		const shipped = await this.executor.tick(nodeIds);
		for (const nodeId of shipped) {
			const node = findNodeV2(this.engine.get(), nodeId);
			this.logEvent("shipped", { node: nodeId, prUrl: node?.prUrl });
		}
		if (shipped.length > 0) this.opts.onPlanChanged();
		return shipped;
	}

	// ─── Status / idle evaluation (verbatim, re-keyed) ─────────────────────

	private handleStatus(agentId: string, status: string): void {
		const run = this.executor.getRunState(agentId);
		if (!run) return;
		this.lastRpcStatus.set(agentId, status);
		if (status === "working") {
			this.idleCount.set(agentId, 0);
			this.stuckSteerSent.delete(agentId);
			return;
		}
		if (status === "idle") this.evaluateIdle(agentId);
	}

	/**
	 * One idle observation (verbatim rules): workers with gating tasks
	 * complete through the dirty-hold gate the moment tasks are done;
	 * zero-gating-task workers and read agents need SUSTAINED idle
	 * (IDLE_DONE_THRESHOLD); stuck-steer at 5 idles names the open tasks.
	 */
	private evaluateIdle(agentId: string): void {
		const count = (this.idleCount.get(agentId) ?? 0) + 1;
		this.idleCount.set(agentId, count);
		const run = this.executor.getRunState(agentId);
		const node = findNodeV2(this.engine.get(), agentId);
		if (!run || !node) return;

		if (node.agent === "worker") {
			if (this.executor.isNodeWorkDone(agentId)) {
				const gating = gatingNodeTasks(node);
				if (gating.length > 0) {
					if (!this.workerMayComplete(agentId)) return;
					this.completeAgent(agentId);
					return;
				}
				if (count >= IDLE_DONE_THRESHOLD && run.status === "working") {
					if (!this.workerMayComplete(agentId)) return;
					this.completeAgent(agentId);
					return;
				}
			}
		} else if (count >= IDLE_DONE_THRESHOLD && run.status === "working") {
			this.completeAgent(agentId);
			return;
		}

		if (count >= 5 && !this.stuckSteerSent.has(agentId)) {
			const remaining = node.tasks
				.filter((task) => (task.kind ?? "task") === "task" && !task.done)
				.map((task) => `${task.title} (task id: \`${task.id}\`)`);
			if (remaining.length > 0) {
				this.router.send(agentId, {
					type: "steer",
					content: `You seem stuck. These tasks are NOT yet marked done in the plan: ${remaining.join(", ")}. For each one you have finished, call task(action="toggle", taskId="<task id>") with the exact task id, then stop.`,
				});
			}
			this.stuckSteerSent.add(agentId);
		}
	}

	private handleDone(agentId: string): void {
		const run = this.executor.getRunState(agentId);
		if (!run) return;
		const node = findNodeV2(this.engine.get(), agentId);
		if (node?.agent === "worker" && !this.workerMayComplete(agentId)) return;
		this.completeAgent(agentId);
	}

	/**
	 * The dirty-worktree completion hold, VERBATIM (#234): a worker node must
	 * leave a clean worktree — steer to commit on a cadence, escalate to a
	 * visible failed+blocked state when the reminder budget is exhausted.
	 */
	private workerMayComplete(agentId: string): boolean {
		const node = findNodeV2(this.engine.get(), agentId);
		const run = this.executor.getRunState(agentId);
		const dirty =
			node?.agent === "worker" &&
			run?.worktreePath &&
			!workingTreeClean(run.worktreePath);
		if (!dirty) {
			if (this.completionHolds.delete(agentId)) {
				this.logEvent("completion-hold-released", { agent: agentId });
			}
			return true;
		}
		const maxSteers = this.opts.dirtyHoldMaxSteers ?? DIRTY_HOLD_MAX_STEERS;
		const resteerMs = this.opts.dirtyHoldResteerMs ?? DIRTY_HOLD_RESTEER_MS;
		const hold = this.completionHolds.get(agentId) ?? {
			steers: 0,
			lastSteerAt: 0,
			escalated: false,
		};
		this.completionHolds.set(agentId, hold);
		if (hold.escalated) return false;
		const now = Date.now();
		if (hold.steers > 0 && now - hold.lastSteerAt < resteerMs) return false;
		if (hold.steers < maxSteers) {
			hold.steers += 1;
			hold.lastSteerAt = now;
			this.logEvent("completion-held", {
				agent: agentId,
				reason: "dirty-worktree",
				steer: hold.steers,
				of: maxSteers,
				worktree: run?.worktreePath,
			});
			this.router.send(agentId, {
				type: "steer",
				content: `All planned tasks are marked done, but the worktree still has uncommitted changes (reminder ${hold.steers}/${maxSteers}). Run \`git add -A && git commit\` with a meaningful message now, verify \`git status --short\` is empty, then end your turn. Maestro will not complete or ship a dirty delivery.`,
			});
			return false;
		}
		hold.escalated = true;
		const reason = `worker finished all tasks but left uncommitted changes after ${maxSteers} commit reminders — commit manually in ${run?.worktreePath ?? "its worktree"}, then /recover ${agentId}`;
		this.logEvent("completion-hold-escalated", { agent: agentId, reason });
		this.executor.markAgentFailed(agentId, reason);
		this.executor.blockNode(agentId, reason);
		this.opts.onPlanChanged();
		return false;
	}

	/** Fire-and-forget completion with rejection safety (verbatim shape). */
	private completeAgent(agentId: string): void {
		this.executor
			.markAgentDone(agentId)
			.then(() => {
				this.opts.onPlanChanged();
				return this.tick();
			})
			.catch((err) => {
				const message = err instanceof Error ? err.message : String(err);
				this.executor.markAgentFailed(agentId, message);
				this.logEvent("error", { agent: agentId, message });
			});
	}

	// ─── Plan mutations from agents (nodeId-keyed) ─────────────────────────

	private handlePlanMutate(agentId: string, msg: PlanMutateMessage): void {
		// v6 wire compat: the field is still named deliverableId; it carries
		// the node id. Auth rule unchanged: an agent mutates only itself.
		const nodeId = msg.deliverableId;
		if (nodeId !== agentId) {
			this.router.send(agentId, {
				type: "planMutateResult",
				id: msg.id,
				success: false,
				error: `agents mutate only their own node (${agentId})`,
			});
			return;
		}
		try {
			if (msg.action === "toggleTask") {
				const params = msg.params as { taskId: string; summary?: string };
				this.engine.toggleTask(nodeId, params.taskId, params.summary);
			} else if (msg.action === "addTask") {
				const params = msg.params as { title: string; body?: string };
				this.engine.addTask(nodeId, params);
			} else {
				this.router.send(agentId, {
					type: "planMutateResult",
					id: msg.id,
					success: false,
					error: `unsupported action ${msg.action}`,
				});
				return;
			}
			this.router.send(agentId, {
				type: "planMutateResult",
				id: msg.id,
				success: true,
			});
			this.opts.onPlanChanged();
			// Task toggles arm completion; the worker still signals via idle/done.
		} catch (err) {
			this.router.send(agentId, {
				type: "planMutateResult",
				id: msg.id,
				success: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// ─── Summaries ─────────────────────────────────────────────────────────

	private async requestSummary(
		sessionId: string,
		consumer: string,
		preamble: string,
	): Promise<string> {
		// The RPC identity is the node id, not the tmux session name.
		const agentId = this.agentIdForSession(sessionId);
		if (!agentId) return NO_SUMMARY_PLACEHOLDER;
		try {
			const response = await this.router.request(
				agentId,
				{
					type: "summarize",
					id: `sum-${++this.requestSeq}`,
					consumer,
					preamble,
					budget: SUMMARY_TOKEN_BUDGET,
				},
				SUMMARY_TIMEOUT_MS,
			);
			return response.content || NO_SUMMARY_PLACEHOLDER;
		} catch {
			// Transcript salvage lands with periphery; the placeholder keeps the
			// v1 fallback semantics (never block completion on a dead agent).
			return NO_SUMMARY_PLACEHOLDER;
		}
	}

	private agentIdForSession(sessionId: string): string | undefined {
		for (const [nodeId, run] of this.executor.getStates()) {
			if (run.sessionId === sessionId) return nodeId;
		}
		return undefined;
	}

	// ─── Defaults / plumbing ───────────────────────────────────────────────

	private async defaultSpawn(
		spawn: SpawnNodeOpts,
	): Promise<{ sessionId: string; sessionFile: string }> {
		const sessionId = `${spawn.nodeId}-${spawn.displayName}`;
		await this.opts.tmux.spawn(sessionId);
		return {
			sessionId,
			sessionFile: join(this.opts.planDir, "sessions", `${spawn.nodeId}.jsonl`),
		};
	}

	private logEvent(event: string, fields: Record<string, unknown>): void {
		try {
			mkdirSync(this.opts.planDir, { recursive: true });
			appendFileSync(
				join(this.opts.planDir, "events.jsonl"),
				`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`,
			);
		} catch {
			// Observability must never crash the adapter.
		}
	}
}
