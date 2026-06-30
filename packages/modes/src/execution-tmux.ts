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
import type { PlanEngine } from "./engine.js";
import { transitionThrough } from "./execution.js";
import { renderPlanSeed } from "./markdown.js";
import {
	type Deliverable,
	defaultBranchForDeliverable,
	pendingLifecycle,
	pickBaseBranch,
	readyDeliverables,
	repoFor,
} from "./schema.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type TmuxAgentStatus =
	| "spawning"
	| "working"
	| "idle"
	| "done"
	| "failed";

export interface TmuxAgentState {
	readonly deliverableId: string;
	readonly agentName: string;
	readonly worktreePath: string;
	readonly sessionFile: string;
	status: TmuxAgentStatus;
	tokens: TokenSnapshot;
}

export interface TmuxFanoutDeps {
	readonly engine: PlanEngine;
	readonly extensionPath: string;
	readonly planDir: string;
	readonly defaultBranch: string;
	readonly onPlanChanged?: () => void;
	readonly onAgentStateChanged?: (id: string, state: TmuxAgentState) => void;
}

// ─── Implementation ─────────────────────────────────────────────────────────

const LOG_FILE = join(tmpdir(), "maestro-fanout.log");
function log(msg: string): void {
	appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
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
	private takenNames = new Set<string>();
	private server: RpcServer;
	private socketPath: string;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private settlePromise: Promise<void> | undefined;
	private settleResolve: (() => void) | undefined;

	constructor(private readonly deps: TmuxFanoutDeps) {
		this.server = new RpcServer();
		this.socketPath = createSocketPath(deps.planDir);
	}

	/**
	 * Start the RPC server and poll loop. Must be called before tick().
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
		this.pollTimer = setInterval(() => this.pollSessions(), POLL_INTERVAL_MS);
	}

	/**
	 * Spawn agents for all ready deliverables. Returns the count spawned.
	 */
	async tick(): Promise<number> {
		const plan = this.deps.engine.get();
		if (pendingLifecycle(plan, "pre")) return 0;

		let spawned = 0;
		for (const d of readyDeliverables(plan)) {
			if (this.agents.has(d.id)) continue;
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
		if (process.env.PATH) {
			vars.push(`PATH=${process.env.PATH}`);
		}
		return vars;
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

		// Write session file
		const sessionDir = join(result.path, ".pi", "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const sessionFile = join(sessionDir, `${timestamp}_agent-${d.id}.jsonl`);
		const seed = renderPlanSeed(this.deps.engine.get(), d.id);
		const seedId = randomUUID().slice(0, 8);
		const sessionLines = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				cwd: result.path,
			}),
			JSON.stringify({
				type: "custom",
				customType: "maestro-execution-seed",
				data: { content: seed, deliverableId: d.id },
				id: seedId,
				parentId: null,
				timestamp: new Date().toISOString(),
			}),
		];
		writeFileSync(sessionFile, `${sessionLines.join("\n")}\n`);

		// Register agent state
		const state: TmuxAgentState = {
			deliverableId: d.id,
			agentName: name,
			worktreePath: result.path,
			sessionFile,
			status: "spawning",
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
		// RPC disconnect = agent exited = work complete
		this.markDone(agentId);
	}

	private handleMessage(agentId: string, msg: AgentMessage): void {
		const state = this.agents.get(agentId);
		if (!state) return;

		switch (msg.type) {
			case "status":
				if (msg.status === "working") {
					state.status = "working";
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
			case "done":
				this.markDone(agentId, msg.summary);
				break;
			case "taskComplete":
				try {
					this.deps.engine.toggleWorkItem(msg.taskId);
					this.deps.onPlanChanged?.();
				} catch {
					// Task may not exist or already toggled
				}
				break;
		}
	}

	private handleAgentIdle(agentId: string): void {
		// Agent finished a turn. Don't shutdown — agents typically need
		// multiple turns (edit, test, commit, push). Let them run to
		// natural completion. The session dying = work complete.
		log(`idle: ${agentId}`);
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
		log(`checkAlive ${state.agentName}: ${alive}`);
		if (!alive) {
			// Session exited — treat as done (pi finished its work and exited)
			this.markDone(agentId);
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
