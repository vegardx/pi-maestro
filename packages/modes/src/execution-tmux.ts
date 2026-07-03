import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, removeWorktree, worktreePathFor } from "@vegardx/pi-git";
import {
	type AgentMessage,
	createSocketPath,
	MaestroRpcServer as RpcServer,
	type TokenSnapshot,
} from "@vegardx/pi-rpc";
import {
	hasSession,
	kill as killSession,
	spawn as tmuxSpawn,
} from "@vegardx/pi-tmux";
import { agentName } from "./agent-names.js";
import {
	type AnalyzeOpts,
	type AnalyzePhase,
	type AnalyzeResult,
	checkpointForDeliverable,
	planAnalyzePhases,
	runAnalyzePhase,
	shouldRefreshAnalyze,
} from "./analyze.js";
import type { PlanEngine } from "./engine.js";
import { completionGateSatisfied, transitionThrough } from "./execution.js";
import { renderPlanSeed } from "./markdown.js";
import { QuestionQueue } from "./question-queue.js";
import {
	type Deliverable,
	defaultBranchForDeliverable,
	deliverables,
	effectiveDependsOn,
	findDeliverable,
	type Plan,
	pendingLifecycle,
	pickBaseBranch,
	readyDeliverables,
	repoFor,
} from "./schema.js";
import {
	appendToSession,
	buildCustomEntry,
	forkSessionAt,
	parseSessionFile,
} from "./session-fork.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type TmuxAgentStatus =
	| "spawning"
	| "working"
	| "idle"
	| "awaiting-decision"
	| "done"
	| "failed";

export interface TmuxAgentState {
	readonly deliverableId: string;
	readonly agentName: string;
	readonly worktreePath: string;
	readonly sessionFile: string;
	readonly startedAt: number;
	status: TmuxAgentStatus;
	shutdownSent: boolean;
	assessmentSent: boolean;
	idleCount: number;
	tokens: TokenSnapshot;
	lensRuns: number;
	reviewCycles: number;
	lastLensAt?: number;
}

export interface TmuxFanoutDeps {
	readonly engine: PlanEngine;
	readonly extensionPath: string;
	readonly planDir: string;
	readonly defaultBranch: string;
	readonly onPlanChanged?: () => void;
	readonly onAgentStateChanged?: (id: string, state: TmuxAgentState) => void;
	readonly onQuestionsReceived?: (id: string, count: number) => void;
	readonly onLensUsage?: (
		id: string,
		lens: string,
		snapshot: TokenSnapshot,
	) => void;
	/** Options for the analyze phase. When provided, enables checkpoint forking. */
	readonly analyzeOpts?: AnalyzeOpts;
}

// ─── Implementation ─────────────────────────────────────────────────────────

const LOG_FILE = join(tmpdir(), "maestro-fanout.log");
function log(msg: string): void {
	appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
}

const POLL_INTERVAL_MS = 3000;
const MAX_REVIEW_CYCLES = Number(process.env.MAESTRO_MAX_REVIEW_CYCLES) || 2;
const ZERO_TOKENS: TokenSnapshot = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
	turns: 0,
};

export class TmuxFanout {
	private agents = new Map<string, TmuxAgentState>();
	readonly questionQueue = new QuestionQueue();
	private takenNames = new Set<string>();
	private server: RpcServer;
	private socketPath: string;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private settlePromise: Promise<void> | undefined;
	private settleResolve: (() => void) | undefined;

	/** Analyze result from the most recent analyze phase. */
	private analyzeResult: AnalyzeResult | undefined;
	/** Planned analyze phases (cached from last analyze run). */
	private analyzePhases: AnalyzePhase[] = [];

	constructor(private readonly deps: TmuxFanoutDeps) {
		this.server = new RpcServer();
		this.socketPath = createSocketPath(deps.planDir);
	}

