// Execution adapter: wraps GroupExecutor with real tmux+RPC spawning.
// Creates tmux sessions running `pi` for each agent, connected via RPC.

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Answers, Questionnaire } from "@vegardx/pi-contracts";
import { type AgentMessage, MaestroRpcServer } from "@vegardx/pi-rpc";
import * as tmux from "@vegardx/pi-tmux";
import {
	buildAgentSeed,
	buildWorkerSeed,
	groupBranch,
} from "./agent-lifecycle.js";
import { agentName } from "./agent-names.js";
import type { PlanEngine } from "./engine.js";
import { type ExecutorDeps, GroupExecutor } from "./group-executor.js";
import { buildPrBody } from "./shipping.js";

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
	private idleCount = new Map<string, number>(); // agentKey → consecutive idle count
	private stuckSteerSent = new Set<string>(); // agentKeys that received a stuck steer
	private respawnCount = new Map<string, number>(); // agentKey → respawn attempts
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private pendingQuestions = new Map<
		string,
		{
			agentId: string;
			questions: Questionnaire;
			resolve: (answers: Answers) => void;
		}
	>(); // agentKey → pending question

	readonly questionQueue = {
		all: () => {
			const items: { id: string; agentId: string; question: string }[] = [];
			for (const [key, entry] of this.pendingQuestions) {
				for (const q of entry.questions) {
					items.push({ id: key, agentId: entry.agentId, question: String(q) });
				}
			}
			return items;
		},
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

				// Build session file (JSONL) with modes state + seed
				const cwd = spawnOpts.worktreePath ?? this.opts.ctx.cwd;
				const maestroAgentDir =
					process.env.PI_CODING_AGENT_DIR ??
					join(process.env.HOME ?? "", ".pi", "agent");
				const agentSessionDir = join(
					process.env.PI_CODING_AGENT_SESSION_DIR ??
						join(maestroAgentDir, "sessions"),
					"agents",
					sessionName,
				);
				mkdirSync(agentSessionDir, { recursive: true });
				const sessionFile = buildSessionFile({
					agentKey,
					seed,
					cwd,
					outDir: agentSessionDir,
				});

				// Env vars for RPC discovery and agent identity
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

				// Build user message for the agent
				const userMsg = isWorker
					? "Implement the tasks described in your seed. Commit as you go. Toggle tasks when done."
					: "Review the code and report your findings. Follow the focus instructions in your seed.";
				const escapedMsg = userMsg.replace(/"/g, '\\"');

				// Run pi interactively with session file (proper modes state hydration)
				const piArgs = [
					extArgs,
					"--no-skills",
					"--no-prompt-templates",
					"--no-themes",
					"--no-context-files",
					`--session "${sessionFile}"`,
					`"${escapedMsg}"`,
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
			this.handleRpcMessage(agentId, msg);
		});

		// Poll timer: check liveness of tmux sessions every 5s
		this.pollTimer = setInterval(() => this.pollSessions(), 5000);

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

	// --- RPC message dispatch ---

	private handleRpcMessage(agentId: string, msg: AgentMessage): void {
		const [groupId, agentNamePart] = agentId.split("/");
		if (!groupId || !agentNamePart) return;

		switch (msg.type) {
			case "status":
				this.handleStatus(agentId, groupId, agentNamePart, msg.status);
				break;
			case "done":
				this.handleDone(groupId, agentNamePart);
				break;
			case "tokens":
				this.opts.onAgentStateChanged?.(agentId, {
					status: "working",
					tokens: {
						input: msg.snapshot.input,
						output: msg.snapshot.output,
						turns: msg.snapshot.turns,
					},
				});
				break;
			case "taskComplete":
				// Legacy path — prefer planMutate/toggleTask
				this.handleTaskComplete(agentId, groupId, msg.taskId);
				break;
			case "planMutate":
				this.handlePlanMutate(agentId, msg);
				break;
			case "planRead":
				this.handlePlanRead(agentId);
				break;
			case "questions":
				this.handleQuestions(agentId, msg.questions);
				break;
		}
	}

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

			// Check if worker completed all tasks
			if (agentNamePart === "worker" && this.executor.isWorkerDone(groupId)) {
				this.checkCompletionGate(agentId, groupId);
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
						this.rpcServer.send(agentId, {
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
		this.executor.markAgentDone(groupId, agentNamePart).then(() => {
			this.opts.onPlanChanged();
			this.tick();
		});
	}

	private handleTaskComplete(
		agentId: string,
		groupId: string,
		taskId: string,
	): void {
		try {
			this.engine.toggleWorkItem(groupId, taskId);
			this.opts.onPlanChanged();
			this.checkCompletionGate(agentId, groupId);
		} catch {
			// Task not found — ignore
		}
	}

	private handlePlanMutate(
		agentId: string,
		msg: {
			action: string;
			deliverableId: string;
			params: Record<string, unknown>;
		},
	): void {
		const groupId = msg.deliverableId;
		const params = msg.params ?? {};

		try {
			switch (msg.action) {
				case "toggleTask": {
					const taskId = params.taskId as string;
					if (!taskId) throw new Error("taskId required");
					this.engine.toggleWorkItem(groupId, taskId);
					this.opts.onPlanChanged();
					this.rpcServer.send(agentId, {
						type: "planMutateResult",
						success: true,
						taskId,
					});
					this.checkCompletionGate(agentId, groupId);
					break;
				}
				case "addTask": {
					const title = params.title as string;
					if (!title) throw new Error("title required");
					const item = this.engine.addWorkItem(groupId, {
						title,
						body: (params.body as string) ?? "",
						kind:
							(params.kind as "task" | "followup" | "question") ?? "followup",
					});
					this.opts.onPlanChanged();
					this.rpcServer.send(agentId, {
						type: "planMutateResult",
						success: true,
						taskId: item.id,
					});
					break;
				}
				case "updateTask": {
					const taskId = params.taskId as string;
					if (!taskId) throw new Error("taskId required");
					this.engine.updateWorkItem(groupId, taskId, {
						...(params.title ? { title: params.title as string } : {}),
						...(params.body ? { body: params.body as string } : {}),
					});
					this.opts.onPlanChanged();
					this.rpcServer.send(agentId, {
						type: "planMutateResult",
						success: true,
						taskId,
					});
					break;
				}
				default:
					this.rpcServer.send(agentId, {
						type: "planMutateResult",
						success: false,
						error: `unknown action: ${msg.action}`,
					});
			}
		} catch (e) {
			this.rpcServer.send(agentId, {
				type: "planMutateResult",
				success: false,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	private handlePlanRead(agentId: string): void {
		const [groupId] = agentId.split("/");
		const content = renderPlanForAgent(this.engine, groupId);
		this.rpcServer.send(agentId, { type: "planReadResponse", content });
	}

	private handleQuestions(agentId: string, questions: unknown): void {
		const qArray = (Array.isArray(questions) ? questions : []) as Questionnaire;
		this.pendingQuestions.set(agentId, {
			agentId,
			questions: qArray,
			resolve: (answers) => {
				this.rpcServer.send(agentId, { type: "answers", answers });
				this.pendingQuestions.delete(agentId);
			},
		});
		this.opts.onQuestionsReceived?.(agentId, qArray.length);
	}

	// --- Completion gate ---

	private checkCompletionGate(agentId: string, groupId: string): void {
		const group = this.engine.get().groups.find((g) => g.id === groupId);
		if (!group) return;
		const gating = group.tasks.filter((t) => t.kind === "task");
		if (gating.length === 0) return;
		if (!gating.every((t) => t.done)) return;

		// All gating tasks done — shutdown the agent
		this.rpcServer.send(agentId, {
			type: "shutdown",
			reason: "all tasks complete",
		});
	}

	// --- Answer pending questions ---

	answerQuestions(agentId: string, answers: Answers): void {
		const pending = this.pendingQuestions.get(agentId);
		if (pending) {
			pending.resolve(answers);
		}
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
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
		// Kill all tmux sessions
		for (const sessionName of this.sessionNames.values()) {
			if (await tmux.hasSession(sessionName)) {
				await tmux.kill(sessionName).catch(() => {});
			}
		}
		this.sessionNames.clear();
		this.rpcServer.close();
	}

	// --- Poll timer: detect dead sessions ---

	private async pollSessions(): Promise<void> {
		for (const [agentKey, sessionName] of this.sessionNames) {
			const [groupId, agentNamePart] = agentKey.split("/");
			if (!groupId || !agentNamePart) continue;

			// Skip agents already marked done
			const states = this.executor.getStates();
			const groupState = states.get(groupId);
			if (!groupState) continue;
			const agentState = groupState.agents.get(agentNamePart);
			if (!agentState || agentState.status === "done") continue;

			// Check if tmux session is still alive
			if (!(await tmux.hasSession(sessionName))) {
				// Session died — attempt respawn or mark done
				const count = this.respawnCount.get(agentKey) ?? 0;
				const group = this.engine.get().groups.find((g) => g.id === groupId);
				const hasRemainingTasks =
					group?.tasks.some((t) => t.kind === "task" && !t.done) ?? false;

				if (hasRemainingTasks && count < 2) {
					// Respawn: rebuild session and try again
					this.respawnCount.set(agentKey, count + 1);
					try {
						await this.executor.respawnAgent(groupId, agentNamePart);
					} catch {
						// Respawn failed — mark done
						await this.executor.markAgentDone(groupId, agentNamePart);
						this.opts.onPlanChanged();
						await this.tick();
					}
				} else {
					// No remaining tasks or max respawns — mark done
					await this.executor.markAgentDone(groupId, agentNamePart);
					this.opts.onPlanChanged();
					await this.tick();
				}
			}
		}
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

// --- Session file builder ---

interface BuildSessionFileOpts {
	agentKey: string; // e.g. "group-id/worker"
	seed: string;
	cwd: string;
	outDir: string;
}

/**
 * Build a JSONL session file that pi can hydrate on session_start.
 * Contains: session header + maestro.modes.state + maestro-execution-seed.
 */
export function buildSessionFile(opts: BuildSessionFileOpts): string {
	const { agentKey, seed, cwd, outDir } = opts;
	const now = new Date().toISOString();
	const sessionId = randomUUID();
	const modesStateId = randomUUID().slice(0, 8);
	const seedId = randomUUID().slice(0, 8);

	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: sessionId,
			timestamp: now,
			cwd,
		}),
		JSON.stringify({
			type: "custom",
			customType: "maestro.modes.state",
			data: {
				version: 2,
				mode: "agent",
				execution: { stage: "executing", deliverableId: agentKey },
				updatedAt: now,
			},
			id: modesStateId,
			parentId: null,
			timestamp: now,
		}),
		JSON.stringify({
			type: "custom",
			customType: "maestro-execution-seed",
			data: { content: seed, deliverableId: agentKey },
			id: seedId,
			parentId: modesStateId,
			timestamp: now,
		}),
	];

	const timestamp = now.replace(/[:.]/g, "-");
	const fileName = `${timestamp}_agent-${agentKey.replace(/\//g, "_")}.jsonl`;
	const filePath = join(outDir, fileName);
	writeFileSync(filePath, `${lines.join("\n")}\n`);
	return filePath;
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
