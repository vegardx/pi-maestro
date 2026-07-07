import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
	Answers,
	Questionnaire,
	WorkItemKind,
} from "@vegardx/pi-contracts";
import {
	type MaestroMessage,
	MaestroRpcClient,
	type PlanMutateResultMessage,
} from "@vegardx/pi-rpc";

/**
 * Agent-side RPC bridge. Activated when the agent detects it's running
 * under the maestro (PI_MAESTRO_SOCK env var is set).
 *
 * Responsibilities:
 * - Connect to maestro via Unix socket RPC
 * - Report status transitions (working/idle) on turn boundaries
 * - Forward steer messages as user messages
 * - Route `ask` tool calls to the maestro and block for answers
 * - Report real token/cost usage (accumulated from assistant messages)
 * - Shut down gracefully on maestro request
 */

export interface AgentBridgeDeps {
	readonly pi: ExtensionAPI;
	readonly socketPath: string;
	readonly agentId: string;
}

/** Minimal shape of pi-ai Usage the bridge consumes (avoids a hard dep). */
export interface AssistantUsage {
	readonly input?: number;
	readonly output?: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	readonly cost?: { readonly total?: number };
}

export class AgentBridge {
	private client: MaestroRpcClient;
	private ctx: ExtensionContext | undefined;
	private turnCount = 0;
	private totalInput = 0;
	private totalOutput = 0;
	private totalCacheRead = 0;
	private totalCacheWrite = 0;
	private totalCost = 0;
	private pendingAsk:
		| { id: string; resolve: (answers: Answers) => void }
		| undefined;
	private pendingPlanRead:
		| { id: string; resolve: (content: string) => void }
		| undefined;
	private pendingPlanMutate:
		| { id: string; resolve: (result: PlanMutateResultMessage) => void }
		| undefined;

	constructor(private readonly deps: AgentBridgeDeps) {
		this.client = new MaestroRpcClient({ reconnect: true });
	}

	/** Initialize the bridge. Call during session_start. */
	start(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.client.on("message", (msg) => this.handleMessage(msg));
		this.client.connect(this.deps.socketPath, {
			agentId: this.deps.agentId,
			role: "agent",
			token: process.env.PI_MAESTRO_TOKEN ?? "",
			pid: process.pid,
		});
	}

	/** Signal turn started — agent is working. */
	onTurnStart(): void {
		this.client.send({ type: "status", status: "working" });
	}

	/** Signal turn ended — agent is idle, waiting for maestro decision. */
	onTurnEnd(): void {
		this.turnCount++;
		this.client.send({ type: "status", status: "idle" });
		this.reportTokens();
	}

	/**
	 * Accumulate real usage from an assistant message (pi-ai Usage). Called
	 * from the message_end handler when the message role is "assistant".
	 */
	recordUsage(usage: AssistantUsage): void {
		this.totalInput += usage.input ?? 0;
		this.totalOutput += usage.output ?? 0;
		this.totalCacheRead += usage.cacheRead ?? 0;
		this.totalCacheWrite += usage.cacheWrite ?? 0;
		this.totalCost += usage.cost?.total ?? 0;
		this.reportTokens();
	}

	/** Signal an error occurred. */
	onError(detail?: string): void {
		this.client.send({ type: "status", status: "error", detail });
	}

	/** Signal the agent completed its work. */
	onDone(opts?: { summary?: string; commits?: string[] }): void {
		this.client.send({
			type: "done",
			id: randomUUID(),
			summary: opts?.summary,
			commits: opts?.commits,
		});
	}

	/** Report a task as completed to the maestro (fire-and-forget toggle). */
	onTaskComplete(groupId: string, taskId: string): void {
		this.client.send({
			type: "planMutate",
			id: randomUUID(),
			action: "toggleTask",
			groupId,
			params: { taskId },
		});
	}

	/** Report usage from a lens sub-invocation (a child pi process). */
	reportLensUsage(
		lens: string,
		snapshot: import("@vegardx/pi-rpc").TokenSnapshot,
		opts?: {
			findings?: number;
			fixed?: number;
			model?: string;
			effort?: string;
		},
	): void {
		this.client.send({
			type: "lensUsage",
			lens,
			snapshot,
			findings: opts?.findings,
			fixed: opts?.fixed,
			model: opts?.model,
			effort: opts?.effort,
		});
	}

