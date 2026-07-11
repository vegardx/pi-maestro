// Execution adapter: wraps DeliverableExecutor with real tmux+RPC spawning.
// Creates tmux sessions running `pi` for each agent, connected via RPC.

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Answers, ThinkingLevel } from "@vegardx/pi-contracts";
import { detectDefaultBranch } from "@vegardx/pi-git";
import { getModelMeta } from "@vegardx/pi-models";
import {
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
} from "../deliverable-executor.js";
import type { PlanEngine } from "../engine.js";
import { requiredGateSatisfied } from "../panel.js";
import { QuestionQueue } from "../question-queue.js";
import {
	deliverableWorkspace,
	repoFor,
	SUMMARY_TOKEN_BUDGET,
} from "../schema.js";
import { resolveSpawnModelSafe } from "../spawn-model.js";
import {
	commitPolicyInstruction,
	detectCommitPolicy,
} from "./commit-policy.js";
import {
	buildAgentSessionFile,
	buildSpawnSpec,
	defaultAgentDir,
	type ProvisionEnvironmentOpts,
	provisionEnvironment,
	provisionWorktree,
} from "./provisioner.js";
import { createRpcRouter, type RpcRouter } from "./rpc-router.js";
import { buildSeed, type SeedSummaries, truncateSummary } from "./seeds.js";
import { shipDeliverable as shipDeliverableReal } from "./shipper.js";

/**
 * Consecutive idle reports after which an agent with no task-based completion
 * signal (read-only reviewers; workers of zero-gating-task deliverables) is
 * considered done. Interactive pi never exits on its own, so sustained idle
 * is the only completion signal these agents produce.
 */
const IDLE_DONE_THRESHOLD = 2;
/** How long an in-flight review round may defer worker completion before we
 *  assume the round died with its reviewers. */
const REVIEW_IN_FLIGHT_TIMEOUT_MS = 15 * 60_000;
/** After steering "run review now", how long completion stays deferred. A
 *  worker that still never reviews then completes into the ship gate, which
 *  blocks visibly — better than hanging the deliverable forever. */
