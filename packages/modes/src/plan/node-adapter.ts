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
import type {
	ContractId,
	NodeResolution,
	TokenSnapshot,
} from "@vegardx/pi-contracts";
import { workingTreeClean, worktreeBaseSha } from "@vegardx/pi-git";
import { MaestroRpcServer, type PlanMutateMessage } from "@vegardx/pi-rpc";
import { provisionBranchWorktree } from "../exec/provisioner.js";
import { createRpcRouter, type RpcRouter } from "../exec/rpc-router.js";
import { QuestionQueue } from "../question-queue.js";
import type { PlanEngineV2 } from "./engine.js";
import {
	NodeExecutor,
	type NodeExecutorDeps,
	type SpawnNodeOpts,
} from "./node-executor.js";
import { collectContract } from "./node-periphery.js";
import {
	findNodeV2,
	gatingNodeTasks,
	type PlanNode,
	SUMMARY_TOKEN_BUDGET,
	walkNodes,
} from "./schema.js";

const IDLE_DONE_THRESHOLD = 2;
const DIRTY_HOLD_MAX_STEERS = 3;
const DIRTY_HOLD_RESTEER_MS = 2 * 60_000;
const SUMMARY_TIMEOUT_MS = 120_000;
const NO_SUMMARY_PLACEHOLDER = "## Summary\n(agent produced no summary)";

export interface TmuxLikeApi {
	spawn(name: string, opts?: unknown): Promise<void>;
	hasSession(name: string): Promise<boolean>;
	kill(name: string): Promise<void>;
	/** Pane capture for /view + crash tails; absent on stub backends. */
	capture?(name: string, lines?: number): Promise<string>;
}

/**
 * Lifecycle events surfaced to agent cards — the v1 vocabulary VERBATIM
 * (risk R1: same event names, same fields; `agentKey`/`deliverableId` carry
 * node ids post-flip). The v1 adapter's copy dies with it in PR-8.
 */
export type ExecutionEvent =
	| {
			kind: "spawn";
			agentKey: string;
			session: string;
			resumed: boolean;
			deliverableTitle: string;
	  }
	| {
			kind: "done";
			agentKey: string;
			deliverableTitle: string;
			durationMs: number;
			tokens: { input: number; output: number; turns: number };
			prefixCacheHitRate?: number;
			model?: string;
			effort?: string;
			adaptive?: boolean;
			summary?: string;
			/** Commit subjects, when the emitter has them. */
			commits?: string[];
	  }
	| {
			kind: "blocked";
			deliverableId: string;
			deliverableTitle: string;
			reason: string;
	  }
	| {
			kind: "failed";
			agentKey: string;
			deliverableTitle: string;
			respawns: number;
	  }
	| {
			kind: "shipped";
			deliverableId: string;
			deliverableTitle: string;
			prUrl?: string;
	  }
	| {
			kind: "settled";
			deliverables: {
				id: string;
				title: string;
				status: string;
				prUrl?: string;
			}[];
	  };

/** Cumulative per-agent state pushed to the usage ledger (v1 seam shape). */
export interface AgentStateSnapshot {
	readonly status: string;
	readonly generation: number;
	readonly revision: number;
	readonly tokens: TokenSnapshot;
}

