// The questionnaire engine: a pending set of questions rendered as one
// merged overlay widget. Non-blocking `post()` returns immediately (answers
// deliver later as a follow-up user message); blocking `present()` raises
// the widget, captures input, and resolves when its questions are answered
// or deferred. It needs an ExtensionContext to reach ctx.ui, but the
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
	CollapsibleQuestionnaireComponent,
	paletteFromTheme,
	runQuestionnaire,
} from "@vegardx/pi-ui";
import { PendingSet } from "./pending.js";
import { parseShorthand, questionToDecisionPoint } from "./shorthand.js";

export type AskSource = "main" | string;

/** How long after the last committed answer the outbox flushes (batching). */
const FLUSH_DELAY_MS = 2_000;

interface Waiter {
	readonly ids: ReadonlySet<string>;
	readonly collected: Map<string, Answer>;
	readonly resolve: (answers: Answers) => void;
}

interface OutboxEntry {
	readonly answer: Answer;
	readonly question: Question;
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
	#component: CollapsibleQuestionnaireComponent | undefined;
	#mounted = false;

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
		const overlays = this.overlays;
		if (!overlays) {
			// Legacy dialog cannot pend; run it and deliver the answers.
			void runQuestionnaire(ctx, questions).then((answers) => {
				const entries = this.#toEntries(answers ?? []);
				if (entries.length > 0) this.#deliver?.(formatDelivery(entries));
			});
			return;
		}
		this.#set.post(questions);
		this.#syncWidget(overlays, { rebuild: true });
	}

	/** Posted-but-unanswered questions (turn-start context lines). */
	pending(): readonly PendingAsk[] {
		return this.#set.list();
	}

	/**
	 * Blocking: present the questionnaire and resolve with answers (or with
	 * `deferred` answers when the user escapes out).
	 * @param questions - The questions to present
	 * @param source - "main" blocks input; agent IDs don't
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

		const overlays = this.overlays;
		if (!overlays) {
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
				// Blocking questions jump the queue — next-up when the user
				// is mid-questionnaire (widget expanded), front otherwise.
				const anchor = this.#component?.expanded
					? this.#component.currentQuestionId
					: undefined;
				this.#set.raise(questions, anchor);
				this.#syncWidget(overlays, { rebuild: true });
				overlays.blockInput();
			} else {
				// Worker questions: pend without capturing input.
				this.#set.post(questions);
				this.#syncWidget(overlays, { rebuild: true });
			}
		});
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
		const overlays = this.overlays;
		if (overlays) {
			this.#handleCommitted(match.answers, overlays);
		} else {
			this.#set.settle(match.answers);
		}
		this.#flushOutbox();
		return true;
	}

	/** Settled answers → waiters first, then the outbox (batched delivery). */
	#handleCommitted(answers: Answers, overlays: OverlaysCapabilityV1): void {
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
		if (this.#set.activeBlockingIds.length === 0 && overlays.isInputBlocked) {
			overlays.unblockInput();
			// The user was mid-questionnaire; keep them in it if more remains.
			if (this.#set.size > 0) overlays.focusOverlay("ask");
		}
		this.#syncWidget(overlays, { rebuild: false });
	}

	/** Esc on a blocking question: demote it, resolve its waiter, unblock. */
	#handleDefer(overlays: OverlaysCapabilityV1): void {
		const ids = this.#set.defer();
		for (const id of ids) {
			const waiter = this.#waiters.find(
				(w) => w.ids.has(id) && !w.collected.has(id),
			);
			waiter?.collected.set(id, { questionId: id, value: "", deferred: true });
		}
		this.#resolveReadyWaiters();
		if (overlays.isInputBlocked) overlays.unblockInput();
		this.#flushOutbox();
		this.#syncWidget(overlays, { rebuild: false });
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

	/**
	 * Reconcile the overlay widget with the set. `rebuild` remounts with the
	 * current questionnaire (set grew); otherwise only emptiness is checked —
	 * mid-flow commits keep the live component so navigation state survives.
	 */
	#syncWidget(
		overlays: OverlaysCapabilityV1,
		opts: { rebuild: boolean },
	): void {
		if (this.#set.size === 0) {
			if (this.#mounted) {
				uiTrace("ask.widget.unmount");
				overlays.unmount("ask");
				this.#mounted = false;
				this.#component = undefined;
			}
			this.#flushOutbox();
			return;
		}
		if (!opts.rebuild && this.#mounted) return;
		uiTrace("ask.widget.rebuild", `size=${this.#set.size}`);

		const wasExpanded = this.#component?.expanded ?? false;
		const palette = this.#ctx?.ui
			? paletteFromTheme(this.#ctx.ui.theme)
			: undefined;
		const comp = new CollapsibleQuestionnaireComponent(
			this.#set.questionnaire(),
			(answers) => {
				if (answers) this.#handleCommitted(answers, overlays);
				this.#flushOutbox();
				this.#syncWidget(overlays, { rebuild: false });
				if (this.#set.size === 0 && !overlays.isInputBlocked) {
					overlays.focusInput();
				}
			},
			{
				palette,
				onQuestionCommitted: (answers) =>
					this.#handleCommitted(answers, overlays),
				onCancel: (draft) => this.#handleCommitted(draft, overlays),
				hasBlocking: () => this.#set.activeBlockingIds.length > 0,
				onDefer: () => this.#handleDefer(overlays),
				badge: () => ({
					pending: this.#set.size,
					deferred: this.#set.deferredCount,
				}),
			},
		);
		this.#component = comp;
		overlays.mount("ask", comp);
		this.#mounted = true;
		if (wasExpanded) overlays.focusOverlay("ask");
	}
}
