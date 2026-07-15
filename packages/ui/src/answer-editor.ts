// Answer mode: the input-takeover presentation for pending questions. A
// CustomEditor subclass renders the question header + numbered options above
// its own input line (prompt char `?` embedded in the takeover rule — pi's
// editor has no prompt glyph of its own). Digits 1-9 select an option, typed
// text is a custom answer, Enter submits, Esc defers (blocking) or exits.
//
// The step/selection state machine lives in AnswerFlow — pure and
// snapshot-testable without a terminal; AnswerEditor is the thin shell and
// openAnswerMode owns the setEditorComponent/restore dance.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Answer, Question, Questionnaire } from "@vegardx/pi-contracts";
import { defaultPalette, type Palette } from "./format.js";

const MAX_OPTION_ROWS = 9;

/**
 * Pure answer-mode state: fixed question list, one step at a time. Digit
 * selection applies to the CURRENT question; committing advances in place
 * (step 1/N → 2/N).
 */
export class AnswerFlow {
	#step = 0;
	#selected: number | undefined;

	constructor(
		readonly questions: Questionnaire,
		readonly blocking: boolean,
	) {
		this.#preselectRecommendation();
	}

	get current(): Question | undefined {
		return this.questions[this.#step];
	}

	/** 1-based step for the "(i/N)" header. */
	get step(): number {
		return Math.min(this.#step + 1, this.questions.length);
	}

	get total(): number {
		return this.questions.length;
	}

	get selected(): number | undefined {
		return this.#selected;
	}

	get done(): boolean {
		return this.#step >= this.questions.length;
	}

	/** Digit 1-9 on an empty editor: select that option. True when handled. */
	selectDigit(n: number): boolean {
		const options = this.current?.options ?? [];
		if (n < 1 || n > Math.min(options.length, MAX_OPTION_ROWS)) return false;
		this.#selected = n - 1;
		return true;
	}

	/** Typed text overrides any digit selection. */
	clearSelection(): void {
		this.#selected = undefined;
	}

	/**
	 * Resolve the answer Enter submits: non-empty text is a custom answer;
	 * otherwise the digit-selected (or recommended) option. Undefined when
	 * there is nothing to submit yet.
	 */
	answerFor(text: string): Answer | undefined {
		const question = this.current;
		if (!question) return undefined;
		const trimmed = text.trim();
		if (trimmed !== "") {
			return { questionId: question.id, value: trimmed, custom: true };
		}
		const options = question.options ?? [];
		const at = this.#selected;
		if (at !== undefined && options[at]) {
			const option = options[at];
			return { questionId: question.id, value: option.value ?? option.label };
		}
		return undefined;
	}

	/** Move to the next question. True while more remain. */
	advance(): boolean {
		this.#step += 1;
		this.#selected = undefined;
		this.#preselectRecommendation();
		return !this.done;
	}

	/** Esc semantics: blocking questions defer; pending ones just close. */
	escAction(): "defer" | "exit" {
		return this.blocking ? "defer" : "exit";
	}

	/**
	 * Plain header lines rendered above the editor: title/step line, the
	 * question, numbered options (selection marked), and the key hint.
	 */
	headerLines(width: number, title: string): AnswerHeaderLine[] {
		const question = this.current;
		if (!question) return [];
		const lines: AnswerHeaderLine[] = [];
		const step = this.total > 1 ? ` (${this.step}/${this.total})` : "";
		const flag = this.blocking ? " — blocking" : "";
		lines.push({
			text: truncateToWidth(` ? ${title}${step}${flag}`, width),
			kind: "title",
		});
		lines.push({
			text: truncateToWidth(
				`   ${question.question.replace(/\s+/g, " ")}`,
				width,
			),
			kind: "question",
		});
		const options = (question.options ?? []).slice(0, MAX_OPTION_ROWS);
		options.forEach((option, i) => {
			const mark = this.#selected === i ? "›" : " ";
			const rec =
				question.recommendation !== undefined &&
				(option.value ?? option.label) === question.recommendation
					? " [rec]"
					: "";
			const description = option.description ? ` — ${option.description}` : "";
			lines.push({
				text: truncateToWidth(
					`  ${mark}${i + 1} ${option.label}${rec}${description}`,
					width,
				),
				kind: this.#selected === i ? "selected" : "option",
			});
		});
		const esc = this.escAction() === "defer" ? "esc defer" : "esc back";
		const digits = options.length > 0 ? "digits choose · " : "";
		lines.push({
			text: truncateToWidth(
				`   ${digits}type a custom answer · enter submit · ${esc}`,
				width,
			),
			kind: "hint",
		});
		return lines;
	}

	#preselectRecommendation(): void {
		const question = this.current;
		if (!question?.recommendation || !question.options) return;
		const at = question.options.findIndex(
			(o) => (o.value ?? o.label) === question.recommendation,
		);
		if (at >= 0) this.#selected = at;
	}
}

export interface AnswerHeaderLine {
	readonly text: string;
	readonly kind: "title" | "question" | "option" | "selected" | "hint";
}

export interface AnswerModeOptions {
	/** Asker line: "maestro" or "worker · slug". */
	readonly title: string;
	readonly blocking: boolean;
	readonly questions: Questionnaire;
	readonly palette?: Palette;
	/** One question committed (per step). */
	onAnswer(answer: Answer): void;
	/** Esc on a blocking set (defer semantics live with the caller). */
	onDefer?(): void;
	/** The takeover ended and the previous editor was restored. */
	onClose?(): void;
}

export interface AnswerModeHandle {
	readonly currentQuestionId: string | undefined;
	close(): void;
}

type UiSlice = Pick<
	ExtensionContext["ui"],
	"setEditorComponent" | "getEditorComponent"
>;

/**
 * Take over the input with the answer editor; restore the previously
 * configured editor component (usually the default) on exit. The same flow
 * serves the ask engine's pending set and the worker question queue.
 */
export function openAnswerMode(
	ui: UiSlice,
	opts: AnswerModeOptions,
): AnswerModeHandle {
	const flow = new AnswerFlow(opts.questions, opts.blocking);
	const previous = ui.getEditorComponent();
	let closed = false;
	const close = (): void => {
		if (closed) return;
		closed = true;
		ui.setEditorComponent(previous);
		opts.onClose?.();
	};
	ui.setEditorComponent(
		(tui, theme, keybindings) =>
			new AnswerEditor(tui, theme, keybindings, {
				flow,
				title: opts.title,
				palette: opts.palette,
				onAnswer: opts.onAnswer,
				onDefer: () => {
					opts.onDefer?.();
					close();
				},
				requestClose: close,
			}),
	);
	return {
		get currentQuestionId() {
			return flow.current?.id;
		},
		close,
	};
}

interface AnswerEditorOptions {
	readonly flow: AnswerFlow;
	readonly title: string;
	readonly palette?: Palette;
	onAnswer(answer: Answer): void;
	onDefer(): void;
	requestClose(): void;
}

/**
 * The takeover editor: question header + options above the input line. The
 * top border carries the `?` prompt label. Extends CustomEditor so app
 * keybindings keep working for keys the flow doesn't own.
 */
export class AnswerEditor extends CustomEditor {
	readonly #opts: AnswerEditorOptions;
	readonly #tui: { requestRender?: () => void };

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
		opts: AnswerEditorOptions,
	) {
		super(tui, theme, keybindings);
		this.#opts = opts;
		this.#tui = tui as unknown as { requestRender?: () => void };
		this.onSubmit = (text) => this.#submit(text);
		this.onEscape = () => {
			if (opts.flow.escAction() === "defer") opts.onDefer();
			else opts.requestClose();
		};
	}

