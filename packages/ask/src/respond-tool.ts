// `respond` — answer a question that arrived from somewhere else.
//
// The counterpart to `ask`, and it lives here for the same reason `ask` does:
// this package knows what a questionnaire is. It used to live in maestro's
// runtime, beside the socket the questions happened to arrive on, and paid for
// it — the answer was a single string copied across every question in the set.
//
// There is no `askTheHuman` flag. Escalation is not a special path: an answerer
// that cannot answer calls `ask` itself, and its own transport decides where
// that goes — up another link, or to the human at the top. The recursion the
// whole design rests on, used once more rather than special-cased.

import {
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Answers } from "@vegardx/pi-contracts";
import type { AskInbox } from "./inbox.js";

export function createRespondTool(inbox: () => AskInbox): ToolDefinition {
	return defineTool({
		name: "respond",
		label: "Respond",
		description:
			"Answer a question something else is blocked on. Answer every question " +
			"in the set — whoever asked is waiting on all of them. If you cannot " +
			"answer, use `ask` to put the question to whoever can, then respond " +
			"with what comes back.",
		promptSnippet:
			"answer a question another agent is blocked on. If you cannot, `ask` first.",
		parameters: Type.Object({
			id: Type.String({
				description: "The id from the question you were told about.",
			}),
			answers: Type.Array(
				Type.Object({
					questionId: Type.String({
						description: "Which question this answers.",
					}),
					value: Type.String({ description: "The answer." }),
				}),
				{
					description: "One entry per question in the set. Answer all of them.",
					minItems: 1,
				},
			),
		}),
		async execute(_id, params) {
			const { id, answers } = params as {
				id: string;
				answers: { questionId: string; value: string }[];
			};
			try {
				inbox().settle(id, answers as Answers);
			} catch (error) {
				// Returned, not thrown: every one of these is something the model
				// can fix on the next call — a stale id, a missed question. A
				// thrown error reads as a broken tool rather than a correction.
				return said(error instanceof Error ? error.message : String(error));
			}
			return said(
				`Answered ${answers.length} question${
					answers.length === 1 ? "" : "s"
				}. Whoever asked is unblocked.`,
			);
		},
	}) as ToolDefinition;
}

function said(text: string): {
	content: { type: "text"; text: string }[];
	details: Record<string, never>;
} {
	return { content: [{ type: "text" as const, text }], details: {} };
}
