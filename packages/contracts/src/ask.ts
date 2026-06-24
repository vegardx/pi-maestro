// Questionnaire vocabulary shared between the ask engine (owner) and its
// consumers (the ask tool, modes gates). Mirrors the AskUserQuestion shape:
// tabbed questions, options with optional preview, optional free text.

export interface QuestionOption {
	readonly label: string;
	/** Defaults to `label` when omitted. */
	readonly value?: string;
	/** Optional preview pane content for this option. */
	readonly preview?: string;
}

export interface Question {
	readonly id: string;
	readonly question: string;
	readonly context?: string;
	readonly options?: readonly QuestionOption[];
	readonly allowFreeText?: boolean;
	readonly multiple?: boolean;
}

export interface Answer {
	readonly questionId: string;
	readonly value: string;
	/** True when the value came from free-text rather than an option. */
	readonly custom?: boolean;
}

export type Questionnaire = readonly Question[];

export type Answers = readonly Answer[];
