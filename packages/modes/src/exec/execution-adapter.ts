// Execution adapter: wraps DeliverableExecutor with real tmux+RPC spawning.
// Creates tmux sessions running `pi` for each agent, connected via RPC.

import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	Answers,
	InterruptResult,
	RunId,
	StopRecord,
	ThinkingLevel,
	TokenSnapshot,
	UsageCheckpoint,
} from "@vegardx/pi-contracts";
import {
	detectDefaultBranch,
	headSha,
	runCommand,
	workingTreeClean,
} from "@vegardx/pi-git";
import { getModelMeta } from "@vegardx/pi-models";
import {
	type ChildRunControlResultMessage,
	type ChildRunSyncMessage,
	type DebugProposalMessage,
	type DebugResultMessage,
	MaestroRpcServer,
	type PlanMutateMessage,
	type PlanReadMessage,
	type QuestionsMessage,
} from "@vegardx/pi-rpc";
import * as realTmux from "@vegardx/pi-tmux";
import { agentName } from "../agent-names.js";
import {
	DeliverableExecutor,
	type ExecutorDeps,
	RESTART_BLOCK_PREFIX,
} from "../deliverable-executor.js";
import type { PlanEngine } from "../engine.js";
import { planFingerprint } from "../engine.js";
import { QuestionQueue } from "../question-queue.js";
import { reportsNotInText, researchReportsDir } from "../research.js";
import {
	deliverableWorkspace,
	findDeliverable,
	repoFor,
	SUMMARY_TOKEN_BUDGET,
	type WorkerRestartMode,
	workerSessionGeneration,
} from "../schema.js";
import { resolveSpawnModelSafe } from "../spawn-model.js";
import { ChildProjectionStore } from "./child-projections.js";
import {
	commitPolicyInstruction,
	detectCommitPolicy,
} from "./commit-policy.js";
import { readKnowledgeSession } from "./knowledge.js";
import {
	buildAgentSessionFile,
	buildSpawnSpec,
	defaultAgentDir,
	type ProvisionEnvironmentOpts,
	provisionEnvironment,
	provisionWorktree,
} from "./provisioner.js";
import {
	createRpcRouter,
	type RpcRouter,
	type RpcRouterHandlers,
} from "./rpc-router.js";
import { buildSeed, type SeedSummaries, truncateSummary } from "./seeds.js";
import { shipDeliverable as shipDeliverableReal } from "./shipper.js";
import {
	validateRestartWorkspace,
	type WorkspaceValidationDeps,
	type WorkspaceValidationResult,
} from "./workspace-validation.js";

/**
 * Consecutive idle reports after which an agent with no task-based completion
 * signal (read-only reviewers; workers of zero-gating-task deliverables) is
 * considered done. Interactive pi never exits on its own, so sustained idle
 * is the only completion signal these agents produce.
 */
const IDLE_DONE_THRESHOLD = 2;
/**
 * Dirty-worktree completion hold: a worker with all gating tasks done but
 * uncommitted changes is reminded to commit at most this many times, spaced
 * by the resteer interval, before the hold escalates to a visible failure.
 * One-shot steering wedged silently when the model ignored it (drive 2,
 * 2026-07-18: both workers held for hours with zero surfaced signal).
 */
const DIRTY_HOLD_MAX_STEERS = 3;
const DIRTY_HOLD_RESTEER_MS = 2 * 60_000;
/** How long an in-flight review round may defer worker completion before we
 *  assume the round died with its reviewers. DERIVED from the ONE panel
 *  deadline: reviewers run concurrently and exactly once (no retries), so a
 *  legitimate round settles within PANEL_HARD_TIMEOUT_MS — the margin covers
 *  result plumbing and cleanup. A guard shorter than a legitimate round
 *  reopens the kill-mid-review hole; the old retry-sized guard (2× cap)
 *  hung dead rounds for ~25 minutes. */

/**
 * Window within which a same-tool-class agent's first tokens message makes a
 * warm prompt-cache prefix expected. A first-turn cache-read ratio below
 * {@link CACHE_MISS_RATIO_THRESHOLD} inside this window means the shared
 * knowledge-fork prefix did not hit — logged as a `cache-miss` event.
 */
const CACHE_WARM_WINDOW_MS = 5 * 60_000;
const CACHE_MISS_RATIO_THRESHOLD = 0.5;

/**
 * Rich lifecycle event mirrored to the chat as an agent-progress card.
 * Emitted alongside the events.jsonl log entries, with enough payload for
 * the card renderer (runtime/agent-cards.ts) to draw collapsed/expanded UI.
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

/** The tmux surface the adapter consumes — injectable for tests (FakeTmux). */
export interface TmuxApi {
	spawn(
		name: string,
		cwd: string,
		command: string | string[],
		opts?: { width?: number; height?: number; env?: Record<string, string> },
	): Promise<void>;
	hasSession(name: string): Promise<boolean>;
	kill(name: string): Promise<void>;
	capturePane?(name: string, lines?: number): Promise<string>;
}

export interface ExecutionAdapterOpts {
	engine: PlanEngine;
	ctx: ExtensionContext;
	extensionPath: string;
	/** All extension paths to pass to agents (includes custom providers etc). */
	extensionPaths?: string[];
	defaultBranch: string;
	planDir: string;
	/** Environment setup applied to freshly provisioned worktrees. */
	worktreeSetup?: ProvisionEnvironmentOpts;
	/** Injectable tmux implementation; defaults to the real seam. */
	tmux?: TmuxApi;
	/** Fixed run token — injectable for tests; defaults to a random UUID. */
	token?: string;
	/** Fixed RPC socket path — injectable for tests. */
	socketPath?: string;
	/** Injectable worker-role resolver for deterministic adapter tests. */
	resolveWorkerModel?: (choice: {
		model?: string;
		effort?: ThinkingLevel;
	}) => Promise<{ modelId: string; effort?: ThinkingLevel }>;
	/** Injectable read-only git/filesystem facts for restart validation. */
	workspaceValidation?: Partial<WorkspaceValidationDeps>;
	/** Fleet-wide stop grace; bounded by settings to 0–60000ms. */
	stopGraceMs?: number;
	/** Restart kill barrier timing (shortened in tests). */
	restartKillTimeoutMs?: number;
	restartPollMs?: number;
	/** Dirty-worktree completion hold timing (shortened in tests). */
	dirtyHoldResteerMs?: number;
	dirtyHoldMaxSteers?: number;
	/**
	 * New-deliverable activation gate, threaded to the executor. False defers
	 * activation (running work still advances/ships). Absent → always allowed.
	 */
	canActivate?: () => boolean;
	onPlanChanged: () => void;
	onAgentStateChanged?: (
		id: string,
		state: {
			status: string;
			generation: number;
			revision: number;
			tokens: TokenSnapshot;
		},
	) => void;
	onChildProjection?: (
		ownerId: string,
		ownerGeneration: number,
		projection: import("@vegardx/pi-contracts").ChildRunProjection,
	) => void;
	/** Durable cumulative usage forwarded by a worker-owned child. */
	onUsageCheckpoint?: (checkpoint: UsageCheckpoint) => void;
	onQuestionsReceived?: (id: string, count: number) => void;
	onAllSettled?: () => void;
	/** Rich lifecycle events for the chat progress cards. */
	onEvent?: (event: ExecutionEvent) => void;
}

export interface ExecutionStopOutcome {
	readonly agentKey: string;
	readonly generation: number;
	readonly session: string;
	readonly outcome: "cooperative" | "forced" | "not-proven";
}

export interface ExecutionStopHint {
	readonly agentKey: string;
	readonly generation: number;
	readonly session?: string;
	readonly workspace?: string;
	readonly branch?: string;
	readonly head?: string;
	readonly usageRevision: number;
	readonly children: readonly string[];
	readonly pendingStages: readonly string[];
}

export interface ExecutionStopResult {
	readonly stop: StopRecord;
	readonly agents: readonly ExecutionStopOutcome[];
	readonly hints: readonly ExecutionStopHint[];
}

export interface WorkerRestartResult {
	ok: boolean;
	deliverableId: string;
	mode: WorkerRestartMode;
	generation: number;
	workspace?: WorkspaceValidationResult;
	sessionPath?: string;
	error?: string;
}

export interface WorkerRestartPreview extends WorkspaceValidationResult {
	deliverableId: string;
	mode: WorkerRestartMode;
	generation: number;
}

/**
 * ExecutionAdapter wraps DeliverableExecutor and provides real tmux+RPC execution.
 */
export class ExecutionAdapter {
	private executor: DeliverableExecutor;
	private engine: PlanEngine;
	private opts: ExecutionAdapterOpts;
	private rpcServer: MaestroRpcServer;
	private router: RpcRouter;
	private tmux: TmuxApi;
	private socketPath: string;
	private token: string;
	private _started = false;
	private takenNames = new Set<string>();
	private sessionNames = new Map<string, string>(); // agentKey → tmux session name
	private sessionFiles = new Map<string, string>(); // agentKey → session JSONL path
	private idleCount = new Map<string, number>(); // agentKey → consecutive idle count
	private lastRpcStatus = new Map<string, string>(); // agentKey → last status report
	private stuckSteerSent = new Set<string>(); // agentKeys that received a stuck steer
	/** Workers already told to clean/commit before completion (dedupe). */
	/** Dirty-worktree completion holds: agentKey → steer bookkeeping. */
	private completionHolds = new Map<
		string,
		{ steers: number; lastSteerAt: number; escalated: boolean }
	>();
	private respawnCount = new Map<string, number>(); // agentKey → respawn attempts
	private provisionedWorktrees = new Set<string>(); // env setup ran already
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private settledAnnounced = false;
	private tokenSnapshots = new Map<string, TokenSnapshot>(); // agentKey → latest tokens
	private connectionGenerations = new Map<string, number>();
	private firstTurnPrefixCacheHitRate = new Map<string, number>();
	// agentKey → resolved display model + adaptive flag (telemetry)
	private agentModelMeta = new Map<
		string,
		{ model: string; modelId: string; effort?: string; adaptive: boolean }
	>();
	private firstTokensSeen = new Map<
		string,
		{ at: number; toolClass: "full" | "read-only" }
	>(); // agentKey → first tokens arrival
	private spawnTimes = new Map<string, number>(); // agentKey → spawn epoch ms
	private blockedLogged = new Set<string>(); // deliverableIds with a logged blocked event
	private tickChain: Promise<void> = Promise.resolve(); // tick mutex
	private pollInFlight = false; // skip overlapping pollSessions runs
	/** All spawn/kill/poll/completion/restart/shutdown transitions serialize here. */
	private lifecycleTail: Promise<void> = Promise.resolve();
	private stopping = false;
	private stopResult: ExecutionStopResult | undefined;
	private stopPromise: Promise<ExecutionStopResult> | undefined;
	private restarting = new Set<string>();
	private childProjections: ChildProjectionStore;
	private childControls = new Map<
		string,
		{
			readonly ownerId: string;
			readonly resolve: (result: ChildRunControlResultMessage) => void;
			readonly timer: ReturnType<typeof setTimeout>;
		}
	>();
	private debugProposalHandler?: (
		agentId: string,
		proposal: DebugProposalMessage,
	) => Promise<DebugResultMessage>;

