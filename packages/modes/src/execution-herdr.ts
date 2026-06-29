// HerdrFanout — worktree-based agent spawning via herdr.
// Replaces FanoutOrchestrator for herdr-backed environments.
// Each deliverable gets its own herdr workspace + pane running pi.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentStatus,
	agentRename,
	agentSend,
	HerdrEventClient,
	paneClose,
	paneRun,
	worktreeCreate,
	worktreeRemove,
} from "@vegardx/pi-herdr";
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
import { SessionTailer, type TokenSnapshot } from "./session-tailer.js";

// --- Types ---

export type HerdrAgentStatus =
	| "spawning"
	| "working"
	| "blocked"
	| "idle"
	| "done"
	| "failed";

export interface HerdrAgentState {
	readonly deliverableId: string;
	readonly workspaceId: string;
	readonly paneId: string;
	readonly agentName: string;
	readonly sessionFile: string;
	readonly worktreePath: string;
	status: HerdrAgentStatus;
	tokens: TokenSnapshot;
}

export interface HerdrFanoutSnapshot {
	readonly agents: ReadonlyMap<string, HerdrAgentState>;
	readonly spawnedDeliverables: ReadonlySet<string>;
}

export interface HerdrFanoutDeps {
	readonly engine: PlanEngine;
	readonly defaultBranch?: string;
	readonly onPlanChanged?: () => void;
	readonly onAgentStateChanged?: (
		deliverableId: string,
		state: HerdrAgentState,
	) => void;
}

// --- Implementation ---

export class HerdrFanout {
	private agents = new Map<string, HerdrAgentState>();
	private tailers = new Map<string, SessionTailer>();
	private eventClient: HerdrEventClient | undefined;
	private takenNames = new Set<string>();
	private settleResolvers: Array<() => void> = [];

	constructor(private readonly deps: HerdrFanoutDeps) {}

	snapshot(): HerdrFanoutSnapshot {
		return {
			agents: new Map(this.agents),
			spawnedDeliverables: new Set(this.agents.keys()),
		};
	}

	/** Spawn all ready deliverables. Returns number spawned. */
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

	/** Send a steering message to an agent. */
	async steer(deliverableId: string, message: string): Promise<boolean> {
		const state = this.agents.get(deliverableId);
		if (!state) return false;
		await agentSend(state.agentName, message);
		return true;
	}

	/** Returns a promise that resolves when all spawned agents reach idle/done. */
	settle(): Promise<void> {
		if (this.allSettled()) return Promise.resolve();
		return new Promise((resolve) => {
			this.settleResolvers.push(resolve);
		});
	}

	/** Get the session file path for a spawned agent. */
	sessionFileForDeliverable(deliverableId: string): string | undefined {
		return this.agents.get(deliverableId)?.sessionFile;
	}

	/** Get agent state by deliverable ID. */
	agentForDeliverable(deliverableId: string): HerdrAgentState | undefined {
		return this.agents.get(deliverableId);
	}

	/** Get agent state by name. */
	agentByName(name: string): HerdrAgentState | undefined {
		for (const state of this.agents.values()) {
			if (state.agentName === name) return state;
		}
		return undefined;
	}

	/** Clean up a single deliverable's workspace after ship. */
	async cleanup(deliverableId: string): Promise<void> {
		const state = this.agents.get(deliverableId);
		if (!state) return;
		this.tailers.get(deliverableId)?.stop();
		this.tailers.delete(deliverableId);
		try {
			await worktreeRemove({ workspaceId: state.workspaceId, force: true });
		} catch {
			// Best-effort cleanup.
		}
		this.takenNames.delete(state.agentName);
		this.agents.delete(deliverableId);
	}

	/** Shut down all agents and event subscriptions. */
	async destroy(): Promise<void> {
		for (const tailer of this.tailers.values()) tailer.stop();
		this.tailers.clear();
		this.eventClient?.close();
		this.eventClient = undefined;
		for (const state of this.agents.values()) {
			try {
				await paneClose(state.paneId);
			} catch {
				// ignore
			}
		}
		this.agents.clear();
		this.takenNames.clear();
	}

	// --- Private ---

	private async spawnAgent(d: Deliverable): Promise<void> {
		const plan = this.deps.engine.get();
		const repo = repoFor(plan, d);
		const _branch = d.branch ?? defaultBranchForDeliverable(d);
		const defaultBranch = this.deps.defaultBranch ?? "main";
		const baseBranch = pickBaseBranch(plan, d.id, defaultBranch);

		// 1. Create worktree workspace via herdr.
		const result = await worktreeCreate({
			cwd: repo.path,
			branch: `deliverable/${d.id}`,
			base: baseBranch,
			label: d.title,
			focus: false,
		});

		const worktreePath = result.worktree.path;
		const workspaceId = result.workspace.workspace_id;
		const paneId = result.root_pane.pane_id;

		// 2. Assign agent name.
		const name = agentName(d.id, this.takenNames);
		this.takenNames.add(name);

		// Rename in herdr for display.
		try {
			await agentRename(paneId, name);
		} catch {
			// Non-critical — herdr might not support rename yet.
		}

		// 3. Create session file with execution seed.
		const sessionFile = this.createSessionFile(worktreePath, d);

		// 4. Register agent state.
		const state: HerdrAgentState = {
			deliverableId: d.id,
			workspaceId,
			paneId,
			agentName: name,
			sessionFile,
			worktreePath,
			status: "spawning",
			tokens: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: 0,
				cacheHitRate: 0,
				turns: 0,
			},
		};
		this.agents.set(d.id, state);

