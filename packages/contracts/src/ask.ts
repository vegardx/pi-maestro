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
	/**
	 * Rich tier: a full page of markdown for this option. Any option with a
	 * body (or dimensions) switches the question to the full-screen explorer.
	 */
	readonly body?: string;
	/** Pros/cons rendered as +/− columns on the option's explorer page. */
	readonly tradeoffs?: {
		readonly pros: readonly string[];
		readonly cons: readonly string[];
	};
	/** Preformatted ASCII sketch, rendered verbatim (width-clamped). */
	readonly sketch?: string;
	/** File paths this option touches. */
	readonly touches?: readonly string[];
	/** Row values for the compare matrix, keyed by dimension name. */
	readonly dimensions?: Readonly<Record<string, string>>;
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
	/**
	 * Block the agent until answered. Default false: the question joins the
	 * pending set and the agent keeps working. Blocking questions jump the
	 * pending queue and capture input; the user can still esc to defer.
	 */
	readonly blocking?: boolean;
	/** Why the asker cannot proceed without this — required when blocking. */
	readonly whyBlocking?: string;
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
	/** True when the user deferred a blocking question (value is ""). */
	readonly deferred?: boolean;
}

/** A pending (posted, unanswered) question — the preamble's context line. */
export interface PendingAsk {
	readonly id: string;
	readonly header?: string;
	readonly question: string;
	/** True when this was blocking and the user deferred it. */
	readonly deferred?: boolean;
}

export type Questionnaire = readonly Question[];

export type Answers = readonly Answer[];