	override handleInput(data: string): void {
		const flow = this.#opts.flow;
		// Digits select an option only while the editor is empty; once a
		// custom answer is being typed they are ordinary text.
		if (/^[1-9]$/.test(data) && this.getText() === "") {
			if (flow.selectDigit(Number(data))) {
				this.#tui.requestRender?.();
				return;
			}
		}
		super.handleInput(data);
		// Any typed text overrides the digit selection.
		if (this.getText() !== "" && flow.selected !== undefined) {
			flow.clearSelection();
		}
	}

	#submit(text: string): void {
		const flow = this.#opts.flow;
		const answer = flow.answerFor(text);
		if (!answer) return;
		this.#opts.onAnswer(answer);
		this.setText("");
		if (!flow.advance()) {
			this.#opts.requestClose();
			return;
		}
		this.#tui.requestRender?.();
	}

	override render(width: number): string[] {
		const palette = this.#opts.palette ?? defaultPalette();
		const header = this.#opts.flow
			.headerLines(width, this.#opts.title)
			.map((line) => styleHeaderLine(line, palette));
		const editor = super.render(width);
		// The editor's own top border becomes the takeover rule with the `?`
		// prompt label embedded.
		if (editor.length > 0) {
			const label = "─? answer ";
			editor[0] = this.borderColor(
				truncateToWidth(
					`${label}${"─".repeat(Math.max(0, width - label.length))}`,
					width,
				),
			);
		}
		return [...header, ...editor];
	}
}

function styleHeaderLine(line: AnswerHeaderLine, palette: Palette): string {
	switch (line.kind) {
		case "title":
			return palette.heading(line.text);
		case "selected":
			return palette.accent(line.text);
		case "hint":
			return palette.muted(line.text);
		default:
			return line.text;
	}
}
