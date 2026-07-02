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
	/** Active note buffer for the focused option, or undefined. */
	readonly noteEdit?: string;
	/** Notes attached to answers, keyed by questionId. */
	readonly notes: ReadonlyMap<string, string>;
	readonly answers: readonly Answer[];
}

export function initQuestionnaireState(): QuestionnaireState {
	return {
		index: 0,
		cursor: 0,
		selected: new Set(),
		notes: new Map(),
		answers: [],
	};
}

/** Index of the recommended option, or -1. Matches option value (or label). */
export function recommendedIndex(question: Question): number {
	if (!question.recommendation || !question.options) return -1;
	return question.options.findIndex(
		(o) => optionValue(o) === question.recommendation,
	);
}

/**
 * Whether a question is shown given the answers so far. A `showIf` is
 * satisfied when the referenced question's answer value equals `choice`
 * or is in `anyOf`; for a multi-select trigger, ANY selected value matches.
 */
export function isShown(
	question: Question,
	answers: readonly Answer[],
): boolean {
	const cond = question.showIf;
	if (!cond) return true;
	const values = answers
		.filter((a) => a.questionId === cond.questionId && !a.skipped)
		.map((a) => a.value);
	if (values.length === 0) return false;
	if (cond.choice !== undefined && values.includes(cond.choice)) return true;
	if (cond.anyOf && values.some((v) => cond.anyOf?.includes(v))) return true;
	return false;
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
	const note = state.notes.get(question.id);
	if (state.freeText !== undefined && state.freeText.trim() !== "") {
		built.push({
			questionId: question.id,
			value: state.freeText.trim(),
			custom: true,
			...(note ? { note } : {}),
		});
	} else if (question.multiple) {
		for (const value of state.selected) {
			built.push({ questionId: question.id, value });
		}
	} else if (question.options?.length) {
		built.push({
			questionId: question.id,
			value: optionValue(question.options[state.cursor]),
			...(note ? { note } : {}),
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
			notes: state.notes,
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
	const border = palette.dim("─".repeat(width));

	lines.push(border);

	if (questionnaire.length > 1) {
		lines.push(...renderTabs(questionnaire, state, width, palette));
		lines.push("");
	}

	lines.push(palette.heading(truncate(question.question, width)));
	if (question.context) {
		lines.push(...wrap(question.context, width, palette));
	}
	lines.push("");

	const recIdx = recommendedIndex(question);
	for (let i = 0; i < (question.options?.length ?? 0); i++) {
		const option = (question.options as QuestionOption[])[i];
		const value = optionValue(option);
		const cursor = i === state.cursor ? palette.accent("›") : " ";
		const box = question.multiple
			? state.selected.has(value)
				? "[x]"
				: "[ ]"
			: "";
		const rec = i === recIdx ? palette.muted(" [rec]") : "";
		const label =
			i === state.cursor ? palette.accent(option.label) : option.label;
		lines.push(
			truncate(`${cursor} ${box ? `${box} ` : ""}${label}${rec}`, width),
		);
		if (option.description) {
			lines.push(
				...wrap(option.description, width - 4, palette).map((l) => `    ${l}`),
			);
		}
	}

	if (state.noteEdit !== undefined) {
		lines.push("");
		lines.push(palette.accent(truncate(`    note: ${state.noteEdit}▌`, width)));
	} else {
		const existing = state.notes.get(question.id);
		if (existing) {
			lines.push("");
			lines.push(palette.dim(truncate(`    note: ${existing}`, width)));
		}
	}

	const highlighted = question.options?.[state.cursor];
	if (highlighted?.preview) {
		lines.push("");
		lines.push(palette.dim("─".repeat(Math.min(width, 40))));
		lines.push(...wrap(highlighted.preview, width, palette));
	}

	if (state.freeText !== undefined) {
		lines.push("");
		lines.push(palette.accent(truncate(`› ${state.freeText}▌`, width)));
	} else if (question.allowFreeText) {
		lines.push("");
		lines.push(palette.muted("(press 't' to type a custom answer)"));
	}

	lines.push("");
	lines.push(border);
	lines.push(
		palette.muted("enter select · ↑/↓ navigate · n note · t other · esc close"),
	);

	return lines;
}

/** Tab bar: header labels with ✓/·skip/active state; collapses on overflow. */
function renderTabs(
	questionnaire: Questionnaire,
	state: QuestionnaireState,
	width: number,
	palette: Palette,
): string[] {
	const labelOf = (q: Question, i: number) => q.header ?? `Q${i + 1}`;
	const raw = questionnaire
		.map((q, i) => {
			const label = labelOf(q, i);
			if (i === state.index) return `[${label}]`;
			if (!isShown(q, state.answers)) return `${label}·skip`;
			return i < state.index ? `${label}✓` : label;
		})
		.join(" ");
	if (raw.length <= width) {
		const coloured = questionnaire
			.map((q, i) => {
				const label = labelOf(q, i);
				if (i === state.index) return palette.accent(`[${label}]`);
				if (!isShown(q, state.answers)) return palette.dim(`${label}·skip`);
				return palette.muted(i < state.index ? `${label}✓` : label);
			})
			.join(" ");
		return [coloured];
	}
	const header = labelOf(questionnaire[state.index], state.index);
	const counter = `‹ ${state.index + 1}/${questionnaire.length} · ${header} ›`;
	return [palette.accent(truncate(counter, width))];
}

const KEY_UP = "\u001b[A";
const KEY_DOWN = "\u001b[B";

export interface QuestionnaireRunOptions extends QuestionnaireRenderOptions {
	/** Prior answers to pre-fill (draft rehydration). */
	readonly initialAnswers?: Answers;
	/** Called with the partial draft when the user closes without sending. */
	readonly onCancel?: (draft: Answers) => void;
}

/**
 * Live, focusable questionnaire. Navigates only shown questions (showIf),
 * pre-selects recommendations, supports per-option notes and free text, and
 * ends on a review step. `done(answers)` on send; `done(undefined)` on esc
 * (with onCancel(draft) so the caller can persist partial progress).
 */
export class QuestionnaireComponent implements Component, Focusable {
	focused = false;
	private state: QuestionnaireState;
	/** true once past the last shown question (review step). */
	private review = false;

	constructor(
		private readonly questionnaire: Questionnaire,
		private readonly done: (answers: Answers | undefined) => void,
		private readonly opts: QuestionnaireRunOptions = {},
	) {
		const notes = new Map<string, string>();
		for (const a of opts.initialAnswers ?? []) {
			if (a.note) notes.set(a.questionId, a.note);
		}
		this.state = {
			...initQuestionnaireState(),
			notes,
			answers: [...(opts.initialAnswers ?? [])],
		};
		this.enter(0);
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.review) return this.renderReview(width);
		return renderQuestionnaire(
			this.questionnaire,
			this.state,
			width,
			this.opts,
		);
	}

	handleInput(data: string): void {
		if (this.state.noteEdit !== undefined) {
			this.handleNote(data);
			return;
		}
		if (this.state.freeText !== undefined) {
			this.handleFreeText(data);
			return;
		}
		if (data === "\u001b") {
			this.cancel();
			return;
		}
		if (this.review) {
			this.handleReview(data);
			return;
		}

		const question = this.questionnaire[this.state.index];
		if (!question) return;
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
			case "n":
				this.state = {
					...this.state,
					noteEdit: this.state.notes.get(question.id) ?? "",
				};
				break;
			case "\r":
			case "\n":
				this.commit();
				break;
		}
	}

	private handleFreeText(data: string): void {
		const buf = this.state.freeText ?? "";
		if (data === "\r" || data === "\n") this.commit();
		else if (data === "\u001b")
			this.state = { ...this.state, freeText: undefined };
		else if (data === "\u007f" || data === "\b")
			this.state = setFreeText(this.state, buf.slice(0, -1));
		else if (data >= " ") this.state = setFreeText(this.state, buf + data);
	}

	private handleNote(data: string): void {
		const buf = this.state.noteEdit ?? "";
		const question = this.questionnaire[this.state.index];
		if (data === "\r" || data === "\n") {
			const notes = new Map(this.state.notes);
			if (question) {
				if (buf.trim()) notes.set(question.id, buf.trim());
				else notes.delete(question.id);
			}
			this.state = { ...this.state, notes, noteEdit: undefined };
		} else if (data === "\u001b") {
			this.state = { ...this.state, noteEdit: undefined };
		} else if (data === "\u007f" || data === "\b") {
			this.state = { ...this.state, noteEdit: buf.slice(0, -1) };
		} else if (data >= " ") {
			this.state = { ...this.state, noteEdit: buf + data };
		}
	}

	private handleReview(data: string): void {
		if (data === "r") {
			this.acceptRecommendations();
			return;
		}
		if (data === "\r" || data === "\n") this.done(this.state.answers);
	}

	/** Commit the current question, then advance to the next shown one. */
	private commit(): void {
		const result = commitQuestion(this.questionnaire, this.state);
		this.state = { ...result.state, index: this.state.index };
		// commitQuestion already appended this question's answer(s).
		this.advanceFrom(this.state.index + 1);
	}

	/** Move to the next shown question from `from`; skip hidden (record skip). */
	private advanceFrom(from: number): void {
		let i = from;
		const answers = [...this.state.answers];
		while (i < this.questionnaire.length) {
			if (isShown(this.questionnaire[i], answers)) break;
			answers.push({
				questionId: this.questionnaire[i].id,
				value: "",
				skipped: true,
			});
			i++;
		}
		this.state = { ...this.state, answers };
		if (i >= this.questionnaire.length) {
			this.review = true;
			return;
		}
		this.enter(i);
	}

	/** Enter question `idx`: set cursor to prior draft choice or recommendation. */
	private enter(idx: number): void {
		if (idx >= this.questionnaire.length) {
			this.review = true;
			return;
		}
		const q = this.questionnaire[idx];
		const prior = this.state.answers.filter(
			(a) => a.questionId === q.id && !a.skipped,
		);
		let cursor = recommendedIndex(q);
		const selected = new Set<string>();
		if (prior.length > 0 && q.options) {
			if (q.multiple) for (const a of prior) selected.add(a.value);
			else {
				const at = q.options.findIndex(
					(o) => optionValue(o) === prior[0].value,
				);
				if (at >= 0) cursor = at;
			}
		}
		// Drop any prior answers for this question; they'll be re-committed.
		const answers = this.state.answers.filter((a) => a.questionId !== q.id);
		this.state = {
			...this.state,
			index: idx,
			cursor: cursor < 0 ? 0 : cursor,
			selected,
			freeText: undefined,
			noteEdit: undefined,
			answers,
		};
	}

	private acceptRecommendations(): void {
		const answers = [...this.state.answers];
		const have = new Set(answers.map((a) => a.questionId));
		for (const q of this.questionnaire) {
			if (have.has(q.id) || !isShown(q, answers)) continue;
			const idx = recommendedIndex(q);
			if (idx >= 0 && q.options)
				answers.push({ questionId: q.id, value: optionValue(q.options[idx]) });
		}
		this.done(answers);
	}

	private cancel(): void {
		this.opts.onCancel?.(this.state.answers);
		this.done(undefined);
	}

	private renderReview(width: number): string[] {
		const palette = this.opts.palette ?? defaultPalette();
		const lines = [palette.heading("Review your answers"), ""];
		for (const q of this.questionnaire) {
			const header = q.header ?? q.id;
			const mine = this.state.answers.filter((a) => a.questionId === q.id);
			if (mine.length === 0 || mine.every((a) => a.skipped)) {
				lines.push(palette.dim(truncate(`  ${header} → (skipped)`, width)));
				continue;
			}
			const val = mine.map((a) => a.value).join(", ");
			lines.push(truncate(`  ${header} → ${val}`, width));
			const note = mine.find((a) => a.note)?.note;
			if (note) lines.push(palette.dim(truncate(`      note: ${note}`, width)));
		}
		lines.push("");
		lines.push(
			palette.muted("[r] accept recommended   [enter] send   [esc] close"),
		);
		return lines;
	}
}

/** Show a questionnaire as a focused component and resolve with the answers. */
export function runQuestionnaire(
	ctx: ExtensionContext,
	questionnaire: Questionnaire,
	opts: QuestionnaireRunOptions = {},
): Promise<Answers | undefined> {
	return ctx.ui.custom<Answers | undefined>(
		(_tui: TUI, theme, _keybindings, done) => {
			const palette = paletteFromTheme(theme);
			return new QuestionnaireComponent(questionnaire, done, {
				...opts,
				palette,
			});
		},
	);
}

function paletteFromTheme(theme: unknown): Palette {
	const t = theme as {
		fg?: (color: string, text: string) => string;
		bold?: (text: string) => string;
	} | null;
	if (!t?.fg) return defaultPalette();
	return {
		dim: (s) => t.fg!("dim", s),
		muted: (s) => t.fg!("muted", s),
		accent: (s) => t.fg!("accent", s),
		heading: (s) => t.bold!(t.fg!("text", s)),
		success: (s) => t.fg!("success", s),
		warning: (s) => t.fg!("warning", s),
		error: (s) => t.fg!("error", s),
		info: (s) => t.fg!("accent", s),
	};
}
