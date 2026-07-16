// The questionnaire engine: one pending set of questions surfaced through
// the maestro HUD (Questions tab + tab-bar counts) instead of a widget.
// Non-blocking `post()` returns immediately (answers deliver later as a
// follow-up user message); blocking `present()` keeps its promise pending,
// badges the footer ("maestro waiting on you") and — when the editor is
// empty — takes over the input with the answer editor. Input is NEVER
// captured wholesale: a user with a draft keeps typing and the blocking ask
// waits as a badge. It needs an ExtensionContext to reach ctx.ui, but the
// ask.v1 capability contract carries no ctx — so the extension captures the
// latest context off lifecycle events and the engine reads it here.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	Answer,
	Answers,
	OverlaysCapabilityV1,
	PendingAsk,
	Question,
	Questionnaire,
} from "@vegardx/pi-contracts";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import { getCapability, uiTrace } from "@vegardx/pi-core";
import {
	type AnswerModeHandle,
	openAnswerMode,
	paletteFromTheme,
	runQuestionnaire,
} from "@vegardx/pi-ui";
import { PendingSet } from "./pending.js";
import { parseShorthand, questionToDecisionPoint } from "./shorthand.js";

export type AskSource = "main" | string;

/** How long after the last committed answer the outbox flushes (batching). */
const FLUSH_DELAY_MS = 2_000;

/** Footer status key for the blocking-ask badge. */
const STATUS_KEY = "maestro.ask";

interface Waiter {
	readonly ids: ReadonlySet<string>;
	readonly collected: Map<string, Answer>;
	readonly resolve: (answers: Answers) => void;
}

interface OutboxEntry {
	readonly answer: Answer;
	readonly question: Question;
}

/** Pending-set counts pushed to the change listener (HUD refresh + event). */
export interface AskChange {
	readonly pending: number;
	readonly blocking: number;
}

/** Format settled answers as the follow-up message the agent receives. */
export function formatDelivery(entries: readonly OutboxEntry[]): string {
	const lines = entries.map(({ answer, question }) => {
		const label = question.header ?? question.id;
		if (answer.skipped) return `- ${answer.questionId} (${label}): skipped`;
		const parts = [`- ${answer.questionId} (${label}): ${answer.value}`];
		if (answer.custom) parts.push(" [free text]");
		if (answer.note) parts.push(` [note: ${answer.note}]`);
		return parts.join("");
	});
	return `The user answered pending question(s):\n${lines.join("\n")}`;
}

export class AskEngine {
	#ctx: ExtensionContext | undefined;
	#queued: Questionnaire = [];
	#set = new PendingSet();
	#questionById = new Map<string, Question>();
	#waiters: Waiter[] = [];
	#outbox: OutboxEntry[] = [];
	#flushTimer: ReturnType<typeof setTimeout> | undefined;
	/** Free text riding along with the next outbox flush (shorthand trailer). */
	#trailer: string | undefined;
	#deliver: ((text: string) => void) | undefined;
	#onChanged: ((change: AskChange) => void) | undefined;
	#answerHandle: AnswerModeHandle | undefined;
	/** Injectable presenter (tests swap the editor takeover for a fake). */
	readonly #openAnswerMode: typeof openAnswerMode;

	constructor(present: typeof openAnswerMode = openAnswerMode) {
		this.#openAnswerMode = present;
	}

	private get overlays(): OverlaysCapabilityV1 | undefined {
		return getCapability(CAPABILITIES.overlays) as
			| OverlaysCapabilityV1
			| undefined;
	}

	/** Update the context the engine renders through. Called on events. */
	setContext(ctx: ExtensionContext): void {
		this.#ctx = ctx;
	}

	/** Wire the follow-up message sink for non-blocking answers. */
	setDeliver(deliver: (text: string) => void): void {
		this.#deliver = deliver;
	}

	/** Observe pending-set changes (HUD refresh + askChanged event). */
	setOnChanged(listener: (change: AskChange) => void): void {
		this.#onChanged = listener;
	}

	/** Active (not deferred) blocking questions the maestro is waiting on. */
	get blockingCount(): number {
		return this.#set.activeBlockingIds.length;
	}

	/** @deprecated Use overlays capability instead. */
	setOverlayManager(_manager: unknown): void {}

