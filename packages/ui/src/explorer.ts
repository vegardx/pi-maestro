// The full-screen option explorer: a page per option for questions whose
// options carry rich content (body/dimensions), plus a compare-matrix view.
// Triggered by content, never declared — a plain question renders as the
// regular panel. Pure render functions; the QuestionnaireComponent owns the
// view state (page scroll, compare toggle) and key handling.

import type { Question, QuestionOption } from "@vegardx/pi-contracts";
import { defaultPalette, type Palette, padRight, truncate } from "./format.js";
import type { QuestionnaireState } from "./questionnaire.js";

/** A question earns the explorer when any option has a page or dimensions. */
export function isExplorerQuestion(question: Question): boolean {
	return (
		question.options?.some(
			(o) => o.body !== undefined || o.dimensions !== undefined,
		) ?? false
	);
}

/** View state the component tracks per question (reset on question entry). */
export interface ExplorerView {
	compare: boolean;
	scroll: number;
}

export function initExplorerView(): ExplorerView {
	return { compare: false, scroll: 0 };
}

/** Rows of the detail region shown at once; longer bodies scroll. */
const DETAIL_ROWS = 16;

function wrapPlain(text: string, width: number): string[] {
	if (width <= 0) return [];
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		if (raw.trim() === "") {
			out.push("");
			continue;
		}
		const words = raw.split(/\s+/);
		let line = "";
		for (const word of words) {
			if (line.length + word.length + 1 > width) {
				if (line) out.push(line);
				line = word;
			} else {
				line = line ? `${line} ${word}` : word;
			}
		}
		if (line) out.push(line);
	}
	return out;
}

