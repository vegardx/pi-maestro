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
import { defaultPalette, type Palette, padRight, truncate } from "./format.js";

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

/** Move the option cursor, clamped to options + free-text input slot. */
export function moveCursor(
	state: QuestionnaireState,
	question: Question,
	delta: number,
): QuestionnaireState {
	// options + 1 free-text slot at the end
	const count = (question.options?.length ?? 0) + 1;
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

	// Box geometry: │ content │ — 4 chars of overhead
	const innerWidth = Math.max(width - 4, 0);
	const topBorder = palette.dim(`╭${"─".repeat(Math.max(width - 2, 0))}╮`);
	const botBorder = palette.dim(`╰${"─".repeat(Math.max(width - 2, 0))}╯`);
	const boxLine = (content: string) =>
		`${palette.dim("│")} ${padRight(content, innerWidth)} ${palette.dim("│")}`;
	const emptyLine = boxLine("");

	const lines: string[] = [];
	lines.push(topBorder);

	if (questionnaire.length > 1) {
		const answered = state.answers.filter((a) => !a.skipped).length;
		const progress = `Question ${state.index + 1} of ${questionnaire.length}`;
		const suffix = answered > 0 ? `  (${answered} answered)` : "";
		lines.push(boxLine(palette.muted(progress + suffix)));
		lines.push(emptyLine);
	}

	lines.push(boxLine(palette.heading(truncate(question.question, innerWidth))));
	if (question.context) {
		for (const l of wrap(question.context, innerWidth, palette)) {
			lines.push(boxLine(l));
		}
	}
	lines.push(emptyLine);

	const recIdx = recommendedIndex(question);
	const optCount = question.options?.length ?? 0;
	for (let i = 0; i < optCount; i++) {
		const option = (question.options as QuestionOption[])[i];
		const value = optionValue(option);
		const cursor = i === state.cursor ? palette.accent("›") : " ";
		const num = `${i + 1}.`;
		const box = question.multiple
			? state.selected.has(value)
				? "[x]"
				: "[ ]"
			: "";
		const rec = i === recIdx ? palette.muted(" [rec]") : "";
		const label =
			i === state.cursor ? palette.accent(option.label) : option.label;
		lines.push(
			boxLine(
				truncate(
					`${cursor} ${num} ${box ? `${box} ` : ""}${label}${rec}`,
					innerWidth,
				),
			),
		);
		if (option.description) {
			for (const l of wrap(option.description, innerWidth - 6, palette)) {
				lines.push(boxLine(`      ${l}`));
			}
		}
	}

	// Free-text input field (always visible as last numbered item)
	const freeIdx = optCount;
	const freeCursor = state.cursor === freeIdx ? palette.accent("›") : " ";
	const freeNum = `${freeIdx + 1}.`;
	if (state.freeText !== undefined && state.cursor === freeIdx) {
		lines.push(
			boxLine(
				palette.accent(
					truncate(`${freeCursor} ${freeNum} ${state.freeText}▌`, innerWidth),
				),
			),
		);
	} else if (state.freeText !== undefined && state.freeText.trim() !== "") {
		lines.push(
			boxLine(
				truncate(`${freeCursor} ${freeNum} ${state.freeText}`, innerWidth),
			),
		);
	} else {
		const placeholder =
			state.cursor === freeIdx
				? palette.accent(`${freeCursor} ${freeNum} `)
				: palette.muted(`${freeCursor} ${freeNum} ___`);
		lines.push(boxLine(truncate(placeholder, innerWidth)));
	}

	if (state.noteEdit !== undefined) {
		lines.push(emptyLine);
		lines.push(
			boxLine(
				palette.accent(truncate(`    note: ${state.noteEdit}▌`, innerWidth)),
			),
		);
	} else {
		const existing = state.notes.get(question.id);
		if (existing) {
			lines.push(emptyLine);
			lines.push(
				boxLine(palette.dim(truncate(`    note: ${existing}`, innerWidth))),
			);
		}
	}

	const highlighted = question.options?.[state.cursor];
	if (highlighted?.preview) {
		lines.push(emptyLine);
		lines.push(boxLine(palette.dim("─".repeat(Math.min(innerWidth, 36)))));
		for (const l of wrap(highlighted.preview, innerWidth, palette)) {
			lines.push(boxLine(l));
		}
	}

	lines.push(emptyLine);
	const hint =
		questionnaire.length > 1
			? "enter select · ←/→ question · ↑/↓ navigate · n note · esc close"
			: "enter select · ↑/↓ navigate · n note · esc close";
	lines.push(boxLine(palette.muted(truncate(hint, innerWidth))));
	lines.push(botBorder);

	return lines;
}

