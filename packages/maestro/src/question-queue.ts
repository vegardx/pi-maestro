import type { Answers, Questionnaire } from "@vegardx/pi-contracts";

/**
 * A pending decision request from an agent. The maestro holds it until
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
}

export type PendingQuestionInput = Omit<
	PendingQuestion,
	"receivedAt" | "draft"
>;

/**
 * FIFO queue of agent decision requests. At most one entry per agent
 * (guaranteed by the blocking ask model: an agent cannot issue a second ask
 * until the first resolves). Answering targets an entry by agentId, so the
 * dashboard can answer out of FIFO order.
 */
export class QuestionQueue {
	private pending: PendingQuestion[] = [];

	enqueue(entry: PendingQuestionInput): void {
		// Replace any stale entry for the same agent (shouldn't happen, but keep
		// the invariant of one-per-agent).
		this.pending = this.pending.filter((p) => p.agentId !== entry.agentId);
		this.pending.push({ ...entry, draft: [], receivedAt: Date.now() });
	}

	count(): number {
		return this.pending.length;
	}

	/** The oldest pending entry (FIFO), or undefined. */
	peek(): PendingQuestion | undefined {
		return this.pending[0];
	}

	pendingForAgent(agentId: string): PendingQuestion | undefined {
		return this.pending.find((p) => p.agentId === agentId);
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
	answer(agentId: string, answers: Answers): void {
		const idx = this.pending.findIndex((p) => p.agentId === agentId);
		if (idx === -1) return;
		const [entry] = this.pending.splice(idx, 1);
		entry.resolve(answers);
	}

	/** Drop an agent's entry (e.g. it died) without resolving to the user. */
	drop(agentId: string): void {
		this.pending = this.pending.filter((p) => p.agentId !== agentId);
	}
}