const REVIEW_STEER_GRACE_MS = 10 * 60_000;

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
		{ model: string; adaptive: boolean }
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
	/** Last ship-gate block reason surfaced per deliverable (dedupe). */
	private gateBlockSurfaced = new Map<string, string>();
	private blockedLogged = new Set<string>(); // deliverableIds with a logged blocked event
	private tickChain: Promise<void> = Promise.resolve(); // tick mutex
	private pollInFlight = false; // skip overlapping pollSessions runs

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
		this.rpcServer = new MaestroRpcServer();
		this.router = createRpcRouter({
			server: this.rpcServer,
			token: this.token,
			handlers: {
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
						tokens: {
							input: msg.snapshot.input,
							output: msg.snapshot.output,
							turns: msg.snapshot.turns,
						},
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
					this.router.send(agentId, {
						type: "panelReadResponse",
						id: msg.id,
						panel,
					});
				},
				panelVerdict: (_agentId, msg) => {
					// Latest round per deliverable drives the executor ship gate.
					this.reviewInFlight.delete(msg.deliverableId);
					this.panelVerdicts.set(msg.deliverableId, msg);
					this.opts.onPanelVerdict?.(msg);
				},
				questions: (agentId, msg) => {
					const [deliverableId, agentNamePart] = agentId.split("/");
					if (!deliverableId || !agentNamePart) return;
					this.handleQuestions(agentId, deliverableId, agentNamePart, msg);
				},
			},
			onDisconnect: (agentId) => {
				this.idleCount.delete(agentId);
				// A respawned worker starts a fresh review episode — a stale steer
				// stamp must not let it complete through the grace period.
				this.reviewSteerAt.delete(agentId);
				// A dead agent can never consume answers — drop its pending
				// question so /answer doesn't offer a phantom entry.
				this.questionQueue.drop(agentId);
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
					const seed = buildSeed({
						plan: this.engine.get(),
						deliverable,
						agentName: spawnOpts.agentName,
						summaries: this.collectSeedSummaries(spawnOpts.deliverableId),
						...(policyNote ? { policyNote } : {}),
					});

					// Build session file (JSONL): fork the plan's frozen knowledge
					// session when it exists (shared cache prefix), then append
					// modes state + seed.
					const knowledgeSessionPath = join(
						this.opts.planDir,
						"base-knowledge.jsonl",
					);
					const session = buildAgentSessionFile({
						agentKey,
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

				// Model plumbing: the worker runs on the `work` tier. When work
				// tracks the session model (the common case) we session-pin (no
				// --model, cache-warm); when it's pinned to a distinct model we
				// pass --model + effort. Reviewers use the headless subagent path,
				// not this one.
				const sessionModelId = this.opts.ctx.model
					? `${this.opts.ctx.model.provider}/${this.opts.ctx.model.id}`
					: undefined;
				let modelOverride: string | undefined;
				let thinkingOverride: string | undefined;
				const resolvedWork = await resolveSpawnModelSafe(this.opts.ctx, {
					tier: "work",
					effort: spawnOpts.effort as ThinkingLevel | undefined,
				});
				if (resolvedWork && resolvedWork.modelId !== sessionModelId) {
					modelOverride = resolvedWork.modelId;
					thinkingOverride =
						resolvedWork.effort ?? (spawnOpts.effort || undefined);
				}
				const displayModelId = modelOverride ?? sessionModelId;
				if (displayModelId) {
					const meta = getModelMeta(this.opts.ctx, displayModelId);
					this.agentModelMeta.set(agentKey, {
						model: meta.shortName,
						adaptive: meta.adaptive,
					});
				}

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
						agentDir,
						sessionDir: agentSessionDir,
						token: this.token,
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
						this.engine.updateDeliverable(spawnOpts.deliverableId, {
							sessionPath: sessionFile,
							sessionName,
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
					tokens: { input: 0, output: 0, turns: 0 },
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

			now: () => new Date().toISOString(),
		};

		this.executor = new DeliverableExecutor(this.engine, deps);
	}

	/**
	 * The ship gate for a deliverable: every REQUIRED review in its panel (per
	 * the plan) must have an approving verdict in the latest reported round. No
	 * verdict yet → not satisfied (blocks ship, stays retryable). A deliverable
	 * with no required reviewers is always satisfied.
	 */
	deliverableGateSatisfied(deliverableId: string): boolean {
		return requiredGateSatisfied(
			this.requiredReviewerNames(deliverableId),
			this.panelVerdicts.get(deliverableId)?.verdicts,
		);
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

	/** Required reviewers currently holding the gate (changes or no verdict). */
	failingRequiredReviewers(deliverableId: string): string[] {
		const required = this.requiredReviewerNames(deliverableId);
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
		// process, but /verify must keep honoring the human's acceptance.
		try {
			this.engine.addWaiver(deliverableId, { reviewer, reason });
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
			// The spawn seam already emitted the agent-state event; just re-arm
			// the gate question and record the decision.
			this.gateBlockSurfaced.delete(deliverableId);
			this.logEvent("send-back", { deliverableId });
		}
		return ok;
	}

	private deliverableGateDetail(deliverableId: string): string {
		const required = this.requiredReviewerNames(deliverableId);
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
		const run = this.tickChain.then(() => this.tickOnce());
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

	// --- RPC handlers (dispatched by the router; see constructor table) ---

	private handleStatus(
		agentId: string,
		deliverableId: string,
		agentNamePart: string,
		status: "working" | "idle" | "error",
	): void {
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
	 * Whether the worker may complete now, review-wise. Two rules close the
	 * kill-mid-review hole (a worker that toggled its last task and then called
	 * `review` used to be summarized/killed before the round returned — the
	 * verdicts never arrived and the gate blocked "not yet reviewed" with
	 * nothing to show the human):
	 *   1. an in-flight review round defers completion until it reports;
	 *   2. a deliverable with REQUIRED reviewers and no recorded round steers
	 *      the worker to run `review` instead of completing it. Completion
	 *      resumes after a grace period so a non-compliant worker still lands
	 *      at the visible ship gate rather than hanging forever.
	 */
	private workerMayComplete(agentId: string, deliverableId: string): boolean {
		const startedAt = this.reviewInFlight.get(deliverableId);
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
		if (this.panelVerdicts.has(deliverableId)) return true;
		const steeredAt = this.reviewSteerAt.get(agentId);
		if (steeredAt === undefined) {
			this.reviewSteerAt.set(agentId, Date.now());
			this.router.send(agentId, {
				type: "steer",
				content:
					"All tasks are toggled, but this deliverable's REQUIRED review " +
					"panel has not reported a round. Call the `review` tool now, " +
					"address any blocking findings, and re-run it until the required " +
					"reviewers approve. Do not stop before the panel has reported.",
			});
			this.logEvent("review-steer", { agent: agentId });
			return false;
		}
		return Date.now() - steeredAt > REVIEW_STEER_GRACE_MS;
	}

	/**
	 * Fire-and-forget completion: finishAgent → plan refresh → tick, with
	 * rejection safety — a summarize/kill race must never crash the maestro.
	 */
	private completeAgent(deliverableId: string, name: string): void {
		this.finishAgent(deliverableId, name).then(
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
		// Capture live bookkeeping now — markAgentDone kills the session, which
		// prunes tokenSnapshots (see killSession) before the event is emitted.
		const tokens = this.tokenSnapshots.get(agentKey);
		const cacheRatio = this.firstTurnCacheRatio.get(agentKey);
		const spawnedAt = this.spawnTimes.get(agentKey);
		if (firstCompletion) {
			this.logEvent("done", { agent: agentKey });
		}
		await this.executor.markAgentDone(deliverableId, name);
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
		const deliverableId = msg.deliverableId;
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

	/**
	 * Resolve a user-facing target to a tmux session name. Accepts a full
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
		await this.finishAgent(deliverableId, name);
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
		this.router.dispose();
		this.rpcServer.close();
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
		// Overlap guard: a slow run (respawns, kill waits) must finish before
		// the next interval fire starts inspecting the same agents.
		if (this.pollInFlight) return;
		this.pollInFlight = true;
		try {
			for (const [agentKey, sessionName] of this.sessionNames) {
				const [deliverableId, agentNamePart] = agentKey.split("/");
				if (!deliverableId || !agentNamePart) continue;

				// Skip agents already done, mid-summarize (session torn down
				// deliberately — not a crash), or FAILED: a crash-capped agent's
				// session stays gone, and re-entering the fail branch every 5s
				// re-failed/re-blocked/re-carded the same agent forever.
				const states = this.executor.getStates();
				const deliverableState = states.get(deliverableId);
				if (!deliverableState) continue;
				const agentState = deliverableState.agents.get(agentNamePart);
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
			this.pollInFlight = false;
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
