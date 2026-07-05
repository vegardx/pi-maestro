// Model configuration vocabulary: presets, tiers, and per-role config.
//
// Shared by the model resolver and every extension that declares background
// model roles. The settings layer reads/writes this shape; the resolver
// consumes it at runtime.

import type { ThinkingLevel } from "./runs.js";

// ─── Tiers ───────────────────────────────────────────────────────────────────

export const TIERS = ["fast", "normal", "heavy"] as const;
export type Tier = (typeof TIERS)[number];

// ─── Presets ─────────────────────────────────────────────────────────────────

/** Ordered fallback list per tier. Resolver walks until one has valid auth. */
export interface PresetTierEntry {
	model: string;
	effort?: ThinkingLevel;
}

export type PresetTierMap = Partial<Record<Tier, PresetTierEntry>>;

/**
 * Top-level `models` key in settings.json:
 * ```json
 * {
 *   "models": {
 *     "active": "anthropic",
 *     "presets": {
 *       "anthropic": { "fast": [...], "normal": [...], "heavy": [...] },
 *       "openai":    { "fast": [...], "normal": [...], "heavy": [...] }
 *     }
 *   }
 * }
 * ```
 */
export interface ModelsConfig {
	/** Name of the currently active preset. */
	readonly active: string;
	/** Named presets mapping tiers to ordered model fallback arrays. */
	readonly presets: Readonly<Record<string, PresetTierMap>>;
}

// ─── Per-role config ─────────────────────────────────────────────────────────

/**
 * Configuration for a single extension role (e.g. modes.worker, modes.lens).
 * Lives in `extensionConfig.<ext>.models.<role>`.
 *
 * Specify EITHER `model` (explicit, bypasses presets) or `tier` (resolved from
 * the active or pinned preset). Both may carry a thinking level.
 */
export interface RoleModelConfig {
	/** Explicit `"provider/id"` — bypasses preset resolution entirely. */
	readonly model?: string;
	/** Tier to resolve from the preset fallback array. */
	readonly tier?: Tier;
	/** Pin this role to a specific preset, overriding `models.active`. */
	readonly preset?: string;
	/** Reasoning effort level for this role. */
	readonly thinking?: ThinkingLevel;
}

/** Map of role name → config. Stored at `extensionConfig.<ext>.models`. */
export type RoleModelMap = Readonly<Record<string, RoleModelConfig>>;

// ─── Role name constants ─────────────────────────────────────────────────────

export const MODES_ROLES = ["worker", "analyze", "lens", "classifier"] as const;
export type ModesRole = (typeof MODES_ROLES)[number];

export const COMPACT_ROLES = ["summarizer"] as const;
export type CompactRole = (typeof COMPACT_ROLES)[number];

// ─── Resolved output ─────────────────────────────────────────────────────────

/** Source of the resolved model — indicates which priority layer won. */
export type ResolutionSource = "explicit" | "env" | "preset" | "session";

/**
 * Return type of `resolveRoleModel()`. Tells the caller what model to use,
 * at what thinking level, and where the decision came from.
 */
export interface ResolvedRoleModel {
	/** The winning `"provider/id"` string. */
	readonly modelId: string;
	/** Thinking level from the winning config layer. */
	readonly thinking?: ThinkingLevel;
	/** Which priority layer provided this resolution. */
	readonly source: ResolutionSource;
	/** Which preset the model was resolved from (if source is "preset"). */
	readonly preset?: string;
	/** Which tier was used (if resolved via preset). */
	readonly tier?: Tier;
}
