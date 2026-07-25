// Shared model-role + effort vocabulary.

import type { ThinkingLevel } from "./runs.js";

/** Stable policy keys used by model-consuming runtimes. */
export const MODEL_ROLES = [
	"worker",
	"classifier",
	"plan-summarizer",
	"compact-summarizer",
	"verifier",
	"general",
	"codebase-research",
	"web-research",
	"plan-review",
	"practical-review",
	"adversarial-review",
	"correctness-review",
	"security-review",
	"test-review",
	"simplification-review",
	"advisor",
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * The authored effort of a tier option: a concrete thinking level, or "auto" —
 * the effort is decided at assignment time (bounded by the model's supported
 * levels; mechanical default picks fall back to the session thinking level).
 */
export type OptionEffort = ThinkingLevel | "auto";

export type ModelConfigScope = "global" | "project" | "session";

/** One resolution candidate's facts, for routing-inspection surfaces. */
export interface ExactModelCandidateFact {
	readonly optionId: string;
	readonly authoredModel: string;
	readonly modelId?: string;
	readonly effort: OptionEffort;
	readonly summary: string;
	readonly registered: boolean;
	readonly authenticated: boolean;
	readonly effortSupported: boolean;
	readonly available: boolean;
	readonly reason?: string;
}