	/**
	 * Start the RPC server and poll loop. Must be called before tick().
	 * If analyzeOpts is provided, runs the analyze phase before polling begins.
	 */
	async start(): Promise<void> {
		await this.server.listen(this.socketPath);
		this.server.on("connected", (agentId) => this.handleConnected(agentId));
		this.server.on("disconnected", (agentId) =>
			this.handleDisconnected(agentId),
		);
		this.server.on("message", (agentId, msg) =>
			this.handleMessage(agentId, msg),
		);

		// Run analyze phase if configured
		if (this.deps.analyzeOpts) {
			const startTime = Date.now();
			const plan = this.deps.engine.get();
			this.analyzeResult = await runAnalyzePhase(plan, this.deps.analyzeOpts);
			this.analyzePhases = planAnalyzePhases(plan);
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			log(
				`analyze: completed in ${elapsed}s (${this.analyzeResult.checkpoints.size} checkpoints, ${this.analyzeResult.compactedFiles.size} compacted)`,
			);
		}

		this.pollTimer = setInterval(() => this.pollSessions(), POLL_INTERVAL_MS);
	}

	/**
	 * Spawn agents for all ready deliverables. Returns the count spawned.
	 */
	async tick(): Promise<number> {
		const plan = this.deps.engine.get();
		if (pendingLifecycle(plan, "pre")) return 0;

		// Refresh analyze if configured, cache stale, and new work exists
		if (
			this.deps.analyzeOpts &&
			shouldRefreshAnalyze(plan, this.analyzeResult)
		) {
			try {
				this.analyzeResult = await runAnalyzePhase(plan, this.deps.analyzeOpts);
				this.analyzePhases = planAnalyzePhases(plan);
				log("analyze: refreshed");
			} catch (e) {
				log(
					`analyze: refresh failed — ${e instanceof Error ? e.message : String(e)}`,
				);
				// Non-fatal on refresh: use stale result
			}
		}

		let spawned = 0;
		for (const d of readyDeliverables(plan)) {
			if (this.agents.has(d.id)) continue;
			if (!this.depsComplete(plan, d)) continue;
			await this.spawnAgent(d);
			spawned++;
		}
		if (spawned > 0) this.deps.onPlanChanged?.();
		return spawned;
	}

	/**
	 * Send a steer message to an agent by deliverable ID.
	 */
	steer(deliverableId: string, message: string): boolean {
		const state = this.agents.get(deliverableId);
		if (!state) return false;
		return this.server.send(deliverableId, {
			type: "steer",
			content: message,
		});
	}

	/**
	 * Returns a promise that resolves when all spawned agents are done/failed.
	 */
	settle(): Promise<void> {
		if (this.allSettled()) return Promise.resolve();
		if (!this.settlePromise) {
			this.settlePromise = new Promise((resolve) => {
				this.settleResolve = resolve;
			});
		}
		return this.settlePromise;
	}

	/**
	 * Snapshot the current agent states.
	 */
	snapshot(): { agents: ReadonlyMap<string, TmuxAgentState> } {
		return { agents: this.agents };
	}

	/**
	 * Find an agent state by its human-readable name.
	 */
	agentByName(name: string): TmuxAgentState | undefined {
		for (const state of this.agents.values()) {
			if (state.agentName === name) return state;
		}
		return undefined;
	}

	/**
	 * Check if an agent's tmux session is still alive.
	 */
	async isAlive(agentName: string): Promise<boolean> {
		return hasSession(agentName);
	}

