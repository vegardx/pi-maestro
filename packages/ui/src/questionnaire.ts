// Questionnaire widget — the interactive primitive the ask engine builds on.
// Renders tabbed questions with selectable options, optional per-option preview
// pane, and optional free-text entry. Interaction logic lives in pure reducers
// (testable without a terminal); the Component and runQuestionnaire wire them to
// the host UI.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type {
	Answer,
	Answers,
	Question,
	Questionnaire,
	QuestionOption,
} from "@vegardx/pi-contracts";
import {
	type ExplorerView,
	initExplorerView,
	isExplorerQuestion,
	renderExplorer,
} from "./explorer.js";
import { defaultPalette, type Palette, padRight, truncate } from "./format.js";

export function optionValue(option: QuestionOption): string {
	return option.value ?? option.label;
}

/** Terminal width at which the panel goes two-column (options ┃ detail). */
export const WIDE_MIN_WIDTH = 100;

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
		// freeText is consumed by the commit — clearing it keeps the review
		// step from routing input back into free-text editing.
		return {
			state: { ...state, answers, freeText: undefined },
			done: true,
			answers,
		};
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

function wrap(
	text: string,
	width: number,
	palette: Palette,
	color?: (s: string) => string,
): string[] {
	if (width <= 0) return [];
	const paint = color ?? palette.dim;
	const words = text.split(/\s+/);
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		if (line.length + word.length + 1 > width) {
			if (line) lines.push(paint(line));
			line = word;
		} else {
			line = line ? `${line} ${word}` : word;
		}
	}
	if (line) lines.push(paint(line));
	return lines;
}

/** Word-wrap plain text to a display width (visible-width aware). */
function wrapPlain(text: string, width: number): string[] {
	if (width <= 0) return [];
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		const candidate = line ? `${line} ${word}` : word;
		if (line && visibleWidth(candidate) > width) {
			lines.push(line);
			line = word;
		} else {
			line = candidate;
		}
	}
	if (line) lines.push(line);
	return lines;
}

const stripBold = (s: string): string => s.replace(/\*\*(.+?)\*\*/g, "$1");

/**
 * Render lightly-structured text (from a model) to styled, wrapped lines.
 * Understands three things so a long summary reads as sections instead of a
 * wall of prose: blank lines separate paragraphs; a leading `-`/`*`/`•` is a
 * hanging-indent bullet; and a `**Heading:**` lead becomes its own emphasized
 * line (with the following text wrapped under it). Inline `**bold**` markers
 * are stripped. Every returned line is ≤ width in display columns.
 */