	/**
	 * Non-blocking: merge questions into the pending set and return. Answers
	 * are delivered through the follow-up sink when the user commits them.
	 */
	post(questions: Questionnaire): void {
		if (questions.length === 0) return;
		uiTrace("ask.post", `n=${questions.length}`);
		for (const q of questions) this.#questionById.set(q.id, q);
		// Agent mode: route to the maestro; deliver whatever comes back.
		const transport = getCapability(CAPABILITIES.askTransport);
		if (transport) {
			void transport.present(questions).then((answers) => {
				const entries = this.#toEntries(answers);
				if (entries.length > 0) this.#deliver?.(formatDelivery(entries));
			});
			return;
		}
		const ctx = this.#ctx;
		if (!ctx?.hasUI) return;
		if (!this.overlays) {
			// Legacy dialog cannot pend; run it and deliver the answers.
			void runQuestionnaire(ctx, questions).then((answers) => {
				const entries = this.#toEntries(answers ?? []);
				if (entries.length > 0) this.#deliver?.(formatDelivery(entries));
			});
			return;
		}
		this.#set.post(questions);
		this.#changed();
	}

	/** Posted-but-unanswered questions (turn-start context lines, the HUD). */
	pending(): readonly PendingAsk[] {
		return this.#set.list();
	}

