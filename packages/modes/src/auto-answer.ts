import type { Answers } from "@vegardx/pi-contracts";
import type { PendingQuestion, QuestionQueue } from "./question-queue.js";
import { formatAnswerNotice, formatQuestionsForLlm } from "./question-formatter.js";

const AUTO_ANSWER_TIMEOUT_MS = 30_000;

export interface AutoAnswerDeps {
	/** Send a message into the conversation (with optional triggerTurn). */
	sendMessage: (opts: {
		customType: string;
		content: string;
		display: boolean;
	}, meta: { triggerTurn: boolean }) => void;

	/** Show the structured picker overlay to the user. */
	showPicker: (entry: PendingQuestion) => void;

	/** Show a notification to the user. */
	notify: (message: string, level: "info" | "warning") => void;

	/** The question queue (shared with TmuxFanout). */
	queue: QuestionQueue;

	/** Whether auto-answering is enabled (auto/hack mode). */
	isAutoMode: () => boolean;
}

/**
 * Manages the two-tier question auto-answer flow:
 * 1. When a worker question arrives, trigger the orchestrator LLM to answer it
 * 2. If the LLM doesn't answer within 30s, escalate to the user
 *
 * Tracks orchestrator busy state via turn_start/turn_end events.
 */
export class AutoAnswerController {
	private orchestratorBusy = false;

	constructor(private readonly deps: AutoAnswerDeps) {}

	/** Call on pi turn_start event. */
	onTurnStart(): void {
		this.orchestratorBusy = true;
		// Cancel any running timers — a turn is active, LLM might address it
		this.cancelAllTimers();
	}

	/** Call on pi turn_end event. Flushes any queued questions or starts timers. */
	onTurnEnd(): void {
		this.orchestratorBusy = false;
		this.flushUndelivered();
		// Start timeout for any delivered-but-unresolved questions
		this.startTimersForPending();
	}

	/**
	 * Called when a worker question arrives via RPC.
	 * Either triggers immediately or waits for the LLM to finish its current turn.
	 */
	onQuestionReceived(agentId: string): void {
		if (!this.deps.isAutoMode()) {
			// In plan/ask mode, just notify — don't auto-answer
			this.deps.notify(
				"Agent has question(s) — /answer to respond.",
				"info",
			);
			return;
		}

		if (!this.orchestratorBusy) {
			this.deliverToLlm();
			// No timer here — it starts on turn_end if still unresolved
		}
		// If busy, flushUndelivered() will fire on turn_end
	}

	/**
	 * Called by the `answer` tool when the LLM resolves a question.
	 * Returns true if resolved, false if not found/already settled.
	 */
	resolveFromLlm(
		agentId: string,
		answers: Answers,
		reasoning?: string,
	): boolean {
		const entry = this.deps.queue.pendingForAgent(agentId);
		if (!entry || entry.settled) return false;

		const resolved = this.deps.queue.answer(agentId, answers);
		if (!resolved) return false;

		// Show answer notice to user
		const notice = formatAnswerNotice(entry, answers, reasoning, true);
		this.deps.sendMessage(
			{ customType: "maestro.question.answered", content: notice, display: true },
			{ triggerTurn: false },
		);

		return true;
	}

	/**
	 * Called by the `escalate` tool when the LLM decides it needs human input.
	 */
	escalateFromLlm(agentId: string, _reason: string): boolean {
		const entry = this.deps.queue.pendingForAgent(agentId);
		if (!entry || entry.settled) return false;

		this.deps.queue.settle(agentId);
		this.deps.showPicker(entry);
		return true;
	}

	/**
	 * Called by the structured picker when the user answers.
	 */
	resolveFromUser(agentId: string, answers: Answers): void {
		const entry = this.deps.queue.pendingForAgent(agentId);
		if (!entry) return;

		this.deps.queue.answer(agentId, answers);

		// Show answer notice
		const notice = formatAnswerNotice(entry, answers, undefined, false);
		this.deps.sendMessage(
			{ customType: "maestro.question.answered", content: notice, display: true },
			{ triggerTurn: false },
		);
	}

	// ─── Private ──────────────────────────────────────────────────────────

	private deliverToLlm(): void {
		const undelivered = this.deps.queue.undelivered();
		if (undelivered.length === 0) return;

		// Mark all as delivered
		for (const entry of undelivered) {
			this.deps.queue.markDelivered(entry.agentId);
		}

		// Format and send
		const content = formatQuestionsForLlm(undelivered);
		this.deps.sendMessage(
			{ customType: "maestro.question.prompt", content, display: true },
			{ triggerTurn: true },
		);
	}

	private flushUndelivered(): void {
		if (!this.deps.isAutoMode()) return;
		const undelivered = this.deps.queue.undelivered();
		if (undelivered.length > 0) {
			this.deliverToLlm();
		}
	}

	/** Start timers for all delivered, unresolved questions (called on turn_end). */
	private startTimersForPending(): void {
		for (const entry of this.deps.queue.all()) {
			if (entry.settled || !entry.deliveredToLlm) continue;
			if (entry.timeoutHandle) continue; // already has a timer
			this.startTimeout(entry.agentId);
		}
	}

	/** Cancel all running timers (called on turn_start). */
	private cancelAllTimers(): void {
		for (const entry of this.deps.queue.all()) {
			if (entry.timeoutHandle) {
				clearTimeout(entry.timeoutHandle);
				entry.timeoutHandle = undefined;
			}
		}
	}

	private startTimeout(agentId: string): void {
		const handle = setTimeout(() => {
			const entry = this.deps.queue.pendingForAgent(agentId);
			if (!entry || entry.settled) return;

			// Timeout fired — escalate to user
			this.deps.queue.settle(agentId);
			this.deps.notify("Question timeout — escalating to user.", "warning");
			this.deps.showPicker(entry);
		}, AUTO_ANSWER_TIMEOUT_MS);

		this.deps.queue.setTimeout(agentId, handle);
	}
}
