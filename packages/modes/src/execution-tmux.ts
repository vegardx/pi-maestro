import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addWorktree, removeWorktree, worktreePathFor } from "@vegardx/pi-git";
import {
	type AgentMessage,
	createSocketPath,
	type PlanMutateMessage,
	type PlanMutateResultMessage,
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
import { renderAgentSeed, renderPlanForAgent } from "./markdown.js";
import { QuestionQueue } from "./question-queue.js";
import {
	type AgentMode,
	type Deliverable,
	defaultBranchForDeliverable,
	deliverables,
	effectiveDependsOn,
	findDeliverable,
	getParentId,
	isChildId,
	type Plan,
	pendingLifecycle,
	pickBaseBranch,
	readyDeliverables,
	repoFor,
	resolveAgentMode,
} from "./schema.js";
import {
	appendToSession,
	buildCustomEntry,
	forkSessionAt,
	parseSessionFile,
} from "./session-fork.js";
import { getModeRoleModel } from "./settings.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Resolve the maestro session directory (centralized location for all sessions). */
function resolveMaestroSessionDir(): string {
	return (
		process.env.PI_CODING_AGENT_SESSION_DIR ||
		join(process.cwd(), ".pi", "sessions")
	);
}

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
	idleCount: number;
	stuckSteerSent: boolean;
	tokens: TokenSnapshot;
	prUrl?: string;
	summary?: string;
	errorDetail?: string;
	commits?: string[];
	model?: string;
}

export interface ForwardSummaryInput {
	readonly completed: {
		readonly id: string;
		readonly title: string;
		readonly body: string;
	};
	readonly agentOutput: string;
	readonly consumers: ReadonlyArray<{
		readonly id: string;
		readonly title: string;
		readonly body: string;
		readonly tasks: string[];
	}>;
}

export interface TmuxFanoutDeps {
	readonly engine: PlanEngine;
	readonly extensionPath: string;
	readonly planDir: string;
	readonly defaultBranch: string;
	readonly ctx: ExtensionContext;
	readonly onPlanChanged?: () => void;
	readonly onAgentStateChanged?: (id: string, state: TmuxAgentState) => void;
	readonly onAllSettled?: () => void;
	readonly onQuestionsReceived?: (id: string, count: number) => void;
	/** Options for the analyze phase. When provided, enables checkpoint forking. */
	readonly analyzeOpts?: AnalyzeOpts;
	/** Generate a forward-looking summary for a completed deliverable. */
	readonly generateSummary?: (input: ForwardSummaryInput) => Promise<string>;
}

// ─── Implementation ─────────────────────────────────────────────────────────

const LOG_FILE = join(tmpdir(), "maestro-fanout.log");
function log(msg: string): void {
	appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
}

