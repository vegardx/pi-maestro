// Execution adapter: wraps GroupExecutor with real tmux+RPC spawning.
// Creates tmux sessions running `pi` for each agent, connected via RPC.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MaestroRpcServer } from "@vegardx/pi-rpc";
import * as tmux from "@vegardx/pi-tmux";
import {
	buildAgentSeed,
	buildWorkerSeed,
	groupBranch,
} from "../agent-lifecycle.js";
import { agentName } from "../agent-names.js";
import type { PlanEngine } from "../engine.js";
import { type ExecutorDeps, GroupExecutor } from "../group-executor.js";
import type { PendingQuestion } from "../question-queue.js";
import { buildPrBody } from "../shipping.js";

export interface ExecutionAdapterOpts {
	engine: PlanEngine;
	ctx: ExtensionContext;
	extensionPath: string;
	/** All extension paths to pass to agents (includes custom providers etc). */
	extensionPaths?: string[];
	defaultBranch: string;
	planDir: string;
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
	private socketPath: string;
	private _started = false;
	private takenNames = new Set<string>();
	private sessionNames = new Map<string, string>(); // agentKey → tmux session name

	readonly questionQueue = {
		all: () => [] as readonly PendingQuestion[],
	};

	constructor(opts: ExecutionAdapterOpts) {
		this.opts = opts;
		this.engine = opts.engine;
		this.socketPath = join(
			"/tmp",
			`maestro-${opts.engine.get().slug.slice(0, 20)}-${process.pid}.sock`,
		);
		this.rpcServer = new MaestroRpcServer();

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

				// Build the seed/prompt for this agent
				const depSummaries = this.collectDepSummaries(spawnOpts.groupId);
				let seed: string;
				if (isWorker) {
					seed = buildWorkerSeed(group, {
						depSummaries,
						siblingeSummaries: [],
					});
				} else {
					const agentSpec = group.agents.find(
						(a) => a.name === spawnOpts.agentName,
					);
					if (!agentSpec)
						throw new Error(`agent ${spawnOpts.agentName} not found in group`);
					seed = buildAgentSeed(group, agentSpec, {
						depSummaries,
						siblingeSummaries: [],
					});
				}

				// Write seed to file for pi to read
				const seedDir = join(this.opts.planDir, "seeds");
				mkdirSync(seedDir, { recursive: true });
				const seedFile = join(seedDir, `${sessionName}.md`);
				const { writeFileSync } = await import("node:fs");
				writeFileSync(seedFile, seed);

				// Build pi command with env vars
				const cwd = spawnOpts.worktreePath ?? this.opts.ctx.cwd;
				// Share the maestro's agent dir so agents inherit auth credentials
				const maestroAgentDir =
					process.env.PI_CODING_AGENT_DIR ??
					join(process.env.HOME ?? "", ".pi", "agent");
				const agentSessionDir = join(
					process.env.PI_CODING_AGENT_SESSION_DIR ??
						join(maestroAgentDir, "sessions"),
					"agents",
					sessionName,
				);
				const envVars = [
					`PI_MAESTRO_SOCK=${this.socketPath}`,
					`PI_MAESTRO_AGENT_ID=${agentKey}`,
					`PI_MAESTRO_AGENT_MODE=${agentMode}`,
					`PI_CODING_AGENT_DIR=${maestroAgentDir}`,
					`PI_CODING_AGENT_SESSION_DIR=${agentSessionDir}`,
				];
				if (process.env.PATH) {
					envVars.push(`PATH=${process.env.PATH}`);
				}

				// Build extension args — include all extensions the maestro loaded
				const extPaths = this.opts.extensionPaths ?? [this.opts.extensionPath];
				const extArgs = extPaths.map((p) => `-e "${p}"`).join(" ");

				// Run pi interactively with seed as system prompt append
				const piArgs = [
					extArgs,
					"--no-skills",
					"--no-prompt-templates",
					"--no-themes",
					"--no-context-files",
					`--append-system-prompt "${seedFile}"`,
					`"Implement the tasks described in your system prompt."`,
				].join(" ");

				const shellCmd = `${envVars.join(" ")} pi ${piArgs}`;
				const cols = process.stdout.columns || 200;
				const rows = process.stdout.rows || 50;

				await tmux.spawn(sessionName, cwd, shellCmd, {
					width: cols,
					height: rows,
				});

				this.opts.onAgentStateChanged?.(agentKey, {
					status: "working",
					tokens: { input: 0, output: 0, turns: 0 },
				});

				return sessionName;
			},