		// Update plan engine.
		this.deps.engine.setStatus(d.id, "active");
		this.deps.engine.updateDeliverable(d.id, {
			branch: `deliverable/${d.id}`,
			worktreePath,
		});

		// 5. Start session file tailer.
		const tailer = new SessionTailer(sessionFile, (tokens) => {
			state.tokens = tokens;
			this.deps.onAgentStateChanged?.(d.id, state);
		});
		this.tailers.set(d.id, tailer);

		// 6. Subscribe to herdr events (lazy — one client for all agents).
		this.ensureEventSubscription();

		// 7. Launch pi in the pane.
		await paneRun(paneId, `pi --session "${sessionFile}"`);
		state.status = "working";
		this.deps.onAgentStateChanged?.(d.id, state);
	}

	private createSessionFile(worktreePath: string, d: Deliverable): string {
		const sessionsDir = join(worktreePath, ".pi", "sessions");
		mkdirSync(sessionsDir, { recursive: true });

		const timestamp = new Date().toISOString();
		const sessionId = `agent-${d.id}-${Date.now()}`;
		const filename = `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
		const filepath = join(sessionsDir, filename);

		const plan = this.deps.engine.get();
		const seed = renderPlanSeed(plan, d.id);

		// Session header.
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: sessionId,
			timestamp,
			cwd: worktreePath,
		});

		// Inject plan seed as a custom message so the agent has context.
		const entryId = "00000001";
		const seedEntry = JSON.stringify({
			type: "custom_message",
			id: entryId,
			parentId: null,
			timestamp,
			customType: "maestro-execution-seed",
			content: seed,
			display: false,
		});

		writeFileSync(filepath, `${header}\n${seedEntry}\n`);
		return filepath;
	}

	private ensureEventSubscription(): void {
		if (this.eventClient) return;
		try {
			this.eventClient = new HerdrEventClient();
			this.eventClient.on((event) => {
				if (event.type === "pane.agent_status_changed") {
					this.handleAgentStatusChanged(
						event.pane_id as string,
						event.agent_status as AgentStatus,
					);
				}
			});
			// Subscribe to all agent status changes.
			this.eventClient.subscribe([{ type: "pane.agent_status_changed" }]);
		} catch {
			// Socket unavailable — fall back to polling or manual check.
			this.eventClient = undefined;
		}
	}

	private handleAgentStatusChanged(paneId: string, status: AgentStatus): void {
		// Find the agent by pane ID.
		let deliverableId: string | undefined;
		let state: HerdrAgentState | undefined;
		for (const [dId, s] of this.agents) {
			if (s.paneId === paneId) {
				deliverableId = dId;
				state = s;
				break;
			}
		}
		if (!deliverableId || !state) return;

		const prevStatus = state.status;
		state.status = mapHerdrStatus(status);
		this.deps.onAgentStateChanged?.(deliverableId, state);

		if (state.status === "idle" && prevStatus !== "idle") {
			this.onAgentComplete(deliverableId, state);
		}
	}

	private onAgentComplete(deliverableId: string, state: HerdrAgentState): void {
		// Stop the tailer.
		this.tailers.get(deliverableId)?.stop();

		// Transition deliverable to in-review.
		transitionThrough(this.deps.engine, deliverableId, "in-review");
		state.status = "done";
		this.deps.onAgentStateChanged?.(deliverableId, state);
		this.deps.onPlanChanged?.();

		// Spawn newly unblocked deliverables.
		this.tick();

		// Check if all settled.
		if (this.allSettled()) {
			for (const resolve of this.settleResolvers) resolve();
			this.settleResolvers = [];
		}
	}

	private allSettled(): boolean {
		for (const state of this.agents.values()) {
			if (
				state.status !== "done" &&
				state.status !== "idle" &&
				state.status !== "failed"
			) {
				return false;
			}
		}
		return this.agents.size > 0;
	}
}

function mapHerdrStatus(status: AgentStatus): HerdrAgentStatus {
	switch (status) {
		case "working":
			return "working";
		case "blocked":
			return "blocked";
		case "idle":
			return "idle";
		case "done":
			return "done";
		default:
			return "working";
	}
}
