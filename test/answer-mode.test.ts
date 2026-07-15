// The answer-mode flow (input takeover state machine): digit selection,
// custom text answers, recommendation preselect, in-place multi-question
// stepping, esc semantics, and the plain header lines rendered above the
// editor's input line.

import type { Questionnaire } from "@vegardx/pi-contracts";
import { AnswerFlow, openAnswerMode } from "@vegardx/pi-ui";
import { describe, expect, it, vi } from "vitest";

const TIER: Questionnaire = [
	{
		id: "tier",
		question: "Pick a tier",
		options: [{ label: "fast", description: "cheap" }, { label: "thorough" }],
	},
];

describe("AnswerFlow", () => {
	it("digit selects an option; Enter submits it", () => {
		const flow = new AnswerFlow(TIER, true);
		expect(flow.selectDigit(2)).toBe(true);
		expect(flow.selected).toBe(1);
		expect(flow.answerFor("")).toEqual({
			questionId: "tier",
			value: "thorough",
		});
		// Out-of-range digits are not handled (fall through to the editor).
		expect(flow.selectDigit(9)).toBe(false);
	});

	it("typed text is a custom answer and overrides the digit selection", () => {
		const flow = new AnswerFlow(TIER, false);
		flow.selectDigit(1);
		flow.clearSelection();
		expect(flow.answerFor("use the medium tier")).toEqual({
			questionId: "tier",
			value: "use the medium tier",
			custom: true,
		});
	});

	it("Enter with nothing typed and nothing selected submits nothing", () => {
		const flow = new AnswerFlow(TIER, false);
		expect(flow.answerFor("")).toBeUndefined();
	});

	it("preselects the recommendation", () => {
		const flow = new AnswerFlow(
			[{ ...TIER[0], recommendation: "thorough" }],
			false,
		);
		expect(flow.selected).toBe(1);
		expect(flow.answerFor("")).toEqual({
			questionId: "tier",
			value: "thorough",
		});
	});

	it("steps through a multi-question set in place (1/N → 2/N)", () => {
		const flow = new AnswerFlow(
			[
				{ id: "a", question: "First?" },
				{ id: "b", question: "Second?" },
			],
			true,
		);
		expect(flow.step).toBe(1);
		expect(flow.total).toBe(2);
		expect(flow.current?.id).toBe("a");
		expect(flow.advance()).toBe(true);
		expect(flow.step).toBe(2);
		expect(flow.current?.id).toBe("b");
		expect(flow.advance()).toBe(false);
		expect(flow.done).toBe(true);
	});

	it("esc defers a blocking set and merely exits a pending one", () => {
		expect(new AnswerFlow(TIER, true).escAction()).toBe("defer");
		expect(new AnswerFlow(TIER, false).escAction()).toBe("exit");
	});

	it("renders the header: title/step, question, numbered options, hint", () => {
		const flow = new AnswerFlow(
			[
				{ ...TIER[0], recommendation: "fast" },
				{ id: "next", question: "Then?" },
			],
			true,
		);
		const lines = flow.headerLines(80, "maestro").map((l) => l.text);
		expect(lines[0]).toBe(" ? maestro (1/2) — blocking");
		expect(lines[1]).toBe("   Pick a tier");
		expect(lines[2]).toBe("  ›1 fast [rec] — cheap");
		expect(lines[3]).toBe("   2 thorough");
		expect(lines[4]).toContain("digits choose");
		expect(lines[4]).toContain("esc defer");
	});
});

describe("openAnswerMode", () => {
	function fakeUi() {
		let factory: unknown;
		return {
			setEditorComponent: vi.fn((f: unknown) => {
				factory = f;
			}),
			getEditorComponent: vi.fn(() => factory),
		};
	}

	it("takes over the editor and restores the previous component on close", () => {
		const ui = fakeUi();
		const onClose = vi.fn();
		const handle = openAnswerMode(ui as never, {
			title: "maestro",
			blocking: false,
			questions: TIER,
			onAnswer: () => {},
			onClose,
		});
		expect(ui.setEditorComponent).toHaveBeenCalledTimes(1);
		expect(handle.currentQuestionId).toBe("tier");

		handle.close();
		// Restored the previous (default) editor: called with undefined.
		expect(ui.setEditorComponent).toHaveBeenLastCalledWith(undefined);
		expect(onClose).toHaveBeenCalledTimes(1);
		// Idempotent.
		handle.close();
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
