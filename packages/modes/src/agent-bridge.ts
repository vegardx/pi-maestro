import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
	Answers,
	ChildRunProjection,
	ChildRunProjectionSourceV1,
	Questionnaire,
	ResolvedAgentAssignment,
	RunId,
	UsageCheckpoint,
	WorkItemKind,
} from "@vegardx/pi-contracts";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import type { MaestroContext } from "@vegardx/pi-core";
import {
	type ChildRunControlRequestMessage,
	type DebugProposalMessage,
	type DebugRecoveryProposalWire,
	type DebugResultMessage,
	type MaestroMessage,
	MaestroRpcClient,
	type PlanMutateResultMessage,
} from "@vegardx/pi-rpc";

export const AGENT_STOP_NOTICE_ENTRY = "maestro.agent.stop";

export interface AgentStopNotice {
	readonly version: 1;
	readonly requestedAt: number;
	readonly deadlineAt: number;
	readonly reason?: string;
	readonly generation: number;
	readonly activeTurn: boolean;
	readonly children: readonly string[];
	readonly usageRevision: number;
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
	readonly assignment?: ResolvedAgentAssignment;
	readonly generation?: number;
	/** Worker-local authoritative run projection/control source. */
	readonly childRuns?: () => ChildRunProjectionSourceV1 | undefined;
	/** Optional durable sink for stop notices (defaults to sessionManager). */
	readonly persistStopNotice?: (notice: AgentStopNotice) => void;
	/** Timeout for planRead/planMutate requests. Default: 30s. */
	readonly requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function defaultAssignment(agentId: string): ResolvedAgentAssignment {
	return {
		agentId,
		kind: "worker",
		presetId: "worker",
		modelSetId: "session",
		optionId: "session",
		modelId: "session",
		runtime: {
			mode: "full",
			transport: "tmux",
			tools: {},
			session: "persistent",
			isolation: "host",
		},
		focus: "Execute the assigned deliverable.",
		rationale: "Runtime compatibility assignment.",
		inputContracts: [],
		outputContracts: [],
		provenance: {
			source: "session",
			presetId: "worker",
			modelSetId: "session",
			optionId: "session",
			resolvedAt: new Date().toISOString(),
		},
		resolvedAt: new Date().toISOString(),
		source: "session",
	};
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
	private usageRevision = 0;
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
	private childUnsubscribe: (() => void) | undefined;
	private childSource: ChildRunProjectionSourceV1 | undefined;
	private childGeneration = 0;
	private childSyncIds = new Map<
		string,
		{
			readonly runs: readonly ChildRunProjection[];
			readonly timer: ReturnType<typeof setTimeout>;
		}
	>();
	private dirtyChildren = new Map<RunId, ChildRunProjection>();
	private stopping = false;

	constructor(private readonly deps: AgentBridgeDeps) {
		this.client = new MaestroRpcClient({ reconnect: true });
	}

	/** Initialize the bridge. Call during session_start. */
	start(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.childGeneration =
			this.deps.generation ??
			Number.parseInt(process.env.PI_MAESTRO_GENERATION ?? "0", 10);
		this.client.on("message", (msg) => this.handleMessage(msg));
		this.installChildSource();
		this.client.connect(this.deps.socketPath, {
			agentId: this.deps.agentId,
			role: "agent",
			kind: this.deps.assignment?.kind ?? "worker",
			generation: this.childGeneration,
			assignment: this.deps.assignment ?? defaultAssignment(this.deps.agentId),
			token: process.env.PI_MAESTRO_TOKEN ?? "",
			pid: process.pid,
		});
	}

	/** Signal turn started — agent is working. */
	onTurnStart(): void {
		if (!this.childSource) this.reconcileChildren();
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

	/** Forward a worker-owned child run's cumulative checkpoint. */
	sendUsageCheckpoint(checkpoint: UsageCheckpoint): void {
		this.client.send({ type: "usageCheckpoint", checkpoint });
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
			summary?: string;
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
			summary?: string;
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
		this.childUnsubscribe?.();
		this.childUnsubscribe = undefined;
		this.childSource = undefined;
		for (const pending of this.childSyncIds.values())
			clearTimeout(pending.timer);
		this.childSyncIds.clear();
		this.settlePending();
		this.client.close();
	}

	private settlePending(): void {
		this.settleAsk([]);
		this.settlePlanRead("");
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

	private settleDebug(result: DebugResultMessage): void {
		const pending = this.pendingDebug;
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pendingDebug = undefined;
		pending.resolve(result);
	}

	private installChildSource(): ChildRunProjectionSourceV1 | undefined {
		const source = this.deps.childRuns?.();
		if (!source || source === this.childSource) return source;
		this.childUnsubscribe?.();
		this.childSource = source;
		this.childUnsubscribe = source.subscribe((projection) => {
			this.dirtyChildren.set(projection.runId, projection);
			this.flushChildUpdates(false);
		});
		return source;
	}

	private reconcileChildren(): void {
		const source = this.installChildSource();
		if (!source) return;
		for (const projection of source.list()) {
			this.dirtyChildren.set(projection.runId, projection);
		}
		this.flushChildUpdates(true);
	}

	private flushChildUpdates(reconcile: boolean): void {
		const runs = reconcile
			? (this.installChildSource()?.list() ?? [])
			: [...this.dirtyChildren.values()];
		if (!reconcile && runs.length === 0) return;
		const id = randomUUID();
		if (
			!this.client.send({
				type: "childRunSync",
				id,
				ownerGeneration: this.childGeneration,
				reconcile,
				runs,
			})
		)
			return;
		const timer = setTimeout(() => {
			const pending = this.childSyncIds.get(id);
			if (!pending) return;
			this.childSyncIds.delete(id);
			for (const projection of pending.runs) {
				const current = this.dirtyChildren.get(projection.runId);
				if (!current || current.revision < projection.revision) {
					this.dirtyChildren.set(projection.runId, projection);
				}
			}
			this.flushChildUpdates(false);
		}, this.deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
		timer.unref?.();
		this.childSyncIds.set(id, { runs, timer });
	}

	private async handleChildControl(
		msg: ChildRunControlRequestMessage,
	): Promise<void> {
		const source = this.installChildSource();
		const base = {
			type: "childRunControlResult" as const,
			id: msg.id,
			ownerGeneration: this.childGeneration,
			runId: msg.runId,
			action: msg.action,
		};
		if (!source || msg.ownerGeneration !== this.childGeneration) {
			this.client.send({
				...base,
				ok: false,
				error: "stale or unavailable owner",
			});
			return;
		}
		try {
			const runId = msg.runId as RunId;
			switch (msg.action) {
				case "steer":
					source.steer(runId, msg.guidance ?? "");
					this.client.send({ ...base, ok: true });
					break;
				case "interrupt": {
					const result = await source.interrupt(runId, msg.reason);
					this.client.send({ ...base, ok: true, outcome: result.outcome });
					break;
				}
				case "capture": {
					const content = await source.capture(runId, msg.lines);
					this.client.send({
						...base,
						ok: true,
						...(content ? { content } : {}),
					});
					break;
				}
				case "stop":
					source.stop(runId, msg.reason);
					this.client.send({ ...base, ok: true });
					break;
			}
		} catch (error) {
			this.client.send({
				...base,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private persistStopNotice(notice: AgentStopNotice): void {
		if (this.deps.persistStopNotice) {
			this.deps.persistStopNotice(notice);
			return;
		}
		const manager = this.ctx?.sessionManager as unknown as
			| { appendCustomEntry?: (type: string, data: unknown) => void }
			| undefined;
		manager?.appendCustomEntry?.(AGENT_STOP_NOTICE_ENTRY, notice);
	}

	private async prepareStop(
		msg: import("@vegardx/pi-rpc").PrepareStopMessage,
	): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		const source = this.installChildSource();
		const liveChildren = (source?.list() ?? []).filter(
			(child) =>
				!["succeeded", "failed", "stopped", "canceled", "timed-out"].includes(
					child.status,
				),
		);
		this.persistStopNotice({
			version: 1,
			requestedAt: msg.requestedAt,
			deadlineAt: msg.deadlineAt,
			...(msg.reason ? { reason: msg.reason } : {}),
			generation: this.childGeneration,
			activeTurn: Boolean(this.activeTurnId),
			children: liveChildren.map((child) => child.runId as string),
			usageRevision: this.usageRevision,
		});
		if (this.activeTurnId && !this.ctx?.isIdle()) this.ctx?.abort();
		for (const child of liveChildren) {
			source?.stop(child.runId, msg.reason ?? "worker stopping");
		}
		this.reconcileChildren();
		this.reportTokens();
		this.settlePending();
		this.client.send({
			type: "status",
			status: "stopping",
			detail: msg.reason,
		});
		this.client.send({
			type: "prepareStopAck",
			id: msg.id,
			completedAt: Date.now(),
			children: liveChildren.length,
			usageRevision: this.usageRevision,
			outcome: "cooperative",
		});
		this.client.close();
		this.ctx?.shutdown();
	}

	private handleMessage(msg: MaestroMessage): void {
		switch (msg.type) {
			case "helloAck": {
				if (msg.ok) {
					setTimeout(() => this.reconcileChildren(), 0).unref?.();
					break;
				}
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
			case "childRunSyncAck": {
				if (msg.ownerGeneration !== this.childGeneration) break;
				const pending = this.childSyncIds.get(msg.id);
				this.childSyncIds.delete(msg.id);
				if (!pending) break;
				clearTimeout(pending.timer);
				const sent = pending.runs;
				const accepted = new Map(
					msg.accepted.map((item) => [item.runId, item.revision]),
				);
				for (const projection of sent) {
					const current = this.dirtyChildren.get(projection.runId);
					if (
						current &&
						current.revision <= (accepted.get(projection.runId as string) ?? -1)
					) {
						this.dirtyChildren.delete(projection.runId);
					}
				}
				break;
			}
			case "childRunControl": {
				void this.handleChildControl(msg);
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
			case "prepareStop":
				void this.prepareStop(msg);
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
		this.usageRevision++;
		this.client.send({
			type: "tokens",
			revision: this.usageRevision,
			snapshot: {
				input: this.totalInput,
				output: this.totalOutput,
				cacheRead: this.totalCacheRead,
				cacheWrite: this.totalCacheWrite,
				promptTokens:
					this.totalInput + this.totalCacheRead + this.totalCacheWrite,
				totalTokens:
					this.totalInput +
					this.totalCacheRead +
					this.totalCacheWrite +
					this.totalOutput,
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
export function initAgentBridge(
	pi: ExtensionAPI,
	maestro?: MaestroContext,
): AgentBridge | undefined {
	const socketPath = process.env.PI_MAESTRO_SOCK;
	const agentId = process.env.PI_MAESTRO_AGENT_ID;
	if (!socketPath || !agentId) return undefined;
	return new AgentBridge({
		pi,
		socketPath,
		agentId,
		childRuns: () =>
			maestro?.capabilities.get(CAPABILITIES.childRunProjections),
	});
}
