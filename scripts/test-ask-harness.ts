/**
 * Test harness: presents a synthetic questionnaire exercising all dialog
 * features on session start. No LLM call — pure UI test.
 *
 * Run via: make test-ask
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineExtension } from "@vegardx/pi-core";
import { runQuestionnaire } from "@vegardx/pi-ui";

const TEST_QUESTIONNAIRE = [
	{
		id: "error_type",
		header: "Error type",
		question: "What error should divide(a, 0) throw?",
		context:
			"This decides the public API contract for division by zero. Callers will catch this type.",
		options: [
			{
				label: "RangeError",
				value: "range",
				description:
					"Standard JS numeric error. Callers already catch RangeError for overflow.",
			},
			{
				label: "Custom DivisionByZeroError",
				value: "custom",
				description:
					"Explicit type — self-documenting, but callers must import it.",
			},
			{
				label: "TypeError",
				value: "type",
				description:
					"Technically incorrect (the types are fine), but some libs use it for invalid args.",
			},
		],
		recommendation: "range",
		allowFreeText: true,
	},
	{
		id: "custom_name",
		header: "Class name",
		question: "What should the custom error class be named?",
		context: "Only relevant if you chose the custom error type above.",
		options: [
			{
				label: "DivisionByZeroError",
				description: "Verbose but explicit.",
			},
			{
				label: "DivByZeroError",
				description: "Shorter, common abbreviation.",
			},
			{
				label: "ZeroDivisionError",
				description: "Python-style naming.",
			},
		],
		showIf: { questionId: "error_type", choice: "custom" },
	},
	{
		id: "precision",
		header: "Precision",
		question: "How should divide handle non-terminating results like 1/3?",
		context:
			"JavaScript floats truncate naturally, but we could add explicit rounding.",
		options: [
			{
				label: "Native JS float",
				value: "native",
				description:
					"Return the IEEE 754 double result as-is (0.3333…15 digits).",
			},
			{
				label: "Configurable decimal places",
				value: "configurable",
				description:
					"Accept an optional `precision` param; default to native when omitted.",
			},
		],
		recommendation: "native",
	},
	{
		id: "multi_test",
		header: "Tags",
		question: "Which categories apply to this function? (multi-select test)",
		context: "This exercises the multi-select checkbox UI.",
		multiple: true,
		options: [
			{ label: "math", description: "Core math operations" },
			{ label: "safe", description: "Throws on invalid input" },
			{ label: "pure", description: "No side effects" },
			{ label: "variadic", description: "Accepts variable args" },
		],
	},
] as const;

export default defineExtension(
	{
		name: "test-ask-harness",
		path: "scripts/test-ask-harness.ts",
		doc: "Synthetic questionnaire for UI testing.",
	},
	(pi) => {
		pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
			// Small delay so the TUI fully initializes its render loop.
			await new Promise((r) => setTimeout(r, 200));
			const answers = await runQuestionnaire(ctx, TEST_QUESTIONNAIRE as any);
			if (answers && answers.length > 0) {
				const summary = answers
					.map((a) => {
						if (a.skipped) return `  ${a.questionId}: (skipped)`;
						const note = a.note ? ` [note: ${a.note}]` : "";
						const custom = a.custom ? " (free text)" : "";
						return `  ${a.questionId}: ${a.value}${custom}${note}`;
					})
					.join("\n");
				ctx.ui.notify(`Answers:\n${summary}`, "info");
			} else {
				ctx.ui.notify("Dialog closed without answering.", "info");
			}
			// Exit after showing the result briefly.
			setTimeout(() => ctx.shutdown(), 2000);
		});
	},
);
