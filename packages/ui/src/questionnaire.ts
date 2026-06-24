// Questionnaire widget — the interactive primitive the ask engine builds on.
// Renders tabbed questions with selectable options, optional per-option preview
// pane, and optional free-text entry. Interaction logic lives in pure reducers
// (testable without a terminal); the Component and runQuestionnaire wire them to
// the host UI.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import type {
	Answer,
	Answers,
	Question,
	Questionnaire,
	QuestionOption,
} from "@vegardx/pi-contracts";
import { defaultPalette, type Palette, truncate } from "./format.js";

export function optionValue(option: QuestionOption): string {
	return option.value ?? option.label;
}

export interface QuestionnaireState {
	readonly index: number;
	readonly cursor: number;
	readonly selected: ReadonlySet<string>;
	/** Active free-text buffer, or undefined when not in free-text mode. */
	readonly freeText?: string;
	readonly answers: readonly Answer[];
}

export function initQuestionnaireState(): QuestionnaireState {
	return { index: 0, cursor: 0, selected: new Set(), answers: [] };
}

function optionCount(question: Question): number {
	return question.options?.length ?? 0;
}

/** Move the option cursor, clamped to the option range. */
export function moveCursor(
	state: QuestionnaireState,
	question: Question,
	delta: number,
): QuestionnaireState {
	const count = optionCount(question);
	if (count === 0) return state;
	const next = Math.min(count - 1, Math.max(0, state.cursor + delta));
	return { ...state, cursor: next };
}

/** Toggle the highlighted option (multiple-choice questions only). */
export function toggleSelection(
	state: QuestionnaireState,
	question: Question,
): QuestionnaireState {
	if (!question.multiple || !question.options?.length) return state;
	const value = optionValue(question.options[state.cursor]);
	const selected = new Set(state.selected);
	if (selected.has(value)) selected.delete(value);
	else selected.add(value);
	return { ...state, selected };
}

export function startFreeText(state: QuestionnaireState): QuestionnaireState {
	return { ...state, freeText: state.freeText ?? "" };
}

export function setFreeText(
	state: QuestionnaireState,
	text: string,
): QuestionnaireState {
	return { ...state, freeText: text };
}

export interface CommitResult {
	readonly state: QuestionnaireState;
	readonly done: boolean;
	readonly answers?: Answers;
}

/**
 * Commit the current question and advance. Builds answers from free-text (if
 * active), the multi-select set, or the highlighted single option. Returns
 * `done: true` with the full answer set once the last question is committed.
 */
export function commitQuestion(
	questionnaire: Questionnaire,
	state: QuestionnaireState,
): CommitResult {
	const question = questionnaire[state.index];
	if (!question) return { state, done: true, answers: state.answers };

	const built: Answer[] = [];
	if (state.freeText !== undefined && state.freeText.trim() !== "") {
		built.push({
			questionId: question.id,
			value: state.freeText.trim(),
			custom: true,
		});
	} else if (question.multiple) {
		for (const value of state.selected) {
			built.push({ questionId: question.id, value });
		}
	} else if (question.options?.length) {
		built.push({
			questionId: question.id,
			value: optionValue(question.options[state.cursor]),
		});
	}

	const answers = [...state.answers, ...built];
	const nextIndex = state.index + 1;
	if (nextIndex >= questionnaire.length) {
		return { state: { ...state, answers }, done: true, answers };
	}
	return {
		state: {
			index: nextIndex,
			cursor: 0,
			selected: new Set(),
			freeText: undefined,
			answers,
		},
		done: false,
	};
}

export interface QuestionnaireRenderOptions {
	palette?: Palette;
}

function wrap(text: string, width: number, palette: Palette): string[] {
	if (width <= 0) return [];
	const words = text.split(/\s+/);
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		if (line.length + word.length + 1 > width) {
			if (line) lines.push(palette.dim(line));
			line = word;
		} else {
			line = line ? `${line} ${word}` : word;
		}
	}
	if (line) lines.push(palette.dim(line));
	return lines;
}

