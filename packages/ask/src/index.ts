// @vegardx/pi-ask — the questionnaire engine. Provides:
//   * the `ask` tool — non-blocking pending set by default, blocking on
//     request (whyBlocking required);
//   * the ask.v1 capability (ask = blocking, post = pending, queue = legacy
//     deferred) other extensions resolve by id (modes gates, commits);
//   * a queued plan-mode driver: questions accumulated during a turn are
//     flushed as one combined dialog at turn_end;
//   * shorthand replies: `2` / `1a 2b` / `rec` typed in chat resolve the
//     pending widget, or expand against the last ◆ decision block in text.
//
// The engine renders through whatever ExtensionContext was last seen on a
// lifecycle event — captured below — since the capability methods carry none.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CAPABILITIES } from "@vegardx/pi-contracts";
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

		// Shorthand replies: try the pending widget set first (answers settle
		// and deliver, input is consumed), then the chat decision block
		// (input transforms into explicit decisions text).
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
		});

		// Plan-mode driver: flush whatever was queued as one dialog when the
		// turn ends, so nudges batch into a single interruption.
		pi.on("turn_end", async () => {
			if (engine.hasQueued) await engine.flush();
		});
	},
);
