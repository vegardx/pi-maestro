// v2 model configuration vocabulary: catalogs (three fixed-meaning tiers),
// profiles (thin seat→catalog bindings), and per-agent-type tier allowlists.
// See docs/design/v2-primitives.md. Config-side only — v1 presets/modelSets
// keep driving resolution until the v2 resolver lands; this vocabulary is
// parsed, validated, and editable ahead of that flip.

import type { ThinkingLevel } from "./runs.js";

/**
 * The three tiers with fixed meanings. The structure IS the routing: no
 * pins, no N named sets — `fast` serves sweeps/gates/classification,
 * `normal` the daily drivers and candidate pools, `heavy` judging and deep
 * review. Personas and policy rows reference tiers by these names.
 */
export const TIER_IDS = ["fast", "normal", "heavy"] as const;
export type TierId = (typeof TIER_IDS)[number];

/** One catalog entry: a concrete fleet model with notes agents reason with. */
export interface CatalogEntry {
	/** Concrete `provider/model` ref — never the session sentinel: the seat
	 *  is reached via inheritance, not through the catalog. */
	readonly model: string;
	/**
	 * Model family, AUTHORED, never inferred — one provider can serve several
	 * families (Copilot serves anthropic and openai models). The diversity
	 * rule ("reviewer ≠ author's family") compares these values.
	 */
	readonly family?: string;
	/** Capability notes written for agents to reason with, not spec sheets. */
	readonly notes?: string;
	/** Default thinking level when this entry is picked. */
	readonly effort?: ThinkingLevel;
	/** Allowlist bounding usable levels (∩ what the model supports). */
	readonly efforts?: readonly ThinkingLevel[];
}

/** A named catalog: the same three tiers, always. Swap = one profile edit. */
export type CatalogTiers = Readonly<Record<TierId, readonly CatalogEntry[]>>;

/**
 * A profile is a thin binding: the session models that activate it (targets;
 * a profile WITHOUT targets is the default profile, active when no targeted
 * profile matches) → a catalog by name. Principles prose migrated into
 * personas; profiles carry routing only.
 */
export interface V2ProfileConfig {
	/** Concrete session models; unique across profiles (the activation key). */
	readonly targets?: readonly string[];
	/** Name of the catalog this profile binds. */
	readonly catalog: string;
}

/**
 * The spawnable agent types. Callers (classifier, summarizer,
 * command-auditor, watcher) are harness components tuned via policy rows —
 * deliberately absent: `agent: caller` in a plan is unrepresentable.
 */
export const SPAWNABLE_AGENT_TYPES = [
	"worker",
	"explorer",
	"reviewer",
] as const;
export type SpawnableAgentType = (typeof SPAWNABLE_AGENT_TYPES)[number];

/** Per-agent-type tier allowlist: which tiers its assignments may draw from. */
export interface AgentTierConfig {
	readonly models: readonly TierId[];
}

/**
 * Defaults applied when settings say nothing. `inherit` and the
 * session-model fallback are exempt from these allowlists (labeled in
 * explain output) — the lists bound deliberate tier references only.
 */
export const DEFAULT_AGENT_TIERS: Readonly<
	Record<SpawnableAgentType, AgentTierConfig>
> = {
	worker: { models: ["normal", "heavy"] },
	explorer: { models: ["fast", "normal"] },
	reviewer: { models: ["normal", "heavy"] },
};

/** The parsed v2 configuration slice (settings `models.catalog`,
 *  `models.profiles`, `agents.<type>.models`). */
export interface V2ModelsConfig {
	readonly catalogs: Readonly<Record<string, CatalogTiers>>;
	readonly profiles: Readonly<Record<string, V2ProfileConfig>>;
	readonly agents: Readonly<Record<SpawnableAgentType, AgentTierConfig>>;
}
