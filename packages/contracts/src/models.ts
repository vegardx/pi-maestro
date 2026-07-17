// Shared exact model-preset vocabulary.

import type { ThinkingLevel } from "./runs.js";

/** Stable policy keys used by model-consuming runtimes. */
export const MODEL_ROLES = [
	"worker",
	"reviewer",
	"research",
	"advisor",
	"classifier",
	"plan-summarizer",
	"compact-summarizer",
	"verifier",
	"delegate",
	"general",
	"codebase-research",
	"web-research",
	"consult",
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
	/** @deprecated Derived compatibility view for the current settings UI. */
	readonly profiles: Readonly<Record<string, ProfileConfig>>;
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

// Deprecated role-pool shapes remain exported for settings source compatibility
// while all runtime resolution is implemented through exact model sets.
export interface ProfileRoleConfig {
	readonly models?: readonly string[];
	readonly efforts?: readonly ThinkingLevel[];
}
export type ProfileRoleMap = Readonly<
	Partial<Record<ModelRole, ProfileRoleConfig>>
>;
export interface ProfileConfig {
	readonly targets: readonly string[];
	readonly roles: ProfileRoleMap;
}
export interface SessionProfileRoleOverride {
	readonly models?: readonly string[];
	readonly efforts?: readonly ThinkingLevel[];
}
export interface RolePoolLeafSource {
	readonly scope: ModelConfigScope;
	readonly profile: string;
	readonly role: ModelRole;
}
export interface RolePoolSource {
	readonly models?: RolePoolLeafSource;
	readonly efforts?: RolePoolLeafSource;
}
export type RoleResolutionErrorCode =
	| "explicit-model-not-allowed"
	| "explicit-model-unavailable"
	| "explicit-effort-not-allowed"
	| "explicit-effort-unsupported"
	| "no-model-available";
export interface RoleResolutionError {
	readonly code: RoleResolutionErrorCode;
	readonly message: string;
	readonly modelId?: string;
	readonly effort?: ThinkingLevel;
}
export interface ResolvedRoleCandidate {
	readonly modelId: string;
	readonly supportedEfforts: readonly ThinkingLevel[];
}
export type ResolutionSource = "profile" | "session";
export interface ResolvedRoleModel {
	readonly role: ModelRole;
	readonly modelId: string;
	readonly effort?: ThinkingLevel;
	readonly source: ResolutionSource;
	readonly profile?: string;
	readonly configuredModels: readonly string[];
	readonly candidates: readonly ResolvedRoleCandidate[];
	readonly allowedEfforts: readonly ThinkingLevel[];
	readonly provenance: RolePoolSource;
	readonly validationErrors: readonly RoleResolutionError[];
}