export function renderRichText(
	text: string,
	width: number,
	palette: Palette,
): string[] {
	if (width <= 0) return [];
	const out: string[] = [];
	const pushBlank = () => {
		if (out.length > 0 && out[out.length - 1] !== "") out.push("");
	};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "") {
			pushBlank();
			continue;
		}
		const bullet = line.match(/^[-*•]\s+(.*)$/);
		if (bullet) {
			const wrapped = wrapPlain(stripBold(bullet[1]), Math.max(width - 2, 1));
			wrapped.forEach((l, i) =>
				out.push(palette.dim(i === 0 ? `• ${l}` : `  ${l}`)),
			);
			continue;
		}
		const heading = line.match(/^\*\*(.+?)\*\*:?\s*(.*)$/);
		if (heading) {
			pushBlank();
			out.push(palette.heading(truncate(heading[1].replace(/:$/, ""), width)));
			for (const l of wrapPlain(stripBold(heading[2]), width)) {
				out.push(palette.dim(l));
			}
			continue;
		}
		for (const l of wrapPlain(stripBold(line), width)) out.push(palette.dim(l));
	}
	while (out.length > 0 && out[out.length - 1] === "") out.pop();
	return out;
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
		const blocked = question.blocking ? palette.warning("  ⛔ blocking") : "";
		lines.push(boxLine(palette.muted(progress + suffix) + blocked));
		lines.push(emptyLine);
	}

	lines.push(boxLine(palette.heading(truncate(question.question, innerWidth))));
	if (question.blocking && question.whyBlocking) {
		for (const l of wrap(
			`⛔ why this blocks: ${question.whyBlocking}`,
			innerWidth,
			palette,
			palette.warning,
		)) {
			lines.push(boxLine(l));
		}
	}
	if (question.context) {
		for (const l of renderRichText(question.context, innerWidth, palette)) {
			lines.push(boxLine(l));
		}
	}
	lines.push(emptyLine);

	const recIdx = recommendedIndex(question);
	const optCount = question.options?.length ?? 0;

	const optionRow = (i: number, colWidth: number): string => {
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
		return truncate(
			`${cursor} ${num} ${box ? `${box} ` : ""}${label}${rec}`,
			colWidth,
		);
	};

	// Free-text input field (always visible as last numbered item)
	const freeIdx = optCount;
	const freeTextRow = (colWidth: number): string => {
		const freeCursor = state.cursor === freeIdx ? palette.accent("›") : " ";
		const freeNum = `${freeIdx + 1}.`;
		const placeholderWidth = Math.min(Math.floor(colWidth * 0.5), 40);
		if (state.freeText !== undefined && state.cursor === freeIdx) {
			return palette.accent(
				truncate(`${freeCursor} ${freeNum} ${state.freeText}▌`, colWidth),
			);
		}
		if (state.freeText !== undefined && state.freeText.trim() !== "") {
			return truncate(`${freeCursor} ${freeNum} ${state.freeText}`, colWidth);
		}
		const underscores = "_".repeat(placeholderWidth);
		return state.cursor === freeIdx
			? palette.accent(`${freeCursor} ${freeNum} ${underscores}`)
			: palette.muted(`${freeCursor} ${freeNum} ${underscores}`);
	};

	// Two-column panel at comfortable widths: options left, the highlighted
	// option's full detail right. Narrow terminals keep the stacked layout.
	const wide = width >= WIDE_MIN_WIDTH && optCount > 0;
	if (wide) {
		const leftW = Math.min(Math.floor(innerWidth * 0.42), 46);
		const rightW = innerWidth - leftW - 3;
		const left: string[] = [];
		for (let i = 0; i < optCount; i++) left.push(optionRow(i, leftW));
		left.push(freeTextRow(leftW));

		const right: string[] = [];
		const sel =
			state.cursor < optCount
				? (question.options as QuestionOption[])[state.cursor]
				: undefined;
		if (sel) {
			right.push(palette.heading(truncate(sel.label, rightW)));
			if (sel.description) {
				right.push("");
				right.push(...wrap(sel.description, rightW, palette, (s) => s));
			}
			if (sel.preview) {
				right.push("");
				right.push(...wrap(sel.preview, rightW, palette));
			}
		}

		const sep = ` ${palette.dim("┃")} `;
		const rows = Math.max(left.length, right.length);
		for (let i = 0; i < rows; i++) {
			lines.push(
				boxLine(
					`${padRight(left[i] ?? "", leftW)}${sep}${truncate(right[i] ?? "", rightW)}`,
				),
			);
		}
	} else {
		for (let i = 0; i < optCount; i++) {
			const option = (question.options as QuestionOption[])[i];
			lines.push(boxLine(optionRow(i, innerWidth)));
			if (option.description) {
				for (const l of wrap(option.description, innerWidth - 6, palette)) {
					lines.push(boxLine(`      ${l}`));
				}
			}
		}
		lines.push(boxLine(freeTextRow(innerWidth)));
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

	// Preview pane (narrow layout only — the wide layout shows it inline)
	const highlighted =
		!wide && state.cursor < optCount
			? question.options?.[state.cursor]
			: undefined;
	if (highlighted?.preview) {
		lines.push(emptyLine);
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
	/**
	 * Called as each question is committed (including showIf skips), so a
	 * pending-set host can settle and deliver answers piecemeal instead of
	 * waiting for the review step.
	 */
	readonly onQuestionCommitted?: (answers: Answers) => void;
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
	/** Explorer view state (page scroll, compare) — reset per question. */
	private explorerView: ExplorerView = initExplorerView();

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
		const question = this.questionnaire[this.state.index];
		if (question && isExplorerQuestion(question)) {
			return renderExplorer(
				this.questionnaire,
				this.state,
				this.explorerView,
				width,
				this.opts,
			);
		}
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
		if (
			isExplorerQuestion(question) &&
			this.handleExplorerKeys(data, question)
		) {
			return;
		}
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

	/**
	 * Explorer pages own ←/→ (cycle options), ↑/↓ (scroll), c (compare),
	 * o (free-text counter-proposal), and bare digits (jump). Everything
	 * else — enter to choose, esc, notes — falls through to the regular
	 * handler. Returns true when the key was consumed.
	 */
	private handleExplorerKeys(data: string, question: Question): boolean {
		const optCount = question.options?.length ?? 0;
		if (optCount === 0) return false;
		switch (data) {
			case KEY_LEFT:
				this.state = {
					...this.state,
					cursor: (this.state.cursor - 1 + optCount) % optCount,
				};
				this.explorerView.scroll = 0;
				return true;
			case KEY_RIGHT:
				this.state = {
					...this.state,
					cursor: (this.state.cursor + 1) % optCount,
				};
				this.explorerView.scroll = 0;
				return true;
			case KEY_UP:
				this.explorerView.scroll = Math.max(this.explorerView.scroll - 1, 0);
				return true;
			case KEY_DOWN:
				this.explorerView.scroll += 1; // clamped at render time
				return true;
			case "c":
				this.explorerView.compare = !this.explorerView.compare;
				return true;
			case "o":
				this.state = startFreeText(this.state);
				return true;
			default:
				if (data >= "1" && data <= "9") {
					const target = Number.parseInt(data, 10) - 1;
					if (target < optCount) {
						this.state = { ...this.state, cursor: target };
						this.explorerView.scroll = 0;
					}
					return true;
				}
				return false;
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

	/** The question the user currently has open (pending-set raise anchor). */
	get currentQuestionId(): string | undefined {
		return this.questionnaire[this.state.index]?.id;
	}

	/** Commit the current question, then advance to the next shown one. */
	private commit(): void {
		const before = this.state.answers.length;
		const result = commitQuestion(this.questionnaire, this.state);
		this.state = { ...result.state, index: this.state.index };
		// commitQuestion already appended this question's answer(s).
		const committed = this.state.answers.slice(before);
		if (committed.length > 0) this.opts.onQuestionCommitted?.(committed);
		this.advanceFrom(this.state.index + 1);
	}

	/** Move to the next shown question from `from`; skip hidden (record skip). */
	private advanceFrom(from: number): void {
		let i = from;
		const answers = [...this.state.answers];
		const skips: Answer[] = [];
		while (i < this.questionnaire.length) {
			if (isShown(this.questionnaire[i], answers)) break;
			const skip = {
				questionId: this.questionnaire[i].id,
				value: "",
				skipped: true,
			};
			answers.push(skip);
			skips.push(skip);
			i++;
		}
		this.state = { ...this.state, answers };
		if (skips.length > 0) this.opts.onQuestionCommitted?.(skips);
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
		this.explorerView = initExplorerView();
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

export interface CollapsibleQuestionnaireOptions
	extends QuestionnaireRunOptions {
	/** Live badge counts; falls back to the wrapped question count. */
	readonly badge?: () => { pending: number; deferred: number };
	/** Whether an undeferred blocking question is in the set. */
	readonly hasBlocking?: () => boolean;
	/** Esc while a blocking question is active: defer instead of collapse. */
	readonly onDefer?: () => void;
}

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
	private readonly copts: CollapsibleQuestionnaireOptions;
	private handle: OverlayHandle | undefined;

	constructor(
		questionnaire: Questionnaire,
		readonly done: (answers: Answers | undefined) => void,
		opts: CollapsibleQuestionnaireOptions = {},
	) {
		this.palette = opts.palette ?? defaultPalette();
		this.questionCount = questionnaire.length;
		this.copts = opts;
		this.inner = new QuestionnaireComponent(questionnaire, done, opts);
	}

	/** The question the user currently has open. */
	get currentQuestionId(): string | undefined {
		return this.inner.currentQuestionId;
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
			// A blocking question owns esc: defer it (the host unblocks and
			// collapses). Otherwise esc just collapses to the badge.
			if (this.copts.hasBlocking?.()) {
				this.copts.onDefer?.();
				return;
			}
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
		const counts = this.copts.badge?.() ?? {
			pending: this.questionCount,
			deferred: 0,
		};
		const label =
			`◆ ${counts.pending} pending` +
			(counts.deferred > 0 ? ` · ${counts.deferred} ⛔` : "");
		const hint = "Tab to expand";
		// Measure DISPLAY width, not JS string length: ⛔ (and ◆) are wide/emoji
		// glyphs whose .length undercounts their terminal columns, which would
		// otherwise push the border one column past `width` and crash the TUI.
		const overhead = 8; // "╭─ " + " " + " " + " ─╮"
		const fillWidth = Math.max(
			width - overhead - visibleWidth(label) - visibleWidth(hint),
			0,
		);
		const fill = "─".repeat(fillWidth);
		const top = truncate(p.dim(`╭─ ${label} ${fill} ${hint} ─╮`), width);
		const bot = truncate(
			p.dim(`╰${"─".repeat(Math.max(width - 2, 0))}╯`),
			width,
		);
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

export function paletteFromTheme(theme: unknown): Palette {
	const t = theme as {
		fg?: (color: string, text: string) => string;
		bold?: (text: string) => string;
	} | null;
	if (!t?.fg) return defaultPalette();
	return {
		dim: (s) => t.fg!("dim", s),
		muted: (s) => t.fg!("muted", s),
		accent: (s) => t.fg!("accent", s),
		heading: (s) => t.bold?.(t.fg!("text", s)) ?? t.fg!("text", s),
		success: (s) => t.fg!("success", s),
		warning: (s) => t.fg!("warning", s),
		error: (s) => t.fg!("error", s),
		info: (s) => t.fg!("accent", s),
	};
}