const KEY_UP = "\u001b[A";
const KEY_DOWN = "\u001b[B";
const KEY_RIGHT = "\u001b[C";
const KEY_LEFT = "\u001b[D";

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
		// Free-text editing when cursor is on the input field and text is active
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
		const optCount = question.options?.length ?? 0;
		const isFreeSlot = this.state.cursor === optCount;

		switch (data) {
			case KEY_UP:
				this.state = moveCursor(this.state, question, -1);
				break;
			case KEY_DOWN:
				this.state = moveCursor(this.state, question, 1);
				break;
			case KEY_LEFT:
				if (this.questionnaire.length > 1 && this.state.index > 0) {
					this.enter(this.state.index - 1);
				}
				break;
			case KEY_RIGHT:
				if (
					this.questionnaire.length > 1 &&
					this.state.index < this.questionnaire.length - 1
				) {
					this.enter(this.state.index + 1);
				}
				break;
			case " ":
				if (isFreeSlot) {
					this.state = {
						...this.state,
						freeText: `${this.state.freeText ?? ""} `,
					};
				} else {
					this.state = toggleSelection(this.state, question);
				}
				break;
			case "n":
				if (isFreeSlot) {
					this.state = {
						...this.state,
						freeText: `${this.state.freeText ?? ""}n`,
					};
				} else {
					this.state = {
						...this.state,
						noteEdit: this.state.notes.get(question.id) ?? "",
					};
				}
				break;
			case "\r":
			case "\n":
				this.commit();
				break;
			default:
				// Number keys: jump to option (1-indexed)
				if (data >= "1" && data <= "9") {
					const target = Number.parseInt(data, 10) - 1;
					const totalSlots = optCount + 1;
					if (target < totalSlots) {
						this.state = { ...this.state, cursor: target };
						// If jumping to free-text slot, activate it
						if (target === optCount) {
							this.state = {
								...this.state,
								freeText: this.state.freeText ?? "",
							};
						}
					}
				} else if (isFreeSlot && data >= " ") {
					// Any printable char on the free-text slot activates typing
					this.state = {
						...this.state,
						freeText: (this.state.freeText ?? "") + data,
					};
				}
				break;
		}
	}

	private handleFreeText(data: string): void {
		const buf = this.state.freeText ?? "";
		if (data === "\r" || data === "\n") this.commit();
		else if (data === "\u001b") {
			// Escape while in free-text: if empty, exit free-text mode; if has content, keep it but exit edit
			if (buf.trim() === "") {
				this.state = { ...this.state, freeText: undefined };
			} else {
				// Keep text but stop editing (cursor stays, re-entering resumes)
				this.state = { ...this.state, freeText: buf };
			}
		} else if (data === KEY_UP || data === KEY_DOWN) {
			// Navigate away from free-text field
			const question = this.questionnaire[this.state.index];
			if (question) {
				const delta = data === KEY_UP ? -1 : 1;
				this.state = moveCursor(this.state, question, delta);
				// If cursor moved away from free slot, deactivate text editing
				const optCount = question.options?.length ?? 0;
				if (this.state.cursor !== optCount) {
					// Keep the text but exit active editing
				}
			}
		} else if (data === "\u007f" || data === "\b")
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

const KEY_TAB = "\t";

/**
 * Collapsible overlay wrapper around QuestionnaireComponent.
 * Starts collapsed (single-line badge). Tab expands/collapses.
 * When expanded, delegates input to the inner QuestionnaireComponent.
 * Calls `done()` when the questionnaire is fully answered.
 */
export class CollapsibleQuestionnaireComponent implements Component, Focusable {
	focused = false;
	expanded = false;
	private readonly inner: QuestionnaireComponent;
	private readonly palette: Palette;
	private readonly questionCount: number;
	private handle: OverlayHandle | undefined;

	constructor(
		questionnaire: Questionnaire,
		readonly done: (answers: Answers | undefined) => void,
		opts: QuestionnaireRunOptions = {},
	) {
		this.palette = opts.palette ?? defaultPalette();
		this.questionCount = questionnaire.length;
		this.inner = new QuestionnaireComponent(questionnaire, done, opts);
	}

	/** Attach the overlay handle for focus control. */
	setHandle(handle: OverlayHandle): void {
		this.handle = handle;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.expanded) return this.renderCollapsed(width);
		return this.renderExpanded(width);
	}

	handleInput(data: string): void {
		if (data === KEY_TAB) {
			if (this.expanded) {
				this.expanded = false;
				this.handle?.unfocus();
			} else {
				this.expanded = true;
				this.handle?.focus();
			}
			return;
		}
		if (data === "\u001b" && this.expanded) {
			this.expanded = false;
			this.handle?.unfocus();
			return;
		}
		if (this.expanded) {
			this.inner.handleInput(data);
		}
	}

	private renderCollapsed(width: number): string[] {
		const p = this.focused ? this.palette : dimmedPalette(this.palette);
		// Top line: ╭─ label ─── hint ─╮  (total = width)
		// Overhead: ╭─␣ (3) + ␣ (1) + ␣ (1) + ␣─╮ (3) = 8
		const label = `${this.questionCount} question${this.questionCount === 1 ? "" : "s"} pending`;
		const hint = "Tab to expand";
		const fillWidth = Math.max(width - 8 - label.length - hint.length, 0);
		const fill = "─".repeat(fillWidth);
		const top = p.dim(`╭─ ${label} ${fill} ${hint} ─╮`);
		const bot = p.dim(`╰${"─".repeat(Math.max(width - 2, 0))}╯`);
		return [top, bot];
	}

	private renderExpanded(width: number): string[] {
		const p = this.focused ? this.palette : dimmedPalette(this.palette);
		this.inner.focused = this.focused;
		// Temporarily swap palette on inner for dim when unfocused
		const lines = this.inner.render(width);
		if (!this.focused) {
			return lines.map((l) => p.dim(l));
		}
		return lines;
	}
}

