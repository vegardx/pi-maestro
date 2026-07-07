// Execution adapter: wraps GroupExecutor with real tmux+RPC spawning.
// Creates tmux sessions running `pi` for each agent, connected via RPC.

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Answers } from "@vegardx/pi-contracts";
import {
	MaestroRpcServer,
	type PlanMutateMessage,
	type PlanReadMessage,
	type QuestionsMessage,
} from "@vegardx/pi-rpc";
import * as realTmux from "@vegardx/pi-tmux";
import { buildAgentSeed, buildWorkerSeed } from "../agent-lifecycle.js";
import { agentName } from "../agent-names.js";
import type { PlanEngine } from "../engine.js";
import { type ExecutorDeps, GroupExecutor } from "../group-executor.js";
import { QuestionQueue } from "../question-queue.js";
import { buildPrBody } from "../shipping.js";
import {
	buildAgentSessionFile,
	buildSpawnSpec,
	defaultAgentDir,
	type ProvisionEnvironmentOpts,
	provisionEnvironment,
	provisionWorktree,
} from "./provisioner.js";
import { createRpcRouter, type RpcRouter } from "./rpc-router.js";

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
	private token = randomUUID();
	private _started = false;
	private takenNames = new Set<string>();
	private sessionNames = new Map<string, string>(); // agentKey → tmux session name
	private idleCount = new Map<string, number>(); // agentKey → consecutive idle count
	private stuckSteerSent = new Set<string>(); // agentKeys that received a stuck steer
	private respawnCount = new Map<string, number>(); // agentKey → respawn attempts
	private provisionedWorktrees = new Set<string>(); // env setup ran already
	private pollTimer: ReturnType<typeof setInterval> | undefined;

	readonly questionQueue = new QuestionQueue();

	constructor(opts: ExecutionAdapterOpts) {
		this.opts = opts;
		this.engine = opts.engine;
		this.tmux = opts.tmux ?? realTmux;
		this.socketPath = join(
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
				// Share the maestro's agent dir so agents inherit auth credentials
				const agentDir = defaultAgentDir();
				const agentSessionDir = join(
					process.env.PI_CODING_AGENT_SESSION_DIR ?? join(agentDir, "sessions"),
					"agents",
					sessionName,
				);
				mkdirSync(agentSessionDir, { recursive: true });
				const session = buildAgentSessionFile({
					agentKey,
					seed,
					cwd,
					outDir: agentSessionDir,
				});

				const userMsg = isWorker
					? "Implement the tasks described in your seed. Commit as you go. Toggle tasks when done."
					: "Review the code and report your findings. Follow the focus instructions in your seed.";

				const spec = buildSpawnSpec({
					sessionName,
					worktreePath: cwd,
					sessionFile: session.path,
					extensionPaths: this.opts.extensionPaths ?? [this.opts.extensionPath],
					env: {
						sock: this.socketPath,
						agentId: agentKey,
						agentMode,
						agentDir,
						sessionDir: agentSessionDir,
						token: this.token,
					},
					kickoffMessage: userMsg,
				});

				const cols = process.stdout.columns || 200;
				const rows = process.stdout.rows || 50;

				await this.tmux.spawn(spec.sessionName, spec.cwd, spec.command, {
					width: cols,
					height: rows,
					env: spec.env,
				});

				this.opts.onAgentStateChanged?.(agentKey, {
					status: "working",
					tokens: { input: 0, output: 0, turns: 0 },
				});

				return sessionName;
			},

			killSession: async (sessionId) => {
				if (await this.tmux.hasSession(sessionId)) {
					await this.tmux.kill(sessionId);
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
					provisionEnvironment(
						path,
						worktreeOpts.repoPath,
						this.opts.worktreeSetup ?? {},
					);
					this.provisionedWorktrees.add(path);
				}
				return path;
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

			defaultBranch: this.opts.defaultBranch,

			now: () => new Date().toISOString(),
		};

		this.executor = new GroupExecutor(this.engine, deps);
	}

	async start(): Promise<void> {
		mkdirSync(this.opts.planDir, { recursive: true });
		await this.rpcServer.listen(this.socketPath);

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
		this.executor.markAgentDone(groupId, agentNamePart).then(() => {
			this.opts.onPlanChanged();
			this.tick();
		});
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

		// All gating tasks done — shutdown the agent
		this.router.send(agentId, {
			type: "shutdown",
			reason: "all tasks complete",
		});
	}

	// --- Answer pending questions ---

	answerQuestions(agentId: string, answers: Answers): void {
		this.questionQueue.answer(agentId, answers);
	}

	steer(groupId: string, guidance: string): void {
		const agentKey = `${groupId}/worker`;
		this.router.send(agentKey, { type: "steer", content: guidance });
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
			if (!(await this.tmux.hasSession(sessionName))) {
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
