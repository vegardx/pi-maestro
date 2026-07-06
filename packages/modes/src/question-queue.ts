import type { Answers, Questionnaire } from "@vegardx/pi-contracts";

/**
 * A pending decision request from an agent. The orchestrator holds it until
 * the user answers (via /answer or the dashboard). `draft` accumulates partial
 * selections when the dialog is closed without sending, so reopening restores
 * progress. `resolve` sends the answers back over RPC.
 */
export interface PendingQuestion {
	readonly agentId: string;
	readonly agentName: string;
	readonly deliverableTitle: string;
	readonly questions: Questionnaire;
	/** Partial answers captured on dialog close; restored on reopen. */
	draft: Answers;
	readonly resolve: (answers: Answers) => void;
	readonly receivedAt: number;
	/** Whether the orchestrator LLM has been presented this question. */
	deliveredToLlm: boolean;
	/** Escalation timeout handle — fires if LLM doesn't answer in time. */
	timeoutHandle?: ReturnType<typeof setTimeout>;
	/** True when already resolved or escalated (guards double-fire). */
	settled: boolean;
}

export type PendingQuestionInput = Omit<
	PendingQuestion,
	"receivedAt" | "draft" | "deliveredToLlm" | "timeoutHandle" | "settled"
>;

/**
 * FIFO queue of agent decision requests. At most one entry per agent
 * (guaranteed by the blocking ask model: a worker cannot issue a second ask
 * until the first resolves). Answering targets an entry by agentId, so the
 * dashboard can answer out of FIFO order.
 */
export class QuestionQueue {
	private pending: PendingQuestion[] = [];

	enqueue(entry: PendingQuestionInput): void {
		// Replace any stale entry for the same agent (shouldn't happen, but keep
		// the invariant of one-per-agent).
		const existing = this.pending.find((p) => p.agentId === entry.agentId);
		if (existing) {
			if (existing.timeoutHandle) clearTimeout(existing.timeoutHandle);
			this.pending = this.pending.filter((p) => p.agentId !== entry.agentId);
		}
		this.pending.push({
			...entry,
			draft: [],
			receivedAt: Date.now(),
			deliveredToLlm: false,
			settled: false,
		});
	}

	count(): number {
		return this.pending.length;
	}

	/** The oldest pending entry (FIFO), or undefined. */
	peek(): PendingQuestion | undefined {
		return this.pending[0];
	}

	pendingForAgent(idOrName: string): PendingQuestion | undefined {
		return this.pending.find(
			(p) => p.agentId === idOrName || p.agentName === idOrName,
		);
	}

	all(): readonly PendingQuestion[] {
		return this.pending;
	}

	/** Save partial progress for an agent without resolving. */
	saveDraft(agentId: string, draft: Answers): void {
		const entry = this.pending.find((p) => p.agentId === agentId);
		if (entry) entry.draft = draft;
	}

	/** Resolve an agent's entry with answers and remove it from the queue. */
	answer(agentId: string, answers: Answers): boolean {
		const idx = this.pending.findIndex((p) => p.agentId === agentId);
		if (idx === -1) return false;
		const [entry] = this.pending.splice(idx, 1);
		if (entry.settled) return false;
		entry.settled = true;
		if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
		entry.resolve(answers);
		return true;
	}

	/** Mark an entry as delivered to the orchestrator LLM. */
	markDelivered(agentId: string): void {
		const entry = this.pending.find((p) => p.agentId === agentId);
		if (entry) entry.deliveredToLlm = true;
	}

	/** Get entries not yet delivered to the LLM. */
	undelivered(): readonly PendingQuestion[] {
		return this.pending.filter((p) => !p.deliveredToLlm && !p.settled);
	}

	/** Set the escalation timeout handle for an agent's entry. */
	setTimeout(agentId: string, handle: ReturnType<typeof setTimeout>): void {
		const entry = this.pending.find((p) => p.agentId === agentId);
		if (entry) entry.timeoutHandle = handle;
	}

	/** Cancel timeout and mark settled (for escalation path). */
	settle(agentId: string): void {
		const entry = this.pending.find((p) => p.agentId === agentId);
		if (entry) {
			entry.settled = true;
			if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
		}
	}

	/** Drop an agent's entry (e.g. it died) without resolving to the user. */
	drop(agentId: string): void {
		const existing = this.pending.find((p) => p.agentId === agentId);
		if (existing?.timeoutHandle) clearTimeout(existing.timeoutHandle);
		this.pending = this.pending.filter((p) => p.agentId !== agentId);
	}
}
