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
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** An authored option is one exact model/effort pair, not a broad pool. */
export interface ExactModelOption {
	readonly id: string;
	readonly model: string;
	readonly effort: ThinkingLevel;
	readonly summary: string;
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

export interface ModelsConfig {
	readonly modelSets: Readonly<Record<string, ModelSetConfig>>;
	readonly presets: Readonly<Record<string, ModelPresetConfig>>;
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
	readonly effort: ThinkingLevel;
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
