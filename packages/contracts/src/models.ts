// Shared exact model-preset vocabulary.

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
 * The authored effort of a model-set option: a concrete thinking level, or
 * "auto" — the effort is decided at assignment time (the planner picks it
 * per task, bounded by `efforts` ∩ the model's supported levels; mechanical
 * default picks fall back to the session thinking level).
 */
export type OptionEffort = ThinkingLevel | "auto";

/** An authored option is one exact model/effort pair, not a broad pool. */
export interface ExactModelOption {
	readonly id: string;
	readonly model: string;
	readonly effort: OptionEffort;
	readonly summary: string;
	/**
	 * Optional allowlist bounding this option's usable thinking levels —
	 * both the planner's "auto" choice and any fixed effort must fall
	 * within it (∩ what the model itself supports).
	 */
	readonly efforts?: readonly ThinkingLevel[];
}

/** Reusable ordered exact options. Order determines the unassigned default. */
export interface ModelSetConfig {
	readonly options: readonly ExactModelOption[];
}

/** `/model` activates a preset, which maps policy keys to reusable sets. */
export interface ModelPresetConfig {
	readonly targets: readonly string[];
	readonly modelSets: Readonly<Partial<Record<ModelRole, string>>>;
}

/**
 * Data-residency filter. `lists` are named whitelists of `provider/model`
 * refs (exact, or `*` glob for hand-authored configs); `active` selects
 * one, or the reserved state "off" (alias "none", case-insensitive) which
 * matches every model — residency has no opinion until a named filter is
 * added on top. Every named list, including one called "Global", is
 * explicit and user-curated. The `session` sentinel always passes — the
 * session model is the user's own explicit choice, outside the fleet
 * filter.
 */
export interface ResidencyConfig {
	readonly active?: string;
	readonly lists?: Readonly<Record<string, readonly string[]>>;
}

export interface ModelsConfig {
	readonly modelSets: Readonly<Record<string, ModelSetConfig>>;
	readonly presets: Readonly<Record<string, ModelPresetConfig>>;
	readonly residency?: ResidencyConfig;
}

export type ModelConfigScope = "global" | "project" | "session";

export interface ModelPresetSource {
	readonly scope: Exclude<ModelConfigScope, "session">;
	readonly preset: string;
}

export interface ModelSetSource {
	readonly scope: Exclude<ModelConfigScope, "session">;
	readonly modelSet: string;
}

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

export type ModelSelectionSource = "preset" | "explicit" | "session";

/** Serializable planning-time result; runtime adapters may add model/auth data. */
export interface ExactModelSelection {
	readonly presetId: string;
	readonly modelSetId: string;
	readonly optionId: string;
	readonly modelId: string;
	/** Always concrete: an "auto" option resolves to the assignment's effort
	 *  when one is persisted, else the session thinking level clamped into
	 *  the option's allowed set. */
	readonly effort: ThinkingLevel;
	readonly summary: string;
	readonly source: ModelSelectionSource;
	readonly candidates: readonly ExactModelCandidateFact[];
}

export type ModelSelectionErrorCode =
	| "overlapping-preset-target"
	| "preset-not-active"
	| "model-set-not-configured"
	| "model-set-not-found"
	| "explicit-assignment-mismatch"
	| "explicit-option-not-found"
	| "explicit-option-unavailable"
	| "no-session-model"
	| "no-model-available";

export interface ModelSelectionError {
	readonly code: ModelSelectionErrorCode;
	readonly message: string;
	readonly presetId?: string;
	readonly modelSetId?: string;
	readonly optionId?: string;
}
