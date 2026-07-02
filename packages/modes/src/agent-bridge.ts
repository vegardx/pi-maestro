import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Answers, Questionnaire } from "@vegardx/pi-contracts";
import { MaestroRpcClient, type OrchestratorMessage } from "@vegardx/pi-rpc";

/**
 * Agent-side RPC bridge. Activated when the agent detects it's running
 * under the orchestrator (PI_MAESTRO_SOCK env var is set).
 *
 * Responsibilities:
 * - Connect to orchestrator via Unix socket RPC
 * - Report status transitions (working/idle) on turn boundaries
 * - Forward steer messages as user messages
 * - Route `ask` tool calls to the orchestrator and block for answers
 * - Report real token/cost usage (accumulated from assistant messages)
 * - Shut down gracefully on orchestrator request
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
	private pendingAsk: { resolve: (answers: Answers) => void } | undefined;

	constructor(private readonly deps: AgentBridgeDeps) {
		this.client = new MaestroRpcClient({ reconnect: true });
	}

	/** Initialize the bridge. Call during session_start. */
	start(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.client.on("message", (msg) => this.handleMessage(msg));
		this.client.connect(this.deps.socketPath, this.deps.agentId);
	}

	/** Signal turn started — agent is working. */
	onTurnStart(): void {
		this.client.send({ type: "status", status: "working" });
	}

	/** Signal turn ended — agent is idle, waiting for orchestrator decision. */
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
	onDone(summary?: string): void {
		this.client.send({ type: "done", summary });
	}

	/** Report a task as completed to the orchestrator. */
	onTaskComplete(taskId: string): void {
		this.client.send({ type: "taskComplete", taskId });
	}

	/**
	 * Send questions to the orchestrator and block until answers arrive.
	 * Resolves empty on shutdown/destroy so a blocked worker exits cleanly.
	 * Only one ask may be pending at a time (guaranteed by the blocking tool
	 * model); a second while one is pending resolves the newcomer empty.
	 */
	ask(questions: Questionnaire): Promise<Answers> {
		if (this.pendingAsk) return Promise.resolve([]);
		this.client.send({ type: "questions", questions });
		return new Promise<Answers>((resolve) => {
			this.pendingAsk = { resolve };
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
	}

	private handleMessage(msg: OrchestratorMessage): void {
		switch (msg.type) {
			case "steer":
				this.deps.pi.sendUserMessage(msg.content, {
					deliverAs: "followUp",
				});
				break;
			case "answers": {
				const pending = this.pendingAsk;
				this.pendingAsk = undefined;
				pending?.resolve(msg.answers);
				break;
			}
			case "shutdown":
				this.settlePending();
				this.client.close();
				this.ctx?.shutdown();
				break;
			case "ping":
				this.client.send({ type: "pong" });
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
