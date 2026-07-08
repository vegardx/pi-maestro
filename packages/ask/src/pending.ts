// The pending question set: one ordered, merged collection of unanswered
// questions. Non-blocking posts append; blocking raises jump to the front
// (or right after the question the user currently has open). Pure state —
// the engine wires it to the widget and to answer delivery.

import type {
	Answer,
	Answers,
	PendingAsk,
	Question,
	Questionnaire,
} from "@vegardx/pi-contracts";

export interface PendingEntry {
	readonly question: Question;
	readonly blocking: boolean;
	/** A blocking question the user deferred (demoted, tool call resolved). */
	readonly deferred: boolean;
}

export class PendingSet {
	#entries: PendingEntry[] = [];

	get size(): number {
		return this.#entries.length;
	}

	/** Blocking questions that still capture input (not yet deferred). */
	get activeBlockingIds(): readonly string[] {
		return this.#entries
			.filter((e) => e.blocking && !e.deferred)
			.map((e) => e.question.id);
	}

	get deferredCount(): number {
		return this.#entries.filter((e) => e.deferred).length;
	}

	/** Merge non-blocking questions in (upsert by id, append new). */
	post(questions: Questionnaire): void {
		for (const question of questions) {
			const at = this.#indexOf(question.id);
			const entry = { question, blocking: false, deferred: false };
			if (at >= 0) this.#entries[at] = entry;
			else this.#entries.push(entry);
		}
	}

	/**
	 * Merge blocking questions in at the front of the queue — or immediately
	 * after `afterId` (the question the user has open), so a raise never
	 * yanks them out of what they are answering.
	 */
	raise(questions: Questionnaire, afterId?: string): void {
		for (const question of questions) {
			const existing = this.#indexOf(question.id);
			if (existing >= 0) this.#entries.splice(existing, 1);
		}
		const after = afterId === undefined ? -1 : this.#indexOf(afterId);
		const entries = questions.map((question) => ({
			question,
			blocking: true,
			deferred: false,
		}));
		this.#entries.splice(after + 1, 0, ...entries);
	}

	/** The set as an ordered questionnaire for the widget. */
	questionnaire(): Questionnaire {
		return this.#entries.map((e) => e.question);
	}

	/** Posted-but-unanswered view for preamble context lines. */
	list(): readonly PendingAsk[] {
		return this.#entries.map((e) => ({
			id: e.question.id,
			header: e.question.header,
			question: e.question.question,
			...(e.deferred ? { deferred: true } : {}),
		}));
	}

	/**
	 * Remove entries answered by `answers`; returns only the answers that
	 * matched a live entry (already-settled ids pass through silently, so a
	 * final review commit never double-delivers).
	 */
	settle(answers: Answers): Answers {
		const settled: Answer[] = [];
		for (const answer of answers) {
			const at = this.#indexOf(answer.questionId);
			if (at < 0) continue;
			this.#entries.splice(at, 1);
			settled.push(answer);
		}
		return settled;
	}

	/**
	 * Demote every active blocking question to a deferred pending one.
	 * Returns the deferred ids (their waiters resolve with `deferred: true`).
	 */
	defer(): readonly string[] {
		const ids: string[] = [];
		this.#entries = this.#entries.map((e) => {
			if (!e.blocking || e.deferred) return e;
			ids.push(e.question.id);
			return { ...e, deferred: true };
		});
		return ids;
	}

	#indexOf(id: string): number {
		return this.#entries.findIndex((e) => e.question.id === id);
	}
}
