// The questionnaire engine: presents a Questionnaire over pi-ui and resolves
// with Answers. It needs an ExtensionContext to reach ctx.ui.custom, but the
// ask.v1 capability contract (ask/queue) carries no ctx — so the extension
// captures the latest context off lifecycle events and the engine reads it
// here. Consumers (modes gates, commit confirmations) call ask() from inside
// their own handler, where a live context is always available.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Answers, Questionnaire } from "@vegardx/pi-contracts";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import { getCapability } from "@vegardx/pi-core";
import { runQuestionnaire } from "@vegardx/pi-ui";

export class AskEngine {
	#ctx: ExtensionContext | undefined;
	#queued: Questionnaire = [];

	/** Update the context the engine renders through. Called on events. */
	setContext(ctx: ExtensionContext): void {
		this.#ctx = ctx;
	}

	/**
	 * Present a questionnaire immediately and resolve with answers. A cancelled
	 * dialog (or no UI) resolves to an empty answer set — callers treat empty
	 * as "no decision" rather than throwing.
	 */
	async present(questions: Questionnaire): Promise<Answers> {
		if (questions.length === 0) return [];
		// Agent mode: an ask-transport capability routes questions to the
		// orchestrator over RPC. Checked before the local-UI fallback so a
		// headless agent (no ctx.hasUI) still reaches the user.
		const transport = getCapability(CAPABILITIES.askTransport);
		if (transport) return transport.present(questions);
		const ctx = this.#ctx;
		if (!ctx?.hasUI) return [];
		const answers = await runQuestionnaire(ctx, questions);
		return answers ?? [];
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
	async flush(): Promise<Answers> {
		if (this.#queued.length === 0) return [];
		const batch = this.#queued;
		this.#queued = [];
		return this.present(batch);
	}
}
