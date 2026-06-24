// The blocking `ask` tool. The model calls it with one or more questions and
// gets the user's answers back inline (it blocks until the dialog resolves).
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
	preview: Type.Optional(
		Type.String({
			description: "Detail shown when this option is highlighted.",
		}),
	),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Stable id echoed back in the answer." }),
	question: Type.String({ description: "The question prompt." }),
	context: Type.Optional(
		Type.String({ description: "Background shown above the options." }),
	),
	options: Type.Optional(Type.Array(OptionSchema)),
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

function formatAnswers(answers: Answers): string {
	if (answers.length === 0) return "No answer — the user dismissed the dialog.";
	const lines = answers.map(
		(a) => `- ${a.questionId}: ${a.value}${a.custom ? " (free text)" : ""}`,
	);
	return `${lines.join("\n")}\n\n\`\`\`json\n${JSON.stringify(answers)}\n\`\`\``;
}

export function createAskTool(engine: AskEngine): ToolDefinition {
	return defineTool({
		name: "ask",
		label: "Ask user",
		description:
			"Ask the user one or more questions and block until they answer. " +
			"Use for decisions you cannot make alone or when several valid options exist. " +
			"Each question can offer options and/or accept free text.",
		promptSnippet:
			"ask — put a question to the user and wait for their answer.",
		parameters: AskParams,
		async execute(_id, params) {
			const answers = await engine.present(params.questions as Questionnaire);
			return {
				content: [{ type: "text", text: formatAnswers(answers) }],
				details: { answers },
			};
		},
	}) as ToolDefinition;
}