	/**
	 * Send questions to the maestro and block until answers arrive.
	 * Resolves empty on shutdown/destroy so a blocked agent exits cleanly.
	 * Only one ask may be pending at a time (guaranteed by the blocking tool
	 * model); a second while one is pending resolves the newcomer empty.
	 */
	ask(questions: Questionnaire): Promise<Answers> {
		if (this.pendingAsk) return Promise.resolve([]);
		const id = randomUUID();
		this.client.send({ type: "questions", id, questions });
		return new Promise<Answers>((resolve) => {
			this.pendingAsk = { id, resolve };
		});
	}

	/** Request the current plan state from maestro. */
	planRead(): Promise<string> {
		if (this.pendingPlanRead) return Promise.resolve("");
		const id = randomUUID();
		this.client.send({ type: "planRead", id });
		return new Promise<string>((resolve) => {
			this.pendingPlanRead = { id, resolve };
		});
	}

	/** Request a plan mutation from maestro. */
	planMutate(
		action: "toggleTask" | "addTask" | "updateTask",
		groupId: string,
		params: {
			taskId?: string;
			title?: string;
			body?: string;
			kind?: WorkItemKind;
		},
	): Promise<PlanMutateResultMessage> {
		if (this.pendingPlanMutate) {
			return Promise.resolve({
				type: "planMutateResult",
				id: "",
				success: false,
				error: "busy",
			});
		}
		const id = randomUUID();
		this.client.send({ type: "planMutate", id, action, groupId, params });
		return new Promise<PlanMutateResultMessage>((resolve) => {
			this.pendingPlanMutate = { id, resolve };
		});
	}

	/** Clean up — settle any pending ask, then disconnect. */
	destroy(): void {
		this.settlePending();
		this.client.close();
	}

	private settlePending(): void {
		if (this.pendingAsk) {
			this.pendingAsk.resolve([]);
			this.pendingAsk = undefined;
		}
		if (this.pendingPlanRead) {
			this.pendingPlanRead.resolve("");
			this.pendingPlanRead = undefined;
		}
		if (this.pendingPlanMutate) {
			this.pendingPlanMutate.resolve({
				type: "planMutateResult",
				id: this.pendingPlanMutate.id,
				success: false,
				error: "shutdown",
			});
			this.pendingPlanMutate = undefined;
		}
	}

	private handleMessage(msg: MaestroMessage): void {
		switch (msg.type) {
			case "helloAck":
				// Connection gating on helloAck lands with the supervisor work.
				break;
			case "steer":
				this.deps.pi.sendUserMessage(msg.content, {
					deliverAs: "followUp",
				});
				break;
			case "answers": {
				const pending = this.pendingAsk;
				if (!pending || pending.id !== msg.id) break;
				this.pendingAsk = undefined;
				pending.resolve(msg.answers);
				break;
			}
			case "planReadResponse": {
				const pr = this.pendingPlanRead;
				if (!pr || pr.id !== msg.id) break;
				this.pendingPlanRead = undefined;
				pr.resolve(msg.content);
				break;
			}
			case "planMutateResult": {
				const pm = this.pendingPlanMutate;
				if (!pm || pm.id !== msg.id) break;
				this.pendingPlanMutate = undefined;
				pm.resolve(msg);
				break;
			}
			case "summarize":
				// Summary capture flow lands with the rpc-router work.
				break;
			case "doneAck":
				break;
			case "error":
				break;
			case "shutdown":
				this.settlePending();
				this.client.close();
				this.ctx?.shutdown();
				break;
			case "ping":
				this.client.send({ type: "pong", id: msg.id });
				break;
		}
	}

	private reportTokens(): void {
		this.client.send({
			type: "tokens",
			snapshot: {
				input: this.totalInput,
				output: this.totalOutput,
				cacheRead: this.totalCacheRead,
				cacheWrite: this.totalCacheWrite,
				totalTokens: this.totalInput + this.totalOutput,
				cost: this.totalCost,
				turns: this.turnCount,
			},
		});
	}
}

/**
 * Detect whether this pi instance is running as a maestro agent.
 */
export function isAgentMode(): boolean {
	return !!process.env.PI_MAESTRO_SOCK && !!process.env.PI_MAESTRO_AGENT_ID;
}

/**
 * Initialize the agent bridge if running in agent mode.
 * Returns the bridge instance (for wiring into event hooks) or undefined.
 */
export function initAgentBridge(pi: ExtensionAPI): AgentBridge | undefined {
	const socketPath = process.env.PI_MAESTRO_SOCK;
	const agentId = process.env.PI_MAESTRO_AGENT_ID;
	if (!socketPath || !agentId) return undefined;
	return new AgentBridge({ pi, socketPath, agentId });
}
