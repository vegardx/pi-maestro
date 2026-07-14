// Shared role-pool model profile vocabulary.

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

/** Ordered allowlists for one role. The first item is the default. */
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
}

export interface ModelsConfig {
	readonly profiles: Readonly<Record<string, ProfileConfig>>;
}

/** A typed, leaf-wise session patch for one named profile and role. */
export interface SessionProfileRoleOverride {
	readonly models?: readonly string[];
	readonly efforts?: readonly ThinkingLevel[];
}

export type ModelConfigScope = "global" | "project" | "session";

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