export interface NodeAdapterOptions {
	readonly engine: PlanEngineV2;
	readonly planDir: string;
	readonly tmux: TmuxLikeApi;
	readonly token: string;
	readonly socketPath: string;
	readonly onPlanChanged: () => void;
	readonly onQuestionsReceived?: (nodeId: string) => void;
	readonly canActivate?: () => boolean;
	readonly onNodeBlocked?: NodeExecutorDeps["onNodeBlocked"];
	readonly defaultBranch?: string;
	readonly dirtyHoldMaxSteers?: number;
	readonly dirtyHoldResteerMs?: number;
	readonly pollIntervalMs?: number;
	/** Injectable spawn seam — tests/live wiring override the tmux default. */
	readonly spawnAgent?: NodeExecutorDeps["spawnAgent"];
	/** Spawn-time resolution: shapes the NodeResolution the adapter records. */
	readonly resolveModel?: (
		node: PlanNode,
	) => Promise<{ resolution: NodeResolution } | undefined>;
	readonly createWorktree?: NodeExecutorDeps["createWorktree"];
	readonly resolveBaseSha?: NodeExecutorDeps["resolveBaseSha"];
	readonly shipNode?: NodeExecutorDeps["shipNode"];
	/** Lifecycle events for agent cards (v1 vocabulary, node-keyed). */
	readonly onEvent?: (event: ExecutionEvent) => void;
	/** Fired once when every node reaches a settled (non-runnable) status. */
	readonly onAllSettled?: () => void;
	/** Cumulative token/state reports for the usage ledger + HUD. */
	readonly onAgentStateChanged?: (
		nodeId: string,
		state: AgentStateSnapshot,
	) => void;
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
	private readonly fallbackNotified = new Set<string>();
	private acceptTicks = true;
	private readonly tokenSnapshots = new Map<
		string,
		{
			input: number;
			output: number;
			turns: number;
			cacheRead?: number;
			cacheWrite?: number;
		}
	>();
	readonly questionQueue = new QuestionQueue();
	private readonly spawnTimes = new Map<string, number>();
	private readonly tokenRevisions = new Map<string, number>();
	private allSettledFired = false;

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
				tokens: (agentId, msg) => {
					const snapshot = {
						input: msg.snapshot.input,
						output: msg.snapshot.output,
						turns: msg.snapshot.turns,
						...(msg.snapshot.cacheRead !== undefined
							? { cacheRead: msg.snapshot.cacheRead }
							: {}),
						...(msg.snapshot.cacheWrite !== undefined
							? { cacheWrite: msg.snapshot.cacheWrite }
							: {}),
					};
					this.tokenSnapshots.set(agentId, snapshot);
					const revision = (this.tokenRevisions.get(agentId) ?? 0) + 1;
					this.tokenRevisions.set(agentId, revision);
					const run = this.executor.getRunState(agentId);
					this.opts.onAgentStateChanged?.(agentId, {
						status: run?.status ?? "working",
						generation: run?.generation ?? 0,
						revision,
						tokens: msg.snapshot,
					});
				},
				questions: (agentId, msg) => {
					const run = this.executor.getRunState(agentId);
					if (!run) return;
					const node = findNodeV2(this.engine.get(), agentId);
					this.questionQueue.enqueue({
						agentId,
						agentName: run.displayName ?? agentId,
						deliverableTitle: node?.title ?? agentId,
						questions: msg.questions,
						resolve: (answers) => {
							this.router.send(agentId, {
								type: "answers",
								id: msg.id,
								answers,
							});
						},
					});
					this.opts.onQuestionsReceived?.(agentId);
				},
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
				this.questionQueue.drop(agentId);
			},
		});

		this.executor = new NodeExecutor(this.engine, {
			spawnAgent: async (spawn) => {
				const spawned = await (opts.spawnAgent
					? opts.spawnAgent(spawn)
					: this.defaultSpawn(spawn));
				this.spawnTimes.set(spawn.nodeId, Date.now());
				this.opts.onEvent?.({
					kind: "spawn",
					agentKey: spawn.nodeId,
					session: spawned.sessionId,
					resumed: Boolean(spawn.resumeSessionFile),
					deliverableTitle: this.nodeTitle(spawn.nodeId),
				});
				// Seed at revision 0 (zero snapshot): the agent's first real
				// cumulative report is revision 1, which recordCheckpoint accepts
				// (1 > 0). Seeding at 1 would tie and reject that first report.
				this.tokenRevisions.set(spawn.nodeId, 0);
				this.opts.onAgentStateChanged?.(spawn.nodeId, {
					status: "working",
					generation: this.executor?.getRunState(spawn.nodeId)?.generation ?? 0,
					revision: 0,
					tokens: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						promptTokens: 0,
						totalTokens: 0,
						cost: 0,
						turns: 0,
					},
				});
				return spawned;
			},
			killSession: async (sessionId) => {
				await opts.tmux.kill(sessionId).catch(() => {});
			},
			// Real-git provisioning by default (PR-6b): branch owners under
			// <worktrees>/<nodeId>, candidates under _candidates/<parent>/<id> —
			// the ensemble spike's layout, idempotent via addWorktree.
			resolveBaseSha:
				opts.resolveBaseSha ??
				((repoPath, branch, baseBranch) =>
					worktreeBaseSha(repoPath, branch, baseBranch) ?? undefined),
			createWorktree:
				opts.createWorktree ??
				(async (wt) =>
					provisionBranchWorktree({
						repoPath: wt.repoPath,
						branch: wt.branch,
						baseBranch: wt.baseBranch,
						pathSegments: wt.branch.startsWith("cand/")
							? ["_candidates", ...wt.branch.split("/").slice(1)]
							: [wt.nodeId],
					})),
			shipNode:
				opts.shipNode ??
				(async (ship) => {
					throw new Error(
						`shipping is not wired in this runtime (node ${ship.nodeId})`,
					);
				}),
			requestSummary: (sessionId, consumer, preamble) =>
				this.requestSummary(sessionId, consumer, preamble),
			// Contract collection between summary and kill: the agent is alive
			// to answer retry steers; the result lands on the LEDGER whatever
			// tier it extracted at. Failures never block completion.
			collectResult: (nodeId, sessionId) =>
				this.collectNodeResult(nodeId, sessionId),
			...(opts.resolveModel
				? {
						resolveModel: async (node: PlanNode) => {
							const outcome = await opts.resolveModel?.(node);
							if (!outcome) return undefined;
							this.engine.recordResolution(node.id, outcome.resolution);
							if (outcome.resolution.source === "session-fallback") {
								this.notifyFallbackOnce(node.id, outcome.resolution);
							}
							return {
								model: outcome.resolution.model,
								...(outcome.resolution.effort
									? { effort: outcome.resolution.effort }
									: {}),
							};
						},
					}
				: {}),
			defaultBranch: opts.defaultBranch,
			canActivate: opts.canActivate,
			...(opts.onNodeBlocked ? { onNodeBlocked: opts.onNodeBlocked } : {}),
			now: () => new Date().toISOString(),
		});
	}

	/** One deduped fallback notice per node (the design's degraded-mode rule). */
	private notifyFallbackOnce(nodeId: string, resolution: NodeResolution): void {
		if (this.fallbackNotified.has(nodeId)) return;
		this.fallbackNotified.add(nodeId);
		this.logEvent("model-fallback", {
			node: nodeId,
			model: resolution.model,
			reason: resolution.fallbackReason,
		});
	}

	/** The node's contract by agent type (persona declarations refine later). */
	private contractFor(agent: PlanNode["agent"]): ContractId {
		return agent === "worker"
			? "summary-and-diff"
			: agent === "explorer"
				? "report"
				: "findings";
	}

	private async collectNodeResult(
		nodeId: string,
		_sessionId: string,
	): Promise<void> {
		const node = findNodeV2(this.engine.get(), nodeId);
		if (!node) return;
		const contract = this.contractFor(node.agent);
		const run = this.executor.getRunState(nodeId);
		const result = await collectContract({
			contract,
			nodeId,
			runId: `${nodeId}#${run?.generation ?? 0}`,
			model: node.resolutions?.at(-1)?.model ?? "session",
			transport: {
				request: async (instruction) => {
					const response = await this.router.request(
						nodeId,
						{
							type: "summarize",
							id: `contract-${++this.requestSeq}`,
							consumer: "the maestro's typed result collector",
							preamble: instruction,
							budget: SUMMARY_TOKEN_BUDGET,
						},
						SUMMARY_TIMEOUT_MS,
					);
					return response.content ?? "";
				},
				steer: (content) => {
					this.router.send(nodeId, { type: "steer", content });
				},
			},
		});
		this.engine.recordResult(nodeId, {
			contract,
			payload: result.envelope?.payload ?? null,
			recordedAt: result.completedAt,
		});
		this.logEvent("contract-collected", {
			node: nodeId,
			contract,
			extraction: result.extraction,
			attempts: result.attempts,
			...(result.diagnostics?.length
				? { diagnostics: result.diagnostics }
				: {}),
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
		if (!this.started || !this.acceptTicks) return [];
		const shipped = await this.executor.tick(nodeIds);
		for (const nodeId of shipped) {
			const node = findNodeV2(this.engine.get(), nodeId);
			this.logEvent("shipped", { node: nodeId, prUrl: node?.prUrl });
			this.opts.onEvent?.({
				kind: "shipped",
				deliverableId: nodeId,
				deliverableTitle: node?.title ?? nodeId,
				...(node?.prUrl ? { prUrl: node.prUrl } : {}),
			});
		}
		if (shipped.length > 0) this.opts.onPlanChanged();
		this.checkAllSettled();
		return shipped;
	}

	/**
	 * Fire the settled card + onAllSettled exactly once when every node has
	 * left the runnable statuses; re-arm when new runnable work appears
	 * (append-only children, /recover unfailing a node).
	 */
	private checkAllSettled(): void {
		const plan = this.engine.get();
		const all = [...walkNodes(plan)].map((visit) => visit.node);
		const settled =
			all.length > 0 &&
			all.every(
				(node) => node.status !== "planned" && node.status !== "active",
			);
		if (!settled) {
			this.allSettledFired = false;
			return;
		}
		if (this.allSettledFired) return;
		this.allSettledFired = true;
		this.opts.onEvent?.({
			kind: "settled",
			deliverables: plan.nodes.map((node) => ({
				id: node.id,
				title: node.title ?? node.id,
				status: node.status,
				...(node.prUrl ? { prUrl: node.prUrl } : {}),
			})),
		});
		this.opts.onAllSettled?.();
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
				const run = this.executor.getRunState(agentId);
				const node = findNodeV2(this.engine.get(), agentId);
				const resolution = node?.resolutions?.at(-1);
				const spawnedAt = this.spawnTimes.get(agentId);
				this.opts.onEvent?.({
					kind: "done",
					agentKey: agentId,
					deliverableTitle: this.nodeTitle(agentId),
					durationMs: spawnedAt ? Date.now() - spawnedAt : 0,
					tokens: this.tokenSnapshots.get(agentId) ?? {
						input: 0,
						output: 0,
						turns: 0,
					},
					...(resolution?.model ? { model: resolution.model } : {}),
					...(resolution?.effort ? { effort: resolution.effort } : {}),
					...(run?.summary ? { summary: run.summary } : {}),
				});
				this.opts.onPlanChanged();
				return this.tick();
			})
			.catch((err) => {
				const message = err instanceof Error ? err.message : String(err);
				this.executor.markAgentFailed(agentId, message);
				this.logEvent("error", { agent: agentId, message });
				this.opts.onEvent?.({
					kind: "failed",
					agentKey: agentId,
					deliverableTitle: this.nodeTitle(agentId),
					respawns: 0,
				});
			});
	}

	/** Display title for events; the node id when the node is gone. */
	private nodeTitle(nodeId: string): string {
		return findNodeV2(this.engine.get(), nodeId)?.title ?? nodeId;
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

	// ─── ExecutionHandle surface (v1 adapter methods, re-keyed to nodeId) ──
	// Agent keys ARE node ids; the v1 3-arg shapes keep an ignored agentName
	// parameter for call-site compatibility during the flip.

	/** Send guidance to a node's agent. False when it is not connected. */
	steer(nodeId: string, guidance: string, _agentName?: string): boolean {
		return this.router.send(nodeId, { type: "steer", content: guidance });
	}

	async interrupt(
		nodeId: string,
		_agentName?: string,
	): Promise<{ ok: boolean; error?: string }> {
		try {
			await this.router.request(
				nodeId,
				{ type: "interrupt", id: `int-${++this.requestSeq}` },
				10_000,
			);
			return { ok: true };
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/** Capture a node's tmux pane when the transport supports it. */
	async capture(
		nodeId: string,
		_agentName?: string,
		lines?: number,
	): Promise<string | undefined> {
		const run = this.executor.getRunState(nodeId);
		if (!run?.sessionId) return undefined;
		const capturer = this.opts.tmux.capture?.bind(this.opts.tmux);
		return capturer ? capturer(run.sessionId, lines) : undefined;
	}

	/**
	 * Stop a node's agent: kill the session and PROVE it gone (verbatim
	 * discipline — a kill that silently fails leaves a zombie writer).
	 */
	async stop(
		nodeId: string,
		_agentName?: string,
		reason?: string,
	): Promise<boolean> {
		const run = this.executor.getRunState(nodeId);
		if (!run?.sessionId) return false;
		const sessionId = run.sessionId;
		await this.opts.tmux.kill(sessionId).catch(() => {});
		for (let attempt = 0; attempt < 3; attempt++) {
			if (!(await this.opts.tmux.hasSession(sessionId).catch(() => false)))
				break;
			await new Promise((resolve) => setTimeout(resolve, 200));
			await this.opts.tmux.kill(sessionId).catch(() => {});
		}
		run.sessionId = undefined;
		run.status = "pending";
		if (reason) this.executor.blockNode(nodeId, reason);
		this.logEvent("agent-stopped", { agent: nodeId, reason });
		return true;
	}

	/** Kill a worker and park its node in the /recover-able shape. */
	async forceFailWorker(nodeId: string, reason: string): Promise<boolean> {
		const run = this.executor.getRunState(nodeId);
		if (!run) return false;
		await this.stop(nodeId, undefined, reason);
		this.executor.markAgentFailed(nodeId, reason);
		this.executor.blockNode(nodeId, reason);
		this.engine.setNodeRuntime(nodeId, { restartState: "blocked" });
		this.opts.onPlanChanged();
		return true;
	}

	previewWorkerRestart(
		nodeId: string,
		mode: "resume" | "fresh",
	): {
		nodeId: string;
		mode: "resume" | "fresh";
		generation: number;
		ok: boolean;
		problems: string[];
	} {
		const run = this.executor.getRunState(nodeId);
		const node = findNodeV2(this.engine.get(), nodeId);
		const problems: string[] = [];
		if (!run || !node) problems.push(`no active node ${nodeId}`);
		if (run && !run.worktreePath) problems.push("no workspace");
		if (mode === "resume" && run && !run.sessionFile)
			problems.push("no session file to resume");
		return {
			nodeId,
			mode,
			generation: (run?.generation ?? 0) + 1,
			ok: problems.length === 0,
			problems,
		};
	}

	async restartWorker(
		nodeId: string,
		mode: "resume" | "fresh",
		recoverySeed?: string,
	): Promise<{
		ok: boolean;
		nodeId: string;
		mode: "resume" | "fresh";
		generation: number;
		sessionPath?: string;
		error?: string;
	}> {
		const preview = this.previewWorkerRestart(nodeId, mode);
		if (!preview.ok)
			return {
				ok: false,
				nodeId,
				mode,
				generation: preview.generation,
				error: preview.problems.join("; "),
			};
		try {
			await this.stop(nodeId, undefined, undefined);
			const run = await this.executor.replaceWorker(
				nodeId,
				mode,
				preview.generation,
				recoverySeed,
			);
			this.executor.unblockNode(nodeId);
			this.opts.onPlanChanged();
			return {
				ok: true,
				nodeId,
				mode,
				generation: run.generation,
				...(run.sessionFile ? { sessionPath: run.sessionFile } : {}),
			};
		} catch (err) {
			return {
				ok: false,
				nodeId,
				mode,
				generation: preview.generation,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * Freeze scheduling and cooperatively stop the fleet: prepareStop to every
	 * live agent (best effort, one deadline), then kill. The plan ledger keeps
	 * every node's session for /recover resumption.
	 */
	async prepareStop(reason?: string): Promise<{
		stopped: string[];
		unresponsive: string[];
	}> {
		this.acceptTicks = false;
		const live = [...this.executor.getStates()].filter(([, run]) =>
			["spawning", "working", "summarizing", "restarting"].includes(run.status),
		);
		const stopped: string[] = [];
		const unresponsive: string[] = [];
		await Promise.all(
			live.map(async ([nodeId, run]) => {
				try {
					await this.router.request(
						nodeId,
						{
							type: "prepareStop",
							id: `ps-${++this.requestSeq}`,
							requestedAt: Date.now(),
							deadlineAt: Date.now() + 15_000,
							...(reason ? { reason } : {}),
						},
						15_000,
					);
					stopped.push(nodeId);
				} catch {
					unresponsive.push(nodeId);
				}
				if (run.sessionId)
					await this.opts.tmux.kill(run.sessionId).catch(() => {});
				run.sessionId = undefined;
				run.status = "pending";
				this.executor.blockNode(
					nodeId,
					"maestro restarted — /recover resumes the interrupted agents",
				);
			}),
		);
		this.logEvent("prepare-stop", { reason, stopped, unresponsive });
		return { stopped, unresponsive };
	}

	/** Per-agent status/tokens + per-node blocked view (HUD snapshot shape). */
	snapshot(): {
		agents: Map<
			string,
			{
				status: string;
				startedAt: number;
				completedAt?: number;
				tokens: {
					input: number;
					output: number;
					turns: number;
					cacheRead?: number;
					cacheWrite?: number;
				};
				model?: string;
				effort?: string;
			}
		>;
		deliverables: Map<string, { blocked?: string }>;
	} {
		const agents = new Map<
			string,
			{
				status: string;
				startedAt: number;
				completedAt?: number;
				tokens: {
					input: number;
					output: number;
					turns: number;
					cacheRead?: number;
					cacheWrite?: number;
				};
				model?: string;
				effort?: string;
			}
		>();
		const deliverables = new Map<string, { blocked?: string }>();
		for (const [nodeId, run] of this.executor.getStates()) {
			const tokens = this.tokenSnapshots.get(nodeId);
			const node = findNodeV2(this.engine.get(), nodeId);
			const resolution = node?.resolutions?.at(-1);
			agents.set(nodeId, {
				status: run.status,
				startedAt: run.startedAt ? Date.parse(run.startedAt) : Date.now(),
				...(run.completedAt
					? { completedAt: Date.parse(run.completedAt) }
					: {}),
				tokens: tokens ?? { input: 0, output: 0, turns: 0 },
				...(resolution?.model ? { model: resolution.model } : {}),
				...(resolution?.effort ? { effort: resolution.effort } : {}),
			});
			deliverables.set(nodeId, {
				...(run.blocked ? { blocked: run.blocked } : {}),
			});
		}
		return { agents, deliverables };
	}

	/** nodeId, tmux session id, or display name → the tmux session. */
	resolveSessionName(target: string): string | undefined {
		const direct = this.executor.getRunState(target)?.sessionId;
		if (direct) return direct;
		for (const [, run] of this.executor.getStates()) {
			if (run.sessionId === target || run.displayName === target)
				return run.sessionId;
		}
		return undefined;
	}

	/** nodeId, session id, or display name → the run's session file (for /view). */
	resolveSessionFile(target: string): string | undefined {
		const direct = this.executor.getRunState(target);
		if (direct?.sessionFile) return direct.sessionFile;
		for (const [, run] of this.executor.getStates()) {
			if (run.sessionId === target || run.displayName === target)
				return run.sessionFile;
		}
		return undefined;
	}

	getWorkerSessions(): string[] {
		const sessions: string[] = [];
		for (const [nodeId, run] of this.executor.getStates()) {
			const node = findNodeV2(this.engine.get(), nodeId);
			if (node?.agent === "worker" && run.sessionId)
				sessions.push(run.sessionId);
		}
		return sessions;
	}

	async markAgentDone(nodeId: string, _name?: string): Promise<void> {
		return this.executor.markAgentDone(nodeId);
	}

	isWorkerDone(nodeId: string): boolean {
		return this.executor.isNodeWorkDone(nodeId);
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
