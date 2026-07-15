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
	type DebugProposalMessage,
	type DebugRecoveryProposalWire,
	type DebugResultMessage,
	type MaestroMessage,
	MaestroRpcClient,
	type PanelReviewerSpec,
	type PanelVerdictEntry,
	type PlanMutateResultMessage,
	type ReviewLedgerWire,
} from "@vegardx/pi-rpc";

/** What panelRead returns: the live panel + the persisted review ledger. */
export interface PanelReadResult {
	readonly panel: readonly PanelReviewerSpec[];
	readonly ledger?: ReviewLedgerWire;
	/** Canonical finding ids the human has waived (never re-litigated). */
	readonly waivedFindingIds?: readonly string[];
}

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
	/** Timeout for planRead/planMutate requests. Default: 30s. */
	readonly requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

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
		| {
				id: string;
				resolve: (content: string) => void;
				timer: ReturnType<typeof setTimeout>;
		  }
		| undefined;
	private pendingPlanMutate:
		| {
				id: string;
				resolve: (result: PlanMutateResultMessage) => void;
				timer: ReturnType<typeof setTimeout>;
		  }
		| undefined;
	private pendingDebug:
		| {
				id: string;
				resolve: (result: DebugResultMessage) => void;
				timer: ReturnType<typeof setTimeout>;
		  }
		| undefined;
	/** Serializes planMutate calls — one in flight, the rest queue behind it. */
	private mutateChain: Promise<unknown> = Promise.resolve();
	private pendingPanelRead:
		| {
				id: string;
				resolve: (result: PanelReadResult) => void;
				timer: ReturnType<typeof setTimeout>;
		  }
		| undefined;
	/**
	 * Summarize capture state. `armed` flips true on the first turn_start
	 * after the summarization prompt is injected: pi delivers the followUp as
	 * the next turn, so that turn's assistant text is the summary. A turn
	 * already in flight when summarize arrives ends un-armed and its mid-work
	 * commentary is NOT captured.
	 */
	private pendingSummarize: { id: string; armed: boolean } | undefined;
	private activeTurnId: string | undefined;
	private interruptingTurnId: string | undefined;
	private queuedSteers: string[] = [];
	private lastAssistantText = "";

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
		this.activeTurnId = randomUUID();
		this.interruptingTurnId = undefined;
		// Arm the summarize capture: the first turn to start after the prompt
		// injection is the turn responding to it (a turn already in flight when
		// summarize arrived has had its turn_start, so it cannot re-arm here).
		if (this.pendingSummarize && !this.pendingSummarize.armed) {
			this.pendingSummarize.armed = true;
		}
		this.client.send({ type: "status", status: "working" });
	}

	/** Signal turn ended — agent is idle, waiting for maestro decision. */
	onTurnEnd(): void {
		this.turnCount++;
		this.activeTurnId = undefined;
		this.interruptingTurnId = undefined;
		// Summarize capture rule: the assistant text of the turn that answered
		// the injected summarization prompt IS the summary. Other injections are
		// queued while a summarize is pending so nothing interleaves. An
		// un-armed pending means this turn was already in flight when the
		// summarize arrived — skip it; the injected prompt runs next turn.
		if (this.pendingSummarize?.armed) {
			this.client.send({
				type: "summary",
				id: this.pendingSummarize.id,
				content: this.lastAssistantText,
			});
			this.pendingSummarize = undefined;
			for (const steer of this.queuedSteers.splice(0)) {
				this.deps.pi.sendUserMessage(steer, { deliverAs: "followUp" });
			}
		}
		this.client.send({ type: "status", status: "idle" });
		this.reportTokens();
	}

	/** Record the latest assistant message text (for summarize capture). */
	recordAssistantText(text: string): void {
		if (text.trim().length > 0) this.lastAssistantText = text;
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
	onTaskComplete(deliverableId: string, taskId: string): void {
		this.client.send({
			type: "planMutate",
			id: randomUUID(),
			action: "toggleTask",
			deliverableId,
			params: { taskId },
		});
	}

	/**
	 * Report a completed review-panel round's verdicts to the maestro. Fire-
	 * and-forget: the executor reads the latest round to gate ship, independent
	 * of the worker's own "done" claim.
	 */
	reportPanelVerdict(
		deliverableId: string,
		round: number,
		verdicts: readonly PanelVerdictEntry[],
		opts?: {
			roundKind?: "panel" | "verification" | "round-started";
			ledger?: ReviewLedgerWire;
		},
	): void {
		this.client.send({
			type: "panelVerdict",
			deliverableId,
			round,
			verdicts,
			...(opts?.roundKind ? { roundKind: opts.roundKind } : {}),
			...(opts?.ledger ? { ledger: opts.ledger } : {}),
		});
	}

	/**
	 * Request this deliverable's live review panel plus the persisted review
	 * ledger (a respawned worker rehydrates its review episode from it).
	 */
	panelRead(deliverableId: string): Promise<PanelReadResult> {
		if (this.pendingPanelRead) return Promise.resolve({ panel: [] });
		const id = randomUUID();
		const timeoutMs = this.deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.client.send({ type: "panelRead", id, deliverableId });
		return new Promise<PanelReadResult>((resolve) => {
			const timer = setTimeout(() => {
				if (this.pendingPanelRead?.id !== id) return;
				this.pendingPanelRead = undefined;
				resolve({ panel: [] });
			}, timeoutMs);
			timer.unref?.();
			this.pendingPanelRead = { id, resolve, timer };
		});
	}

	/**
	 * Send questions to the maestro and block until answers arrive.
	 * Resolves empty on shutdown/destroy so a blocked agent exits cleanly.
	 * No timeout — a human is in the loop — but an error{id} from the maestro
	 * (e.g. code:"cancelled") settles it empty. Only one ask may be pending at
	 * a time (guaranteed by the blocking tool model); a second while one is
	 * pending rejects so the tool layer surfaces a real error to the model
	 * instead of fabricating an empty answer.
	 */
	ask(questions: Questionnaire): Promise<Answers> {
		if (this.pendingAsk) {
			return Promise.reject(new Error("ask already pending"));
		}
		const id = randomUUID();
		this.client.send({ type: "questions", id, questions });
		return new Promise<Answers>((resolve) => {
			this.pendingAsk = { id, resolve };
		});
	}

	/** Request the current plan state from maestro. Times out with an error. */
	planRead(): Promise<string> {
		if (this.pendingPlanRead) return Promise.resolve("");
		const id = randomUUID();
		const timeoutMs = this.deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.client.send({ type: "planRead", id });
		return new Promise<string>((resolve) => {
			const timer = setTimeout(() => {
				if (this.pendingPlanRead?.id !== id) return;
				this.pendingPlanRead = undefined;
				resolve(`Error: plan read timed out after ${timeoutMs}ms.`);
			}, timeoutMs);
			timer.unref?.();
			this.pendingPlanRead = { id, resolve, timer };
		});
	}

	/**
	 * Request a plan mutation from maestro. Calls SERIALIZE: a model turn often
	 * toggles several tasks as parallel tool calls, and rejecting the overlap
	 * with "busy" silently dropped all but one — task state drifted from the
	 * real work until someone reconciled by hand. Times out with an error
	 * result.
	 */
	planMutate(
		action: "toggleTask" | "addTask" | "updateTask",
		deliverableId: string,
		params: {
			taskId?: string;
			title?: string;
			body?: string;
			kind?: WorkItemKind;
		},
	): Promise<PlanMutateResultMessage> {
		const run = this.mutateChain.then(() =>
			this.planMutateNow(action, deliverableId, params),
		);
		this.mutateChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private planMutateNow(
		action: "toggleTask" | "addTask" | "updateTask",
		deliverableId: string,
		params: {
			taskId?: string;
			title?: string;
			body?: string;
			kind?: WorkItemKind;
		},
	): Promise<PlanMutateResultMessage> {
		const id = randomUUID();
		const timeoutMs = this.deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.client.send({ type: "planMutate", id, action, deliverableId, params });
		return new Promise<PlanMutateResultMessage>((resolve) => {
			const timer = setTimeout(() => {
				if (this.pendingPlanMutate?.id !== id) return;
				this.pendingPlanMutate = undefined;
				resolve({
					type: "planMutateResult",
					id,
					success: false,
					error: `plan mutate timed out after ${timeoutMs}ms`,
				});
			}, timeoutMs);
			timer.unref?.();
			this.pendingPlanMutate = { id, resolve, timer };
		});
	}

	/**
	 * Submit a generation/fingerprint-bound debug proposal to the maestro.
	 * A timeout is an explicit local-only result; workers never recover themselves.
	 */
	proposeDebug(input: {
		proposalId?: string;
		generation: number;
		planFingerprint: string;
		observed: readonly string[];
		likelyCause: string;
		recovery?: DebugRecoveryProposalWire;
	}): Promise<DebugResultMessage> {
		if (this.pendingDebug) {
			return Promise.resolve({
				type: "debugResult",
				id: "",
				proposalId: input.proposalId ?? "",
				accepted: false,
				error: "another debug proposal is pending",
			});
		}
		const id = randomUUID();
		const proposalId = input.proposalId ?? randomUUID();
		const timeoutMs = this.deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		const message: DebugProposalMessage = {
			type: "debugProposal",
			id,
			proposalId,
			agentId: this.deps.agentId,
			generation: input.generation,
			planFingerprint: input.planFingerprint,
			observed: input.observed.slice(0, 32),
			likelyCause: input.likelyCause.slice(0, 2000),
			...(input.recovery ? { recovery: input.recovery } : {}),
		};
		this.client.send(message);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				if (this.pendingDebug?.id !== id) return;
				this.pendingDebug = undefined;
				resolve({
					type: "debugResult",
					id,
					proposalId,
					accepted: false,
					error: `maestro unavailable after ${timeoutMs}ms; no recovery was attempted`,
				});
			}, timeoutMs);
			timer.unref?.();
			this.pendingDebug = { id, resolve, timer };
		});
	}

	/** Clean up — settle any pending ask, then disconnect. */
	destroy(): void {
		this.settlePending();
		this.client.close();
	}

	private settlePending(): void {
		this.settleAsk([]);
		this.settlePlanRead("");
		this.settlePanelRead({ panel: [] });
		this.settleDebug({
			type: "debugResult",
			id: this.pendingDebug?.id ?? "",
			proposalId: "",
			accepted: false,
			error: "shutdown",
		});
		this.settlePlanMutate({
			type: "planMutateResult",
			id: this.pendingPlanMutate?.id ?? "",
			success: false,
			error: "shutdown",
		});
		this.pendingSummarize = undefined;
		this.queuedSteers.length = 0;
	}

	private settleAsk(answers: Answers): void {
		const pending = this.pendingAsk;
		if (!pending) return;
		this.pendingAsk = undefined;
		pending.resolve(answers);
	}

	private settlePlanRead(content: string): void {
		const pending = this.pendingPlanRead;
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pendingPlanRead = undefined;
		pending.resolve(content);
	}

	private settlePlanMutate(result: PlanMutateResultMessage): void {
		const pending = this.pendingPlanMutate;
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pendingPlanMutate = undefined;
		pending.resolve(result);
	}

	private settlePanelRead(result: PanelReadResult): void {
		const pending = this.pendingPanelRead;
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pendingPanelRead = undefined;
		pending.resolve(result);
	}

	private settleDebug(result: DebugResultMessage): void {
		const pending = this.pendingDebug;
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pendingDebug = undefined;
		pending.resolve(result);
	}

	private handleMessage(msg: MaestroMessage): void {
		switch (msg.type) {
			case "helloAck": {
				if (msg.ok) break;
				// A rejected agent must not keep working: settle everything,
				// stop reconnecting, and shut the session down.
				this.ctx?.ui.notify(
					`Maestro rejected connection: ${msg.error ?? "unknown error"}`,
					"error",
				);
				this.settlePending();
				this.client.close();
				this.ctx?.shutdown();
				break;
			}
			case "interrupt": {
				const active = this.activeTurnId;
				if (!active || this.ctx?.isIdle()) {
					this.client.send({
						type: "interruptAck",
						id: msg.id,
						turnId: active,
						outcome: "already-idle",
					});
					break;
				}
				if (msg.turnId && msg.turnId !== active) {
					this.client.send({
						type: "interruptAck",
						id: msg.id,
						turnId: active,
						outcome: "already-idle",
					});
					break;
				}
				if (this.interruptingTurnId === active) {
					this.client.send({
						type: "interruptAck",
						id: msg.id,
						turnId: active,
						outcome: "already-interrupting",
					});
					break;
				}
				this.interruptingTurnId = active;
				this.ctx?.abort();
				this.client.send({
					type: "interruptAck",
					id: msg.id,
					turnId: active,
					outcome: "accepted",
				});
				break;
			}
			case "steer":
				if (this.pendingSummarize) {
					this.queuedSteers.push(msg.content);
					break;
				}
				this.deps.pi.sendUserMessage(msg.content, {
					deliverAs: "followUp",
				});
				break;
			case "answers": {
				if (this.pendingAsk?.id !== msg.id) break;
				this.settleAsk(msg.answers);
				break;
			}
			case "planReadResponse": {
				if (this.pendingPlanRead?.id !== msg.id) break;
				this.settlePlanRead(msg.content);
				break;
			}
			case "panelReadResponse": {
				if (this.pendingPanelRead?.id !== msg.id) break;
				this.settlePanelRead({
					panel: msg.panel,
					...(msg.ledger ? { ledger: msg.ledger } : {}),
					...(msg.waivedFindingIds
						? { waivedFindingIds: msg.waivedFindingIds }
						: {}),
				});
				break;
			}
			case "planMutateResult": {
				if (this.pendingPlanMutate?.id !== msg.id) break;
				this.settlePlanMutate(msg);
				break;
			}
			case "debugResult": {
				if (this.pendingDebug?.id !== msg.id) break;
				this.settleDebug(msg);
				break;
			}
			case "summarize": {
				if (this.pendingSummarize) {
					// One at a time: settle the newcomer immediately with an
					// empty summary so the maestro falls back fast instead of
					// waiting out its request timeout.
					this.client.send({ type: "summary", id: msg.id, content: "" });
					break;
				}
				// Armed on the next turn_start — see pendingSummarize docs.
				this.pendingSummarize = { id: msg.id, armed: false };
				const prompt = [
					"Write a forward-looking summary of the work you completed in this session.",
					`It will be read by: ${msg.consumer}.`,
					msg.preamble,
					"Include only what future agents need to build on this work: what exists now, key decisions, interfaces and file paths, and gotchas. Do not narrate your process.",
					`Hard limit: ~${msg.budget} tokens.`,
					'Reply with ONLY the summary in markdown, starting with "## Summary".',
				].join("\n");
				this.deps.pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				break;
			}
			case "doneAck":
				break;
			case "error": {
				// Explicit failure for a pending request: settle it so tool
				// calls surface the error instead of hanging.
				if (!msg.id) break;
				if (this.pendingAsk?.id === msg.id) {
					this.settleAsk([]);
				} else if (this.pendingPlanRead?.id === msg.id) {
					this.settlePlanRead(`Error: ${msg.message}`);
				} else if (this.pendingPanelRead?.id === msg.id) {
					this.settlePanelRead({ panel: [] });
				} else if (this.pendingDebug?.id === msg.id) {
					this.settleDebug({
						type: "debugResult",
						id: msg.id,
						proposalId: "",
						accepted: false,
						error: msg.message,
					});
				} else if (this.pendingPlanMutate?.id === msg.id) {
					this.settlePlanMutate({
						type: "planMutateResult",
						id: msg.id,
						success: false,
						error: msg.message,
					});
				}
				break;
			}
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
