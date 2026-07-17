// Execution adapter: wraps DeliverableExecutor with real tmux+RPC spawning.
// Creates tmux sessions running `pi` for each agent, connected via RPC.

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	Answers,
	InterruptResult,
	RunId,
	ThinkingLevel,
} from "@vegardx/pi-contracts";
import { detectDefaultBranch, runCommand } from "@vegardx/pi-git";
import { getModelMeta } from "@vegardx/pi-models";
import {
	type ChildRunControlResultMessage,
	type ChildRunSyncMessage,
	type DebugProposalMessage,
	type DebugResultMessage,
	MaestroRpcServer,
	type PanelVerdictMessage,
	type PlanMutateMessage,
	type PlanReadMessage,
	type QuestionsMessage,
	type TokenSnapshot,
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
import { PANEL_HARD_TIMEOUT_MS, requiredGateSatisfied } from "../panel.js";
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
import {
	ledgerSummary,
	openBlocking,
	openDisputed,
	type ReviewLedger,
} from "./findings.js";
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
/** How long an in-flight review round may defer worker completion before we
 *  assume the round died with its reviewers. DERIVED from the ONE panel
 *  deadline: reviewers run concurrently and exactly once (no retries), so a
 *  legitimate round settles within PANEL_HARD_TIMEOUT_MS — the margin covers
 *  result plumbing and cleanup. A guard shorter than a legitimate round
 *  reopens the kill-mid-review hole; the old retry-sized guard (2× cap)
 *  hung dead rounds for ~25 minutes. */
const REVIEW_CLEANUP_MARGIN_MS = 2 * 60_000;
const REVIEW_IN_FLIGHT_TIMEOUT_MS =
	PANEL_HARD_TIMEOUT_MS + REVIEW_CLEANUP_MARGIN_MS;
/** After steering "run review now", how long completion stays deferred. A
 *  worker that still never reviews then completes into the ship gate, which
 *  blocks visibly — better than hanging the deliverable forever. */
const REVIEW_STEER_GRACE_MS = 10 * 60_000;
/** Fix+verify cycle budget when the deliverable doesn't set maxFixRounds. */
const DEFAULT_MAX_FIX_ROUNDS = 3;
/** Protected fixing window after each fix-cycle steer. The worker re-arms
 *  stronger protection the moment it re-enters review (reviewInFlight). */
const FIX_CYCLE_GRACE_MS = 15 * 60_000;

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
			cacheRatio?: number;
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
	/** Restart kill barrier timing (shortened in tests). */
	restartKillTimeoutMs?: number;
	restartPollMs?: number;
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
			tokens: TokenSnapshot;
		},
	) => void;
	onChildProjection?: (
		ownerId: string,
		ownerGeneration: number,
		projection: import("@vegardx/pi-contracts").ChildRunProjection,
	) => void;
	onQuestionsReceived?: (id: string, count: number) => void;
	onAllSettled?: () => void;
	/** Rich lifecycle events for the chat progress cards. */
	onEvent?: (event: ExecutionEvent) => void;
	/** A worker reported a completed review-panel round (drives the gate). */
	onPanelVerdict?: (msg: PanelVerdictMessage) => void;
	/**
	 * A deliverable just transitioned into a ship-gate block (worker done,
	 * required verdicts unsatisfied). Fired once per distinct reason — the
	 * runtime turns it into a decision question for the human.
	 */
	onShipGateBlocked?: (deliverableId: string, reason: string) => void;
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
	private respawnCount = new Map<string, number>(); // agentKey → respawn attempts
	private provisionedWorktrees = new Set<string>(); // env setup ran already
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private settledAnnounced = false;
	private tokenSnapshots = new Map<string, TokenSnapshot>(); // agentKey → latest tokens
	private firstTurnCacheRatio = new Map<string, number>(); // agentKey → first-turn cacheRead ratio
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
	private panelVerdicts = new Map<string, PanelVerdictMessage>(); // deliverableId → latest round
	/**
	 * deliverableId → epoch ms a worker began a review round (panelRead with a
	 * non-empty panel). Cleared by panelVerdict. While fresh, worker completion
	 * is deferred — summarize/kill during an in-flight round is how verdicts
	 * silently vanished (review tool call with no result, gate blocked
	 * "not yet reviewed", human overrode blind).
	 */
	private reviewInFlight = new Map<string, number>();
	/** agentKey → epoch ms of the run-your-review steer (sent once). */
	private reviewSteerAt = new Map<string, number>();
	/**
	 * deliverableId → epoch ms of the targeted repair steer: when the gate is
	 * held ONLY by required reviewers that never reported (no open findings),
	 * the worker is steered once to review({action:"repair"}) — never sent
	 * back for rework it doesn't have. After the grace window it completes
	 * into the visible gate, where triage/human own it.
	 */
	private repairSteerAt = new Map<string, number>();
	/**
	 * deliverableId → the fix-cycle steer sent for a failing gate: one steer
	 * per ledger cycle, then a grace window, then the visible ship gate.
	 * Cleared on send-back (fresh rework episode).
	 */
	private fixSteer = new Map<string, { cycle: number; at: number }>();
	/** Last ship-gate block reason surfaced per deliverable (dedupe). */
	private gateBlockSurfaced = new Map<string, string>();
	private blockedLogged = new Set<string>(); // deliverableIds with a logged blocked event
	private tickChain: Promise<void> = Promise.resolve(); // tick mutex
	private pollInFlight = false; // skip overlapping pollSessions runs
	/** All spawn/kill/poll/completion/restart/shutdown transitions serialize here. */
	private lifecycleTail: Promise<void> = Promise.resolve();
	private restarting = new Set<string>();
	private childProjections: ChildProjectionStore;
	private childControls = new Map<
		string,
		{
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
					this.recordFirstTurnCache(agentId, msg.snapshot);
					this.tokenSnapshots.set(agentId, msg.snapshot);
					this.opts.onAgentStateChanged?.(agentId, {
						status: "working",
						tokens: msg.snapshot,
					});
				},
				planMutate: (agentId, msg) => this.handlePlanMutate(agentId, msg),
				planRead: (agentId, msg) => this.handlePlanRead(agentId, msg),
				panelRead: (agentId, msg) => {
					// The worker's review panel = its deliverable's subAgents, live
					// from the plan (edits mid-flight take effect on the next read).
					const deliverable = this.engine
						.get()
						.deliverables.find((d) => d.id === msg.deliverableId);
					const panel = deliverable?.subAgents ?? [];
					// Reading a non-empty panel is how a review round starts — hold
					// worker completion until the round reports (panelVerdict).
					if (panel.length > 0) {
						this.reviewInFlight.set(msg.deliverableId, Date.now());
					}
					// A respawned worker rehydrates its episode from the persisted
					// ledger; waived finding ids are excluded from its gate math.
					const waived = (deliverable?.waivers ?? []).flatMap((w) =>
						w.findingId ? [w.findingId] : [],
					);
					this.router.send(agentId, {
						type: "panelReadResponse",
						id: msg.id,
						panel,
						...(deliverable?.reviewLedger
							? { ledger: deliverable.reviewLedger }
							: {}),
						...(waived.length > 0 ? { waivedFindingIds: waived } : {}),
					});
				},
				panelVerdict: (_agentId, msg) => {
					// A round-STARTED marker: no verdicts exist yet — the worker is
					// persisting its in-flight round (ledger.pendingRound) so a
					// respawn reattaches instead of duplicating the round. Arm the
					// completion-deferral window here too (panelRead arming stays —
					// it also covers workers that never send this) and persist the
					// marker WITHOUT touching the last real round's verdict cache.
					if (msg.roundKind === "round-started") {
						this.reviewInFlight.set(msg.deliverableId, Date.now());
						this.persistReportedLedger(msg.deliverableId, msg.ledger);
						return;
					}
					// Latest round per deliverable drives the executor ship gate.
					this.reviewInFlight.delete(msg.deliverableId);
					// Verification runs carry no per-reviewer verdicts — keep the
					// last panel round's reports for the human-facing surfaces.
					if (msg.roundKind !== "verification" || msg.verdicts.length > 0) {
						this.panelVerdicts.set(msg.deliverableId, msg);
					}
					this.persistReportedLedger(msg.deliverableId, msg.ledger);
					this.opts.onPanelVerdict?.(msg);
				},
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
			onDisconnect: (agentId) => {
				this.idleCount.delete(agentId);
				// A respawned worker starts a fresh review episode — a stale steer
				// stamp must not let it complete through the grace period.
				this.reviewSteerAt.delete(agentId);
				// A dead agent can never consume answers — drop its pending
				// question so /answer doesn't offer a phantom entry.
				this.questionQueue.drop(agentId);
				for (const [id, pending] of this.childControls) {
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
				const authored = isWorker
					? deliverable.worker
					: deliverable.agents.find((a) => a.name === spawnOpts.agentName);
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
				this.opts.onAgentStateChanged?.(agentKey, {
					status: "working",
					tokens: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: 0,
						turns: 0,
					},
				});

				return { sessionId: sessionName, sessionFile };
			},

			killSession: async (sessionId) => {
				// Graceful first: shutdown over RPC, short grace, then tmux kill.
				const agentKey = this.agentKeyForSession(sessionId);
				if (agentKey) {
					this.router.send(agentKey, {
						type: "shutdown",
						reason: "work complete",
					});
					const deadline = Date.now() + 5000;
					while (
						Date.now() < deadline &&
						(await this.tmux.hasSession(sessionId))
					) {
						await new Promise((r) => setTimeout(r, 250));
					}
				}
				if (await this.tmux.hasSession(sessionId)) {
					try {
						await this.tmux.kill(sessionId);
					} catch {
						// Session vanished between hasSession and kill — already dead.
					}
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
				// Human review overrides are part of the record: name them in the PR.
				const overridden = (
					this.panelVerdicts.get(shipOpts.deliverableId)?.verdicts ?? []
				).filter(
					(v) => (v as { humanOverride?: string }).humanOverride !== undefined,
				);
				if (overridden.length > 0) {
					agentReports.push(
						`### Review overrides\n${overridden
							.map(
								(v) =>
									`- **${v.name}**: approved by human override — ${(v as { humanOverride?: string }).humanOverride}`,
							)
							.join("\n")}`,
					);
				}
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

			panelGate: (deliverableId) =>
				this.deliverableGateSatisfied(deliverableId),
			panelGateDetail: (deliverableId) =>
				this.deliverableGateDetail(deliverableId),

			canActivate: this.opts.canActivate,

			now: () => new Date().toISOString(),
		};

		this.executor = new DeliverableExecutor(this.engine, deps);
	}

	/**
	 * The ship gate for a deliverable. With a review ledger (the redesigned
	 * loop): every required reviewer participated in the panel round AND no
	 * blocking finding is open (unwaived critical/major without a verified
	 * fix). Without one (legacy round): every required reviewer's latest
	 * verdict approves. A deliverable with no required reviewers is always
	 * satisfied; no round at all blocks (stays retryable).
	 */
	deliverableGateSatisfied(deliverableId: string): boolean {
		const required = this.requiredReviewerNames(deliverableId);
		if (required.length === 0) return true;
		const { ledger, waived } = this.ledgerState(deliverableId);
		if (ledger) {
			// A round is still settling — its verdicts are not in yet. The
			// marker ledger may be an empty round-start stub, which must never
			// read as a clear gate.
			if (ledger.pendingRound) return false;
			const participated = ledger.participants
				? required.every((n) =>
						ledger.participants?.some((p) => p.name === n && p.ok),
					)
				: true;
			return participated && openBlocking(ledger, waived).length === 0;
		}
		return requiredGateSatisfied(
			required,
			this.panelVerdicts.get(deliverableId)?.verdicts,
		);
	}

	/**
	 * Persist a reported review ledger on the plan — the gate's source of
	 * truth; it must survive worker respawns and maestro restarts. Shared by
	 * settled rounds and the round-started crash marker.
	 */
	private persistReportedLedger(
		deliverableId: string,
		ledger: PanelVerdictMessage["ledger"],
	): void {
		if (!ledger) return;
		try {
			this.engine.setReviewLedger(
				deliverableId,
				structuredClone(ledger) as ReviewLedger,
			);
			this.opts.onPlanChanged();
		} catch {
			// Unknown deliverable — the verdict cache still applies.
		}
	}

	/** Epoch ms a persisted pending round started (parseable marker only) —
	 *  the review-in-flight signal that survives a maestro restart. */
	private pendingRoundStartMs(deliverableId: string): number | undefined {
		const marker = this.ledgerState(deliverableId).ledger?.pendingRound;
		if (!marker) return undefined;
		const at = Date.parse(marker.startedAt);
		return Number.isFinite(at) ? at : undefined;
	}

	/** The persisted ledger + waived finding ids + cycle budget for a deliverable. */
	private ledgerState(deliverableId: string): {
		ledger?: ReviewLedger;
		waived: Set<string>;
		maxCycles: number;
	} {
		const deliverable = this.engine
			.get()
			.deliverables.find((d) => d.id === deliverableId);
		return {
			...(deliverable?.reviewLedger
				? { ledger: deliverable.reviewLedger }
				: {}),
			waived: new Set(
				(deliverable?.waivers ?? []).flatMap((w) =>
					w.findingId ? [w.findingId] : [],
				),
			),
			maxCycles: deliverable?.maxFixRounds ?? DEFAULT_MAX_FIX_ROUNDS,
		};
	}

	private requiredReviewerNames(deliverableId: string): string[] {
		const deliverable = this.engine
			.get()
			.deliverables.find((d) => d.id === deliverableId);
		return (deliverable?.subAgents ?? [])
			.filter((s) => s.required && (s.kind ?? "review") === "review")
			.map((s) => s.name);
	}

	/**
	 * Why the gate is blocking: which required reviewers have no verdict yet
	 * (never ran, or still running) vs. which returned changes. Drives the
	 * blocked card the maestro/human sees when a completed worker didn't clear
	 * its panel.
	 */
	/** Fire onShipGateBlocked once per new ship-gate reason; re-arm on clear. */
	private surfaceGateBlocks(): void {
		for (const [id, state] of this.executor.getStates()) {
			const reason = state.blocked;
			if (!reason?.startsWith("ship gate:")) {
				this.gateBlockSurfaced.delete(id);
				continue;
			}
			if (this.gateBlockSurfaced.get(id) === reason) continue;
			this.gateBlockSurfaced.set(id, reason);
			this.opts.onShipGateBlocked?.(id, reason);
		}
	}

	/** Latest panel round's verdicts + clipped findings (human decision context). */
	reviewerFindings(deliverableId: string): ReadonlyArray<{
		readonly name: string;
		readonly verdict: string;
		readonly required: boolean;
		readonly report?: string;
	}> {
		return (this.panelVerdicts.get(deliverableId)?.verdicts ?? []).map((v) => ({
			name: v.name,
			verdict: v.verdict,
			required: v.required,
			...(v.report ? { report: v.report } : {}),
		}));
	}

	/**
	 * Who is holding the gate. With a ledger: the distinct reviewers (incl.
	 * verifier regressions) owning open blocking findings, plus required
	 * reviewers that never reported. Legacy: required reviewers whose latest
	 * verdict isn't approve. These names are what a human override waives.
	 */
	failingRequiredReviewers(deliverableId: string): string[] {
		const required = this.requiredReviewerNames(deliverableId);
		const { ledger, waived } = this.ledgerState(deliverableId);
		if (ledger) {
			const holders = new Set(
				openBlocking(ledger, waived).map((e) => e.reviewer),
			);
			for (const n of required) {
				if (
					ledger.participants &&
					!ledger.participants.some((p) => p.name === n && p.ok)
				) {
					holders.add(n);
				}
			}
			return [...holders];
		}
		const byName = new Map(
			(this.panelVerdicts.get(deliverableId)?.verdicts ?? []).map((v) => [
				v.name,
				v.verdict,
			]),
		);
		return required.filter((n) => byName.get(n) !== "approve");
	}

	/**
	 * Record a HUMAN override as a reviewer's latest verdict. The gate opens
	 * through its own rules (latest verdict per required reviewer) — the human
	 * simply becomes the author of a verdict, with provenance that surfaces in
	 * the PR body. Only reachable from the gate-decision answer flow, never
	 * from a model-facing tool.
	 */
	overrideReviewerVerdict(
		deliverableId: string,
		reviewer: string,
		reason: string,
	): void {
		const current = this.panelVerdicts.get(deliverableId);
		const verdicts = [...(current?.verdicts ?? [])];
		const idx = verdicts.findIndex((v) => v.name === reviewer);
		const entry =
			idx >= 0
				? {
						...verdicts[idx],
						verdict: "approve" as const,
						humanOverride: reason,
					}
				: {
						name: reviewer,
						persona: reviewer,
						required: true,
						ok: true,
						verdict: "approve" as const,
						humanOverride: reason,
					};
		if (idx >= 0) verdicts[idx] = entry;
		else verdicts.push(entry);
		const baseMsg: PanelVerdictMessage = current ?? {
			type: "panelVerdict",
			deliverableId,
			round: 0,
			verdicts: [],
		};
		this.panelVerdicts.set(deliverableId, { ...baseMsg, verdicts });
		this.logEvent("human-override", { deliverableId, reviewer, reason });
		// Persist the waiver on the plan — the in-memory verdict dies with this
		// process, but /verify must keep honoring the human's acceptance. With
		// a ledger, the override waives this reviewer's OPEN BLOCKING findings
		// individually (id + claim + file — the claim is the durable identity
		// that crosses into /verify), which is what actually opens the gate.
		try {
			const { ledger, waived } = this.ledgerState(deliverableId);
			const mine = ledger
				? openBlocking(ledger, waived).filter((e) => e.reviewer === reviewer)
				: [];
			if (mine.length > 0) {
				for (const e of mine) {
					this.engine.addWaiver(deliverableId, {
						reviewer,
						reason,
						findingId: e.finding.id,
						claim: e.finding.claim ?? e.finding.actual,
						...(e.finding.file ? { file: e.finding.file } : {}),
					});
				}
			} else {
				this.engine.addWaiver(deliverableId, { reviewer, reason });
			}
			this.opts.onPlanChanged();
		} catch {
			// The override still applies for this session even if the plan write
			// failed; the event log above keeps the audit trail.
		}
	}

	/**
	 * Reopen a gate-blocked deliverable and respawn its worker with the review
	 * findings (the gate-decision "send back" route). The executor resumes the
	 * worker's own session file when it has one — cache-hot, full context of
	 * its earlier pass. Re-arms the gate question: a fresh block after the
	 * rework round asks the human again.
	 */
	async sendBackToWorker(
		deliverableId: string,
		kickoff: string,
	): Promise<boolean> {
		const ok = await this.executor.sendBackToWorker(deliverableId, kickoff);
		if (ok) {
			// Rework epoch: the respawned worker must not inherit exhausted or
			// stale review state — a stale failing round used to re-complete it
			// within seconds of the respawn (sdk-foundation, 16s death loop).
			// The ledger (the work list) stays; the cycle budget and steer
			// bookkeeping reset so the fix loop actually runs.
			this.gateBlockSurfaced.delete(deliverableId);
			this.fixSteer.delete(deliverableId);
			this.reviewInFlight.delete(deliverableId);
			const deliverable = this.engine
				.get()
				.deliverables.find((d) => d.id === deliverableId);
			if (deliverable?.reviewLedger && deliverable.reviewLedger.cycle > 0) {
				try {
					this.engine.setReviewLedger(deliverableId, {
						...deliverable.reviewLedger,
						cycle: 0,
						updatedAt: new Date().toISOString(),
					});
					this.opts.onPlanChanged();
				} catch {
					// Plan write failure — the in-memory resets still apply.
				}
			}
			this.logEvent("send-back", { deliverableId });
		}
		return ok;
	}

	private deliverableGateDetail(deliverableId: string): string {
		const required = this.requiredReviewerNames(deliverableId);
		const { ledger, waived, maxCycles } = this.ledgerState(deliverableId);
		if (ledger) {
			const open = openBlocking(ledger, waived);
			const parts: string[] = [ledgerSummary(ledger, maxCycles, waived)];
			if (open.length > 0) {
				parts.push(`open: ${open.map((e) => e.finding.id).join(", ")}`);
			}
			const missing = ledger.participants
				? required.filter(
						(n) => !ledger.participants?.some((p) => p.name === n && p.ok),
					)
				: [];
			if (missing.length > 0) {
				parts.push(`${missing.join(", ")} never reported`);
			}
			return parts.join(" — ");
		}
		const byName = new Map(
			(this.panelVerdicts.get(deliverableId)?.verdicts ?? []).map((v) => [
				v.name,
				v.verdict,
			]),
		);
		const missing = required.filter((n) => !byName.has(n));
		const failing = required.filter(
			(n) => byName.has(n) && byName.get(n) !== "approve",
		);
		const parts: string[] = [];
		if (failing.length) parts.push(`${failing.join(", ")} requested changes`);
		if (missing.length) parts.push(`${missing.join(", ")} not yet reviewed`);
		return parts.length
			? parts.join("; ")
			: "required review verdicts not satisfied";
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
					const gone = await this.stopAndProveGone(
						`${deliverableId}/worker`,
						oldSession,
						"worker restart",
					);
					if (!gone) {
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
				// Dropping the poll mapping and the crash budget is what breaks
				// the force-exit → auto-respawn loop: pollSessionsLocked iterates
				// sessionNames, and a later /recover gets fresh respawn attempts.
				this.sessionNames.delete(agentKey);
				this.respawnCount.delete(agentKey);
				if (session) {
					const gone = await this.stopAndProveGone(agentKey, session, reason);
					if (!gone) {
						// Session survived the kill barrier: keep watching it and
						// report failure instead of marking a live process pending.
						this.sessionNames.set(agentKey, session);
						return false;
					}
				}
				this.executor.failWorkerReplacement(
					deliverableId,
					`${RESTART_BLOCK_PREFIX} — force-failed (${reason}); /recover respawns it (or /retry ${deliverableId})`,
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
	): Promise<boolean> {
		this.router.send(agentKey, { type: "shutdown", reason });
		const gracefulUntil =
			Date.now() + Math.min(1000, this.opts.restartKillTimeoutMs ?? 5000);
		while (Date.now() < gracefulUntil) {
			if (!(await this.tmux.hasSession(sessionId))) break;
			await new Promise((resolve) =>
				setTimeout(resolve, this.opts.restartPollMs ?? 50),
			);
		}
		if (await this.tmux.hasSession(sessionId)) {
			await this.tmux.kill(sessionId).catch(() => {});
		}
		const deadline = Date.now() + (this.opts.restartKillTimeoutMs ?? 5000);
		while (Date.now() < deadline) {
			if (!(await this.tmux.hasSession(sessionId))) {
				if (this.sessionNames.get(agentKey) === sessionId) {
					this.sessionNames.delete(agentKey);
				}
				return true;
			}
			await new Promise((resolve) =>
				setTimeout(resolve, this.opts.restartPollMs ?? 50),
			);
		}
		return !(await this.tmux.hasSession(sessionId));
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
		const open = g.reviewLedger
			? openBlocking(
					g.reviewLedger,
					new Set(
						(g.waivers ?? []).flatMap((waiver) =>
							waiver.findingId ? [waiver.findingId] : [],
						),
					),
				).map((entry) => `${entry.finding.id}: ${entry.finding.claim}`)
			: [];
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
			"## Review ledger and open findings",
			...(g.reviewLedger
				? [`- cycle ${g.reviewLedger.cycle}, round ${g.reviewLedger.round}`]
				: ["- No review ledger"]),
			...(open.length
				? open.map((finding) => `- ${finding}`)
				: ["- No open blocking findings"]),
			"",
			"## Artifacts",
			...(g.prUrl ? [`- PR: ${g.prUrl}`] : []),
			...(g.previousSessionPaths ?? []).map(
				(path) => `- Previous session: ${path}`,
			),
			...(g.sessionPath ? [`- Replaced session: ${g.sessionPath}`] : []),
			"",
			"Continue only in the assigned workspace. Inspect and preserve existing changes; do not reset, clean, checkout, or create worktrees. Commit as you go, update tasks normally, and satisfy the existing review ledger without rewriting it.",
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
	 * Serialized tick: every entry point (/implement, plan changes, completion
	 * chains, the poll timer) funnels through a promise-chain mutex so the
	 * executor never runs two ticks concurrently.
	 */
	async tick(): Promise<number> {
		const run = this.tickChain.then(() =>
			this.withLifecycle(() => this.tickOnce()),
		);
		this.tickChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async tickOnce(): Promise<number> {
		if (!this._started) return 0;

		const beforeActive = this.engine
			.get()
			.deliverables.filter((g) => g.status === "active").length;

		const shipped = await this.executor.tick();
		this.recordDeliverableTransitions();
		this.surfaceGateBlocks();

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
			this.childControls.set(id, { resolve, timer });
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
	 * Whether the worker may complete now, review-wise. The rules, in order:
	 *   1. an in-flight review/verification run defers completion until it
	 *      reports (window derived from the reviewer timeout);
	 *   2. required reviewers + no round this episode → steer "run review
	 *      now" once, then a grace period;
	 *   3. the gate is SATISFIED (blocking ledger empty / verdicts approve)
	 *      → complete;
	 *   4. the gate is failing → the worker gets protected fix cycles: one
	 *      steer per ledger cycle listing the open finding ids, a grace
	 *      window per steer, budget deliverable.maxFixRounds (default 3);
	 *   5. the gate is held ONLY by required reviewers that never reported →
	 *      one steer to review({action:"repair"}) (a missing reviewer is not
	 *      rework — send-back respawned workers with nothing to fix), then
	 *      the visible gate;
	 *   6. only disputes remain, the budget is exhausted, or a steer's grace
	 *      expired → complete into the VISIBLE ship gate (triage/human own
	 *      it from there). A failing round is never a kill signal by itself
	 *      — that rule turned every request-changes into a dead worker and a
	 *      human question (orchestra run, 2026-07-11).
	 */
	private workerMayComplete(agentId: string, deliverableId: string): boolean {
		// The in-memory window dies with a maestro restart; the persisted
		// pendingRound marker carries the same in-flight signal across it,
		// bounded by the round's OWN start time (elapsed time counts).
		const startedAt =
			this.reviewInFlight.get(deliverableId) ??
			this.pendingRoundStartMs(deliverableId);
		if (startedAt !== undefined) {
			if (Date.now() - startedAt <= REVIEW_IN_FLIGHT_TIMEOUT_MS) return false;
			this.reviewInFlight.delete(deliverableId);
		}
		const deliverable = this.engine
			.get()
			.deliverables.find((g) => g.id === deliverableId);
		const requiredReviews = (deliverable?.subAgents ?? []).filter(
			(s) => (s.kind ?? "review") === "review" && s.required,
		);
		if (requiredReviews.length === 0) return true;

		const { ledger, waived, maxCycles } = this.ledgerState(deliverableId);
		const hasRound = Boolean(ledger) || this.panelVerdicts.has(deliverableId);
		if (!hasRound) {
			const steeredAt = this.reviewSteerAt.get(agentId);
			if (steeredAt === undefined) {
				this.reviewSteerAt.set(agentId, Date.now());
				this.router.send(agentId, {
					type: "steer",
					content:
						"All tasks are toggled, but this deliverable's REQUIRED review " +
						"panel has not reported a round. Call the `review` tool now, " +
						"resolve any blocking findings, and verify your fixes. Do not " +
						"stop before the panel has reported.",
				});
				this.logEvent("review-steer", { agent: agentId });
				return false;
			}
			return Date.now() - steeredAt > REVIEW_STEER_GRACE_MS;
		}

		if (this.deliverableGateSatisfied(deliverableId)) return true;

		// Gate failing. What can the worker still act on?
		let cycle = this.panelVerdicts.get(deliverableId)?.round ?? 1;
		let actionable: string[] | undefined;
		if (ledger) {
			cycle = ledger.cycle;
			const open = openBlocking(ledger, waived);
			const disputed = new Set(
				openDisputed(ledger, waived).map((e) => e.finding.id),
			);
			actionable = open
				.map((e) => e.finding.id)
				.filter((id) => !disputed.has(id));
			if (actionable.length === 0) {
				// No open findings — the gate is held by required reviewers that
				// never reported. That is a review-run failure, not rework:
				// completing here parked the deliverable at triage, whose
				// send-back respawned a worker with nothing to fix, which
				// completed straight back into the same gate (infinite loop).
				// One targeted steer to review({action:"repair"}), a grace
				// window, then the VISIBLE gate — a second failure is a human's
				// call, never an automatic respawn.
				const missing = requiredReviews
					.map((s) => s.name)
					.filter(
						(n) => !ledger.participants?.some((p) => p.name === n && p.ok),
					);
				if (ledger.participants && missing.length > 0) {
					const steeredAt = this.repairSteerAt.get(deliverableId);
					if (steeredAt === undefined) {
						this.repairSteerAt.set(deliverableId, Date.now());
						this.router.send(agentId, {
							type: "steer",
							content:
								`Required reviewer(s) never reported a valid review: ` +
								`${missing.join(", ")}. Do NOT rework the deliverable — ` +
								`run review({action: "repair"}) once to re-run just them. ` +
								`If the repair fails too, stop; the gate escalates to a human.`,
						});
						this.logEvent("repair-steer", {
							agent: agentId,
							missing: missing.join(", "),
						});
						return false;
					}
					return Date.now() - steeredAt > REVIEW_STEER_GRACE_MS;
				}
				// Only disputes remain — nothing left for the worker; the gate
				// surfaces it to triage/human.
				return true;
			}
		}
		if (cycle >= maxCycles) return true;

		const steer = this.fixSteer.get(deliverableId);
		if (!steer || steer.cycle !== cycle) {
			this.fixSteer.set(deliverableId, { cycle, at: Date.now() });
			const what = actionable?.length
				? `Open blocking findings: ${actionable.join(", ")}.`
				: `Holding reviewers: ${this.failingRequiredReviewers(deliverableId).join(", ")}.`;
			this.router.send(agentId, {
				type: "steer",
				content:
					`The review gate is holding this deliverable. ${what} ` +
					`Fix them, commit, and run review({resolutions: [...]}) to verify ` +
					`— fix cycle ${cycle + 1}/${maxCycles}. Dispute a finding only ` +
					`with a code-referencing rationale; wont-fix is for minors only.`,
			});
			this.logEvent("fix-steer", { agent: agentId, cycle: cycle + 1 });
			return false;
		}
		if (Date.now() - steer.at <= FIX_CYCLE_GRACE_MS) return false;
		return true;
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
		const cacheRatio = this.firstTurnCacheRatio.get(agentKey);
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
				...(cacheRatio !== undefined ? { cacheRatio } : {}),
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
					this.engine.toggleWorkItem(deliverableId, taskId);
					this.opts.onPlanChanged();
					this.router.send(agentId, {
						type: "planMutateResult",
						id: msg.id,
						success: true,
						taskId,
					});
					this.checkCompletionGate(agentId, deliverableId);
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
		// Tasks done is not enough: the required review panel must have
		// reported (and no round may be in flight) before the worker is killed.
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
				tokens: { input: number; output: number; turns: number };
				cacheRatio?: number;
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
				tokens: { input: number; output: number; turns: number };
				cacheRatio?: number;
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
				const cacheRatio = this.firstTurnCacheRatio.get(key);
				const meta = this.agentModelMeta.get(key);
				agents.set(key, {
					status: agentState.status,
					startedAt:
						this.spawnTimes.get(key) ??
						(agentState.startedAt
							? Date.parse(agentState.startedAt)
							: Date.now()),
					tokens: tokens
						? {
								input: tokens.input,
								output: tokens.output,
								turns: tokens.turns,
							}
						: { input: 0, output: 0, turns: 0 },
					...(cacheRatio !== undefined ? { cacheRatio } : {}),
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

	async destroy(): Promise<void> {
		return this.withLifecycle(async () => {
			this._started = false;
			if (this.pollTimer) {
				clearInterval(this.pollTimer);
				this.pollTimer = undefined;
			}
			// Kill all tmux sessions
			for (const sessionName of this.sessionNames.values()) {
				if (await this.tmux.hasSession(sessionName)) {
					await this.tmux.kill(sessionName).catch(() => {});
				}
			}
			this.sessionNames.clear();
			for (const pending of this.childControls.values()) {
				clearTimeout(pending.timer);
			}
			this.childControls.clear();
			this.router.dispose();
			this.rpcServer.close();
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
							`agent ${agentNamePart} crashed repeatedly — see ${this.crashFileFor(sessionName)}, then /retry`,
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
	private recordFirstTurnCache(agentKey: string, snap: TokenSnapshot): void {
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
			this.firstTurnCacheRatio.set(agentKey, ratio);

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
			if (dep?.summary) deliverables.set(depId, dep.summary);
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
