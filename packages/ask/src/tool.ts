// The `ask` tool. Non-blocking by default: questions join the pending set
// (a badge widget) and the agent keeps working — answers arrive later as a
// follow-up user message. `blocking: true` (with a required whyBlocking)
// suspends the call until the user answers or defers. Schema mirrors the
// contracts Questionnaire shape; blocking answers are returned as readable
// text plus a JSON block the model can parse.

import {
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Answers, Question, Questionnaire } from "@vegardx/pi-contracts";
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
	body: Type.Optional(
		Type.String({
			description:
				"Full markdown page for this option. Providing a body (or " +
				"dimensions) upgrades the question to a full-screen explorer the " +
				"user tabs through — use for real architecture forks.",
		}),
	),
	tradeoffs: Type.Optional(
		Type.Object(
			{
				pros: Type.Array(Type.String()),
				cons: Type.Array(Type.String()),
			},
			{ description: "Pros/cons rendered as +/− lists on the option page." },
		),
	),
	sketch: Type.Optional(
		Type.String({
			description: "Preformatted ASCII sketch rendered verbatim.",
		}),
	),
	touches: Type.Optional(
		Type.Array(Type.String(), {
			description: "File paths this option would touch.",
		}),
	),
	dimensions: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description:
				"Comparison values keyed by dimension (e.g. latency, effort). " +
				"Options sharing dimensions get a side-by-side compare matrix.",
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
	blocking: Type.Optional(
		Type.Boolean({
			description:
				"Suspend until answered. Default false — the question pends while " +
				"you keep working. Block ONLY when your very next action depends " +
				"on the answer AND proceeding on a guess is expensive to undo.",
		}),
	),
	whyBlocking: Type.Optional(
		Type.String({
			description:
				"Required when blocking: one sentence on why you cannot proceed. " +
				"Shown to the user.",
		}),
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
		if (a.deferred) {
			parts.push(
				"deferred — the user will answer later; continue without blocking on it",
			);
		} else if (a.skipped) {
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
			"Ask the user one or more questions. Non-blocking by default: the " +
			"questions pend in a badge and you continue working — answers arrive " +
			"as a follow-up user message. Set blocking: true (with whyBlocking) " +
			"only when you cannot proceed without the answer and guessing is " +
			"expensive to undo; the user may still defer a blocking question. " +
			"Before asking at all: if there is a defensible recommendation and " +
			"being wrong is cheap to undo, proceed on it and note the assumption " +
			"instead. Provide 2-4 options with trade-offs and a recommendation; " +
			"batch related questions (max 4) into one call; use showIf for " +
			"conditional follow-ups. For real architecture forks give options a " +
			"body/tradeoffs/dimensions — the user gets a full-screen explorer " +
			"with a compare matrix.",
		promptSnippet:
			"ask — put a question to the user; non-blocking unless you truly " +
			"cannot proceed (blocking: true + whyBlocking).",
		parameters: AskParams,
		async execute(_id, params) {
			type AskDetails = {
				posted?: readonly string[];
				answers?: Answers;
			};
			const questions = params.questions as readonly Question[];
			const blocking = questions.filter((q) => q.blocking);
			const posted = questions.filter((q) => !q.blocking);

			const missing = blocking.filter((q) => !q.whyBlocking?.trim());
			if (missing.length > 0) {
				return {
					content: [
						{
							type: "text",
							text:
								`Blocking questions require whyBlocking (missing on: ${missing
									.map((q) => q.id)
									.join(", ")}). State in one sentence why you cannot ` +
								"proceed without the answer — or make them non-blocking " +
								"and keep working.",
						},
					],
					details: {} as AskDetails,
				};
			}

			if (posted.length > 0) engine.post(posted);

			if (blocking.length === 0) {
				const ids = posted.map((q) => q.id).join(", ");
				return {
					content: [
						{
							type: "text",
							text:
								`Posted ${posted.length} question(s) to the pending set ` +
								`(${ids}). Continue with independent work — the user's ` +
								"answers will arrive as a follow-up message. Do not ask " +
								"again; do not wait.",
						},
					],
					details: { posted: posted.map((q) => q.id) } as AskDetails,
				};
			}

			const answers = await engine.present(blocking);
			const postedNote =
				posted.length > 0
					? `\n\n(${posted.length} non-blocking question(s) also posted: ` +
						`${posted.map((q) => q.id).join(", ")} — answers will follow.)`
					: "";
			return {
				content: [
					{
						type: "text",
						text: formatAnswers(answers, blocking) + postedNote,
					},
				],
				details: { answers } as AskDetails,
			};
		},
	}) as ToolDefinition;
}
