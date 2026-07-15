// @vegardx/pi-ask — the questionnaire engine. Provides:
//   * the `ask` tool — non-blocking pending set by default, blocking on
//     request (whyBlocking required);
//   * the ask.v1 capability (ask = blocking, post = pending, queue = legacy
//     deferred, open = answer mode) other extensions resolve by id;
//   * a queued plan-mode driver: questions accumulated during a turn are
//     flushed as one combined presentation at turn_end;
//   * shorthand replies: `2` / `1a 2b` / `rec` typed in chat resolve the
//     pending set, or expand against the last ◆ decision block in text.
// Presentation is the maestro HUD (Questions tab) + the answer-editor input
// takeover; pending-set changes are broadcast as EVENTS.askChanged.
//
// The engine renders through whatever ExtensionContext was last seen on a
// lifecycle event — captured below — since the capability methods carry none.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CAPABILITIES, EVENTS } from "@vegardx/pi-contracts";
import { defineExtension } from "@vegardx/pi-core";
import { AskEngine } from "./engine.js";
import {
	type DecisionPoint,
	parseDecisionBlock,
	parseShorthand,
} from "./shorthand.js";
import { createAskTool } from "./tool.js";

export { AskEngine, type AskSource } from "./engine.js";
export {
	type DecisionPoint,
	parseDecisionBlock,
	parseShorthand,
	questionToDecisionPoint,
	type ShorthandMatch,
} from "./shorthand.js";
export { createAskTool } from "./tool.js";

/** Best-effort text of an assistant message's content blocks. */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			block && typeof block === "object" && "text" in block
				? String((block as { text: unknown }).text)
				: "",
		)
		.join("\n");
}

export default defineExtension(
	{
		name: "ask",
		path: "packages/ask/src/index.ts",
		doc: "Questionnaire engine: blocking ask tool + queued plan-mode driver.",
	},
	(pi, maestro) => {
		const engine = new AskEngine();

		// Capture the freshest context so capability calls have a UI to render
		// through. These fire before any consumer would call ask().
		const capture = (_e: unknown, ctx: ExtensionContext) =>
			engine.setContext(ctx);
		pi.on("session_start", capture);
		pi.on("turn_start", capture);

		// Pending-set changes drive the HUD's Questions tab + tab-bar counts.
		// The "queued while blocked" notify re-arms whenever blocking clears.
		let queuedNotified = false;
		engine.setOnChanged((change) => {
			if (change.blocking === 0) queuedNotified = false;
			maestro.events.emit(EVENTS.askChanged, change);
		});

		// The latest assistant message's ◆ decision block (if any) — the
		// mapping bare-letter/number replies expand against.
		let decisionPoints: DecisionPoint[] = [];
		pi.on("message_end", (event) => {
			const message = (
				event as { message?: { role?: string; content?: unknown } }
			).message;
			if (message?.role !== "assistant") return;
			const text = messageText(message.content);
			if (text.trim() === "") return;
			// Any newer text replaces the mapping — shorthand only ever
			// resolves against the latest message.
			decisionPoints = parseDecisionBlock(text);
		});

		// Shorthand replies: try the pending set first (answers settle and
		// deliver, input is consumed), then the chat decision block (input
		// transforms into explicit decisions text).
		pi.on("input", (event, ctx: ExtensionContext) => {
			engine.setContext(ctx);
			const e = event as { text?: string; source?: string };
			if (e.source !== "interactive" || !e.text) {
				return { action: "continue" as const };
			}
			if (engine.applyShorthand(e.text)) {
				return { action: "handled" as const };
			}
			if (decisionPoints.length > 0) {
				const match = parseShorthand(e.text, decisionPoints);
				if (match) {
					decisionPoints = [];
					return { action: "transform" as const, text: match.expansion };
				}
			}
			// A normal prompt while the maestro is blocked on a question: let
			// it queue as usual (pi handles mid-turn user messages) but say so
			// once, so the silence has an explanation.
			if (engine.blockingCount > 0 && !queuedNotified) {
				queuedNotified = true;
				ctx.ui.notify(
					"queued — maestro is waiting on a question (Tab → Questions)",
					"info",
				);
			}
			return { action: "continue" as const };
		});

		// Non-blocking answers arrive as a follow-up user message: queued to
		// turn end while the agent streams, triggering a turn when idle.
		engine.setDeliver((text) => {
			void pi.sendUserMessage(text, { deliverAs: "followUp" });
		});

		pi.registerTool(createAskTool(engine));

		maestro.capabilities.register(CAPABILITIES.ask, {
			ask: (questions) => engine.present(questions),
			queue: (questions) => engine.queue(questions),
			post: (questions) => engine.post(questions),
			pending: () => engine.pending(),
			open: (questionId) => engine.openAnswers(questionId),
		});

		// Plan-mode driver: flush whatever was queued as one dialog when the
		// turn ends, so nudges batch into a single interruption.
		pi.on("turn_end", async () => {
			if (engine.hasQueued) await engine.flush();
		});
	},
);