			killSession: async (sessionId) => {
				if (await tmux.hasSession(sessionId)) {
					await tmux.kill(sessionId);
				}
				this.takenNames.delete(sessionId);
			},

			createWorktree: async (worktreeOpts) => {
				// For now, use the main repo cwd (proper worktree creation is a follow-up)
				const _branch = groupBranch(worktreeOpts.groupId);
				const cwd = this.opts.ctx.cwd;
				// TODO: create actual git worktree on branch
				return cwd;
			},

			shipGroup: async (shipOpts) => {
				const group = this.engine
					.get()
					.groups.find((g) => g.id === shipOpts.groupId);
				if (!group) return `error: group ${shipOpts.groupId} not found`;
				// TODO: actual git push + gh pr create
				const body = buildPrBody(group, []);
				return `shipped:${group.title} (${body.length} chars)`;
			},

			requestSummary: async (_sessionId) => {
				// TODO: send RPC summarize instruction and await response
				return "## Summary\nWork completed.";
			},

			now: () => new Date().toISOString(),
		};

		this.executor = new GroupExecutor(this.engine, deps);
	}

	async start(): Promise<void> {
		mkdirSync(this.opts.planDir, { recursive: true });
		await this.rpcServer.listen(this.socketPath);

		// Listen for agent events via RPC
		this.rpcServer.on("message", (agentId, msg) => {
			if (msg.type === "status" && msg.status === "idle") {
				// Agent went idle — check if worker is done (all tasks toggled)
				const parts = agentId.split("/");
				const groupId = parts[0];
				const agentNamePart = parts[1];
				if (agentNamePart === "worker" && this.executor.isWorkerDone(groupId)) {
					this.executor.markAgentDone(groupId, "worker").then(() => {
						this.opts.onPlanChanged();
						this.tick();
					});
				}
			}
			if (msg.type === "done") {
				const parts = agentId.split("/");
				const groupId = parts[0];
				const agentNamePart = parts[1];
				if (agentNamePart) {
					this.executor.markAgentDone(groupId, agentNamePart).then(() => {
						this.opts.onPlanChanged();
						this.tick();
					});
				}
			}
			if (msg.type === "tokens") {
				this.opts.onAgentStateChanged?.(agentId, {
					status: "working",
					tokens: {
						input: msg.snapshot.input,
						output: msg.snapshot.output,
						turns: msg.snapshot.turns,
					},
				});
			}
		});

		this._started = true;
	}

	async tick(): Promise<number> {
		if (!this._started) return 0;

		const beforeActive = this.engine
			.get()
			.groups.filter((g) => g.status === "active").length;

		const shipped = await this.executor.tick();

		const afterActive = this.engine
			.get()
			.groups.filter((g) => g.status === "active").length;

		if (shipped.length > 0) {
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

	steer(groupId: string, guidance: string): void {
		const agentKey = `${groupId}/worker`;
		this.rpcServer.send(agentKey, { type: "steer", content: guidance });
	}

	snapshot(): {
		agents: Map<
			string,
			{
				status: string;
				startedAt: number;
				tokens: { input: number; output: number; turns: number };
			}
		>;
	} {
		const agents = new Map<
			string,
			{
				status: string;
				startedAt: number;
				tokens: { input: number; output: number; turns: number };
			}
		>();
		const states = this.executor.getStates();

		for (const [groupId, groupState] of states) {
			for (const [name, agentState] of groupState.agents) {
				const key = `${groupId}/${name}`;
				agents.set(key, {
					status: agentState.status,
					startedAt: Date.now(),
					tokens: { input: 0, output: 0, turns: 0 },
				});
			}
		}

		return { agents };
	}

	async markAgentDone(groupId: string, name: string): Promise<void> {
		await this.executor.markAgentDone(groupId, name);
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
		// Kill all tmux sessions
		for (const sessionName of this.sessionNames.values()) {
			if (await tmux.hasSession(sessionName)) {
				await tmux.kill(sessionName).catch(() => {});
			}
		}
		this.sessionNames.clear();
		this.rpcServer.close();
	}

	private collectDepSummaries(groupId: string): string[] {
		const plan = this.engine.get();
		const group = plan.groups.find((g) => g.id === groupId);
		if (!group?.dependsOn?.length) return [];

		const summaries: string[] = [];
		for (const depId of group.dependsOn) {
			const dep = plan.groups.find((g) => g.id === depId);
			if (dep?.summary) {
				summaries.push(`## From: ${dep.title} (${dep.id})\n${dep.summary}`);
			}
		}
		return summaries;
	}
}
