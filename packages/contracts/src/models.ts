// Shared model-profile vocabulary. New configuration is role-first; the tier
// shapes at the bottom of this file are compatibility input only.

import type { ThinkingLevel } from "./runs.js";

/** Stable, user-facing model roles. Additions are a public settings API change. */
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
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * Ordered allowlists for one role. The first item is the default. A present
 * list must be non-empty and contain no duplicates; readers validate these
 * invariants at trust boundaries.
 */
export interface ProfileRoleConfig {
	readonly models?: readonly string[];
	readonly efforts?: readonly ThinkingLevel[];
}

export type ProfileRoleMap = Readonly<
	Partial<Record<ModelRole, ProfileRoleConfig>>
>;

/** Persistent profile selected by membership of the live `/model` in targets. */
export interface ProfileConfig {
	readonly targets: readonly string[];
	readonly roles: ProfileRoleMap;
	/** @deprecated Compatibility input. New writers must use `roles`. */
	readonly work?: LegacyTierConfig;
	/** @deprecated Compatibility input. New writers must use `roles`. */
	readonly review?: LegacyTierConfig;
	/** @deprecated Compatibility input. New writers must use `roles`. */
	readonly fast?: LegacyTierConfig;
}

export interface ModelsConfig {
	readonly profiles: Readonly<Record<string, ProfileConfig>>;
}

/** A typed, leaf-wise session patch for one named profile and role. */
export interface SessionProfileRoleOverride {
	readonly models?: readonly string[];
	readonly efforts?: readonly ThinkingLevel[];
}

export type ModelConfigScope = "global" | "project" | "session" | "legacy";

export interface RolePoolLeafSource {
	readonly scope: ModelConfigScope;
	readonly profile: string;
	readonly role: ModelRole;
	readonly legacyTier?: LegacyPinnableTier;
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

/** Successful role-pool selection metadata used by callers and diagnostics. */
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

// ─── Legacy compatibility input ─────────────────────────────────────────────

/** @deprecated Use ModelRole and profile role pools. */
export const TIERS = ["plan", "work", "review", "fast"] as const;
/** @deprecated Use ModelRole. */
export type Tier = (typeof TIERS)[number];
/** @deprecated Use ModelRole. */
export const PINNABLE_TIERS = ["work", "review", "fast"] as const;
/** @deprecated Use ModelRole. */
export type PinnableTier = (typeof PINNABLE_TIERS)[number];
export type LegacyPinnableTier = PinnableTier;

/** @deprecated Read-only compatibility shape for old profiles. */
export interface LegacyTierConfig {
	readonly model?: string;
	readonly effort?: ThinkingLevel;
}
/** @deprecated Alias retained for source compatibility. */
export type TierConfig = LegacyTierConfig;

/** @deprecated Extension-local scalar role settings are compatibility input. */
export interface RoleModelConfig {
	readonly model?: string;
	readonly effort?: ThinkingLevel;
}
/** @deprecated Extension-local scalar role settings are compatibility input. */
export type RoleModelMap = Readonly<Record<string, RoleModelConfig>>;

/** Legacy extension role names retained until runtime callers migrate. */
export const MODES_ROLES = ["agent", "analyze", "classifier"] as const;
export type ModesRole = (typeof MODES_ROLES)[number];
export const COMPACT_ROLES = ["summarizer"] as const;
export type CompactRole = (typeof COMPACT_ROLES)[number];