/** Render the current question of a questionnaire to plain lines. */
export function renderQuestionnaire(
	questionnaire: Questionnaire,
	state: QuestionnaireState,
	width: number,
	opts: QuestionnaireRenderOptions = {},
): string[] {
	const palette = opts.palette ?? defaultPalette();
	const question = questionnaire[state.index];
	if (!question) return [];
	const lines: string[] = [];

	if (questionnaire.length > 1) {
		const tabs = questionnaire
			.map((_, i) => {
				const label = `Q${i + 1}`;
				if (i === state.index) return palette.accent(`[${label}]`);
				return palette.muted(i < state.index ? `${label}✓` : label);
			})
			.join(" ");
		lines.push(tabs);
	}

	lines.push(palette.heading(truncate(question.question, width)));
	if (question.context) lines.push(...wrap(question.context, width, palette));

	for (let i = 0; i < (question.options?.length ?? 0); i++) {
		const option = (question.options as QuestionOption[])[i];
		const value = optionValue(option);
		const cursor = i === state.cursor ? palette.accent("›") : " ";
		const box = question.multiple
			? state.selected.has(value)
				? "[x]"
				: "[ ]"
			: "";
		const label =
			i === state.cursor ? palette.accent(option.label) : option.label;
		lines.push(truncate(`${cursor} ${box ? `${box} ` : ""}${label}`, width));
	}

	const highlighted = question.options?.[state.cursor];
	if (highlighted?.preview) {
		lines.push(palette.dim("─".repeat(Math.min(width, 20))));
		lines.push(...wrap(highlighted.preview, width, palette));
	}

	if (state.freeText !== undefined) {
		lines.push(palette.accent(truncate(`› ${state.freeText}▌`, width)));
	} else if (question.allowFreeText) {
		lines.push(palette.muted("(press 't' to type a custom answer)"));
	}

	return lines;
}

const KEY_UP = "\u001b[A";
const KEY_DOWN = "\u001b[B";

/** Live, focusable questionnaire component. Calls `done` with the answers. */
export class QuestionnaireComponent implements Component, Focusable {
	focused = false;
	private state = initQuestionnaireState();

	constructor(
		private readonly questionnaire: Questionnaire,
		private readonly done: (answers: Answers | undefined) => void,
		private readonly opts: QuestionnaireRenderOptions = {},
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		return renderQuestionnaire(
			this.questionnaire,
			this.state,
			width,
			this.opts,
		);
	}

	handleInput(data: string): void {
		const question = this.questionnaire[this.state.index];
		if (!question) return;

		if (this.state.freeText !== undefined) {
			if (data === "\r" || data === "\n") {
				this.commit();
			} else if (data === "\u001b") {
				this.state = { ...this.state, freeText: undefined };
			} else if (data === "\u007f" || data === "\b") {
				this.state = setFreeText(this.state, this.state.freeText.slice(0, -1));
			} else if (data >= " ") {
				this.state = setFreeText(this.state, this.state.freeText + data);
			}
			return;
		}

		switch (data) {
			case KEY_UP:
				this.state = moveCursor(this.state, question, -1);
				break;
			case KEY_DOWN:
				this.state = moveCursor(this.state, question, 1);
				break;
			case " ":
				this.state = toggleSelection(this.state, question);
				break;
			case "t":
				if (question.allowFreeText) this.state = startFreeText(this.state);
				break;
			case "\r":
			case "\n":
				this.commit();
				break;
			case "\u001b":
				this.done(undefined);
				break;
		}
	}

	private commit(): void {
		const result = commitQuestion(this.questionnaire, this.state);
		this.state = result.state;
		if (result.done) this.done(result.answers ?? []);
	}
}

/** Show a questionnaire as a focused overlay and resolve with the answers. */
export function runQuestionnaire(
	ctx: ExtensionContext,
	questionnaire: Questionnaire,
	opts: QuestionnaireRenderOptions = {},
): Promise<Answers | undefined> {
	return ctx.ui.custom<Answers | undefined>(
		(_tui: TUI, theme, _keybindings, done) => {
			void theme;
			return new QuestionnaireComponent(questionnaire, done, opts);
		},
		{ overlay: true },
	);
}
