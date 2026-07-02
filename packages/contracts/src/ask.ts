// Questionnaire vocabulary shared between the ask engine (owner) and its
// consumers (the ask tool, modes gates). Mirrors the AskUserQuestion shape:
// tabbed questions, options with optional preview, optional free text.

export interface QuestionOption {
	readonly label: string;
	/** Defaults to `label` when omitted. Also what `recommendation`/`showIf` match. */
	readonly value?: string;
	/** One-line help shown under the label explaining the trade-off. */
	readonly description?: string;
	/** Optional preview pane content for this option. */
	readonly preview?: string;
}

/** Show a question only when an earlier answer matches. */
export interface ShowIf {
	readonly questionId: string;
	/** Show when that question's answer value equals this. */
	readonly choice?: string;
	/** Show when that question's answer value is any of these. */
	readonly anyOf?: readonly string[];
}

export interface Question {
	readonly id: string;
	readonly question: string;
	readonly context?: string;
	readonly options?: readonly QuestionOption[];
	readonly allowFreeText?: boolean;
	readonly multiple?: boolean;
	/** Short tab label (concise, 1-3 words); falls back to `Q<n>`. */
	readonly header?: string;
	/**
	 * Option value the asker recommends — pre-selected and marked `[rec]`.
	 * A single-choice affordance; for `multiple` it pre-checks that one option.
	 */
	readonly recommendation?: string;
	/**
	 * Conditional display based on a previous answer. For a multi-select
	 * trigger, satisfied when ANY selected value matches.
	 */
	readonly showIf?: ShowIf;
}

export interface Answer {
	readonly questionId: string;
	readonly value: string;
	/** True when the value came from free-text rather than an option. */
	readonly custom?: boolean;
	/** Optional note the user attached to their choice. */
	readonly note?: string;
	/** True when hidden by an unmet `showIf` (value is ""). */
	readonly skipped?: boolean;
}

export type Questionnaire = readonly Question[];

export type Answers = readonly Answer[];
