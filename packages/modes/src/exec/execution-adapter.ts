// Execution adapter: wraps GroupExecutor with real tmux+RPC spawning.
// Creates tmux sessions running `pi` for each agent, connected via RPC.

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Answers } from "@vegardx/pi-contracts";
import {
	MaestroRpcServer,
	type PlanMutateMessage,
	type PlanReadMessage,
	type QuestionsMessage,
	type TokenSnapshot,
} from "@vegardx/pi-rpc";
import * as realTmux from "@vegardx/pi-tmux";
import { agentName } from "../agent-names.js";
import type { PlanEngine } from "../engine.js";
import { type ExecutorDeps, GroupExecutor } from "../group-executor.js";
import { QuestionQueue } from "../question-queue.js";
import { SUMMARY_TOKEN_BUDGET } from "../schema.js";
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
import { shipGroup as shipGroupReal } from "./shipper.js";

/**
 * Consecutive idle reports after which an agent with no task-based completion
 * signal (read-only reviewers; workers of zero-gating-task groups) is
 * considered done. Interactive pi never exits on its own, so sustained idle
 * is the only completion signal these agents produce.
 */
const IDLE_DONE_THRESHOLD = 2;

/**
 * Window within which a same-tool-class agent's first tokens message makes a
 * warm prompt-cache prefix expected. A first-turn cache-read ratio below
 * {@link CACHE_MISS_RATIO_THRESHOLD} inside this window means the shared
 * knowledge-fork prefix did not hit — logged as a `cache-miss` event.
 */
const CACHE_WARM_WINDOW_MS = 5 * 60_000;
const CACHE_MISS_RATIO_THRESHOLD = 0.5;

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
}

/**
 * ExecutionAdapter wraps GroupExecutor and provides real tmux+RPC execution.
 */