/** Collect git info from a worktree after agent completes. */
function collectGitInfo(
	worktreePath: string,
	defaultBranch: string,
): { commits: string[]; prUrl?: string } {
	const commits: string[] = [];
	let prUrl: string | undefined;
	try {
		// Get commits on this branch not on default
		const log = execSync(
			`git log --oneline ${defaultBranch}..HEAD --format="%s"`,
			{ cwd: worktreePath, encoding: "utf-8", timeout: 5000 },
		).trim();
		if (log) {
			for (const line of log.split("\n")) {
				if (line.trim()) commits.push(line.trim());
			}
		}
	} catch {
		/* ignore git errors */
	}
	try {
		// Check for open PR on current branch
		const pr = execSync("gh pr view --json url -q .url", {
			cwd: worktreePath,
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		if (pr.startsWith("http")) prUrl = pr;
	} catch {
		/* no PR or gh not available */
	}
	return { commits, prUrl };
}

const POLL_INTERVAL_MS = 3000;
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
	private settledFired = false;

	/** Analyze result from the most recent analyze phase. */
	private analyzeResult: AnalyzeResult | undefined;
	/** Planned analyze phases (cached from last analyze run). */
	private analyzePhases: AnalyzePhase[] = [];

	constructor(private readonly deps: TmuxFanoutDeps) {
		this.server = new RpcServer();
		this.socketPath = createSocketPath(deps.planDir);
	}

	private get extensionCtx(): ExtensionContext {
		return this.deps.ctx;
	}

	/**
	 * Start the RPC server and poll loop. Must be called before tick().
	 * If analyzeOpts is provided, runs the analyze phase before polling begins.
	 */
	async start(): Promise<void> {
		await this.server.listen(this.socketPath);
		this.server.on("connected", (agentId, model) =>
			this.handleConnected(agentId, model),
		);
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
		const envVars = await this.buildEnvVars(deliverableId);
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

	/**
	 * Find the author sibling's worktree for a read-only child agent.
	 * Convention: parent--author is the author sibling.
	 */
	private findAuthorWorktree(childId: string): string | undefined {
		const parentId = getParentId(childId);
		if (!parentId) return undefined;
		// Look for the author sibling: parentId--author
		const authorId = `${parentId}--author`;
		const authorState = this.agents.get(authorId);
		if (authorState?.worktreePath) return authorState.worktreePath;
		// Fallback: the parent itself might have a worktree (flat structure)
		const parentState = this.agents.get(parentId);
		return parentState?.worktreePath;
	}

	private async buildEnvVars(
		agentId: string,
		agentMode?: AgentMode,
	): Promise<string[]> {
		const agentSessionDir = join(resolveMaestroSessionDir(), "agents", agentId);
		const vars = [
			`PI_MAESTRO_SOCK=${this.socketPath}`,
			`PI_MAESTRO_AGENT_ID=${agentId}`,
			`PI_CODING_AGENT_SESSION_DIR=${agentSessionDir}`,
		];
		if (agentMode) {
			vars.push(`PI_MAESTRO_AGENT_MODE=${agentMode}`);
		}
		if (process.env.PI_CODING_AGENT_DIR) {
			vars.push(`PI_CODING_AGENT_DIR=${process.env.PI_CODING_AGENT_DIR}`);
		}
		// Resolve model — use deliverable's slot/effort if specified
		const d = findDeliverable(this.deps.engine.get(), agentId);
		const resolved = await getModeRoleModel(this.extensionCtx, "agent");
		if (resolved) {
			vars.push(`PI_MODEL=${resolved.modelId}`);
			const effort = d?.effort ?? resolved.effort;
			if (effort && effort !== "off") {
				vars.push(`PI_THINKING=${effort}`);
			}
		}
		if (process.env.PATH) {
			vars.push(`PATH=${process.env.PATH}`);
		}
		return vars;
	}

	/**
	 * Build the session file for an agent. Tries to fork from a compacted
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
								mode: "agent",
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
					mode: "agent",
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
		const agentMode = resolveAgentMode(d);

		// Read-only agents reuse the author sibling's worktree (no own branch)
		let wtPath: string;
		let branch: string;
		if (agentMode === "read-only" && isChildId(d.id)) {
			const authorWt = this.findAuthorWorktree(d.id);
			if (authorWt) {
				wtPath = authorWt;
				branch = d.branch ?? defaultBranchForDeliverable(d);
			} else {
				// No author sibling worktree found — use repo root in read-only
				wtPath = repo.path;
				branch = this.deps.defaultBranch;
			}
		} else {
			branch = d.branch ?? defaultBranchForDeliverable(d);
			const baseBranch = pickBaseBranch(plan, d.id, this.deps.defaultBranch);
			wtPath = worktreePathFor(repo.path, d.id);

			const result = addWorktree(repo.path, wtPath, branch, baseBranch);
			log(
				`worktree ${d.id}: repo=${repo.path} wt=${wtPath} branch=${branch} base=${baseBranch} ok=${result.ok} path=${result.ok ? result.path : "n/a"}`,
			);
			if (!result.ok) {
				log(`worktree ${d.id}: FAILED — ${result.error}`);
				this.markFailed(d.id, result.error);
				return;
			}
			wtPath = result.path;
		}

		// Assign agent name
		const name = agentName(d.id, this.takenNames);
		this.takenNames.add(name);

		// Set status to active in the plan
		this.deps.engine.setStatus(d.id, "active");

		// Write session file in maestro's session dir (not in the worktree)
		const sessionDir = join(resolveMaestroSessionDir(), "agents", d.id);
		mkdirSync(sessionDir, { recursive: true });
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const seed = renderAgentSeed(this.deps.engine.get(), d.id);
		const sessionFile = this.buildSessionFile(
			d,
			sessionDir,
			timestamp,
			seed,
			wtPath,
		);

		// Register agent state
		const state: TmuxAgentState = {
			deliverableId: d.id,
			agentName: name,
			worktreePath: wtPath,
			sessionFile,
			startedAt: Date.now(),
			status: "spawning",
			shutdownSent: false,
			idleCount: 0,
			stuckSteerSent: false,
			tokens: { ...ZERO_TOKENS },
		};
		this.agents.set(d.id, state);

		// Kill stale session with same name from a previous run
		try {
			await killSession(name);
		} catch {
			// No existing session — expected
		}

		// Spawn tmux session with env vars for RPC discovery.
		const envVars = await this.buildEnvVars(d.id, agentMode);
		const userMsg =
			agentMode === "read-only"
				? `Review deliverable: "${d.title}". ` +
					"Read the code, analyze it, and report your findings via task update. " +
					"You cannot modify files."
				: `Implement this deliverable: "${d.title}". ` +
					"Follow the plan context above. Complete all gating tasks, " +
					"commit your work, push, and open a PR.";
		const escapedMsg = userMsg.replace(/"/g, '\\"');
		const piCmd = this.deps.extensionPath
			? `pi --session "${sessionFile}" -e "${this.deps.extensionPath}" "${escapedMsg}"`
			: `pi --session "${sessionFile}" "${escapedMsg}"`;
		const command = [...envVars, piCmd].join(" ");
		log(`spawn ${name}: cwd=${wtPath} cmd=${command.slice(0, 200)}`);
		try {
			await tmuxSpawn(name, wtPath, command, {
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

	private handleConnected(agentId: string, model?: string): void {
		log(`connected: ${agentId}`);
		const state = this.agents.get(agentId);
		if (!state) return;
		state.status = "working";
		if (model) state.model = model;
		this.deps.onAgentStateChanged?.(agentId, state);
	}

	private handleDisconnected(agentId: string): void {
		log(`disconnected: ${agentId}`);
		const state = this.agents.get(agentId);
		if (!state || state.status === "done" || state.status === "failed") return;
		// Check if tmux session is actually dead before marking done.
		// RPC can disconnect transiently (maestro compact/restart).
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
				// Legacy lens usage — ignored (lens system removed)
				break;
			case "done":
				this.markDone(agentId, msg.summary, msg.prUrl, msg.commits, msg.model);
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
			case "planRead": {
				const plan = this.deps.engine.get();
				const content = renderPlanForAgent(plan, agentId);
				this.server.send(agentId, { type: "planReadResponse", content });
				break;
			}
			case "planMutate": {
				const result = this.handlePlanMutate(agentId, msg);
				this.server.send(agentId, result);
				break;
			}
		}
	}

	private handlePlanMutate(
		agentId: string,
		msg: PlanMutateMessage,
	): PlanMutateResultMessage {
		try {
			switch (msg.action) {
				case "toggleTask": {
					if (!msg.params.taskId) {
						return {
							type: "planMutateResult",
							success: false,
							error: "taskId required",
						};
					}
					this.deps.engine.toggleWorkItem(msg.params.taskId);
					this.deps.onPlanChanged?.();
					this.checkCompletionGate(agentId);
					return {
						type: "planMutateResult",
						success: true,
						taskId: msg.params.taskId,
					};
				}
				case "addTask": {
					const kind = msg.params.kind ?? "task";
					// Permission: gating tasks only to own deliverable
					if (kind === "task" && msg.deliverableId !== agentId) {
						return {
							type: "planMutateResult",
							success: false,
							error: "can only add gating tasks to own deliverable",
						};
					}
					if (!msg.params.title) {
						return {
							type: "planMutateResult",
							success: false,
							error: "title required",
						};
					}
					const item = this.deps.engine.addWorkItem(msg.deliverableId, {
						title: msg.params.title,
						body: msg.params.body,
						kind,
					});
					this.deps.onPlanChanged?.();
					return { type: "planMutateResult", success: true, taskId: item.id };
				}
				case "updateTask": {
					if (!msg.params.taskId) {
						return {
							type: "planMutateResult",
							success: false,
							error: "taskId required",
						};
					}
					// Permission: can only update tasks in own deliverable
					const d = findDeliverable(this.deps.engine.get(), agentId);
					const ownsTask = d?.children.some(
						(c) => c.type === "work-item" && c.id === msg.params.taskId,
					);
					if (!ownsTask) {
						return {
							type: "planMutateResult",
							success: false,
							error: "can only update tasks in own deliverable",
						};
					}
					this.deps.engine.updateWorkItem(msg.params.taskId, {
						title: msg.params.title,
						body: msg.params.body,
					});
					this.deps.onPlanChanged?.();
					return {
						type: "planMutateResult",
						success: true,
						taskId: msg.params.taskId,
					};
				}
				default:
					return {
						type: "planMutateResult",
						success: false,
						error: "unknown action",
					};
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { type: "planMutateResult", success: false, error: message };
		}
	}

	private handleAgentIdle(agentId: string): void {
		const state = this.agents.get(agentId);
		if (!state || state.shutdownSent) return;
		state.idleCount++;
		log(`idle: ${agentId} (count=${state.idleCount})`);

		// Check if all tasks are done — if so, agent is complete
		if (this.checkCompletionGate(agentId)) return;

		// Stuck detection: 5+ consecutive idles with no progress
		if (state.idleCount >= 5 && !state.stuckSteerSent) {
			state.stuckSteerSent = true;
			const d = findDeliverable(this.deps.engine.get(), agentId);
			const remaining = d
				? d.children
						.filter(
							(c) =>
								c.type === "work-item" &&
								(c.kind === "task" || !c.kind) &&
								!c.done,
						)
						.map((c) => c.id)
				: [];
			this.server.send(agentId, {
				type: "steer",
				content:
					"You seem stuck. " +
					(remaining.length > 0
						? `Remaining tasks: ${remaining.join(", ")}. `
						: "") +
					"Call `plan` to see current state. Commit progress and ship when ready.",
			});
			log(`stuck-steer: ${agentId} after ${state.idleCount} idles`);
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
		// Collect git info from the worktree before marking done
		const gitInfo = collectGitInfo(state.worktreePath, this.deps.defaultBranch);
		this.markDone(agentId, undefined, gitInfo.prUrl, gitInfo.commits);
		return true;
	}

	private markDone(
		agentId: string,
		summary?: string,
		prUrl?: string,
		commits?: string[],
		model?: string,
	): void {
		const state = this.agents.get(agentId);
		if (!state || state.status === "done") return;
		state.status = "done";
		if (summary) {
			state.summary = summary;
			this.deps.engine.updateDeliverable(agentId, { summary });
		}
		if (prUrl) state.prUrl = prUrl;
		if (commits) state.commits = commits;
		if (model) state.model = model;
		transitionThrough(this.deps.engine, agentId, "in-review");
		this.deps.onAgentStateChanged?.(agentId, state);
		this.deps.onPlanChanged?.();

		// Check if this was a review agent completing — toggle reviews-gate on author
		this.checkReviewsGate(agentId);

		// Generate forward-looking summary (fire-and-forget, don't block tick)
		this.generateForwardSummary(agentId);

		// Spawn newly unblocked dependents
		this.tick();
		this.checkSettle();
	}

	/**
	 * Generate a forward-looking summary shaped by downstream consumers' needs.
	 * Runs asynchronously after agent completion — does not block spawning.
	 */
	private async generateForwardSummary(agentId: string): Promise<void> {
		if (!this.deps.generateSummary) return;

		const plan = this.deps.engine.get();
		const completed = findDeliverable(plan, agentId);
		if (!completed) return;

		// Find downstream consumers (deliverables that depend on this one)
		const allDeliverables = deliverables(plan);
		const downstream = allDeliverables.filter((d) =>
			d.dependsOn?.includes(agentId),
		);
		if (downstream.length === 0) return;

		// Collect agent output (PR description, commits, summary)
		const state = this.agents.get(agentId);
		const agentOutput = [
			state?.summary ? `Summary: ${state.summary}` : "",
			state?.commits?.length ? `Commits:\n${state.commits.join("\n")}` : "",
			state?.prUrl ? `PR: ${state.prUrl}` : "",
		]
			.filter(Boolean)
			.join("\n\n");

		const consumers = downstream.map((d) => ({
			id: d.id,
			title: d.title,
			body: d.body,
			tasks: d.children
				.filter((c) => c.type === "work-item" && (c.kind === "task" || !c.kind))
				.map((c) => (c as { title: string }).title),
		}));

		try {
			const forwardSummary = await this.deps.generateSummary({
				completed: {
					id: completed.id,
					title: completed.title,
					body: completed.body,
				},
				agentOutput,
				consumers,
			});
			this.deps.engine.updateDeliverable(agentId, {
				summary: forwardSummary,
			});
			this.deps.onPlanChanged?.();
			log(`forward-summary: generated for ${agentId}`);
		} catch (e) {
			log(
				`forward-summary: failed for ${agentId} — ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	/**
	 * When a review/verify child agent finishes, check if all review siblings
	 * are done. If so, toggle the `reviews-gate` task on the author sibling.
	 */
	private checkReviewsGate(completedId: string): void {
		if (!isChildId(completedId)) return;
		const parentId = getParentId(completedId);
		if (!parentId) return;

		const plan = this.deps.engine.get();
		const parent = findDeliverable(plan, parentId);
		if (parent?.type !== "deliverable") return;

		// Find all review/verify children under this parent grouping
		const reviewChildren = parent.children.filter(
			(c): c is Deliverable =>
				c.type === "deliverable" &&
				(c.agentRole === "review" || c.agentRole === "verify"),
		);
		if (reviewChildren.length === 0) return;

		// Check if ALL review children are done/shipped
		const allDone = reviewChildren.every(
			(rc) =>
				rc.status === "in-review" ||
				rc.status === "ready-to-ship" ||
				rc.status === "shipped",
		);
		if (!allDone) return;

		// Find the author sibling and toggle its reviews-gate task
		const authorChild = parent.children.find(
			(c): c is Deliverable =>
				c.type === "deliverable" && c.agentRole === "author",
		);
		if (!authorChild) return;

		// Look for a task with id containing "reviews-gate" on the author
		const gateTask = authorChild.children.find(
			(c) =>
				c.type === "work-item" &&
				(c.kind === "manual" || c.kind === "task") &&
				c.id.includes("reviews-gate"),
		);
		if (gateTask && gateTask.type === "work-item" && !gateTask.done) {
			log(
				`reviews-gate: all reviews done for ${parentId}, toggling ${gateTask.id}`,
			);
			this.deps.engine.toggleWorkItem(gateTask.id);
			this.deps.onPlanChanged?.();
		}
	}

	private markFailed(agentId: string, detail?: string): void {
		const state = this.agents.get(agentId);
		if (!state) return;
		state.status = "failed";
		if (detail) state.errorDetail = detail;
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
				// Expected exit after maestro sent shutdown
				this.markDone(agentId);
			} else {
				// Unexpected death — crash or user killed it
				this.markFailed(agentId, "agent session terminated unexpectedly");
			}
		}
	}

	private pollSessions(): void {
		for (const [id, state] of this.agents) {
			if (state.status === "working") {
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
		if (this.allSettled() && !this.settledFired) {
			this.settledFired = true;
			this.deps.onAllSettled?.();
		}
	}
}