/** Minimal handle interface for overlay focus control. */
export interface OverlayHandle {
	focus(): void;
	unfocus(opts?: { target?: unknown }): void;
}

function dimmedPalette(base: Palette): Palette {
	return {
		...base,
		accent: base.dim,
		heading: base.dim,
		muted: base.dim,
	};
}

/** Show a questionnaire as a focused component and resolve with the answers. */
export function runQuestionnaire(
	ctx: ExtensionContext,
	questionnaire: Questionnaire,
	opts: QuestionnaireRunOptions = {},
): Promise<Answers | undefined> {
	let comp: CollapsibleQuestionnaireComponent | undefined;
	return ctx.ui.custom<Answers | undefined>(
		(_tui: TUI, theme, _keybindings, done) => {
			const palette = paletteFromTheme(theme);
			comp = new CollapsibleQuestionnaireComponent(questionnaire, done, {
				...opts,
				palette,
			});
			return comp;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "60%",
			},
			onHandle: (handle: OverlayHandle) => {
				comp?.setHandle(handle);
			},
		} as any,
	);
}

function paletteFromTheme(theme: unknown): Palette {
	const t = theme as {
		fg?: (color: string, text: string) => string;
		bold?: (text: string) => string;
	} | null;
	if (!t?.fg) return defaultPalette();
	// biome-ignore lint/style/noNonNullAssertion: guarded above
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
