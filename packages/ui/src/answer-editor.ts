// Answer mode: a focused editor takeover hosting the full questionnaire
// component. The questionnaire owns selection, rich option pages, free text,
// notes, conditional questions, and the final review/send boundary; this file
// only integrates that state machine with pi's custom-editor surface.
//
// Return is handled directly in handleInput. pi rewires a custom editor's
// onSubmit callback after construction, so answer mode must never depend on
// that callback for committing or sending answers.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { Answers, Questionnaire } from "@vegardx/pi-contracts";
import type { Palette } from "./format.js";
import { QuestionnaireComponent } from "./questionnaire.js";

export interface AnswerModeOptions {
	/** Asker line: "maestro" or "worker · slug". */
	readonly title: string;
	readonly blocking: boolean;
	readonly questions: Questionnaire;
	readonly palette?: Palette;
	/** Prior questionnaire progress (worker questions reopened from the HUD). */
	readonly initialAnswers?: Answers;
	/** Complete answers, called only from the review screen's Send action. */
	onDone(answers: Answers): void;
	/** Partial draft captured when a non-blocking session closes. */
	onCancel?(draft: Answers): void;
	/** Esc on a blocking question (defer semantics live with the caller). */
	onDefer?(): void;
	/** The takeover ended and the previous editor/draft were restored. */
	onClose?(): void;
}

export interface AnswerModeHandle {
	readonly currentQuestionId: string | undefined;
	close(): void;
}

type UiSlice = Pick<
	ExtensionContext["ui"],
	| "setEditorComponent"
	| "getEditorComponent"
	| "getEditorText"
	| "setEditorText"
>;

/**
 * Take over the input with a questionnaire editor, preserving both the
 * configured editor factory and its exact draft. Restoration is idempotent
 * and always restores the factory before putting the draft back into it.
 */
export function openAnswerMode(
	ui: UiSlice,
	opts: AnswerModeOptions,
): AnswerModeHandle {
	const previous = ui.getEditorComponent();
	const draft = ui.getEditorText?.() ?? "";
	let editor: AnswerEditor | undefined;
	let closed = false;
	const close = (): void => {
		if (closed) return;
		closed = true;
		ui.setEditorComponent(previous);
		ui.setEditorText?.(draft);
		opts.onClose?.();
	};
	ui.setEditorComponent(
		(tui, theme, keybindings) =>
			(editor = new AnswerEditor(tui, theme, keybindings, {
				...opts,
				requestClose: close,
			})),
	);
	// pi copies the previous editor text into every replacement component.
	// Clear it: questionnaire free text is separate from the normal prompt.
	ui.setEditorText?.("");
	return {
		get currentQuestionId() {
			return editor?.currentQuestionId ?? opts.questions[0]?.id;
		},
		close,
	};
}

interface AnswerEditorOptions extends AnswerModeOptions {
	requestClose(): void;
}

/**
 * Thin CustomEditor-compatible host for QuestionnaireComponent. It renders no
 * ordinary text editor: all visible state and input belong to the questionnaire.
 */
export class AnswerEditor extends CustomEditor {
	readonly #questionnaire: QuestionnaireComponent;
	readonly #tui: { requestRender?: () => void };

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
		opts: AnswerEditorOptions,
	) {
		super(tui, theme, keybindings);
		this.#tui = tui as unknown as { requestRender?: () => void };
		this.#questionnaire = new QuestionnaireComponent(
			opts.questions,
			(answers) => {
				if (answers) opts.onDone(answers);
				opts.requestClose();
			},
			{
				recipient: opts.title,
				...(opts.palette ? { palette: opts.palette } : {}),
				...(opts.initialAnswers ? { initialAnswers: opts.initialAnswers } : {}),
				onCancel: (partial) => {
					opts.onCancel?.(partial);
					if (opts.blocking) opts.onDefer?.();
				},
			},
		);
		this.#questionnaire.focused = true;
	}

	get currentQuestionId(): string | undefined {
		return this.#questionnaire.currentQuestionId;
	}

	override handleInput(data: string): void {
		// App-level interrupt/exit chords must never be trapped by the takeover.
		if (data === "\u0003" || data === "\u0004") {
			super.handleInput(data);
			return;
		}
		// QuestionnaireComponent owns Return and Escape directly. In particular,
		// Return must not reach onSubmit: pi overwrites that callback on install.
		this.#questionnaire.handleInput(data);
		this.#tui.requestRender?.();
	}

	override render(width: number): string[] {
		return this.#questionnaire.render(width);
	}
}
