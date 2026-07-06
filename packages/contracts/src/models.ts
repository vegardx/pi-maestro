// Model configuration vocabulary: presets, slots, and per-role config.
//
// Shared by the model resolver and every extension that declares background
// model roles. The settings layer reads/writes this shape; the resolver
// consumes it at runtime.

import type { ThinkingLevel } from "./runs.js";

// ─── Slots ───────────────────────────────────────────────────────────────────

export const SLOTS = ["default", "alternate"] as const;
export type Slot = (typeof SLOTS)[number];

// ─── Presets ─────────────────────────────────────────────────────────────────

/**
 * Configuration for a single model slot within a preset.
 */
export interface SlotConfig {
	readonly model: string;
	readonly effort?: ThinkingLevel;
}

/**
 * A preset maps two model slots to concrete model configurations.
 * `default` is the workhorse (cache-friendly), `alternate` is a different
 * model family for intentional diversity ("second pair of eyes").
 */
export interface PresetConfig {
	readonly default: SlotConfig;
	readonly alternate?: SlotConfig;
}

/**
 * Top-level `models` key in settings.json:
 * ```json
 * {
 *   "models": {
 *     "active": "anthropic",
 *     "presets": {
 *       "anthropic": {
 *         "default": { "model": "anthropic/claude-sonnet-4", "effort": "high" },
 *         "alternate": { "model": "openai/o3", "effort": "medium" }
 *       }
 *     }
 *   }
 * }
 * ```
 */
export interface ModelsConfig {
	/** Name of the currently active preset. */
	readonly active: string;
	/** Named presets mapping slots to model identifiers. */
	readonly presets: Readonly<Record<string, PresetConfig>>;
}

// ─── Per-role config ─────────────────────────────────────────────────────────

/**
 * Configuration for a single extension role (e.g. modes.worker, modes.lens).
 * Lives in `extensionConfig.<ext>.models.<role>`.
 *
 * Specify EITHER `model` (explicit, bypasses presets) or rely on slot
 * resolution from the active/pinned preset.
 */
export interface RoleModelConfig {
	/** Explicit `"provider/id"` — bypasses preset resolution entirely. */
	readonly model?: string;
	/** Which slot to use from the preset ("default" | "alternate"). */
	readonly slot?: Slot;
	/** Pin this role to a specific preset, overriding `models.active`. */
	readonly preset?: string;
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
export type ResolutionSource = "explicit" | "env" | "preset" | "session";

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
	/** Which preset the model was resolved from (if source is "preset"). */
	readonly preset?: string;
	/** Which slot was used (if resolved via preset). */
	readonly slot?: Slot;
}
