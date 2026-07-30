// The other half of a question: receiving one.
//
// `AskTransportV1` describes only `present()` — how a question LEAVES a
// session. Nothing described how one arrives, so the first thing that forwarded
// questions (maestro, over its worker socket) improvised the receiving side in
// its own runtime: it kept its own registry, rendered questionnaires itself, and
// built `Answers` by copying ONE string across every question in the set. A
// worker asking three things got the same reply to all three, because the code
// answering had no idea what a questionnaire was.
//
// This is that missing half, in the package that owns what a question IS. A
// transport delivers questions here; something answers them; the answers go
// back the way they came. Who owns the wire is the caller's business — the
// inbox never knows there is one.

import type { Answers, Questionnaire } from "@vegardx/pi-contracts";

export interface InboundQuestion {
	/** Opaque, and the sink's to choose — it has to route the answer back. */
	readonly id: string;
	/** Who is waiting, for display. A worker id, another session, anything. */
	readonly from: string;
	readonly questions: Questionnaire;
	readonly receivedAt: string;
}

/** Settle an inbound question. Called once; the inbox drops the entry first. */
export type SettleInbound = (answers: Answers) => void;

export class AskInbox {
	readonly #open = new Map<
		string,
		{ readonly question: InboundQuestion; readonly settle: SettleInbound }
	>();

	/**
	 * Take delivery of a question from elsewhere.
	 *
	 * Returns the entry so a sink can announce it however it likes — the inbox
	 * holds the state and takes no view on how a human or a model is told.
	 */
	receive(question: InboundQuestion, settle: SettleInbound): InboundQuestion {
		this.#open.set(question.id, { question, settle });
		return question;
	}

	open(): readonly InboundQuestion[] {
		return [...this.#open.values()].map((entry) => entry.question);
	}

	get size(): number {
		return this.#open.size;
	}

	has(id: string): boolean {
		return this.#open.has(id);
	}

	/**
	 * Answer one, per question.
	 *
	 * EVERY question must be answered. The asker is blocked on the whole set, so
	 * a partial reply would unblock it with gaps it cannot tell from real
	 * answers — and the version this replaces did worse, stamping one string
	 * onto all of them.
	 */
	settle(id: string, answers: Answers): void {
		const entry = this.#open.get(id);
		if (!entry) throw new UnknownInboundQuestion(id, [...this.#open.keys()]);

		const wanted = entry.question.questions.map((question) => question.id);
		const given = new Set(answers.map((answer) => answer.questionId));
		const missing = wanted.filter((questionId) => !given.has(questionId));
		if (missing.length > 0) throw new IncompleteAnswer(id, missing);
		const unknown = [...given].filter(
			(questionId) => !wanted.includes(questionId),
		);
		if (unknown.length > 0) throw new IncompleteAnswer(id, [], unknown);

		// Dropped BEFORE settling: `settle` hands control to the transport, and a
		// second answer for a question already on its way back is worse than none.
		this.#open.delete(id);
		entry.settle(answers);
	}

	/**
	 * Answer everything still open, with one reason.
	 *
	 * For the case where the answerer is going away — a session ending, a socket
	 * closing. Silence would leave the asker blocked forever, and "no answer" is
	 * a worse thing to be told than the truth about why.
	 */
	drain(value: string): number {
		const entries = [...this.#open.values()];
		this.#open.clear();
		for (const entry of entries)
			entry.settle(
				entry.question.questions.map((question) => ({
					questionId: question.id,
					value,
				})),
			);
		return entries.length;
	}
}

export class UnknownInboundQuestion extends Error {
	constructor(
		readonly id: string,
		readonly openIds: readonly string[],
	) {
		super(
			`nothing is waiting on \`${id}\` (waiting: ${
				openIds.join(", ") || "none"
			})`,
		);
		this.name = "UnknownInboundQuestion";
	}
}

export class IncompleteAnswer extends Error {
	constructor(
		readonly id: string,
		readonly missing: readonly string[],
		readonly unknown: readonly string[] = [],
	) {
		super(
			missing.length > 0
				? `\`${id}\` is still waiting on: ${missing.join(", ")}. Answer every question — the asker is blocked on all of them.`
				: `\`${id}\` was never asked: ${unknown.join(", ")}`,
		);
		this.name = "IncompleteAnswer";
	}
}
