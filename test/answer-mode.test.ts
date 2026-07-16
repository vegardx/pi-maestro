// Questionnaire answer-mode takeover: rich question rendering, direct key
// routing despite pi overwriting onSubmit, explicit review/send, blocking
// defer, and exact editor-factory/draft restoration.

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { Answers, Questionnaire } from "@vegardx/pi-contracts";
import { AnswerEditor, openAnswerMode } from "@vegardx/pi-ui";
import { describe, expect, it, vi } from "vitest";

const ENTER = "\r";
const ESC = "\u001b";
const TIER: Questionnaire = [
	{
		id: "tier",
		header: "Execution tier",
		question: "Pick a tier",
		context: "The next operation depends on this choice.",
		blocking: true,
		whyBlocking: "the operation cannot start without a tier",
		options: [
			{ label: "fast", description: "cheap" },
			{ label: "thorough", description: "careful" },
		],
		recommendation: "fast",
	},
];

function editor(
	opts: {
		blocking?: boolean;
		onDone?: (answers: Answers) => void;
		onDefer?: () => void;
	} = {},
) {
	const requestRender = vi.fn();
	const tui = {
		terminal: { rows: 30, cols: 100 },
		requestRender,
	} as never;
	const theme = { borderColor: (s: string) => s, selectList: {} } as never;
	const keybindings = {
		matches: (data: string, action: string) =>
			(action === "app.interrupt" && data === ESC) ||
			(action === "app.exit" && data === "\u0004"),
	} as never;
	const onDone = vi.fn(opts.onDone);
	const onDefer = vi.fn(opts.onDefer);
	const requestClose = vi.fn();
	const e = new AnswerEditor(tui, theme, keybindings, {
		title: "maestro",
		blocking: opts.blocking ?? true,
		questions: TIER,
		onDone,
		onDefer,
		requestClose,
	});
	return { e, onDone, onDefer, requestClose, requestRender };
}

describe("AnswerEditor questionnaire takeover", () => {
	it("renders the rich question including context and whyBlocking", () => {
		const { e } = editor();
		const text = e.render(100).join("\n");
		expect(text).toContain("Pick a tier");
		expect(text).toContain("next operation depends");
		expect(text).toContain("why this blocks");
		expect(text).toContain("cheap");
	});

	it("digit + Enter reaches review; second Enter sends even when pi overwrites onSubmit", () => {
		const { e, onDone, requestClose } = editor();
		const stolenSubmit = vi.fn();
		// This is exactly what pi's setCustomEditorComponent does after factory
		// construction. The takeover must not depend on this callback.
		e.onSubmit = stolenSubmit;
		e.handleInput("2");
		e.handleInput(ENTER);
		expect(e.render(100).join("\n")).toContain("Review answers");
		expect(e.render(100).join("\n")).toContain("thorough");
		expect(onDone).not.toHaveBeenCalled();
		e.handleInput(ENTER);
		expect(onDone).toHaveBeenCalledWith([
			{ questionId: "tier", value: "thorough" },
		]);
		expect(requestClose).toHaveBeenCalledTimes(1);
		expect(stolenSubmit).not.toHaveBeenCalled();
	});

	it("Esc on a blocking question defers and closes", () => {
		const { e, onDone, onDefer, requestClose } = editor();
		e.handleInput(ESC);
		expect(onDone).not.toHaveBeenCalled();
		expect(onDefer).toHaveBeenCalledTimes(1);
		expect(requestClose).toHaveBeenCalledTimes(1);
	});

	it("Ctrl+C and Ctrl+D delegate to CustomEditor", () => {
		const { e } = editor();
		const parent = vi.spyOn(CustomEditor.prototype, "handleInput");
		e.handleInput("\u0003");
		e.handleInput("\u0004");
		expect(parent).toHaveBeenCalledTimes(2);
	});
});

describe("openAnswerMode", () => {
	function fakeUi(draft = "half-written prompt") {
		const previous = () => ({}) as never;
		let factory: unknown = previous;
		let text = draft;
		const calls: string[] = [];
		return {
			previous,
			calls,
			get factory() {
				return factory;
			},
			get text() {
				return text;
			},
			ui: {
				setEditorComponent: vi.fn((f: unknown) => {
					factory = f;
					calls.push("factory");
				}),
				getEditorComponent: vi.fn(() => factory),
				getEditorText: vi.fn(() => text),
				setEditorText: vi.fn((value: string) => {
					text = value;
					calls.push(`text:${value}`);
				}),
			},
		};
	}

	it("takes over with an empty surface, then restores factory before exact draft", () => {
		const rig = fakeUi();
		const onClose = vi.fn();
		const handle = openAnswerMode(rig.ui as never, {
			title: "maestro",
			blocking: false,
			questions: TIER,
			onDone: () => {},
			onClose,
		});
		expect(rig.factory).not.toBe(rig.previous);
		expect(rig.text).toBe("");
		rig.calls.length = 0;
		handle.close();
		expect(rig.factory).toBe(rig.previous);
		expect(rig.text).toBe("half-written prompt");
		expect(rig.calls).toEqual(["factory", "text:half-written prompt"]);
		expect(onClose).toHaveBeenCalledTimes(1);
		handle.close();
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