export class ExecutionAdapter {
	private executor: GroupExecutor;
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
	private stuckSteerSent = new Set<string>(); // agentKeys that received a stuck steer
	private respawnCount = new Map<string, number>(); // agentKey → respawn attempts
	private provisionedWorktrees = new Set<string>(); // env setup ran already
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private tokenSnapshots = new Map<string, TokenSnapshot>(); // agentKey → latest tokens
	private firstTurnCacheRatio = new Map<string, number>(); // agentKey → first-turn cacheRead ratio
	private firstTokensSeen = new Map<
		string,
		{ at: number; toolClass: "full" | "read-only" }
	>(); // agentKey → first tokens arrival
	private spawnTimes = new Map<string, number>(); // agentKey → spawn epoch ms
	private lastRounds = new Map<string, number>(); // groupId → last logged fix round
	private blockedLogged = new Set<string>(); // groupIds with a logged blocked event
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
					const [groupId, agentNamePart] = agentId.split("/");
					if (!groupId || !agentNamePart) return;
					this.handleStatus(agentId, groupId, agentNamePart, msg.status);
				},
				done: (agentId, msg) => {
					const [groupId, agentNamePart] = agentId.split("/");
					if (!groupId || !agentNamePart) return;
					this.router.send(agentId, { type: "doneAck", id: msg.id });
					this.handleDone(groupId, agentNamePart);
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
				questions: (agentId, msg) => {
					const [groupId, agentNamePart] = agentId.split("/");
					if (!groupId || !agentNamePart) return;
					this.handleQuestions(agentId, groupId, agentNamePart, msg);
				},
				// Explicit no-op: lens usage feeds the ledger once Wave 4 wires it.
				lensUsage: () => {},
			},
			onDisconnect: (agentId) => {
				this.idleCount.delete(agentId);
				// A dead agent can never consume answers — drop its pending
				// question so /answer doesn't offer a phantom entry.
				this.questionQueue.drop(agentId);
			},
		});

		const deps: ExecutorDeps = {
			spawnAgent: async (spawnOpts) => {
				const sessionName = agentName(spawnOpts.groupId, this.takenNames);
				this.takenNames.add(sessionName);
				const agentKey = `${spawnOpts.groupId}/${spawnOpts.agentName}`;
				this.sessionNames.set(agentKey, sessionName);

				const group = this.engine
					.get()
					.groups.find((g) => g.id === spawnOpts.groupId);
				if (!group) throw new Error(`group ${spawnOpts.groupId} not found`);

				// Determine agent mode
				const isWorker = spawnOpts.agentName === "worker";
				const agentMode = isWorker
					? group.worker.mode
					: (group.agents.find((a) => a.name === spawnOpts.agentName)?.mode ??
						"read-only");

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
					// Deterministic framed seed: Prior Work (dep-group summaries) →
					// Findings from Earlier Review (done siblings) → the assignment.
					const seed = buildSeed({
						plan: this.engine.get(),
						group,
						agentName: spawnOpts.agentName,
						summaries: this.collectSeedSummaries(spawnOpts.groupId),
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
							? "Implement the tasks described in your seed. Commit as you go. Toggle tasks when done."
							: "Review the code and report your findings. Follow the focus instructions in your seed.");
				}
				this.sessionFiles.set(agentKey, sessionFile);

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
				});

				const cols = process.stdout.columns || 200;
				const rows = process.stdout.rows || 50;

				await this.tmux.spawn(spec.sessionName, spec.cwd, spec.command, {
					width: cols,
					height: rows,
					env: spec.env,
				});

				this.spawnTimes.set(agentKey, Date.now());
				this.logEvent("spawn", {
					agent: agentKey,
					session: sessionName,
					resumed: Boolean(spawnOpts.resumeSessionFile),
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
			},

			createWorktree: async (worktreeOpts) => {
				const path = provisionWorktree({
					repoPath: worktreeOpts.repoPath,
					groupId: worktreeOpts.groupId,
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

			shipGroup: async (shipOpts) => {
				const plan = this.engine.get();
				const group = plan.groups.find((g) => g.id === shipOpts.groupId);
				if (!group) throw new Error(`group ${shipOpts.groupId} not found`);
				const groupState = this.executor.getStates().get(shipOpts.groupId);
				const agentReports = groupState
					? [...groupState.agents.values()]
							.filter((a) => a.summary)
							.map(
								(a) =>
									`### ${a.displayName ?? a.name} (${a.name})\n${a.summary}`,
							)
					: [];
				const result = await shipGroupReal({
					plan,
					group,
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

			now: () => new Date().toISOString(),
		};

		this.executor = new GroupExecutor(this.engine, deps);
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
			.groups.filter((g) => g.status === "active").length;

		const shipped = await this.executor.tick();
		this.recordGroupTransitions();

		const afterActive = this.engine
			.get()
			.groups.filter((g) => g.status === "active").length;

		if (shipped.length > 0) {
			for (const groupId of shipped) {
				const g = this.engine.get().groups.find((x) => x.id === groupId);
				this.logEvent("shipped", { group: groupId, prUrl: g?.prUrl });
			}
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

		const newlyActivated = afterActive - beforeActive;
		return Math.max(0, newlyActivated + shipped.length);
	}

	// --- RPC handlers (dispatched by the router; see constructor table) ---

	private handleStatus(
		agentId: string,
		groupId: string,
		agentNamePart: string,
		status: "working" | "idle" | "error",
	): void {
		if (status === "working") {
			this.idleCount.set(agentId, 0);
			this.stuckSteerSent.delete(agentId);
			return;
		}
		if (status === "idle") {
			const count = (this.idleCount.get(agentId) ?? 0) + 1;
			this.idleCount.set(agentId, count);

			const state = this.executor.getAgentState(groupId, agentNamePart);
			if (
				state &&
				(state.status === "summarizing" || state.status === "done")
			) {
				return;
			}

			if (agentNamePart === "worker") {
				// Check if worker completed all tasks
				if (this.executor.isWorkerDone(groupId)) {
					const group = this.engine.get().groups.find((g) => g.id === groupId);
					const gating = group?.tasks.filter((t) => t.kind === "task") ?? [];
					if (gating.length > 0) {
						this.checkCompletionGate(agentId, groupId);
						return;
					}
					// Zero gating tasks: "all toggled" is vacuous, so sustained
					// idling is the worker's only completion signal.
					if (count >= IDLE_DONE_THRESHOLD && state?.status === "working") {
						this.completeAgent(groupId, agentNamePart);
						return;
					}
				}
			} else if (count >= IDLE_DONE_THRESHOLD && state?.status === "working") {
				// Non-worker agents (read-only reviewers) never toggle tasks and
				// interactive pi never exits — sustained idle means they're done.
				// This is what makes the review→fix loop reachable in real runs.
				this.completeAgent(groupId, agentNamePart);
				return;
			}

			// Stuck detection: steer after 5 consecutive idles
			if (count >= 5 && !this.stuckSteerSent.has(agentId)) {
				const group = this.engine.get().groups.find((g) => g.id === groupId);
				if (group) {
					const remaining = group.tasks
						.filter((t) => t.kind === "task" && !t.done)
						.map((t) => t.title);
					if (remaining.length > 0) {
						this.router.send(agentId, {
							type: "steer",
							content: `You seem stuck. Remaining tasks: ${remaining.join(", ")}. Toggle tasks when done, then stop.`,
						});
					}
					this.stuckSteerSent.add(agentId);
				}
			}
		}
	}

	private handleDone(groupId: string, agentNamePart: string): void {
		this.completeAgent(groupId, agentNamePart);
	}

	/**
	 * Fire-and-forget completion: finishAgent → plan refresh → tick, with
	 * rejection safety — a summarize/kill race must never crash the maestro.
	 */
	private completeAgent(groupId: string, name: string): void {
		this.finishAgent(groupId, name).then(
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
				this.executor.markAgentFailed(groupId, name, message);
				this.logEvent("error", { agent: `${groupId}/${name}`, message });
			},
		);
	}

	/** Complete an agent through the executor, logging the lifecycle event. */
	private async finishAgent(groupId: string, name: string): Promise<void> {
		const state = this.executor.getAgentState(groupId, name);
		if (state && state.status !== "done") {
			this.logEvent("done", { agent: `${groupId}/${name}` });
		}
		await this.executor.markAgentDone(groupId, name);
		this.recordGroupTransitions();
	}

	private handlePlanMutate(agentId: string, msg: PlanMutateMessage): void {
		const groupId = msg.groupId;
		const params = msg.params ?? {};

		try {
			switch (msg.action) {
				case "toggleTask": {
					const taskId = params.taskId;
					if (!taskId) throw new Error("taskId required");
					this.engine.toggleWorkItem(groupId, taskId);
					this.opts.onPlanChanged();
					this.router.send(agentId, {
						type: "planMutateResult",
						id: msg.id,
						success: true,
						taskId,
					});
					this.checkCompletionGate(agentId, groupId);
					break;
				}
				case "addTask": {
					const title = params.title;
					if (!title) throw new Error("title required");
					const item = this.engine.addWorkItem(groupId, {
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
					this.engine.updateWorkItem(groupId, taskId, {
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
		const [groupId] = agentId.split("/");
		const content = renderPlanForAgent(this.engine, groupId);
		this.router.send(agentId, {
			type: "planReadResponse",
			id: msg.id,
			content,
		});
	}

	private handleQuestions(
		agentId: string,
		groupId: string,
		agentNamePart: string,
		msg: QuestionsMessage,
	): void {
		const group = this.engine.get().groups.find((g) => g.id === groupId);
		this.questionQueue.enqueue({
			agentId,
			agentName: agentNamePart,
			deliverableTitle: group?.title ?? groupId,
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

	private checkCompletionGate(agentId: string, groupId: string): void {
		const group = this.engine.get().groups.find((g) => g.id === groupId);
		if (!group) return;
		const gating = group.tasks.filter((t) => t.kind === "task");
		if (gating.length === 0) return;
		if (!gating.every((t) => t.done)) return;

		// All gating tasks done — summarize (over the live agent), then shut down.
		// markAgentDone runs requestSummary before killSession; sending a raw
		// shutdown here would kill the agent before it could summarize.
		const agentNamePart = agentId.split("/")[1];
		if (!agentNamePart) return;
		const state = this.executor.getAgentState(groupId, agentNamePart);
		if (state && (state.status === "summarizing" || state.status === "done"))
			return;
		this.completeAgent(groupId, agentNamePart);
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

	steer(groupId: string, guidance: string, agentName = "worker"): boolean {
		const agentKey = `${groupId}/${agentName}`;
		return this.router.send(agentKey, { type: "steer", content: guidance });
	}

	/**
	 * Resolve a user-facing target to a tmux session name. Accepts a full
	 * agent key (`group/agent`), a group id (→ its worker), a bare agent
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
			}
		>;
		groups: Map<string, { round: number; blocked?: string }>;
	} {
		const agents = new Map<
			string,
			{
				status: string;
				startedAt: number;
				tokens: { input: number; output: number; turns: number };
				cacheRatio?: number;
			}
		>();
		const groups = new Map<string, { round: number; blocked?: string }>();
		const states = this.executor.getStates();

		for (const [groupId, groupState] of states) {
			groups.set(groupId, {
				round: groupState.round,
				...(groupState.blocked ? { blocked: groupState.blocked } : {}),
			});
			for (const [name, agentState] of groupState.agents) {
				const key = `${groupId}/${name}`;
				const tokens = this.tokenSnapshots.get(key);
				const cacheRatio = this.firstTurnCacheRatio.get(key);
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
				});
			}
		}

		return { agents, groups };
	}

	async markAgentDone(groupId: string, name: string): Promise<void> {
		await this.finishAgent(groupId, name);
		this.opts.onPlanChanged();
	}

	isWorkerDone(groupId: string): boolean {
		return this.executor.isWorkerDone(groupId);
	}

	getExecutor(): GroupExecutor {
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

	// --- Poll timer: detect dead sessions ---

	private async pollSessions(): Promise<void> {
		// Overlap guard: a slow run (respawns, kill waits) must finish before
		// the next interval fire starts inspecting the same agents.
		if (this.pollInFlight) return;
		this.pollInFlight = true;
		try {
			for (const [agentKey, sessionName] of this.sessionNames) {
				const [groupId, agentNamePart] = agentKey.split("/");
				if (!groupId || !agentNamePart) continue;

				// Skip agents already done or mid-summarize (their session is
				// being torn down deliberately — not a crash).
				const states = this.executor.getStates();
				const groupState = states.get(groupId);
				if (!groupState) continue;
				const agentState = groupState.agents.get(agentNamePart);
				if (
					!agentState ||
					agentState.status === "done" ||
					agentState.status === "summarizing"
				) {
					continue;
				}

				try {
					// Check if tmux session is still alive
					if (await this.tmux.hasSession(sessionName)) continue;

					// Session died — attempt respawn or mark done
					const count = this.respawnCount.get(agentKey) ?? 0;
					const group = this.engine.get().groups.find((g) => g.id === groupId);
					const hasRemainingTasks =
						group?.tasks.some((t) => t.kind === "task" && !t.done) ?? false;

					if (hasRemainingTasks && count < 2) {
						// Respawn: rebuild session and try again
						this.respawnCount.set(agentKey, count + 1);
						this.logEvent("crash-respawn", {
							agent: agentKey,
							attempt: count + 1,
						});
						try {
							await this.executor.respawnAgent(groupId, agentNamePart);
						} catch {
							// Respawn failed — mark done
							this.completeAgent(groupId, agentNamePart);
						}
					} else {
						// No remaining tasks or max respawns — mark done
						this.completeAgent(groupId, agentNamePart);
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
		const [groupId, name] = agentKey.split("/");
		const group = this.engine.get().groups.find((g) => g.id === groupId);
		if (!group) return "full";
		const mode =
			name === "worker"
				? group.worker.mode
				: (group.agents.find((a) => a.name === name)?.mode ?? "read-only");
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

	/** Diff executor group state and log fix-round-start / blocked events. */
	private recordGroupTransitions(): void {
		for (const [groupId, state] of this.executor.getStates()) {
			const lastRound = this.lastRounds.get(groupId) ?? 0;
			if (state.round > lastRound) {
				this.logEvent("fix-round-start", {
					group: groupId,
					round: state.round,
				});
				this.lastRounds.set(groupId, state.round);
			}
			if (state.blocked && !this.blockedLogged.has(groupId)) {
				this.logEvent("blocked", { group: groupId, reason: state.blocked });
				this.blockedLogged.add(groupId);
			} else if (!state.blocked) {
				this.blockedLogged.delete(groupId);
			}
		}
	}

	/**
	 * Stored summaries feeding buildSeed: completed dep groups' group
	 * summaries plus summaries of siblings that already finished in this group
	 * (e.g. the worker's summary seeding its reviewers).
	 */
	private collectSeedSummaries(groupId: string): SeedSummaries {
		const plan = this.engine.get();
		const group = plan.groups.find((g) => g.id === groupId);

		const groups = new Map<string, string>();
		for (const depId of group?.dependsOn ?? []) {
			const dep = plan.groups.find((g) => g.id === depId);
			if (dep?.summary) groups.set(depId, dep.summary);
		}

		const agents = new Map<string, string>();
		const groupState = this.executor.getStates().get(groupId);
		if (groupState) {
			for (const [name, state] of groupState.agents) {
				if (state.status === "done" && state.summary) {
					agents.set(name, state.summary);
				}
			}
		}

		return { groups, agents };
	}
}

// --- Plan rendering for agents ---

/**
 * Render a filtered plan view for an agent, scoped to its group.
 * Shows group title, body, tasks (with done status), and dep summaries.
 */
export function renderPlanForAgent(
	engine: PlanEngine,
	groupId: string,
): string {
	const plan = engine.get();
	const group = plan.groups.find((g) => g.id === groupId);
	if (!group) return "(group not found)";

	const lines: string[] = [];
	lines.push(`# ${group.title}`);
	lines.push("");
	if (group.body) {
		lines.push(group.body);
		lines.push("");
	}

	// Dependency summaries
	if (group.dependsOn?.length) {
		for (const depId of group.dependsOn) {
			const dep = plan.groups.find((g) => g.id === depId);
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
	for (const task of group.tasks) {
		const check = task.done ? "x" : " ";
		const kindTag = task.kind !== "task" ? ` _(${task.kind})_` : "";
		lines.push(`- [${check}] **${task.title}**${kindTag}`);
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
