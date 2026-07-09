// Model configuration vocabulary: tiers, profiles, and per-role config.
//
// Shared by the model resolver and every extension that declares background
// model roles. The settings layer reads/writes this shape; the resolver
// consumes it at runtime.

import type { ThinkingLevel } from "./runs.js";

// ─── Tiers ───────────────────────────────────────────────────────────────────

/**
 * The four model tiers, named by intent (not cost):
 *   plan   — the maestro reasons & plans here; ALWAYS the session model (/model).
 *   work   — workers implement here.
 *   review — reviewers + advisor run here (cross-model second opinion).
 *   fast   — cheap mechanical subagents (classify, scout, quick research).
 */
export const TIERS = ["plan", "work", "review", "fast"] as const;
export type Tier = (typeof TIERS)[number];

/** Tiers a profile can pin. `plan` is implicit — always the live session model. */
export const PINNABLE_TIERS = ["work", "review", "fast"] as const;
export type PinnableTier = (typeof PINNABLE_TIERS)[number];

// ─── Profiles ─────────────────────────────────────────────────────────────────

/**
 * A single tier's model config within a profile. Absent `model` ⇒ "track plan"
 * (use the live session model). `effort` steers adaptive models / budgets fixed
 * ones.
 */
export interface TierConfig {
	readonly model?: string;
	readonly effort?: ThinkingLevel;
}

/**
 * A profile owns a SET of `/model` targets (an exclusive partition — each model
 * belongs to at most one profile) and pins the work/review/fast tiers. `plan` is
 * implicit = whichever target is currently live. Activation is DERIVED: the
 * active profile is the one whose `targets` include the session model.
 *
 * ```json
 * {
 *   "models": {
 *     "profiles": {
 *       "opus": {
 *         "targets": ["anthropic/claude-opus-4-8", "anthropic/claude-opus-4-7"],
 *         "work":   {},
 *         "review": { "model": "openai/gpt-5.5", "effort": "high" },
 *         "fast":   { "model": "anthropic/claude-haiku-4-5", "effort": "low" }
 *       }
 *     }
 *   }
 * }
 * ```
 */
export interface ProfileConfig {
	/** `"provider/id"` values that activate this profile (exclusive across profiles). */
	readonly targets: readonly string[];
	readonly work?: TierConfig;
	readonly review?: TierConfig;
	readonly fast?: TierConfig;
}

/**
 * Top-level `models` key in settings.json. There is no `active` key — the active
 * profile is derived from the session model's membership in a profile's targets.
 */
export interface ModelsConfig {
	/** Named profiles, keyed by a user-chosen label. */
	readonly profiles: Readonly<Record<string, ProfileConfig>>;
}

// ─── Per-role config ─────────────────────────────────────────────────────────

/**
 * Per-role escape hatch, living at `extensionConfig.<ext>.models.<role>`. Roles
 * normally map to a tier (hardcoded), which resolves through the active profile;
 * this lets a power user pin one role to a specific model/effort. The `/maestro`
 * menu does not write these by default.
 */
export interface RoleModelConfig {
	/** Explicit `"provider/id"` — bypasses tier resolution entirely. */
	readonly model?: string;
	/** Reasoning effort level for this role. */
	readonly effort?: ThinkingLevel;
}

/** Map of role name → config. Stored at `extensionConfig.<ext>.models`. */
export type RoleModelMap = Readonly<Record<string, RoleModelConfig>>;

// ─── Role name constants ─────────────────────────────────────────────────────

export const MODES_ROLES = ["agent", "analyze", "classifier"] as const;
export type ModesRole = (typeof MODES_ROLES)[number];

export const COMPACT_ROLES = ["summarizer"] as const;
export type CompactRole = (typeof COMPACT_ROLES)[number];

// ─── Resolved output ─────────────────────────────────────────────────────────

/** Source of the resolved model — indicates which priority layer won. */
export type ResolutionSource = "explicit" | "env" | "profile" | "session";

/**
 * Return type of `resolveRoleModel()`. Tells the caller what model to use,
 * at what effort level, and where the decision came from.
 */
export interface ResolvedRoleModel {
	/** The winning `"provider/id"` string. */
	readonly modelId: string;
	/** Effort/thinking level from the winning config layer. */
	readonly effort?: ThinkingLevel;
	/** Which priority layer provided this resolution. */
	readonly source: ResolutionSource;
	/** Which profile the model was resolved from (if source is "profile"). */
	readonly profile?: string;
	/** Which tier was used (if resolved via a profile/tier). */
	readonly tier?: Tier;
}
