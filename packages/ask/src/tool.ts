// The blocking `ask` tool. The model calls it with one or more questions and
// gets the user's answers back inline (it blocks until answers resolve —
// locally via a dialog, or in agent mode via the ask-transport capability).
// Schema mirrors the contracts Questionnaire shape; answers are returned as
// readable text plus a JSON block the model can parse.

import {
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Answers, Questionnaire } from "@vegardx/pi-contracts";
import type { AskEngine } from "./engine.js";

const OptionSchema = Type.Object({
	label: Type.String({ description: "Human-readable choice label." }),
	value: Type.Optional(
		Type.String({ description: "Machine value; defaults to the label." }),
	),
	description: Type.Optional(
		Type.String({
			description: "One-line help shown under the label (the trade-off).",
		}),
	),
	preview: Type.Optional(
		Type.String({
			description: "Detail shown when this option is highlighted.",
		}),
	),
});

const ShowIfSchema = Type.Object({
	questionId: Type.String({
		description: "The earlier question this depends on.",
	}),
	choice: Type.Optional(
		Type.String({ description: "Show when that answer's value equals this." }),
	),
	anyOf: Type.Optional(
		Type.Array(Type.String(), {
			description: "Show when that answer's value is any of these.",
		}),
	),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Stable id echoed back in the answer." }),
	header: Type.Optional(
		Type.String({
			maxLength: 25,
			description:
				"Concise tab label, 1-3 words (e.g. 'Error type'). Not the question.",
		}),
	),
	question: Type.String({ description: "The question prompt." }),
	context: Type.Optional(
		Type.String({ description: "Background shown above the options." }),
	),
	options: Type.Optional(Type.Array(OptionSchema)),
	recommendation: Type.Optional(
		Type.String({
			description:
				"Option value (or label) you recommend — pre-selected and marked [rec].",
		}),
	),
	showIf: Type.Optional(ShowIfSchema),
	allowFreeText: Type.Optional(
		Type.Boolean({
			description: "Permit a typed answer instead of an option.",
		}),
	),
	multiple: Type.Optional(
		Type.Boolean({ description: "Allow selecting more than one option." }),
	),
});

const AskParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: "One or more questions; each renders as its own tab.",
		minItems: 1,
	}),
});

function formatAnswers(answers: Answers, questions: Questionnaire): string {
	if (answers.length === 0) return "No answer — the user dismissed the dialog.";
	const headerOf = new Map(questions.map((q) => [q.id, q.header ?? q.id]));
	const lines = answers.map((a) => {
		const parts = [
			`- ${a.questionId} (${headerOf.get(a.questionId) ?? a.questionId}): `,
		];
		if (a.skipped) {
			parts.push("skipped (condition not met)");
		} else {
			parts.push(a.value);
			if (a.custom) parts.push(" [free text]");
			if (a.note) parts.push(` [note: ${a.note}]`);
		}
		return parts.join("");
	});
	return `${lines.join("\n")}\n\n\`\`\`json\n${JSON.stringify(answers)}\n\`\`\``;
}

export function createAskTool(engine: AskEngine): ToolDefinition {
	return defineTool({
		name: "ask",
		label: "Ask user",
		description:
			"Ask the user one or more questions and block until they answer. " +
			"Use for decisions you cannot make alone or when several valid options exist. " +
			"Provide 2-4 options with trade-offs and a recommendation; batch related " +
			"questions (max 4) into one call; use showIf for conditional follow-ups.",
		promptSnippet:
			"ask — put a question to the user and wait for their answer.",
		parameters: AskParams,
		async execute(_id, params) {
			const questions = params.questions as Questionnaire;
			const answers = await engine.present(questions);
			return {
				content: [{ type: "text", text: formatAnswers(answers, questions) }],
				details: { answers },
			};
		},
	}) as ToolDefinition;
}