	/**
	 * Respawn a dead agent with an optional new message.
	 * Re-uses the existing session file so pi picks up full context.
	 */
	async respawn(deliverableId: string, message?: string): Promise<boolean> {
		const state = this.agents.get(deliverableId);
		if (!state) return false;

		// Kill stale session if somehow still around
		try {
			await killSession(state.agentName);
		} catch {
			// Expected
		}

		// Build command
		const envVars = this.buildEnvVars(deliverableId);
		const escapedMsg = message?.replace(/"/g, '\\"');
		const piCmd = this.deps.extensionPath
			? `pi -c --session "${state.sessionFile}" -e "${this.deps.extensionPath}"${escapedMsg ? ` "${escapedMsg}"` : ""}`
			: `pi -c --session "${state.sessionFile}"${escapedMsg ? ` "${escapedMsg}"` : ""}`;
		const command = [...envVars, piCmd].join(" ");

		try {
			await tmuxSpawn(state.agentName, state.worktreePath, command, {
				width: process.stdout.columns || 200,
				height: process.stdout.rows || 50,
			});
		} catch (e) {
			log(
				`respawn ${state.agentName}: FAILED — ${e instanceof Error ? e.message : String(e)}`,
			);
			return false;
		}

		state.status = "working";
		this.deps.onAgentStateChanged?.(deliverableId, state);
		this.deps.onPlanChanged?.();
		log(`respawn ${state.agentName}: ok`);
		return true;
	}

	/**
	 * Get the extension path for building pi commands externally.
	 */
	getExtensionPath(): string {
		return this.deps.extensionPath;
	}

	/**
	 * Kill a specific agent's session and remove its worktree.
	 */
	async cleanup(deliverableId: string): Promise<void> {
		const state = this.agents.get(deliverableId);
		if (!state) return;
		try {
			await killSession(state.agentName);
		} catch {
			// Session may already be gone
		}
		removeWorktree(this.deps.engine.get().repoPath, state.worktreePath, {
			force: true,
		});
		this.agents.delete(deliverableId);
		this.takenNames.delete(state.agentName);
	}

	/**
	 * Kill all agents, stop the server and poll loop.
	 */
	async destroy(): Promise<void> {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
		for (const [id] of this.agents) {
			const state = this.agents.get(id);
			if (state) {
				try {
					await killSession(state.agentName);
				} catch {
					// Ignore
				}
			}
		}
		await this.server.close();
		this.agents.clear();
		this.takenNames.clear();
	}

	// ─── Private ──────────────────────────────────────────────────────────────

	private depsComplete(
		plan: Pick<Plan, "nodes">,
		d: Pick<Deliverable, "id" | "dependsOn">,
	): boolean {
		const deps = effectiveDependsOn(plan, d);
		if (deps.length === 0) return true;
		const DONE_STATUSES = ["in-review", "ready-to-ship", "shipped"];
		return deps.every((depId) => {
			const parent = deliverables(plan).find((p) => p.id === depId);
			return parent ? DONE_STATUSES.includes(parent.status) : false;
		});
	}

	private buildEnvVars(agentId: string): string[] {
		const vars = [
			`PI_MAESTRO_SOCK=${this.socketPath}`,
			`PI_MAESTRO_AGENT_ID=${agentId}`,
		];
		if (process.env.PI_CODING_AGENT_DIR) {
			vars.push(`PI_CODING_AGENT_DIR=${process.env.PI_CODING_AGENT_DIR}`);
		}
		if (process.env.PI_CODING_AGENT_SESSION_DIR) {
			vars.push(
				`PI_CODING_AGENT_SESSION_DIR=${process.env.PI_CODING_AGENT_SESSION_DIR}`,
			);
		}
		if (process.env.MAESTRO_WORKER_MODEL) {
			vars.push(`PI_MODEL=${process.env.MAESTRO_WORKER_MODEL}`);
		}
		if (process.env.PATH) {
			vars.push(`PATH=${process.env.PATH}`);
		}
		return vars;
	}

	/**
	 * Build the session file for a worker agent. Tries to fork from a compacted
	 * analyze checkpoint; falls back to cold start (header + modes state + seed).
	 */
	private buildSessionFile(
		d: Deliverable,
		sessionDir: string,
		timestamp: string,
		seed: string,
		cwd: string,
	): string {
		// Try checkpoint-based fork
		if (this.analyzeResult) {
			const label = checkpointForDeliverable(this.analyzePhases, d.id);
			const compactedFile = label
				? this.analyzeResult.compactedFiles.get(label)
				: undefined;
			if (compactedFile) {
				try {
					const { entries } = parseSessionFile(compactedFile);
					const lastEntry = entries[entries.length - 1];
					if (lastEntry) {
						const forked = forkSessionAt(
							compactedFile,
							lastEntry.id,
							sessionDir,
							{ cwd },
						);
						// Append modes state + execution seed
						const modesState = buildCustomEntry(
							"maestro.modes.state",
							{
								version: 2,
								mode: "auto",
								execution: { stage: "executing", deliverableId: d.id },
								updatedAt: new Date().toISOString(),
							},
							lastEntry.id,
						);
						const seedEntry = buildCustomEntry(
							"maestro-execution-seed",
							{ content: seed, deliverableId: d.id },
							modesState.id,
						);
						appendToSession(forked, [modesState, seedEntry]);
						log(`spawn ${d.id}: forked from checkpoint "${label}"`);
						return forked;
					}
				} catch (e) {
					log(
						`spawn ${d.id}: fork failed, falling back to cold start — ${e instanceof Error ? e.message : String(e)}`,
					);
				}
			}
		}

		// Cold start fallback
		const sessionFile = join(sessionDir, `${timestamp}_agent-${d.id}.jsonl`);
		const modesStateId = randomUUID().slice(0, 8);
		const seedId = randomUUID().slice(0, 8);
		const sessionLines = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				cwd,
			}),
			JSON.stringify({
				type: "custom",
				customType: "maestro.modes.state",
				data: {
					version: 2,
					mode: "auto",
					execution: { stage: "executing", deliverableId: d.id },
					updatedAt: new Date().toISOString(),
				},
				id: modesStateId,
				parentId: null,
				timestamp: new Date().toISOString(),
			}),
			JSON.stringify({
				type: "custom",
				customType: "maestro-execution-seed",
				data: { content: seed, deliverableId: d.id },
				id: seedId,
				parentId: modesStateId,
				timestamp: new Date().toISOString(),
			}),
		];
		writeFileSync(sessionFile, `${sessionLines.join("\n")}\n`);
		return sessionFile;
	}

	private async spawnAgent(d: Deliverable): Promise<void> {
		const plan = this.deps.engine.get();
		const repo = repoFor(plan, d);
		const branch = d.branch ?? defaultBranchForDeliverable(d);
		const baseBranch = pickBaseBranch(plan, d.id, this.deps.defaultBranch);
		const wtPath = worktreePathFor(repo.path, d.id);

		const result = addWorktree(repo.path, wtPath, branch, baseBranch);
		log(
			`worktree ${d.id}: repo=${repo.path} wt=${wtPath} branch=${branch} base=${baseBranch} ok=${result.ok} path=${result.ok ? result.path : "n/a"}`,
		);
		if (!result.ok) {
			log(`worktree ${d.id}: FAILED — ${result.error}`);
			this.markFailed(d.id, result.error);
			return;
		}

		// Assign agent name
		const name = agentName(d.id, this.takenNames);
		this.takenNames.add(name);

		// Set status to active in the plan
		this.deps.engine.setStatus(d.id, "active");

		// Write session file — fork from checkpoint or cold start
		const sessionDir = join(result.path, ".pi", "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const seed = renderPlanSeed(this.deps.engine.get(), d.id);
		const sessionFile = this.buildSessionFile(
			d,
			sessionDir,
			timestamp,
			seed,
			result.path,
		);

		// Register agent state
		const state: TmuxAgentState = {
			deliverableId: d.id,
			agentName: name,
			worktreePath: result.path,
			sessionFile,
			startedAt: Date.now(),
			status: "spawning",
			shutdownSent: false,
			assessmentSent: false,
			idleCount: 0,
			tokens: { ...ZERO_TOKENS },
			lensRuns: 0,
			reviewCycles: 0,
		};
		this.agents.set(d.id, state);

		// Kill stale session with same name from a previous run
		try {
			await killSession(name);
		} catch {
			// No existing session — expected
		}

		// Spawn tmux session with env vars for RPC discovery.
		const envVars = this.buildEnvVars(d.id);
		const userMsg =
			`Implement this deliverable: "${d.title}". ` +
			"Follow the plan context above. Complete all gating tasks, " +
			"commit your work, push, and open a PR.";
		const escapedMsg = userMsg.replace(/"/g, '\\"');
		const piCmd = this.deps.extensionPath
			? `pi --session "${sessionFile}" -e "${this.deps.extensionPath}" "${escapedMsg}"`
			: `pi --session "${sessionFile}" "${escapedMsg}"`;
		const command = [...envVars, piCmd].join(" ");
		log(`spawn ${name}: cwd=${result.path} cmd=${command.slice(0, 200)}`);
		try {
			await tmuxSpawn(name, result.path, command, {
				width: process.stdout.columns || 200,
				height: process.stdout.rows || 50,
			});
			log(`spawn ${name}: ok`);
		} catch (e) {
			const msg = `tmux spawn failed: ${e instanceof Error ? e.message : String(e)}`;
			log(`spawn ${name}: FAILED — ${msg}`);
			this.markFailed(d.id, msg);
			return;
		}

		this.deps.onAgentStateChanged?.(d.id, state);
	}

	private handleConnected(agentId: string): void {
		log(`connected: ${agentId}`);
		const state = this.agents.get(agentId);
		if (!state) return;
		state.status = "working";
		this.deps.onAgentStateChanged?.(agentId, state);
	}

	private handleDisconnected(agentId: string): void {
		log(`disconnected: ${agentId}`);
		const state = this.agents.get(agentId);
		if (!state || state.status === "done" || state.status === "failed") return;
		// Check if tmux session is actually dead before marking done.
		// RPC can disconnect transiently (orchestrator compact/restart).
		this.checkSessionAlive(agentId);
	}

	private handleMessage(agentId: string, msg: AgentMessage): void {
		const state = this.agents.get(agentId);
		if (!state) return;

		switch (msg.type) {
			case "status":
				if (msg.status === "working") {
					state.status = "working";
					state.idleCount = 0;
				} else if (msg.status === "idle") {
					state.status = "idle";
					this.handleAgentIdle(agentId);
				} else if (msg.status === "error") {
					this.markFailed(agentId, msg.detail);
				}
				this.deps.onAgentStateChanged?.(agentId, state);
				break;
			case "tokens":
				state.tokens = msg.snapshot;
				this.deps.onAgentStateChanged?.(agentId, state);
				break;
			case "lensUsage":
				state.lensRuns++;
				state.lastLensAt = Date.now();
				if (msg.lens === "review") {
					state.reviewCycles++;
					this.handleReviewCycleCheck(agentId, state);
				}
				this.deps.onLensUsage?.(agentId, msg.lens, msg.snapshot);
				break;
			case "done":
				this.markDone(agentId, msg.summary);
				break;
			case "questions": {
				const d = findDeliverable(this.deps.engine.get(), agentId);
				this.questionQueue.enqueue({
					agentId,
					agentName: state.agentName,
					deliverableTitle: d?.title ?? state.agentName,
					questions: msg.questions,
					resolve: (answers) =>
						this.server.send(agentId, { type: "answers", answers }),
				});
				state.status = "awaiting-decision";
				this.deps.onQuestionsReceived?.(agentId, msg.questions.length);
				this.deps.onAgentStateChanged?.(agentId, state);
				break;
			}
			case "taskComplete":
				try {
					this.deps.engine.toggleWorkItem(msg.taskId);
					this.deps.onPlanChanged?.();
					this.checkCompletionGate(agentId);
				} catch {
					// Task may not exist or already toggled
				}
				break;
		}
	}

	private handleAgentIdle(agentId: string): void {
		const state = this.agents.get(agentId);
		if (!state || state.shutdownSent) return;
		state.idleCount++;
		log(`idle: ${agentId} (count=${state.idleCount})`);

		// Check if all tasks are done — if so, agent is complete
		if (this.checkCompletionGate(agentId)) return;

		// After first idle with incomplete tasks, steer the agent to assess (once)
		if (!state.assessmentSent) {
			const d = findDeliverable(this.deps.engine.get(), agentId);
			const taskIds = d
				? d.children
						.filter(
							(c) =>
								c.type === "work-item" &&
								(c.kind === "task" || !c.kind) &&
								!c.done,
						)
						.map((c) => c.id)
				: [];
			if (taskIds.length > 0) {
				this.server.send(agentId, {
					type: "steer",
					content:
						"Assess whether you have completed your work. For each task, verify it is actually done " +
						"(code implemented, tests passing, committed). Then mark completed tasks:\n" +
						taskIds
							.map((id) => `  task({action: "toggle", id: "${id}"})`)
							.join("\n") +
						"\n\nIf any task is NOT done, continue working on it.",
				});
				state.assessmentSent = true;
				log(`steered ${agentId} to toggle tasks: ${taskIds.join(", ")}`);
			}
		}
	}

	private handleReviewCycleCheck(agentId: string, state: TmuxAgentState): void {
		if (state.reviewCycles === MAX_REVIEW_CYCLES) {
			this.server.send(agentId, {
				type: "steer",
				content:
					"You have completed multiple review cycles. From this point, only fix IMPORTANT " +
					"or CRITICAL findings. Accept all MINOR findings as-is and proceed to SHIP. " +
					"Do not run the review tool again unless you made substantial architectural changes.",
			});
			log(
				`review-loop-breaker: steered ${agentId} after ${state.reviewCycles} cycles`,
			);
		} else if (state.reviewCycles > MAX_REVIEW_CYCLES) {
			this.server.send(agentId, {
				type: "steer",
				content:
					"STOP. You have exceeded the maximum review cycles. Ship your current " +
					"implementation NOW using the ship tool. Do not run review again.",
			});
			log(
				`review-loop-breaker: FORCE steered ${agentId} after ${state.reviewCycles} cycles`,
			);
		}
	}

	private checkCompletionGate(agentId: string): boolean {
		const state = this.agents.get(agentId);
		if (!state || state.status === "done" || state.shutdownSent) return false;
		const d = findDeliverable(this.deps.engine.get(), agentId);
		if (!d || !completionGateSatisfied(d)) return false;
		// All gating tasks done — send shutdown
		log(`completionGate satisfied: ${agentId}, sending shutdown`);
		state.shutdownSent = true;
		this.server.send(agentId, {
			type: "shutdown",
			reason: "all tasks complete",
		});
		this.markDone(agentId);
		return true;
	}

	private markDone(agentId: string, summary?: string): void {
		const state = this.agents.get(agentId);
		if (!state || state.status === "done") return;
		state.status = "done";
		if (summary) {
			this.deps.engine.updateDeliverable(agentId, { summary });
		}
		transitionThrough(this.deps.engine, agentId, "in-review");
		this.deps.onAgentStateChanged?.(agentId, state);
		this.deps.onPlanChanged?.();
		// Spawn newly unblocked dependents
		this.tick();
		this.checkSettle();
	}

	private markFailed(agentId: string, detail?: string): void {
		const state = this.agents.get(agentId);
		if (!state) return;
		state.status = "failed";
		// Drop any pending decision request — the agent is gone, so resolving it
		// would send to a dead socket and it must not be offered in /answer.
		this.questionQueue.drop(agentId);
		if (detail) {
			this.deps.engine.updateDeliverable(agentId, { summary: detail });
		}
		transitionThrough(this.deps.engine, agentId, "needs-attention");
		this.deps.onAgentStateChanged?.(agentId, state);
		this.deps.onPlanChanged?.();
		this.checkSettle();
	}

	private async checkSessionAlive(agentId: string): Promise<void> {
		const state = this.agents.get(agentId);
		if (!state) return;
		const alive = await hasSession(state.agentName);
		log(
			`checkAlive ${state.agentName}: ${alive} shutdownSent=${state.shutdownSent}`,
		);
		if (!alive) {
			if (state.shutdownSent) {
				// Expected exit after orchestrator sent shutdown
				this.markDone(agentId);
			} else {
				// Unexpected death — crash or user killed it
				this.markFailed(agentId, "agent session terminated unexpectedly");
			}
		}
	}

	private pollSessions(): void {
		for (const [id, state] of this.agents) {
			if (state.status === "spawning" || state.status === "working") {
				this.checkSessionAlive(id);
			}
		}
	}

	private allSettled(): boolean {
		for (const state of this.agents.values()) {
			if (state.status !== "done" && state.status !== "failed") return false;
		}
		return this.agents.size > 0;
	}

	private checkSettle(): void {
		if (this.allSettled() && this.settleResolve) {
			this.settleResolve();
			this.settleResolve = undefined;
			this.settlePromise = undefined;
		}
	}
}