/** The option-page detail lines (unscrolled): body, tradeoffs, sketch, files. */
export function optionPageLines(
	option: QuestionOption,
	width: number,
	palette: Palette,
): string[] {
	const lines: string[] = [];
	if (option.description) {
		lines.push(...wrapPlain(option.description, width).map(palette.muted));
		lines.push("");
	}
	if (option.body) {
		lines.push(...wrapPlain(option.body, width));
		lines.push("");
	}
	if (option.tradeoffs) {
		lines.push(palette.heading("Tradeoffs"));
		for (const pro of option.tradeoffs.pros) {
			lines.push(palette.success(truncate(`  + ${pro}`, width)));
		}
		for (const con of option.tradeoffs.cons) {
			lines.push(palette.error(truncate(`  − ${con}`, width)));
		}
		lines.push("");
	}
	if (option.sketch) {
		const sketchLines = option.sketch.split("\n");
		const clamp = Math.max(width - 4, 8);
		lines.push(palette.dim(`┌ sketch ${"─".repeat(Math.max(clamp - 9, 0))}┐`));
		for (const raw of sketchLines) {
			lines.push(palette.dim("│ ") + truncate(raw, clamp - 2));
		}
		lines.push(palette.dim(`└${"─".repeat(Math.max(clamp - 1, 0))}┘`));
		lines.push("");
	}
	if (option.touches && option.touches.length > 0) {
		lines.push(
			palette.dim(truncate(`Touches  ${option.touches.join(" · ")}`, width)),
		);
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** The tab row: every option label, the highlighted one marked. */
export function explorerTabRow(
	question: Question,
	cursor: number,
	width: number,
	palette: Palette,
): string {
	const parts: string[] = [];
	const options = question.options ?? [];
	for (let i = 0; i < options.length; i++) {
		const rec =
			question.recommendation !== undefined &&
			(options[i].value ?? options[i].label) === question.recommendation
				? " [rec]"
				: "";
		const cell = `${i + 1} ${options[i].label}${rec}`;
		parts.push(
			i === cursor ? palette.accent(`▌${cell}▐`) : palette.muted(` ${cell} `),
		);
	}
	return truncate(parts.join(" "), width);
}

/** Compare matrix: dimension rows × option columns. */
export function renderCompareMatrix(
	question: Question,
	cursor: number,
	width: number,
	palette: Palette,
): string[] {
	const options = question.options ?? [];
	const dims: string[] = [];
	for (const option of options) {
		for (const key of Object.keys(option.dimensions ?? {})) {
			if (!dims.includes(key)) dims.push(key);
		}
	}
	if (dims.length === 0) return [palette.dim("(no comparison dimensions)")];

	const labelW = Math.min(
		Math.max(...dims.map((d) => d.length), 4) + 2,
		Math.floor(width * 0.25),
	);
	const colW = Math.max(
		Math.floor((width - labelW - options.length) / options.length),
		8,
	);
	const paint = (i: number, s: string) =>
		i === cursor ? palette.accent(s) : s;

	const lines: string[] = [];
	const header = options
		.map((o, i) =>
			paint(i, padRight(truncate(`${i + 1} ${o.label}`, colW), colW)),
		)
		.join(" ");
	lines.push(`${" ".repeat(labelW)}${header}`);
	for (const dim of dims) {
		const cells = options
			.map((o, i) =>
				paint(i, padRight(truncate(o.dimensions?.[dim] ?? "—", colW), colW)),
			)
			.join(" ");
		lines.push(
			`${palette.muted(padRight(truncate(dim, labelW - 1), labelW))}${cells}`,
		);
	}
	return lines;
}

export interface ExplorerRenderOptions {
	palette?: Palette;
}

/**
 * Render an explorer question to plain lines (same box chrome as the panel).
 * The detail region shows DETAIL_ROWS at a time; `view.scroll` moves the
 * window and the hint row grows ↑/↓ markers when there is more.
 */
export function renderExplorer(
	questionnaire: readonly Question[],
	state: QuestionnaireState,
	view: ExplorerView,
	width: number,
	opts: ExplorerRenderOptions = {},
): string[] {
	const palette = opts.palette ?? defaultPalette();
	const question = questionnaire[state.index];
	if (!question) return [];
	const options = question.options ?? [];

	const innerWidth = Math.max(width - 4, 0);
	const topBorder = palette.dim(`╭${"─".repeat(Math.max(width - 2, 0))}╮`);
	const botBorder = palette.dim(`╰${"─".repeat(Math.max(width - 2, 0))}╯`);
	const boxLine = (content: string) =>
		`${palette.dim("│")} ${padRight(content, innerWidth)} ${palette.dim("│")}`;
	const emptyLine = boxLine("");

	const lines: string[] = [];
	lines.push(topBorder);

	if (questionnaire.length > 1) {
		const progress = `Question ${state.index + 1} of ${questionnaire.length}`;
		const blocked = question.blocking ? palette.warning("  ⛔ blocking") : "";
		lines.push(boxLine(palette.muted(progress) + blocked));
		lines.push(emptyLine);
	}
	lines.push(boxLine(palette.heading(truncate(question.question, innerWidth))));
	if (question.blocking && question.whyBlocking) {
		lines.push(
			boxLine(
				palette.warning(
					truncate(`⛔ why this blocks: ${question.whyBlocking}`, innerWidth),
				),
			),
		);
	}
	lines.push(emptyLine);
	lines.push(
		boxLine(explorerTabRow(question, state.cursor, innerWidth, palette)),
	);
	lines.push(boxLine(palette.dim("─".repeat(innerWidth))));

	// Detail region: the highlighted option's page, or the compare matrix.
	const detail = view.compare
		? renderCompareMatrix(question, state.cursor, innerWidth, palette)
		: options[state.cursor]
			? optionPageLines(options[state.cursor], innerWidth, palette)
			: [];
	const maxScroll = Math.max(detail.length - DETAIL_ROWS, 0);
	const scroll = Math.min(Math.max(view.scroll, 0), maxScroll);
	const visible = detail.slice(scroll, scroll + DETAIL_ROWS);
	for (const l of visible) lines.push(boxLine(truncate(l, innerWidth)));
	if (visible.length === 0) lines.push(emptyLine);

	// Free-text (counter-proposal) row when active.
	if (state.freeText !== undefined) {
		lines.push(emptyLine);
		lines.push(
			boxLine(
				palette.accent(truncate(`propose: ${state.freeText}▌`, innerWidth)),
			),
		);
	}

	lines.push(emptyLine);
	const scrollHint =
		detail.length > DETAIL_ROWS
			? ` · ↑/↓ scroll${scroll > 0 ? " ↑" : ""}${scroll < maxScroll ? " ↓" : ""}`
			: "";
	const compareHint = view.compare ? "c page" : "c compare";
	const hint = `←/→ option · 1-9 jump · ${compareHint} · enter choose · o propose${scrollHint} · esc`;
	lines.push(boxLine(palette.muted(truncate(hint, innerWidth))));
	lines.push(botBorder);
	return lines;
}