	readonly questionQueue = new QuestionQueue();

	constructor(opts: ExecutionAdapterOpts) {
		this.opts = opts;
		this.engine = opts.engine;
		this.tmux = opts.tmux ?? realTmux;
		this.token = opts.token ?? randomUUID();
		this.socketPath =
			opts.socketPath ??
			join(
				"/tmp",
				`maestro-${opts.engine.get().slug.slice(0, 20)}-${process.pid}.sock`,
			);
		this.childProjections = new ChildProjectionStore(
			join(opts.planDir, "child-projections.json"),
		);
		this.rpcServer = new MaestroRpcServer();
		this.router = createRpcRouter({
			server: this.rpcServer,
			token: this.token,
			handlers: this.ignoreRestartingWorkers({
				childRunSync: (agentId, msg) => this.handleChildRunSync(agentId, msg),
				childRunControlResult: (_agentId, msg) => {
					const pending = this.childControls.get(msg.id);
					if (!pending) return;
					this.childControls.delete(msg.id);
					clearTimeout(pending.timer);
					pending.resolve(msg);
				},
				status: (agentId, msg) => {
					const [deliverableId, agentNamePart] = agentId.split("/");
					if (!deliverableId || !agentNamePart) return;
					this.handleStatus(agentId, deliverableId, agentNamePart, msg.status);
				},
				done: (agentId, msg) => {
					const [deliverableId, agentNamePart] = agentId.split("/");
					if (!deliverableId || !agentNamePart) return;
					this.router.send(agentId, { type: "doneAck", id: msg.id });
					this.handleDone(deliverableId, agentNamePart);
				},
				tokens: (agentId, msg) => {
					const generation = this.connectionGenerations.get(agentId);
					if (generation === undefined) return;
					this.recordFirstTurnPrefixCache(agentId, msg.snapshot);
					this.tokenSnapshots.set(agentId, msg.snapshot);
					this.opts.onAgentStateChanged?.(agentId, {
						status: "working",
						generation,
						revision: msg.revision,
						tokens: msg.snapshot,
					});
				},
				usageCheckpoint: (agentId, msg) => {
					const generation = this.connectionGenerations.get(agentId);
					if (generation === undefined) return;
					const source = msg.checkpoint.source;
					if (
						source.kind !== "run" ||
						source.ownerId !== agentId ||
						source.ownerGeneration !== generation
					)
						return;
					this.opts.onUsageCheckpoint?.(msg.checkpoint);
				},
				planMutate: (agentId, msg) => this.handlePlanMutate(agentId, msg),
				planRead: (agentId, msg) => this.handlePlanRead(agentId, msg),
				debugProposal: async (agentId, msg) => {
					let result: DebugResultMessage;
					if (!this.debugProposalHandler) {
						result = {
							type: "debugResult",
							id: msg.id,
							proposalId: msg.proposalId,
							accepted: false,
							error:
								"maestro debug UI is unavailable; no recovery was attempted",
						};
					} else {
						result = await this.debugProposalHandler(agentId, msg);
					}
					this.router.send(agentId, result);
				},
				questions: (agentId, msg) => {
					const [deliverableId, agentNamePart] = agentId.split("/");
					if (!deliverableId || !agentNamePart) return;
					this.handleQuestions(agentId, deliverableId, agentNamePart, msg);
				},
			}),
			onConnect: (agentId, hello) => {
				const [deliverableId, agentName] = agentId.split("/");
				const current =
					deliverableId && agentName
						? this.executor.getAgentState(deliverableId, agentName)?.generation
						: undefined;
				if (current !== undefined && hello.generation !== current) return;
				this.connectionGenerations.set(agentId, hello.generation);
			},
			onDisconnect: (agentId) => {
				this.connectionGenerations.delete(agentId);
				this.idleCount.delete(agentId);
				// A dead agent can never consume answers — drop its pending
				// question so /answer doesn't offer a phantom entry.
				this.questionQueue.drop(agentId);
				// Its projected child runs can no longer be confirmed live — degrade
				// them to unconfirmed so the view stops advertising them as
				// controllable until the owner reconnects and reconciles.
				this.childProjections.markLiveUnconfirmed(agentId);
				// Cancel ONLY this owner's pending controls; other owners' in-flight
				// requests must not be resolved out from under them.
				for (const [id, pending] of this.childControls) {
					if (pending.ownerId !== agentId) continue;
					this.childControls.delete(id);
					clearTimeout(pending.timer);
					pending.resolve({
						type: "childRunControlResult",
						id,
						ownerGeneration: -1,
						runId: "",
						action: "interrupt",
						ok: false,
						error: "owner disconnected",
					});
				}
			},
		});

		const deps: ExecutorDeps = {
			spawnAgent: async (spawnOpts) => {
				const sessionName = agentName(spawnOpts.deliverableId, this.takenNames);
				this.takenNames.add(sessionName);
				const agentKey = `${spawnOpts.deliverableId}/${spawnOpts.agentName}`;
				this.sessionNames.set(agentKey, sessionName);

				const deliverable = this.engine
					.get()
					.deliverables.find((g) => g.id === spawnOpts.deliverableId);
				if (!deliverable)
					throw new Error(`deliverable ${spawnOpts.deliverableId} not found`);

				// Determine agent mode
				const isWorker = spawnOpts.agentName === "worker";
				const agentMode = isWorker
					? deliverable.worker.mode
					: (deliverable.agents.find((a) => a.name === spawnOpts.agentName)
							?.mode ?? "read-only");

				const cwd = spawnOpts.worktreePath ?? this.opts.ctx.cwd;
				// Share the maestro's agent dir so agents inherit auth credentials
				const agentDir = defaultAgentDir();
				const agentSessionDir = join(
					process.env.PI_CODING_AGENT_SESSION_DIR ?? join(agentDir, "sessions"),
					"agents",
					sessionName,
				);
				mkdirSync(agentSessionDir, { recursive: true });

				let sessionFile: string;
				let kickoffMessage: string;
				if (spawnOpts.resumeSessionFile) {
					// Resurrection/crash-respawn: pi appends to the existing session
					// file in place, so resuming it is cache-hot by construction.
					// Skip seeding and session assembly entirely.
					sessionFile = spawnOpts.resumeSessionFile;
					kickoffMessage =
						spawnOpts.kickoffMessage ??
						"Your session was resumed. Review your progress and continue.";
				} else {
					// Deterministic framed seed: Prior Work (dep-deliverable summaries) →
					// Findings from Earlier Review (done siblings) → the assignment.
					// Repo-backed workers also get the repo's commit policy — a bare
					// "Add …" subject in a semantic-release repo publishes nothing.
					const scratch = deliverableWorkspace(deliverable) === "scratch";
					const commitNote =
						isWorker && !scratch
							? (commitPolicyInstruction(
									detectCommitPolicy(
										repoFor(this.engine.get(), deliverable).path,
									),
								) ?? undefined)
							: undefined;
					// A fresh worktree shares NO node_modules with the main checkout
					// — workers burned a cycle discovering "biome: command not found"
					// before figuring out to install. Say it up front.
					const needsInstall =
						isWorker &&
						!scratch &&
						existsSync(join(cwd, "package.json")) &&
						!existsSync(join(cwd, "node_modules"));
					const setupNote = needsInstall
						? "This is a fresh git worktree: dependencies are NOT installed " +
							"(node_modules is not shared with the main checkout). Run the " +
							"repo's install (bun install / npm ci / pnpm install — match " +
							"the lockfile) before running any checks or tests."
						: undefined;
					const policyNote = [commitNote, setupNote]
						.filter(Boolean)
						.join("\n\n");
					const knowledgeSessionPath = join(
						this.opts.planDir,
						"base-knowledge.jsonl",
					);
					// Post-freeze research refs: reports on disk that the frozen
					// knowledge doc's Research Index does not cover. They ride the
					// per-agent seed (after the shared prefix), so later workers see
					// the expanding picture without the base ever changing bytes.
					const researchRefs = reportsNotInText(
						researchReportsDir(this.opts.planDir),
						this.readKnowledgeContent(knowledgeSessionPath),
					).map((r) => ({ ref: r.ref, question: r.question }));
					const seed = spawnOpts.freshRecovery
						? spawnOpts.seed
						: buildSeed({
								plan: this.engine.get(),
								deliverable,
								agentName: spawnOpts.agentName,
								summaries: this.collectSeedSummaries(spawnOpts.deliverableId),
								...(policyNote ? { policyNote } : {}),
								...(researchRefs.length > 0 ? { researchRefs } : {}),
							});

					// Build session file (JSONL): fork the plan's frozen knowledge
					// session when it exists (shared cache prefix), then append
					// modes state + seed.
					const session = buildAgentSessionFile({
						agentKey,
						agentMode,
						seed,
						cwd,
						outDir: agentSessionDir,
						...(existsSync(knowledgeSessionPath)
							? { knowledgeSessionPath }
							: {}),
					});
					sessionFile = session.path;
					kickoffMessage =
						spawnOpts.kickoffMessage ??
						(isWorker
							? scratch
								? "Complete the tasks described in your seed. Toggle tasks when done."
								: "Implement the tasks described in your seed. Commit as you go. Toggle tasks when done."
							: "Review the code and report your findings. Follow the focus instructions in your seed.");
				}
				this.sessionFiles.set(agentKey, sessionFile);

				// Worker and support agents share the worker role policy. Authored exact
				// choices are persisted on their plan specs and revalidated on every fresh
				// spawn/resume, so unavailable or out-of-pool choices fail visibly.
				const authoredAgent = isWorker
					? undefined
					: deliverable.agents.find((a) => a.name === spawnOpts.agentName);
				const authored = isWorker ? deliverable.worker : authoredAgent;
				const resolvedWork = await (this.opts.resolveWorkerModel
					? this.opts.resolveWorkerModel({
							model: authored?.model ?? spawnOpts.model,
							effort: (authored?.effort ?? spawnOpts.effort) as
								| ThinkingLevel
								| undefined,
						})
					: resolveSpawnModelSafe(this.opts.ctx, {
							role: "worker",
							model: authored?.model ?? spawnOpts.model,
							effort: (authored?.effort ?? spawnOpts.effort) as
								| ThinkingLevel
								| undefined,
						}));
				// Pin the resolution onto the plan spec the first time it is made.
				// Without this, an agent spec with no authored model re-resolves
				// first-available on every respawn/resume — a mid-run config edit
				// silently re-rolls the model under a running deliverable. Pinned,
				// the resume path revalidates this exact choice like any authored
				// one: still available → same model; gone → a visible spawn error,
				// never a silent substitute.
				if (!authored?.model) {
					if (isWorker) {
						this.engine.updateDeliverable(spawnOpts.deliverableId, {
							workerModel: resolvedWork.modelId,
							...(authored?.effort === undefined && resolvedWork.effort
								? { workerEffort: resolvedWork.effort }
								: {}),
						});
					} else if (authoredAgent) {
						this.engine.updateAgent(
							spawnOpts.deliverableId,
							authoredAgent.name,
							{
								model: resolvedWork.modelId,
								...(authoredAgent.effort === undefined && resolvedWork.effort
									? { effort: resolvedWork.effort }
									: {}),
							},
						);
					}
				}
				const sessionModelId = this.opts.ctx.model
					? `${this.opts.ctx.model.provider}/${this.opts.ctx.model.id}`
					: undefined;
				// A resumed worker restores its model from its own session file
				// (pi falls back to the last assistant message's model), which may
				// be stale or no longer served by the gateway. Always pass the
				// freshly resolved model on resume; only fresh spawns may omit it
				// when it matches the maestro session's model.
				const modelOverride =
					resolvedWork.modelId === sessionModelId &&
					!spawnOpts.resumeSessionFile
						? undefined
						: resolvedWork.modelId;
				const thinkingOverride = resolvedWork.effort;
				const meta = getModelMeta(this.opts.ctx, resolvedWork.modelId);
				this.agentModelMeta.set(agentKey, {
					model: meta.shortName,
					modelId: resolvedWork.modelId,
					effort: resolvedWork.effort,
					adaptive: meta.adaptive,
				});

				try {
					mkdirSync(join(this.opts.planDir, "crashes"), { recursive: true });
				} catch {}
				const spec = buildSpawnSpec({
					sessionName,
					worktreePath: cwd,
					sessionFile,
					extensionPaths: this.opts.extensionPaths ?? [this.opts.extensionPath],
					env: {
						sock: this.socketPath,
						agentId: agentKey,
						agentMode,
						generation:
							this.executor.getAgentState(spawnOpts.deliverableId, "worker")
								?.generation ?? workerSessionGeneration(deliverable),
						planFingerprint: planFingerprint(this.engine.get()),
						agentDir,
						sessionDir: agentSessionDir,
						token: this.token,
						planDir: this.opts.planDir,
					},
					kickoffMessage,
					crashFile: this.crashFileFor(sessionName),
					...(modelOverride ? { model: modelOverride } : {}),
					...(thinkingOverride ? { thinking: thinkingOverride } : {}),
				});

				const cols = process.stdout.columns || 200;
				const rows = process.stdout.rows || 50;

				// A previous maestro run's worker may still be running for this
				// deliverable (crash orphan) — its RPC socket is dead, so it can
				// never report. Kill it before spawning the replacement.
				if (isWorker && deliverable.sessionName) {
					const stale = deliverable.sessionName;
					if (stale !== sessionName && (await this.tmux.hasSession(stale))) {
						await this.tmux.kill(stale).catch(() => {});
					}
				}

				await this.tmux.spawn(spec.sessionName, spec.cwd, spec.command, {
					width: cols,
					height: rows,
					env: spec.env,
				});

				// Persist the worker's resume ingredients on the plan: a restarted
				// maestro (which loses these in-memory maps) can then respawn the
				// worker RESUMED from its session file instead of from scratch.
				if (isWorker) {
					try {
						const current = findDeliverable(
							this.engine.get(),
							spawnOpts.deliverableId,
						);
						const generation =
							this.executor?.getAgentState(spawnOpts.deliverableId, "worker")
								?.generation ?? workerSessionGeneration(current ?? deliverable);
						this.engine.updateWorkerSession(spawnOpts.deliverableId, {
							sessionPath: sessionFile,
							sessionName,
							sessionGeneration: generation,
							restartState: "running",
						});
					} catch {
						// Persistence is best-effort — recovery degrades to re-seed.
					}
				}

				this.spawnTimes.set(agentKey, Date.now());
				this.logEvent("spawn", {
					agent: agentKey,
					session: sessionName,
					resumed: Boolean(spawnOpts.resumeSessionFile),
				});
				this.emitEvent({
					kind: "spawn",
					agentKey,
					session: sessionName,
					resumed: Boolean(spawnOpts.resumeSessionFile),
					deliverableTitle: this.deliverableTitle(spawnOpts.deliverableId),
				});
				const generation =
					this.executor.getAgentState(
						spawnOpts.deliverableId,
						spawnOpts.agentName,
					)?.generation ?? 0;
				this.opts.onAgentStateChanged?.(agentKey, {
					status: "working",
					generation,
					// Seed at revision 0 (zero snapshot): the worker's first real
					// cumulative report is revision 1, which recordCheckpoint accepts
					// (1 > 0). Seeding at 1 would tie and reject that first report.
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

				return { sessionId: sessionName, sessionFile };
			},

			killSession: async (sessionId) => {
				const agentKey = this.agentKeyForSession(sessionId);
				if (agentKey) {
					await this.stopAndProveGone(
						agentKey,
						sessionId,
						"work complete",
						Date.now() +
							(this.opts.stopGraceMs ?? this.opts.restartKillTimeoutMs ?? 5000),
					);
				} else if (await this.tmux.hasSession(sessionId)) {
					await this.tmux.kill(sessionId).catch(() => {});
				}
				this.takenNames.delete(sessionId);
				// Prune live-session bookkeeping so getWorkerSessions() only
				// returns live workers (auto-closing /watch panes). Guarded on
				// the session id: a respawn may have remapped the agent key to a
				// fresh session that must keep its entries. sessionFiles are
				// deliberately retained — resurrection resumes from them.
				if (agentKey && this.sessionNames.get(agentKey) === sessionId) {
					this.sessionNames.delete(agentKey);
					this.idleCount.delete(agentKey);
					this.lastRpcStatus.delete(agentKey);
					this.tokenSnapshots.delete(agentKey);
				}
			},

			createWorktree: async (worktreeOpts) => {
				const baseSha = headSha(worktreeOpts.repoPath);
				if (!baseSha) {
					throw new Error(
						`cannot capture delivery base before provisioning ${worktreeOpts.deliverableId}`,
					);
				}
				const path = provisionWorktree({
					repoPath: worktreeOpts.repoPath,
					deliverableId: worktreeOpts.deliverableId,
					baseBranch: worktreeOpts.baseBranch,
				});
				if (!this.provisionedWorktrees.has(path)) {
					await provisionEnvironment(
						path,
						worktreeOpts.repoPath,
						this.opts.worktreeSetup ?? {},
					);
					this.provisionedWorktrees.add(path);
				}
				this.engine.updateDeliverable(worktreeOpts.deliverableId, { baseSha });
				return path;
			},

			createScratchWorkspace: async (deliverableId) => {
				const path = join(this.opts.planDir, "workspaces", deliverableId);
				mkdirSync(path, { recursive: true });
				return path;
			},

			// Per-repo default branch: the registry's cached value wins (set at
			// register time), else live detection. Null falls back to the
			// executor's plan-wide defaultBranch.
			defaultBranchFor: (repoPath) => {
				const cached = this.engine
					.get()
					.repos?.find((r) => r.path === repoPath)?.defaultBranch;
				return cached ?? detectDefaultBranch(repoPath);
			},

			shipDeliverable: async (shipOpts) => {
				const plan = this.engine.get();
				const deliverable = plan.deliverables.find(
					(g) => g.id === shipOpts.deliverableId,
				);
				if (!deliverable)
					throw new Error(`deliverable ${shipOpts.deliverableId} not found`);
				const deliverableState = this.executor
					.getStates()
					.get(shipOpts.deliverableId);
				const agentReports = deliverableState
					? [...deliverableState.agents.values()]
							.filter((a) => a.summary)
							.map(
								(a) =>
									`### ${a.displayName ?? a.name} (${a.name})\n${a.summary}`,
							)
					: [];
				const result = await shipDeliverableReal({
					plan,
					deliverable,
					worktreePath: shipOpts.worktreePath,
					agentReports,
				});
				if (!result.ok) {
					throw new Error(`ship failed (${result.code}): ${result.message}`);
				}
				return result.prUrl;
			},

			requestSummary: async (sessionId, consumer, preamble) => {
				const agentKey = this.agentKeyForSession(sessionId);
				if (agentKey) {
					try {
						const reply = await this.router.request(
							agentKey,
							{
								type: "summarize",
								id: randomUUID(),
								consumer,
								preamble,
								budget: SUMMARY_TOKEN_BUDGET,
							},
							120_000,
						);
						if (reply.content.trim().length > 0) {
							return truncateSummary(reply.content);
						}
					} catch {
						// Timeout or dead agent — fall through to the transcript.
					}
					const fromTranscript = this.lastAssistantFromTranscript(agentKey);
					if (fromTranscript) return truncateSummary(fromTranscript);
				}
				return "## Summary\n(agent produced no summary)";
			},

			defaultBranch: this.opts.defaultBranch,

			canActivate: () => !this.stopping && (this.opts.canActivate?.() ?? true),

			now: () => new Date().toISOString(),
		};

		this.executor = new DeliverableExecutor(this.engine, deps);
	}

	/**
	 * Whether inbound RPC from this agent may act right now. A restarting
	 * deliverable's old worker generation can still flush buffered messages or
	 * reconnect mid-barrier; none of that may mutate state.
	 */
	private acceptsWorkerRpc(agentId: string): boolean {
		const [deliverableId, agentName] = agentId.split("/");
		return !(
			agentName === "worker" &&
			deliverableId &&
			this.restarting.has(deliverableId)
		);
	}

	/** Gate every router entrypoint on {@link acceptsWorkerRpc}. */
	private ignoreRestartingWorkers(
		handlers: RpcRouterHandlers,
	): RpcRouterHandlers {
		const guarded: Record<string, unknown> = {};
		for (const [type, handler] of Object.entries(handlers)) {
			guarded[type] = (agentId: string, msg: never) => {
				if (!this.acceptsWorkerRpc(agentId)) return;
				return (handler as (a: string, m: never) => void | Promise<void>)(
					agentId,
					msg,
				);
			};
		}
		return guarded as RpcRouterHandlers;
	}

	/** Run one lifecycle mutation after all prior lifecycle work settles. */
	private withLifecycle<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.lifecycleTail.then(fn, fn);
		this.lifecycleTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	setDebugProposalHandler(
		handler: (
			agentId: string,
			proposal: DebugProposalMessage,
		) => Promise<DebugResultMessage>,
	): void {
		this.debugProposalHandler = handler;
	}

	previewWorkerRestart(
		deliverableId: string,
		mode: WorkerRestartMode,
	): WorkerRestartPreview {
		const plan = this.engine.get();
		const deliverable = findDeliverable(plan, deliverableId);
		const generation = deliverable
			? workerSessionGeneration(deliverable) + 1
			: 0;
		if (!deliverable) {
			return {
				ok: false,
				deliverableId,
				mode,
				generation,
				error: `unknown deliverable: ${deliverableId}`,
			};
		}
		if (deliverable.status !== "active") {
			return {
				ok: false,
				deliverableId,
				mode,
				generation,
				error: `deliverable ${deliverableId} is ${deliverable.status}, not active`,
			};
		}
		return {
			deliverableId,
			mode,
			generation,
			...validateRestartWorkspace(
				plan,
				deliverable,
				this.opts.workspaceValidation,
				this.opts.planDir,
			),
		};
	}

	async restartWorkerResume(
		deliverableId: string,
	): Promise<WorkerRestartResult> {
		return this.restartWorker(deliverableId, "resume");
	}

	async restartWorkerFresh(
		deliverableId: string,
	): Promise<WorkerRestartResult> {
		return this.restartWorker(deliverableId, "fresh");
	}

	private async restartWorker(
		deliverableId: string,
		mode: WorkerRestartMode,
	): Promise<WorkerRestartResult> {
		return this.withLifecycle(async () => {
			const preview = this.previewWorkerRestart(deliverableId, mode);
			if (!preview.ok && !preview.missing) return preview;
			const state = this.executor.getStates().get(deliverableId);
			const worker = state?.agents.get("worker");
			const deliverable = findDeliverable(this.engine.get(), deliverableId);
			if (!state || !worker || !deliverable) return preview;
			this.restarting.add(deliverableId);
			// Detach the old generation before any await. Buffered messages on its
			// socket can no longer route, and reconnects are ignored while restarting.
			this.rpcServer.disconnect(`${deliverableId}/worker`);
			worker.status = "restarting";
			this.executor.blockDeliverable(
				deliverableId,
				`worker restarting (${mode})`,
			);
			this.engine.updateWorkerSession(deliverableId, {
				restartMode: mode,
				restartState: "restarting",
			});
			const oldSession = worker.sessionId ?? deliverable.sessionName;
			const oldGeneration =
				worker.generation ?? workerSessionGeneration(deliverable);
			const oldPath = deliverable.sessionPath ?? worker.sessionFile;
			try {
				if (oldSession) {
					const stopResult = await this.stopAndProveGone(
						`${deliverableId}/worker`,
						oldSession,
						"worker restart",
					);
					if (!stopResult.gone) {
						return this.failWorkerRestart(
							preview,
							`old tmux session ${oldSession} did not exit before timeout`,
						);
					}
				}
				if ((worker.generation ?? 0) !== oldGeneration) {
					return this.failWorkerRestart(
						preview,
						"worker generation changed during restart barrier",
					);
				}

				let workspace = preview;
				if (preview.missing) {
					// Missing is the sole mutation-allowing validation result. Existing
					// invalid workspaces never trigger Git state changes.
					const provisioned =
						await this.executor.reprovisionWorkspace(deliverableId);
					workspace = this.previewWorkerRestart(deliverableId, mode);
					if (!workspace.ok) {
						return this.failWorkerRestart(
							workspace,
							workspace.error ?? "reprovisioned workspace validation failed",
						);
					}
					if (provisioned.worktreePath !== workspace.path) {
						return this.failWorkerRestart(
							workspace,
							"reprovisioned workspace could not be reserved",
						);
					}
				}

				const nextGeneration = oldGeneration + 1;
				const history =
					mode === "fresh" && oldPath
						? [...(deliverable.previousSessionPaths ?? []), oldPath]
						: deliverable.previousSessionPaths;
				this.engine.updateWorkerSession(deliverableId, {
					sessionGeneration: nextGeneration,
					restartMode: mode,
					restartState: "restarting",
				});
				const seed =
					mode === "fresh"
						? this.buildFreshRecoverySeed(deliverableId, nextGeneration)
						: undefined;
				await this.executor.replaceWorker(
					deliverableId,
					mode,
					nextGeneration,
					seed,
				);
				this.engine.updateWorkerSession(deliverableId, {
					...(history ? { previousSessionPaths: history } : {}),
					restartState: "running",
				});
				const persisted = findDeliverable(this.engine.get(), deliverableId);
				return {
					...workspace,
					ok: true,
					deliverableId,
					mode,
					generation: nextGeneration,
					...(persisted?.sessionPath
						? { sessionPath: persisted.sessionPath }
						: {}),
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return this.failWorkerRestart(preview, `restart failed: ${message}`);
			} finally {
				this.restarting.delete(deliverableId);
			}
		});
	}

	/**
	 * Every restart failure funnels here: the persisted restart state blocks,
	 * and the executor state becomes retryable (pending, no session) instead of
	 * a wedged "restarting" worker no later attempt can pick up.
	 */
	private failWorkerRestart(
		preview: WorkerRestartPreview,
		error: string,
	): WorkerRestartResult {
		this.engine.updateWorkerSession(preview.deliverableId, {
			restartState: "blocked",
		});
		this.executor.failWorkerReplacement(preview.deliverableId, error);
		return { ...preview, ok: false, error };
	}

	/**
	 * Force-fail a worker on user demand (the /recover preflight): kill its
	 * session, park the deliverable in the /recover-able restart shape, and
	 * suppress the crash-respawn loop. Returns false when there is nothing to
	 * fail (unknown deliverable, worker already done/summarizing) or the tmux
	 * session refused to die — in that case nothing is mutated.
	 */
	async forceFailWorker(
		deliverableId: string,
		reason: string,
	): Promise<boolean> {
		return this.withLifecycle(async () => {
			const state = this.executor.getStates().get(deliverableId);
			const worker = state?.agents.get("worker");
			if (!state || !worker) return false;
			if (worker.status === "done" || worker.status === "summarizing") {
				return false;
			}
			const agentKey = `${deliverableId}/worker`;
			this.restarting.add(deliverableId);
			try {
				// Detach the RPC route before any await — buffered messages from
				// the dying process must not land as fresh state.
				this.rpcServer.disconnect(agentKey);
				const session = worker.sessionId ?? this.sessionNames.get(agentKey);
				// Drop the crash budget so a later /recover gets fresh respawn
				// attempts. Do NOT drop the sessionNames mapping yet:
				// stopAndProveGone's generation guard needs it to actually poll and
				// kill the tmux session, and it removes the mapping itself once the
				// process is proven gone — a premature delete short-circuits the
				// guard to {gone:true} and the real kill never runs.
				this.respawnCount.delete(agentKey);
				if (session) {
					const stopResult = await this.stopAndProveGone(
						agentKey,
						session,
						reason,
					);
					if (!stopResult.gone) {
						// Session survived the kill barrier: keep watching it and
						// report failure instead of marking a live process pending.
						this.sessionNames.set(agentKey, session);
						return false;
					}
				}
				this.executor.failWorkerReplacement(
					deliverableId,
					`${RESTART_BLOCK_PREFIX} — force-failed (${reason}); /recover ${deliverableId} audits and respawns it`,
				);
				this.logEvent("force-fail", { agent: agentKey, reason });
				this.emitEvent({
					kind: "failed",
					agentKey,
					deliverableTitle: this.deliverableTitle(deliverableId),
					respawns: 0,
				});
				this.opts.onPlanChanged();
				return true;
			} finally {
				this.restarting.delete(deliverableId);
			}
		});
	}

	private async stopAndProveGone(
		agentKey: string,
		sessionId: string,
		reason: string,
		deadlineAt = Date.now() + (this.opts.restartKillTimeoutMs ?? 5000),
	): Promise<{ gone: boolean; cooperative: boolean }> {
		const generation = this.currentGeneration(agentKey);
		let cooperative = false;
		try {
			await this.router.request(
				agentKey,
				{
					type: "prepareStop",
					id: randomUUID(),
					requestedAt: Date.now(),
					deadlineAt,
					reason,
				},
				Math.max(0, deadlineAt - Date.now()),
			);
			cooperative = true;
		} catch {
			// Deadline/disconnect falls through to the one forced escalation path.
		}
		if (!this.generationMatches(agentKey, generation, sessionId)) {
			return { gone: true, cooperative };
		}
		while (Date.now() < deadlineAt) {
			if (!(await this.tmux.hasSession(sessionId))) break;
			await new Promise((resolve) =>
				setTimeout(resolve, this.opts.restartPollMs ?? 50),
			);
		}
		if (
			this.generationMatches(agentKey, generation, sessionId) &&
			(await this.tmux.hasSession(sessionId))
		) {
			await this.tmux.kill(sessionId).catch(() => {});
		}
		while (Date.now() < deadlineAt) {
			if (!(await this.tmux.hasSession(sessionId))) break;
			await new Promise((resolve) =>
				setTimeout(resolve, this.opts.restartPollMs ?? 50),
			);
		}
		const gone = !(await this.tmux.hasSession(sessionId));
		if (gone && this.sessionNames.get(agentKey) === sessionId) {
			this.sessionNames.delete(agentKey);
		}
		return { gone, cooperative };
	}

	private currentGeneration(agentKey: string): number {
		const [deliverableId, name] = agentKey.split("/");
		return (
			(deliverableId && name
				? this.executor.getAgentState(deliverableId, name)?.generation
				: undefined) ?? 0
		);
	}

	private generationMatches(
		agentKey: string,
		generation: number,
		sessionId: string,
	): boolean {
		return (
			this.currentGeneration(agentKey) === generation &&
			this.sessionNames.get(agentKey) === sessionId
		);
	}

	private buildFreshRecoverySeed(
		deliverableId: string,
		generation: number,
	): string {
		const plan = this.engine.get();
		const g = findDeliverable(plan, deliverableId);
		if (!g) throw new Error(`unknown deliverable: ${deliverableId}`);
		const state = this.executor.getStates().get(deliverableId);
		const workspace = state?.worktreePath ?? g.worktreePath ?? "(missing)";
		const branch = g.branch ?? "(scratch workspace — no branch)";
		const done = g.tasks.filter((task) => task.done);
		const remaining = g.tasks.filter((task) => !task.done);
		const commits = this.commitsFor(workspace);
		const open: string[] = [];
		const agentFacts = state
			? [...state.agents.values()]
					.filter((agent) => agent.summary || agent.error)
					.map(
						(agent) =>
							`- ${agent.name}: ${agent.summary ?? `error: ${agent.error}`}`,
					)
			: [];
		const repository =
			deliverableWorkspace(g) === "scratch"
				? "(scratch workspace)"
				: repoFor(plan, g).path;
		return [
			"# Fresh-session recovery",
			`Plan: ${plan.slug}`,
			`Deliverable: ${g.id} — ${g.title}`,
			`Worker generation: ${generation}`,
			"",
			"## Assigned workspace",
			`- Workspace: ${workspace}`,
			`- Repository: ${repository}`,
			`- Branch: ${branch}`,
			"- The workspace is already provisioned. Do not create another worktree or checkout/change branches.",
			"- Inspect git status and existing files first. Preserve all valid dirty/uncommitted changes.",
			"",
			"## Deliverable",
			g.body,
			"",
			"## Done tasks",
			...(done.length
				? done.map((task) => `- [x] ${task.title}: ${task.body}`)
				: ["- None"]),
			"",
			"## Remaining tasks",
			...(remaining.length
				? remaining.map((task) => `- [ ] ${task.title}: ${task.body}`)
				: ["- None"]),
			"",
			"## Existing summaries and errors",
			...(g.summary ? [g.summary] : []),
			...(agentFacts.length ? agentFacts : ["- None recorded"]),
			"",
			"## Existing commits",
			...(commits.length
				? commits.map((commit) => `- ${commit}`)
				: ["- None recorded"]),
			"",
			"## Canonical workflow findings",
			...(open.length ? open.map((finding) => `- ${finding}`) : ["- None"]),
			"",
			"## Artifacts",
			...(g.prUrl ? [`- PR: ${g.prUrl}`] : []),
			...(g.previousSessionPaths ?? []).map(
				(path) => `- Previous session: ${path}`,
			),
			...(g.sessionPath ? [`- Replaced session: ${g.sessionPath}`] : []),
			"",
			"Continue only in the assigned workspace. Inspect and preserve existing changes; do not reset, clean, checkout, or create worktrees. Commit as you go and update tasks normally.",
		].join("\n");
	}

	private commitsFor(workspace: string): string[] {
		const result = runCommand("git", ["log", "-10", "--pretty=%h %s"], {
			cwd: workspace,
		});
		return result.ok
			? result.stdout
					.split("\n")
					.map((line) => line.trim())
					.filter(Boolean)
			: [];
	}

	async start(): Promise<void> {
		mkdirSync(this.opts.planDir, { recursive: true });
		await this.rpcServer.listen(this.socketPath);

		// Poll timer: check liveness of tmux sessions every 5s. Never let a
		// rejection escape the interval callback — it would crash the maestro.
		this.pollTimer = setInterval(() => {
			this.pollSessions().catch((e) => {
				this.logEvent("error", {
					scope: "pollSessions",
					message: e instanceof Error ? e.message : String(e),
				});
			});
		}, 5000);

		this._started = true;
	}

	/**
	 * Serialized tick: every entry point (start, plan changes, completion
	 * chains, the poll timer) funnels through a promise-chain mutex so the
	 * executor never runs two ticks concurrently.
	 */
	async tick(deliverableIds?: readonly string[]): Promise<number> {
		const run = this.tickChain.then(() =>
			this.withLifecycle(() => this.tickOnce(deliverableIds)),
		);
		this.tickChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async tickOnce(deliverableIds?: readonly string[]): Promise<number> {
		if (!this._started) return 0;

		const beforeActive = this.engine
			.get()
			.deliverables.filter((g) => g.status === "active").length;

		const shipped = await this.executor.tick(deliverableIds);
		this.recordDeliverableTransitions();

		const afterActive = this.engine
			.get()
			.deliverables.filter((g) => g.status === "active").length;

		if (shipped.length > 0) {
			for (const deliverableId of shipped) {
				const g = this.engine
					.get()
					.deliverables.find((x) => x.id === deliverableId);
				this.logEvent("shipped", {
					deliverable: deliverableId,
					prUrl: g?.prUrl,
				});
				this.emitEvent({
					kind: "shipped",
					deliverableId,
					deliverableTitle: g?.title ?? deliverableId,
					...(g?.prUrl ? { prUrl: g.prUrl } : {}),
				});
			}
			this.opts.onPlanChanged();
		}

		// Check if all deliverables are terminal
		const plan = this.engine.get();
		const allDone = plan.deliverables.every(
			(g) =>
				g.status === "shipped" ||
				g.status === "superseded" ||
				g.status === "abandoned",
		);
		if (allDone && plan.deliverables.length > 0 && !this.settledAnnounced) {
			this.settledAnnounced = true;
			this.opts.onAllSettled?.();
			this.emitEvent({
				kind: "settled",
				deliverables: plan.deliverables.map((g) => ({
					id: g.id,
					title: g.title,
					status: g.status,
					...(g.prUrl ? { prUrl: g.prUrl } : {}),
				})),
			});
		}

		const newlyActivated = afterActive - beforeActive;
		return Math.max(0, newlyActivated + shipped.length);
	}

	private handleChildRunSync(agentId: string, msg: ChildRunSyncMessage): void {
		const [deliverableId, name] = agentId.split("/");
		if (!deliverableId || name !== "worker") return;
		const deliverable = findDeliverable(this.engine.get(), deliverableId);
		const expectedGeneration =
			this.executor.getAgentState(deliverableId, "worker")?.generation ??
			(deliverable ? workerSessionGeneration(deliverable) : -1);
		const accepted = this.childProjections.apply({
			ownerId: agentId,
			expectedGeneration,
			ownerGeneration: msg.ownerGeneration,
			reconcile: msg.reconcile,
			runs: msg.runs,
		});
		for (const projection of msg.runs) {
			if (!accepted.some((item) => item.runId === projection.runId)) continue;
			this.opts.onChildProjection?.(agentId, msg.ownerGeneration, projection);
		}
		this.router.send(agentId, {
			type: "childRunSyncAck",
			id: msg.id,
			ownerGeneration: msg.ownerGeneration,
			accepted,
		});
	}

	projectedRuns() {
		return this.childProjections.asRunRecords();
	}

	steerProjectedRun(runId: RunId, guidance: string): boolean {
		void this.controlProjectedRun(runId, "steer", { guidance });
		return Boolean(this.childProjections.get(runId as string));
	}

	async interruptProjectedRun(
		runId: RunId,
		reason?: string,
	): Promise<InterruptResult> {
		const result = await this.controlProjectedRun(runId, "interrupt", {
			reason,
		});
		return {
			outcome: result?.outcome ?? "disconnected",
			targetId: `run:${runId}`,
			...(result?.error ? { detail: result.error } : {}),
		};
	}

	async captureProjectedRun(
		runId: RunId,
		lines?: number,
	): Promise<string | undefined> {
		return (await this.controlProjectedRun(runId, "capture", { lines }))
			?.content;
	}

	stopProjectedRun(runId: RunId, reason?: string): boolean {
		void this.controlProjectedRun(runId, "stop", { reason });
		return Boolean(this.childProjections.get(runId as string));
	}

	private async controlProjectedRun(
		runId: RunId,
		action: "steer" | "interrupt" | "capture" | "stop",
		input: { guidance?: string; reason?: string; lines?: number },
	): Promise<ChildRunControlResultMessage | undefined> {
		const record = this.childProjections.get(runId as string);
		if (!record?.confirmed) return undefined;
		const id = randomUUID();
		const response = new Promise<ChildRunControlResultMessage>((resolve) => {
			const timer = setTimeout(() => {
				this.childControls.delete(id);
				resolve({
					type: "childRunControlResult",
					id,
					ownerGeneration: record.ownerGeneration,
					runId: runId as string,
					action,
					ok: false,
					error: "child control timed out",
				});
			}, 30_000);
			timer.unref?.();
			this.childControls.set(id, { ownerId: record.ownerId, resolve, timer });
		});
		const sent = this.router.send(record.ownerId, {
			type: "childRunControl",
			id,
			ownerGeneration: record.ownerGeneration,
			runId: runId as string,
			action,
			...input,
		});
		if (!sent) {
			const pending = this.childControls.get(id);
			if (pending) {
				this.childControls.delete(id);
				clearTimeout(pending.timer);
				pending.resolve({
					type: "childRunControlResult",
					id,
					ownerGeneration: record.ownerGeneration,
					runId: runId as string,
					action,
					ok: false,
					error: "owner disconnected",
				});
			}
		}
		return response;
	}

	// --- RPC handlers (dispatched by the router; see constructor table) ---

	private handleStatus(
		agentId: string,
		deliverableId: string,
		agentNamePart: string,
		status: "working" | "idle" | "stopping" | "stopped" | "error",
	): void {
		if (this.restarting.has(deliverableId)) return;
		const mapped = this.sessionNames.get(agentId);
		const state = this.executor.getAgentState(deliverableId, agentNamePart);
		if (mapped && state?.sessionId && mapped !== state.sessionId) return;
		this.lastRpcStatus.set(agentId, status);
		if (status === "working") {
			this.idleCount.set(agentId, 0);
			this.stuckSteerSent.delete(agentId);
			return;
		}
		if (status === "idle") {
			this.evaluateIdle(agentId, deliverableId, agentNamePart);
		}
	}

	/**
	 * One idle observation for an agent. Fired on every idle status report AND
	 * from the 5s poll while the last report was idle — a finished agent
	 * reports idle exactly once, so gates that need "sustained idle" (reviewer
	 * completion, zero-task workers, stuck-steer) must be re-fed by the poll.
	 */
	private evaluateIdle(
		agentId: string,
		deliverableId: string,
		agentNamePart: string,
	): void {
		{
			const count = (this.idleCount.get(agentId) ?? 0) + 1;
			this.idleCount.set(agentId, count);

			const state = this.executor.getAgentState(deliverableId, agentNamePart);
			if (
				state &&
				(state.status === "summarizing" || state.status === "done")
			) {
				return;
			}

			if (agentNamePart === "worker") {
				// Check if worker completed all tasks
				if (this.executor.isWorkerDone(deliverableId)) {
					const deliverable = this.engine
						.get()
						.deliverables.find((g) => g.id === deliverableId);
					const gating =
						deliverable?.tasks.filter((t) => t.kind === "task") ?? [];
					if (gating.length > 0) {
						this.checkCompletionGate(agentId, deliverableId);
						return;
					}
					// Zero gating tasks: "all toggled" is vacuous, so sustained
					// idling is the worker's only completion signal.
					if (count >= IDLE_DONE_THRESHOLD && state?.status === "working") {
						if (!this.workerMayComplete(agentId, deliverableId)) return;
						this.completeAgent(deliverableId, agentNamePart);
						return;
					}
				}
			} else if (count >= IDLE_DONE_THRESHOLD && state?.status === "working") {
				// Non-worker support agents never toggle tasks and interactive pi
				// never exits — sustained idle is their only completion signal.
				this.completeAgent(deliverableId, agentNamePart);
				return;
			}

			// Stuck detection: steer after 5 consecutive idles
			if (count >= 5 && !this.stuckSteerSent.has(agentId)) {
				const deliverable = this.engine
					.get()
					.deliverables.find((g) => g.id === deliverableId);
				if (deliverable) {
					const remaining = deliverable.tasks
						.filter((t) => t.kind === "task" && !t.done)
						.map((t) => `${t.title} (task id: \`${t.id}\`)`);
					if (remaining.length > 0) {
						this.router.send(agentId, {
							type: "steer",
							content: `You seem stuck. These tasks are NOT yet marked done in the plan: ${remaining.join(", ")}. For each one you have finished, call task(action="toggle", taskId="<task id>") with the exact task id, then stop.`,
						});
					}
					this.stuckSteerSent.add(agentId);
				}
			}
		}
	}

	private handleDone(deliverableId: string, agentNamePart: string): void {
		if (this.restarting.has(deliverableId)) return;
		const agentKey = `${deliverableId}/${agentNamePart}`;
		const state = this.executor.getAgentState(deliverableId, agentNamePart);
		const mapped = this.sessionNames.get(agentKey);
		if (mapped && state?.sessionId && mapped !== state.sessionId) return;
		if (
			agentNamePart === "worker" &&
			!this.workerMayComplete(
				`${deliverableId}/${agentNamePart}`,
				deliverableId,
			)
		) {
			return;
		}
		this.completeAgent(deliverableId, agentNamePart);
	}

	/**
	 * Whether the worker may complete now, workspace-wise: a non-scratch
	 * deliverable must leave a CLEAN worktree — the shipper refuses dirty
	 * trees far too late to fix. While dirty, the worker is steered to
	 * commit on a cadence (dirtyHoldResteerMs, dirtyHoldMaxSteers); every
	 * hold/steer/release is logged to events.jsonl. When the reminder
	 * budget is exhausted the hold ESCALATES — agent failed + deliverable
	 * blocked with a /recover hint — because a silent hold wedged the
	 * whole post-completion pipeline for hours (drive 2, 2026-07-18).
	 */
	private workerMayComplete(agentId: string, deliverableId: string): boolean {
		const deliverable = findDeliverable(this.engine.get(), deliverableId);
		const state = this.executor.getStates().get(deliverableId);
		const dirty =
			deliverable &&
			deliverableWorkspace(deliverable) !== "scratch" &&
			state?.worktreePath &&
			!workingTreeClean(state.worktreePath);
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
		// Idle observations re-feed this every ~5s; act only on the cadence.
		if (hold.steers > 0 && now - hold.lastSteerAt < resteerMs) return false;
		if (hold.steers < maxSteers) {
			hold.steers += 1;
			hold.lastSteerAt = now;
			this.logEvent("completion-held", {
				agent: agentId,
				reason: "dirty-worktree",
				steer: hold.steers,
				of: maxSteers,
				worktree: state?.worktreePath,
			});
			this.router.send(agentId, {
				type: "steer",
				content: `All planned tasks are marked done, but the worktree still has uncommitted changes (reminder ${hold.steers}/${maxSteers}). Run \`git add -A && git commit\` with a meaningful message now, verify \`git status --short\` is empty, then end your turn. Maestro will not complete or ship a dirty delivery.`,
			});
			return false;
		}
		// Reminder budget exhausted one full cadence ago — escalate to a
		// visible, /recover-able state instead of holding silently forever.
		hold.escalated = true;
		const agentNamePart = agentId.split("/")[1] ?? "worker";
		const reason = `worker finished all tasks but left uncommitted changes after ${maxSteers} commit reminders — commit manually in ${state?.worktreePath ?? "its worktree"}, then /recover ${deliverableId}`;
		this.logEvent("completion-hold-escalated", { agent: agentId, reason });
		this.executor.markAgentFailed(deliverableId, agentNamePart, reason);
		this.executor.blockDeliverable(deliverableId, reason);
		this.recordDeliverableTransitions();
		this.opts.onPlanChanged();
		return false;
	}

	/**
	 * Fire-and-forget completion: finishAgent → plan refresh → tick, with
	 * rejection safety — a summarize/kill race must never crash the maestro.
	 */
	private completeAgent(deliverableId: string, name: string): void {
		this.withLifecycle(() => this.finishAgent(deliverableId, name)).then(
			() => {
				this.opts.onPlanChanged();
				this.tick().catch((e) => {
					this.logEvent("error", {
						scope: "tick",
						message: e instanceof Error ? e.message : String(e),
					});
				});
			},
			(e) => {
				const message = e instanceof Error ? e.message : String(e);
				this.executor.markAgentFailed(deliverableId, name, message);
				this.logEvent("error", { agent: `${deliverableId}/${name}`, message });
			},
		);
	}

	/** Complete an agent through the executor, logging the lifecycle event. */
	private async finishAgent(
		deliverableId: string,
		name: string,
	): Promise<void> {
		const agentKey = `${deliverableId}/${name}`;
		const state = this.executor.getAgentState(deliverableId, name);
		const firstCompletion = Boolean(state && state.status !== "done");
		const capturedGeneration = state?.generation ?? 0;
		const capturedSession = state?.sessionId;
		// Capture live bookkeeping now — markAgentDone kills the session, which
		// prunes tokenSnapshots (see killSession) before the event is emitted.
		const tokens = this.tokenSnapshots.get(agentKey);
		const prefixCacheHitRate = this.firstTurnPrefixCacheHitRate.get(agentKey);
		const spawnedAt = this.spawnTimes.get(agentKey);
		if (firstCompletion) {
			this.logEvent("done", { agent: agentKey });
		}
		await this.executor.markAgentDone(deliverableId, name, {
			generation: capturedGeneration,
			...(capturedSession ? { sessionId: capturedSession } : {}),
		});
		if (firstCompletion) {
			// Summary exists only after markAgentDone ran requestSummary.
			const summary = this.executor.getAgentState(deliverableId, name)?.summary;
			const doneMeta = this.agentModelMeta.get(agentKey);
			const doneEffort = this.executor.getAgentState(
				deliverableId,
				name,
			)?.effort;
			this.emitEvent({
				kind: "done",
				agentKey,
				deliverableTitle: this.deliverableTitle(deliverableId),
				durationMs: spawnedAt !== undefined ? Date.now() - spawnedAt : 0,
				tokens: tokens
					? { input: tokens.input, output: tokens.output, turns: tokens.turns }
					: { input: 0, output: 0, turns: 0 },
				...(prefixCacheHitRate !== undefined ? { prefixCacheHitRate } : {}),
				...(doneMeta
					? { model: doneMeta.model, adaptive: doneMeta.adaptive }
					: {}),
				...(doneEffort ? { effort: doneEffort } : {}),
				...(summary ? { summary } : {}),
			});
		}
		this.recordDeliverableTransitions();
	}

	private handlePlanMutate(agentId: string, msg: PlanMutateMessage): void {
		const [authenticatedDeliverable] = agentId.split("/");
		// A blank id means "my own deliverable" — models routinely send "" for
		// optional params, and the agent can only ever target itself anyway.
		const deliverableId = msg.deliverableId?.trim() || authenticatedDeliverable;
		if (authenticatedDeliverable !== deliverableId) {
			this.router.send(agentId, {
				type: "planMutateResult",
				id: msg.id,
				success: false,
				error: `agent may only mutate its own deliverable ("${authenticatedDeliverable}")`,
			});
			return;
		}
		const params = msg.params ?? {};

		try {
			switch (msg.action) {
				case "toggleTask": {
					const taskId = params.taskId;
					if (!taskId) throw new Error("taskId required");
					this.engine.toggleWorkItem(deliverableId, taskId, {
						summary: params.summary,
					});
					this.opts.onPlanChanged();
					this.router.send(agentId, {
						type: "planMutateResult",
						id: msg.id,
						success: true,
						taskId,
					});
					// Toggling the final task only arms completion. The worker may
					// still be running validation/formatting in this turn; completion is
					// evaluated after the turn reports idle (or an explicit done claim).
					break;
				}
				case "addTask": {
					const title = params.title;
					if (!title) throw new Error("title required");
					const item = this.engine.addWorkItem(deliverableId, {
						title,
						body: params.body ?? "",
						kind: params.kind ?? "followup",
					});
					this.opts.onPlanChanged();
					this.router.send(agentId, {
						type: "planMutateResult",
						id: msg.id,
						success: true,
						taskId: item.id,
					});
					break;
				}
				case "updateTask": {
					const taskId = params.taskId;
					if (!taskId) throw new Error("taskId required");
					this.engine.updateWorkItem(deliverableId, taskId, {
						...(params.title ? { title: params.title } : {}),
						...(params.body ? { body: params.body } : {}),
					});
					this.opts.onPlanChanged();
					this.router.send(agentId, {
						type: "planMutateResult",
						id: msg.id,
						success: true,
						taskId,
					});
					break;
				}
				default:
					this.router.send(agentId, {
						type: "planMutateResult",
						id: msg.id,
						success: false,
						error: `unknown action: ${msg.action}`,
					});
			}
		} catch (e) {
			this.router.send(agentId, {
				type: "planMutateResult",
				id: msg.id,
				success: false,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	private handlePlanRead(agentId: string, msg: PlanReadMessage): void {
		const [deliverableId] = agentId.split("/");
		const content = renderPlanForAgent(this.engine, deliverableId);
		this.router.send(agentId, {
			type: "planReadResponse",
			id: msg.id,
			content,
		});
	}

	private handleQuestions(
		agentId: string,
		deliverableId: string,
		agentNamePart: string,
		msg: QuestionsMessage,
	): void {
		const deliverable = this.engine
			.get()
			.deliverables.find((g) => g.id === deliverableId);
		this.questionQueue.enqueue({
			agentId,
			agentName: agentNamePart,
			deliverableTitle: deliverable?.title ?? deliverableId,
			questions: msg.questions,
			resolve: (answers) => {
				this.router.send(agentId, {
					type: "answers",
					id: msg.id,
					answers,
				});
			},
		});
		this.opts.onQuestionsReceived?.(agentId, msg.questions.length);
	}

	// --- Completion gate ---

	private checkCompletionGate(agentId: string, deliverableId: string): void {
		const deliverable = this.engine
			.get()
			.deliverables.find((g) => g.id === deliverableId);
		if (!deliverable) return;
		const gating = deliverable.tasks.filter((t) => t.kind === "task");
		if (gating.length === 0) return;
		if (!gating.every((t) => t.done)) return;

		// All gating tasks done — summarize (over the live agent), then shut down.
		// markAgentDone runs requestSummary before killSession; sending a raw
		// shutdown here would kill the agent before it could summarize.
		const agentNamePart = agentId.split("/")[1];
		if (!agentNamePart) return;
		const state = this.executor.getAgentState(deliverableId, agentNamePart);
		if (state && (state.status === "summarizing" || state.status === "done"))
			return;
		// Tasks done is not enough: required workflow reviews must have
		// reported before the worker is killed.
		if (!this.workerMayComplete(agentId, deliverableId)) return;
		this.completeAgent(deliverableId, agentNamePart);
	}

	// --- Session lookups ---

	private agentKeyForSession(sessionName: string): string | undefined {
		for (const [key, name] of this.sessionNames) {
			if (name === sessionName) return key;
		}
		return undefined;
	}

	/** Fallback summary source: the agent's last assistant message on disk. */
	private lastAssistantFromTranscript(agentKey: string): string | undefined {
		const path = this.sessionFiles.get(agentKey);
		if (!path) return undefined;
		try {
			const lines = readFileSync(path, "utf-8").trim().split("\n");
			for (let i = lines.length - 1; i >= 0; i--) {
				let entry: Record<string, unknown>;
				try {
					entry = JSON.parse(lines[i]) as Record<string, unknown>;
				} catch {
					continue;
				}
				const message = (entry.message ?? entry) as Record<string, unknown>;
				if (message.role !== "assistant") continue;
				const text = extractAssistantText(message.content);
				if (text) return text;
			}
		} catch {
			// unreadable transcript — no fallback available
		}
		return undefined;
	}

	// --- Answer pending questions ---

	answerQuestions(agentId: string, answers: Answers): void {
		this.questionQueue.answer(agentId, answers);
	}

	steer(
		deliverableId: string,
		guidance: string,
		agentName = "worker",
	): boolean {
		const agentKey = `${deliverableId}/${agentName}`;
		return this.router.send(agentKey, { type: "steer", content: guidance });
	}

	async interrupt(
		deliverableId: string,
		agentName = "worker",
	): Promise<import("@vegardx/pi-contracts").InterruptResult> {
		const agentKey = `${deliverableId}/${agentName}`;
		const targetId = `worker:${agentKey}`;
		try {
			const response = await this.router.request(
				agentKey,
				{
					type: "interrupt",
					id: randomUUID(),
					reason: "user interrupt",
				},
				3000,
			);
			return { outcome: response.outcome, targetId };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				outcome: message.includes("timed out") ? "timed-out" : "disconnected",
				targetId,
				detail: message,
			};
		}
	}

	async capture(
		deliverableId: string,
		agentName = "worker",
		lines = 200,
	): Promise<string | undefined> {
		const session = this.resolveSessionName(`${deliverableId}/${agentName}`);
		if (!session) return undefined;
		return this.tmux.capturePane?.(session, lines).catch(() => undefined);
	}

	async stop(
		deliverableId: string,
		agentName = "worker",
		reason = "user stop",
	): Promise<boolean> {
		return this.forceFailWorker(deliverableId, `${reason} (${agentName})`);
	}

	/**
	 * Resolve to a tmux session name. Accepts a full
	 * agent key (`deliverable/agent`), a deliverable id (→ its worker), a bare agent
	 * name, or a session name itself.
	 */
	resolveSessionName(target: string): string | undefined {
		const t = target.trim();
		if (!t) return undefined;
		const direct =
			this.sessionNames.get(t) ?? this.sessionNames.get(`${t}/worker`);
		if (direct) return direct;
		for (const [key, name] of this.sessionNames) {
			if (name === t || key.endsWith(`/${t}`)) return name;
		}
		return undefined;
	}

	snapshot(): {
		agents: Map<
			string,
			{
				status: string;
				startedAt: number;
				completedAt?: number;
				tokens: TokenSnapshot;
				prefixCacheHitRate?: number;
				model?: string;
				effort?: string;
				adaptive?: boolean;
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
				tokens: TokenSnapshot;
				prefixCacheHitRate?: number;
				model?: string;
				effort?: string;
				adaptive?: boolean;
			}
		>();
		const deliverables = new Map<string, { blocked?: string }>();
		const states = this.executor.getStates();

		for (const [deliverableId, deliverableState] of states) {
			deliverables.set(deliverableId, {
				...(deliverableState.blocked
					? { blocked: deliverableState.blocked }
					: {}),
			});
			for (const [name, agentState] of deliverableState.agents) {
				const key = `${deliverableId}/${name}`;
				const tokens = this.tokenSnapshots.get(key);
				const prefixCacheHitRate = this.firstTurnPrefixCacheHitRate.get(key);
				const meta = this.agentModelMeta.get(key);
				agents.set(key, {
					status: agentState.status,
					startedAt:
						this.spawnTimes.get(key) ??
						(agentState.startedAt
							? Date.parse(agentState.startedAt)
							: Date.now()),
					...(agentState.completedAt
						? { completedAt: Date.parse(agentState.completedAt) }
						: {}),
					tokens: tokens ?? {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						promptTokens: 0,
						totalTokens: 0,
						cost: 0,
						turns: 0,
					},
					...(prefixCacheHitRate !== undefined ? { prefixCacheHitRate } : {}),
					...(meta ? { model: meta.model, adaptive: meta.adaptive } : {}),
					...(agentState.effort ? { effort: agentState.effort } : {}),
				});
			}
		}

		return { agents, deliverables };
	}

	async markAgentDone(deliverableId: string, name: string): Promise<void> {
		await this.withLifecycle(() => this.finishAgent(deliverableId, name));
		this.opts.onPlanChanged();
	}

	isWorkerDone(deliverableId: string): boolean {
		return this.executor.isWorkerDone(deliverableId);
	}

	getExecutor(): DeliverableExecutor {
		return this.executor;
	}

	/** Get tmux session names for worker agents only. */
	getWorkerSessions(): string[] {
		const result: string[] = [];
		for (const [key, name] of this.sessionNames) {
			if (key.endsWith("/worker")) result.push(name);
		}
		return result;
	}

	async prepareStop(
		reason = "execution shutdown",
	): Promise<ExecutionStopResult> {
		if (this.stopResult) return this.stopResult;
		if (this.stopPromise) return this.stopPromise;
		this.stopping = true;
		this.stopPromise = this.withLifecycle(async () => {
			this._started = false;
			if (this.pollTimer) {
				clearInterval(this.pollTimer);
				this.pollTimer = undefined;
			}
			const requestedAt = Date.now();
			const grace = Math.min(
				60_000,
				Math.max(
					0,
					this.opts.stopGraceMs ?? this.opts.restartKillTimeoutMs ?? 5000,
				),
			);
			const deadlineAt = requestedAt + grace;
			const fleet = [...this.sessionNames.entries()].map(
				([agentKey, session]) => ({
					agentKey,
					session,
					generation: this.currentGeneration(agentKey),
				}),
			);
			const settled = await Promise.all(
				fleet.map(async ({ agentKey, session, generation }) => {
					const result = await this.stopAndProveGone(
						agentKey,
						session,
						reason,
						deadlineAt,
					);
					return {
						agentKey,
						generation,
						session,
						outcome: result.gone
							? result.cooperative
								? ("cooperative" as const)
								: ("forced" as const)
							: ("not-proven" as const),
					};
				}),
			);
			const completedAt = Date.now();
			const stop: StopRecord = {
				kind: settled.some((item) => item.outcome === "not-proven")
					? "failed"
					: "interrupted",
				requestedAt,
				completedAt,
				requestedBy: "maestro",
				reason,
				outcome: settled.some((item) => item.outcome === "forced")
					? "escalated-kill"
					: settled.some((item) => item.outcome === "not-proven")
						? "timed-out"
						: "accepted",
				recoverable: true,
			};
			const hints = fleet.map(({ agentKey, session, generation }) =>
				this.buildStopHint(agentKey, session, generation),
			);
			const result = {
				stop,
				agents: settled,
				hints,
			} satisfies ExecutionStopResult;
			this.persistStopResult(result);
			this.stopResult = result;
			return result;
		});
		return this.stopPromise;
	}

	private buildStopHint(
		agentKey: string,
		session: string,
		generation: number,
	): ExecutionStopHint {
		const [deliverableId, agentNamePart] = agentKey.split("/");
		const deliverable = deliverableId
			? findDeliverable(this.engine.get(), deliverableId)
			: null;
		const workspace = deliverable?.worktreePath;
		const head = workspace
			? runCommand("git", ["rev-parse", "HEAD"], { cwd: workspace })
			: undefined;
		const children = this.childProjections
			.list()
			.filter(
				(record) =>
					record.ownerId === agentKey &&
					record.ownerGeneration === generation &&
					!["succeeded", "failed", "stopped", "canceled", "timed-out"].includes(
						record.projection.status,
					),
			)
			.map((record) => record.projection.runId as string);
		const state = deliverableId
			? this.executor.getStates().get(deliverableId)
			: undefined;
		const agentStatus = agentNamePart
			? state?.agents.get(agentNamePart)?.status
			: undefined;
		const pendingStages: string[] = [
			...(state?.blocked ? [`blocked:${state.blocked}`] : []),
			...(agentStatus ? [agentStatus] : []),
		];
		return {
			agentKey,
			generation,
			session,
			...(workspace ? { workspace } : {}),
			...(deliverable?.branch ? { branch: deliverable.branch } : {}),
			...(head?.ok && head.stdout.trim() ? { head: head.stdout.trim() } : {}),
			usageRevision: this.tokenSnapshots.get(agentKey)?.turns ?? 0,
			children,
			pendingStages,
		};
	}

	private persistStopResult(result: ExecutionStopResult): void {
		const path = join(this.opts.planDir, "execution-stop.json");
		mkdirSync(this.opts.planDir, { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ version: 1, ...result }, null, 2));
		renameSync(tmp, path);
	}

	async destroy(): Promise<void> {
		await this.prepareStop("execution adapter destroyed");
		return this.withLifecycle(async () => {
			for (const pending of this.childControls.values()) {
				clearTimeout(pending.timer);
			}
			this.childControls.clear();
			this.router.dispose();
			await this.rpcServer.close();
		});
	}

	/** Where a session's dying screen is captured (see buildSpawnSpec). */
	private crashFileFor(sessionName: string): string {
		return join(this.opts.planDir, "crashes", `${sessionName}.log`);
	}

	/** The captured final screen of a dead session, ANSI-stripped and clipped. */
	private readCrashTail(sessionName: string): string | undefined {
		try {
			const raw = readFileSync(this.crashFileFor(sessionName), "utf-8");
			const text = raw
				// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes
				.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
				.trim();
			return text ? text.slice(-600) : undefined;
		} catch {
			return undefined;
		}
	}

	// --- Poll timer: detect dead sessions ---

	private async pollSessions(): Promise<void> {
		// Set before joining the lifecycle queue so concurrent interval/manual
		// calls skip rather than queue a duplicate sweep behind the first.
		if (this.pollInFlight) return;
		this.pollInFlight = true;
		try {
			await this.withLifecycle(() => this.pollSessionsLocked());
		} finally {
			this.pollInFlight = false;
		}
	}

	private async pollSessionsLocked(): Promise<void> {
		try {
			for (const [agentKey, sessionName] of this.sessionNames) {
				const [deliverableId, agentNamePart] = agentKey.split("/");
				if (!deliverableId || !agentNamePart) continue;
				if (this.restarting.has(deliverableId)) continue;

				// Skip agents already done, mid-summarize (session torn down
				// deliberately — not a crash), or FAILED: a crash-capped agent's
				// session stays gone, and re-entering the fail branch every 5s
				// re-failed/re-blocked/re-carded the same agent forever.
				const states = this.executor.getStates();
				const deliverableState = states.get(deliverableId);
				if (!deliverableState) continue;
				const agentState = deliverableState.agents.get(agentNamePart);
				if (agentState?.sessionId !== sessionName) continue;
				if (
					!agentState ||
					agentState.status === "done" ||
					agentState.status === "summarizing" ||
					agentState.status === "failed"
				) {
					continue;
				}

				try {
					// Check if tmux session is still alive
					if (await this.tmux.hasSession(sessionName)) {
						// Re-feed idle gates: agents report idle once per turn end,
						// but sustained-idle gates (reviewer done, zero-task worker,
						// stuck-steer) need repeated observations to fire.
						if (
							this.lastRpcStatus.get(agentKey) === "idle" &&
							agentState.status === "working"
						) {
							this.evaluateIdle(agentKey, deliverableId, agentNamePart);
						}
						continue;
					}

					// Session died — attempt respawn or mark done
					const count = this.respawnCount.get(agentKey) ?? 0;
					const deliverable = this.engine
						.get()
						.deliverables.find((g) => g.id === deliverableId);
					const hasRemainingTasks =
						deliverable?.tasks.some((t) => t.kind === "task" && !t.done) ??
						false;

					if (hasRemainingTasks && count < 2) {
						// Respawn: rebuild session and try again
						this.respawnCount.set(agentKey, count + 1);
						const lastOutput = this.readCrashTail(sessionName);
						this.logEvent("crash-respawn", {
							agent: agentKey,
							attempt: count + 1,
							...(lastOutput ? { lastOutput } : {}),
						});
						try {
							await this.executor.respawnAgent(deliverableId, agentNamePart);
						} catch {
							// Respawn failed — mark done
							this.completeAgent(deliverableId, agentNamePart);
						}
					} else if (!hasRemainingTasks) {
						// Work finished and the session is gone — legit completion.
						this.completeAgent(deliverableId, agentNamePart);
					} else {
						// Respawn cap with tasks outstanding: a crash, not a
						// completion. Fail the agent ONCE and block the deliverable —
						// dropping the session from the poll map guarantees this
						// branch can't re-fire on the next interval.
						this.sessionNames.delete(agentKey);
						const lastOutput = this.readCrashTail(sessionName);
						this.executor.markAgentFailed(
							deliverableId,
							agentNamePart,
							"crashed and exhausted respawn attempts",
						);
						this.executor.blockDeliverable(
							deliverableId,
							`agent ${agentNamePart} crashed repeatedly — see ${this.crashFileFor(sessionName)}, then /recover ${deliverableId}`,
						);
						this.logEvent("failed", {
							agent: agentKey,
							respawns: count,
							...(lastOutput ? { lastOutput } : {}),
						});
						this.emitEvent({
							kind: "failed",
							agentKey,
							deliverableTitle: this.deliverableTitle(deliverableId),
							respawns: count,
						});
					}
				} catch (e) {
					// One agent's tmux race must not abort the sweep or leak an
					// unhandled rejection out of the interval callback.
					this.logEvent("error", {
						scope: "pollSessions",
						agent: agentKey,
						message: e instanceof Error ? e.message : String(e),
					});
				}
			}
		} finally {
			// pollSessions owns the overlap flag outside the lifecycle queue.
		}
	}

	// --- Cache-efficiency surfacing ---

	/**
	 * The agent's prompt-cache class: full-mode and read-only agents have
	 * distinct tool sets (two cache classes); agents of the same class share a
	 * byte-identical prefix and should hit each other's warm cache.
	 */
	private agentToolClass(agentKey: string): "full" | "read-only" {
		const [deliverableId, name] = agentKey.split("/");
		const deliverable = this.engine
			.get()
			.deliverables.find((g) => g.id === deliverableId);
		if (!deliverable) return "full";
		const mode =
			name === "worker"
				? deliverable.worker.mode
				: (deliverable.agents.find((a) => a.name === name)?.mode ??
					"read-only");
		return mode === "read-only" ? "read-only" : "full";
	}

	/**
	 * On an agent's FIRST tokens message, record its cache-read ratio
	 * (cacheRead / (cacheRead + input)). When the ratio is low but a warm
	 * prefix was expected — another agent of the same tool class started
	 * within {@link CACHE_WARM_WINDOW_MS} — log a `cache-miss` event.
	 * Observability only: never throws.
	 */
	private recordFirstTurnPrefixCache(
		agentKey: string,
		snap: TokenSnapshot,
	): void {
		try {
			if (this.tokenSnapshots.has(agentKey)) return;
			const toolClass = this.agentToolClass(agentKey);
			const now = Date.now();

			// Most recent same-class first-tokens arrival inside the warm window.
			let warmPeer: { key: string; at: number } | undefined;
			for (const [key, seen] of this.firstTokensSeen) {
				if (key === agentKey || seen.toolClass !== toolClass) continue;
				if (now - seen.at > CACHE_WARM_WINDOW_MS) continue;
				if (!warmPeer || seen.at > warmPeer.at) {
					warmPeer = { key, at: seen.at };
				}
			}
			this.firstTokensSeen.set(agentKey, { at: now, toolClass });

			const denominator = snap.cacheRead + snap.input;
			if (denominator <= 0) return;
			const ratio = snap.cacheRead / denominator;
			this.firstTurnPrefixCacheHitRate.set(agentKey, ratio);

			if (ratio < CACHE_MISS_RATIO_THRESHOLD && warmPeer) {
				this.logEvent("cache-miss", {
					agentKey,
					class: toolClass,
					expectedWarmBecause: `same-class agent ${warmPeer.key} received first tokens ${Math.round((now - warmPeer.at) / 1000)}s ago`,
					ratio,
					input: snap.input,
					cacheRead: snap.cacheRead,
				});
			}
		} catch {
			// Observability only — never let cache accounting break execution.
		}
	}

	// --- Event log ---

	/** Deliverable title for user-facing events; falls back to the id. */
	private deliverableTitle(deliverableId: string): string {
		return (
			this.engine.get().deliverables.find((g) => g.id === deliverableId)
				?.title ?? deliverableId
		);
	}

	/** Mirror a rich lifecycle event to the UI. Observability only. */
	private emitEvent(event: ExecutionEvent): void {
		try {
			this.opts.onEvent?.(event);
		} catch {
			// A UI listener failure must never break execution.
		}
	}

	/** Append one JSON line per lifecycle event to <planDir>/events.jsonl. */
	private logEvent(event: string, data: Record<string, unknown> = {}): void {
		try {
			mkdirSync(this.opts.planDir, { recursive: true });
			appendFileSync(
				join(this.opts.planDir, "events.jsonl"),
				`${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`,
			);
		} catch {
			// Observability only — never let logging break execution.
		}
	}

	/** Diff executor deliverable state and log blocked-transition events. */
	private recordDeliverableTransitions(): void {
		for (const [deliverableId, state] of this.executor.getStates()) {
			if (state.blocked && !this.blockedLogged.has(deliverableId)) {
				this.logEvent("blocked", {
					deliverable: deliverableId,
					reason: state.blocked,
				});
				this.blockedLogged.add(deliverableId);
				this.emitEvent({
					kind: "blocked",
					deliverableId,
					deliverableTitle: this.deliverableTitle(deliverableId),
					reason: state.blocked,
				});
			} else if (!state.blocked) {
				this.blockedLogged.delete(deliverableId);
			}
		}
	}

	/**
	 * The frozen knowledge doc's content (its Research Index tells us which
	 * refs the base already covers), or undefined when absent or invalid —
	 * then ALL on-disk reports count as post-freeze and ride the seed.
	 */
	private readKnowledgeContent(path: string): string | undefined {
		if (!existsSync(path)) return undefined;
		try {
			return readKnowledgeSession(path).content;
		} catch {
			return undefined;
		}
	}

	/**
	 * Stored summaries feeding buildSeed: completed dep deliverables' deliverable
	 * summaries plus summaries of siblings that already finished in this deliverable
	 * (e.g. the worker's summary seeding its reviewers).
	 */
	private collectSeedSummaries(deliverableId: string): SeedSummaries {
		const plan = this.engine.get();
		const deliverable = plan.deliverables.find((g) => g.id === deliverableId);

		const deliverables = new Map<string, string>();
		for (const depId of deliverable?.dependsOn ?? []) {
			const dep = plan.deliverables.find((g) => g.id === depId);
			// The worker-authored downstream handoff is the intended seed; the
			// combined agent summary remains the fallback for pre-handoff plans.
			const handoff = dep?.handoff ?? dep?.summary;
			if (handoff) deliverables.set(depId, handoff);
		}

		const agents = new Map<string, string>();
		const deliverableState = this.executor.getStates().get(deliverableId);
		if (deliverableState) {
			for (const [name, state] of deliverableState.agents) {
				if (state.status === "done" && state.summary) {
					agents.set(name, state.summary);
				}
			}
		}

		return { deliverables, agents };
	}
}

// --- Plan rendering for agents ---

/**
 * Render a filtered plan view for an agent, scoped to its deliverable.
 * Shows deliverable title, body, tasks (with done status), and dep summaries.
 */
export function renderPlanForAgent(
	engine: PlanEngine,
	deliverableId: string,
): string {
	const plan = engine.get();
	const deliverable = plan.deliverables.find((g) => g.id === deliverableId);
	if (!deliverable) return "(deliverable not found)";

	const lines: string[] = [];
	lines.push(`# ${deliverable.title}`);
	lines.push("");
	if (deliverable.body) {
		lines.push(deliverable.body);
		lines.push("");
	}

	// Dependency summaries
	if (deliverable.dependsOn?.length) {
		for (const depId of deliverable.dependsOn) {
			const dep = plan.deliverables.find((g) => g.id === depId);
			if (dep?.summary) {
				lines.push(`## Dependency: ${dep.title}`);
				lines.push(dep.summary);
				lines.push("");
			}
		}
	}

	// Tasks
	lines.push("## Tasks");
	lines.push("");
	for (const task of deliverable.tasks) {
		const check = task.done ? "x" : " ";
		const kindTag = task.kind !== "task" ? ` _(${task.kind})_` : "";
		lines.push(
			`- [${check}] **${task.title}** (task id: \`${task.id}\`)${kindTag}`,
		);
		if (task.body) {
			lines.push(`  ${task.body.split("\n").join("\n  ")}`);
		}
	}

	return lines.join("\n");
}

/** Pull plain text out of an assistant message's content blocks. */
function extractAssistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (typeof block === "string") return block;
			if (
				block &&
				typeof block === "object" &&
				(block as { type?: string }).type === "text"
			) {
				return (block as { text?: string }).text ?? "";
			}
			return "";
		})
		.filter((s) => s.length > 0)
		.join("\n");
}
