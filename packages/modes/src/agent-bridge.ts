import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { MaestroRpcClient, type OrchestratorMessage } from "@vegardx/pi-rpc";

/**
 * Agent-side RPC bridge. Activated when the agent detects it's running
 * under the orchestrator (PI_MAESTRO_SOCK env var is set).
 *
 * Responsibilities:
 * - Connect to orchestrator via Unix socket RPC
 * - Report status transitions (working/idle) on turn boundaries
 * - Forward steer messages as user messages
 * - Shut down gracefully on orchestrator request
 * - Report token usage periodically
 */

export interface AgentBridgeDeps {
	readonly pi: ExtensionAPI;
	readonly socketPath: string;
	readonly agentId: string;
}

export class AgentBridge {
	private client: MaestroRpcClient;
	private ctx: ExtensionContext | undefined;
	private turnCount = 0;
	private totalInput = 0;
	private totalOutput = 0;

	constructor(private readonly deps: AgentBridgeDeps) {
		this.client = new MaestroRpcClient({ reconnect: true });
	}

	/**
	 * Initialize the bridge. Call during session_start.
	 */
	start(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.client.on("message", (msg) => this.handleMessage(msg));
		this.client.connect(this.deps.socketPath, this.deps.agentId);
	}

	/**
	 * Signal turn started — agent is working.
	 */
	onTurnStart(): void {
		this.client.send({ type: "status", status: "working" });
	}

	/**
	 * Signal turn ended — agent is idle, waiting for orchestrator decision.
	 */
	onTurnEnd(usage?: { input?: number; output?: number }): void {
		this.turnCount++;
		if (usage) {
			this.totalInput += usage.input ?? 0;
			this.totalOutput += usage.output ?? 0;
		}
		this.client.send({ type: "status", status: "idle" });
		this.reportTokens();
	}

	/**
	 * Signal an error occurred.
	 */
	onError(detail?: string): void {
		this.client.send({ type: "status", status: "error", detail });
	}

	/**
	 * Signal the agent completed its work.
	 */
	onDone(summary?: string): void {
		this.client.send({ type: "done", summary });
	}

	/**
	 * Report a task as completed to the orchestrator.
	 */
	onTaskComplete(taskId: string): void {
		this.client.send({ type: "taskComplete", taskId });
	}

	/**
	 * Clean up — disconnect from orchestrator.
	 */
	destroy(): void {
		this.client.close();
	}

	private handleMessage(msg: OrchestratorMessage): void {
		switch (msg.type) {
			case "steer":
				this.deps.pi.sendUserMessage(msg.content, {
					deliverAs: "followUp",
				});
				break;
			case "shutdown":
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
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: this.totalInput + this.totalOutput,
				cost: 0,
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