	/**
	 * Blocking: keep the promise pending until the questions are answered (or
	 * deferred). Presentation: the tab bar shows the blocking count, the
	 * footer says the maestro is waiting, and answer mode auto-opens ONLY
	 * when the editor is empty — a user mid-draft is never interrupted.
	 * @param questions - The questions to present
	 * @param source - "main" is the maestro's own blocking ask; agent ids pend
	 */
	async present(
		questions: Questionnaire,
		source: AskSource = "main",
	): Promise<Answers> {
		if (questions.length === 0) return [];
		uiTrace("ask.present", `n=${questions.length} source=${source}`);
		for (const q of questions) this.#questionById.set(q.id, q);
		// Agent mode: an ask-transport capability routes questions to the
		// maestro over RPC. Checked before the local-UI fallback so a
		// headless agent (no ctx.hasUI) still reaches the user.
		const transport = getCapability(CAPABILITIES.askTransport);
		if (transport) return transport.present(questions);
		const ctx = this.#ctx;
		if (!ctx?.hasUI) return [];

		if (!this.overlays) {
			// Fallback: legacy blocking dialog
			const answers = await runQuestionnaire(ctx, questions);
			return answers ?? [];
		}

		return new Promise<Answers>((resolve) => {
			this.#waiters.push({
				ids: new Set(questions.map((q) => q.id)),
				collected: new Map(),
				resolve,
			});
			if (source === "main") {
				// Blocking questions jump the queue — right after the question
				// the user currently has open in answer mode, front otherwise.
				this.#set.raise(questions, this.#answerHandle?.currentQuestionId);
				this.#changed();
				const draft = ctx.ui.getEditorText?.() ?? "";
				if (draft === "") this.#openBlockingAnswers();
			} else {
				// Worker questions: pend without stealing anything.
				this.#set.post(questions);
				this.#changed();
			}
		});
	}

	/**
	 * Enter answer mode for one pending question (the HUD's Questions tab
	 * Enter action). Replaces any open answer session.
	 */
	openAnswers(questionId: string): void {
		const ctx = this.#ctx;
		if (!ctx?.hasUI) return;
		const entry = this.#set.list().find((p) => p.id === questionId);
		const question = this.#set.find(questionId);
		if (!entry || !question) return;
		this.#answerHandle?.close();
		this.#openAnswerSession([question], entry.blocking === true);
	}

	/** Queue questions for the next flush (the plan-mode driver). */
	queue(questions: Questionnaire): void {
		if (questions.length === 0) return;
		this.#queued = [...this.#queued, ...questions];
	}

	/** Whether anything is waiting to be flushed. */
	get hasQueued(): boolean {
		return this.#queued.length > 0;
	}

	/**
	 * Present everything queued as one combined dialog and clear the queue.
	 * Resolves to the collected answers (empty when nothing was queued).
	 */
	async flush(source: AskSource = "main"): Promise<Answers> {
		if (this.#queued.length === 0) return [];
		const batch = this.#queued;
		this.#queued = [];
		return this.present(batch, source);
	}

	/**
	 * Resolve a shorthand reply (`2`, `1a 2b`, `rec`, optional trailer)
	 * against the pending set. On a match the answers settle through the
	 * normal path and everything (including the trailer) is delivered at
	 * once; returns true so the caller marks the input handled.
	 */
	applyShorthand(text: string): boolean {
		if (this.#set.size === 0) return false;
		const points = this.#set.questionnaire().map(questionToDecisionPoint);
		const match = parseShorthand(text, points);
		if (!match) return false;
		// The trailer rides along with whichever flush delivers the batch —
		// set before settling, since an emptied set flushes immediately.
		this.#trailer = match.trailer;
		this.#handleCommitted(match.answers);
		this.#flushOutbox();
		return true;
	}

	/** Settled answers → waiters first, then the outbox (batched delivery). */
	#handleCommitted(answers: Answers): void {
		const settled = this.#set.settle(answers);
		if (settled.length === 0) return;
		for (const answer of settled) {
			const waiter = this.#waiters.find(
				(w) =>
					w.ids.has(answer.questionId) && !w.collected.has(answer.questionId),
			);
			if (waiter) {
				waiter.collected.set(answer.questionId, answer);
			} else {
				const question = this.#questionById.get(answer.questionId);
				if (question) this.#outbox.push({ answer, question });
			}
		}
		this.#resolveReadyWaiters();
		this.#scheduleFlush();
		if (this.#set.size === 0) this.#flushOutbox();
		this.#changed();
	}

	/** Esc on a blocking question: demote it, resolve its waiter, move on. */
	#handleDefer(): void {
		const ids = this.#set.defer();
		for (const id of ids) {
			const waiter = this.#waiters.find(
				(w) => w.ids.has(id) && !w.collected.has(id),
			);
			waiter?.collected.set(id, { questionId: id, value: "", deferred: true });
		}
		this.#resolveReadyWaiters();
		this.#flushOutbox();
		this.#changed();
	}

	#resolveReadyWaiters(): void {
		this.#waiters = this.#waiters.filter((waiter) => {
			if (waiter.collected.size < waiter.ids.size) return true;
			waiter.resolve([...waiter.collected.values()]);
			return false;
		});
	}

	#toEntries(answers: Answers): OutboxEntry[] {
		const entries: OutboxEntry[] = [];
		for (const answer of answers) {
			const question = this.#questionById.get(answer.questionId);
			if (question && !answer.deferred) entries.push({ answer, question });
		}
		return entries;
	}

	#scheduleFlush(): void {
		if (this.#outbox.length === 0) return;
		if (this.#flushTimer) clearTimeout(this.#flushTimer);
		const timer = setTimeout(() => this.#flushOutbox(), FLUSH_DELAY_MS);
		timer.unref?.();
		this.#flushTimer = timer;
	}

	#flushOutbox(): void {
		if (this.#flushTimer) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = undefined;
		}
		const trailer = this.#trailer;
		if (this.#outbox.length === 0) {
			if (trailer) {
				this.#trailer = undefined;
				this.#deliver?.(trailer);
			}
			return;
		}
		this.#trailer = undefined;
		const batch = this.#outbox;
		this.#outbox = [];
		const suffix = trailer ? `\n\nThe user adds: ${trailer}` : "";
		this.#deliver?.(formatDelivery(batch) + suffix);
	}

	/** Pending-set change: sync the footer badge and notify the listener. */
	#changed(): void {
		const blocking = this.#set.activeBlockingIds.length;
		this.#ctx?.ui.setStatus?.(
			STATUS_KEY,
			blocking > 0 ? "maestro waiting on you" : undefined,
		);
		this.#onChanged?.({ pending: this.#set.size, blocking });
	}

	/** Answer mode for every active blocking question, oldest first. */
	#openBlockingAnswers(): void {
		if (this.#answerHandle) return;
		const questions = this.#set.activeBlockingIds
			.map((id) => this.#set.find(id))
			.filter((q): q is Question => q !== undefined);
		if (questions.length === 0) return;
		this.#openAnswerSession(questions, true);
	}

	#openAnswerSession(questions: Questionnaire, blocking: boolean): void {
		const ctx = this.#ctx;
		if (!ctx?.hasUI) return;
		uiTrace(
			"ask.answerMode.open",
			`n=${questions.length} blocking=${blocking}`,
		);
		const palette = ctx.ui.theme ? paletteFromTheme(ctx.ui.theme) : undefined;
		this.#answerHandle = this.#openAnswerMode(ctx.ui, {
			title: "maestro",
			blocking,
			questions,
			...(palette ? { palette } : {}),
			onDone: (answers) => this.#handleCommitted(answers),
			onDefer: () => this.#handleDefer(),
			onClose: () => {
				this.#answerHandle = undefined;
				this.#flushOutbox();
				// Blocking questions that arrived mid-session: reopen for the
				// remainder (never when the user started a draft meanwhile).
				const draft = this.#ctx?.ui.getEditorText?.() ?? "";
				if (this.#set.activeBlockingIds.length > 0 && draft === "") {
					this.#openBlockingAnswers();
				}
			},
		});
	}
}
