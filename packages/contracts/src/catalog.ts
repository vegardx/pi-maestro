// v2 model configuration vocabulary: families (ranked; each holds free-text
// aliases with ordered per-provider attachments), rosters (three fixed-meaning
// tiers holding ordered alias refs), bindings (thin seat→roster bindings),
// region (the active model allowlist), and per-agent tier allowances.
// See docs/design/v2-primitives.md and memory/project-model-families-design.

import type { ThinkingLevel } from "./runs.js";

/**
 * The three tiers with fixed meanings. The structure IS the routing: `light`
 * serves sweeps/gates/classification, `standard` the daily drivers and
 * candidate pools, `heavy` judging and deep review. Personas and rules
 * reference tiers by these names.
 */
export const TIER_IDS = ["light", "standard", "heavy"] as const;
export type TierId = (typeof TIER_IDS)[number];

/**
 * One alias: a free-text logical model within a family, backed by concrete
 * provider/model attachments. `attach` is ORDERED — the per-alias
 * cross-provider fallback order at resolve time (the resolving agent's own
 * gateway provider jumps the queue). effort/notes live here, shared everywhere
 * the alias is used.
 */
export interface AliasConfig {
	/** Ordered concrete `provider/model` refs that ARE this logical model. */
	readonly attach: readonly string[];
	/** Default thinking level; clamped to the resolved model's supported set. */
	readonly effort?: ThinkingLevel;
	/** Allowlist bounding usable levels (∩ what the resolved model supports). */
	readonly efforts?: readonly ThinkingLevel[];
	/** Capability notes written for agents to reason with, not spec sheets. */
	readonly notes?: string;
}

/**
 * A family: the diversity axis and a bag of aliases. Families are RANKED — the
 * insertion order of `models.families` IS the diversity preference (a diverse
 * pick walks onward from the author's family).
 */
export interface FamilyConfig {
	readonly aliases: Readonly<Record<string, AliasConfig>>;
}

/**
 * A roster tier is an ORDERED list of alias refs. A ref is `"Family/Alias"`
 * (family-scoped, so qualified). Order = preference: a single agent takes #1,
 * a candidate pool the top-N.
 */
export type RosterTiers = Readonly<Record<TierId, readonly string[]>>;

/**
 * A binding is a thin routing rule: the session models that activate it
 * (`targets` — the "when"; a binding WITHOUT targets is the default, active
 * when no targeted binding matches) → a roster by name.
 */
export interface BindingConfig {
	/** Concrete session models; unique across bindings (the activation key). */
	readonly targets?: readonly string[];
	/** Name of the roster this binding selects. */
	readonly roster: string;
}

/**
 * The active region filter and its named allowlists (was "residency"). A hard
 * filter over which models are usable at all; `active` names a list, or is
 * "off"/"none" (the reserved no-filter state).
 */
export interface RegionConfig {
	readonly active?: string;
	readonly lists: Readonly<Record<string, readonly string[]>>;
}

/**
 * The spawnable agent types. Callers (classifier, summarizer,
 * command-auditor, watcher) are harness components tuned via rules —
 * deliberately absent: `agent: caller` in a plan is unrepresentable.
 */
export const SPAWNABLE_AGENT_TYPES = [
	"worker",
	"explorer",
	"reviewer",
	// A read-only, persistent consultant spawned at RUNTIME (the reader path),
	// never authored as a plan node — so it is spawnable (has a tier allowance)
	// but NOT a NODE_AGENT_TYPE. See docs/design/multi-model-agents.md §6.
	"advisor",
] as const;
export type SpawnableAgentType = (typeof SPAWNABLE_AGENT_TYPES)[number];

/** Per-agent-type tier allowance: which tiers its assignments may draw from. */
export interface AgentAllowanceConfig {
	readonly tiers: readonly TierId[];
	/**
	 * Fan-out width WHEN a review is authored multi-modal — never always-on. A
	 * reviewer whose plan node did not ask for multi-modal resolves to exactly
	 * one model regardless of this, so config cannot widen a fan-out behind the
	 * plan's back. The plan decides WHETHER; this decides HOW WIDE.
	 */
	readonly spread?: number;
}

/**
 * Ceiling on `spread`. Every extra slot is another full review of the same
 * diff — real money and real latency — so an authored value above this is
 * rejected rather than silently honored.
 */
export const MAX_SPREAD = 5;

/**
 * Defaults applied when settings say nothing. `inherit` and the
 * session-model fallback are exempt from these allowances (labeled in explain
 * output) — the lists bound deliberate tier references only.
 */
export const DEFAULT_AGENT_ALLOWANCES: Readonly<
	Record<SpawnableAgentType, AgentAllowanceConfig>
> = {
	// The worker is the deliverable's implementer — the maestro's direct hand.
	// With no explicit allowance it INHERITS the session model (empty tiers →
	// defaultTierForAgent returns undefined → the resolver's inherit path), so an
	// unconfigured worker runs on the seat, not a roster tier. The rosters govern
	// the support agents a worker fans out to (explorer/reviewer/advisor) and any
	// worker that IS given an explicit allowance. (Note: user-authored allowances
	// require a non-empty tiers list; only this built-in default may be empty.)
	worker: { tiers: [] },
	explorer: { tiers: ["light", "standard"] },
	// spread: a multi-modal review reads the same diff through three distinct
	// families — enough for genuine disagreement to surface, without the cost
	// running away. Only applies to reviews the PLAN marked multi-modal.
	reviewer: { tiers: ["standard", "heavy"], spread: 3 },
	// Advice draws on strong reasoning; overflow into standard when a fan-out
	// wants more models than heavy holds.
	advisor: { tiers: ["heavy", "standard"], spread: 2 },
};

/**
 * The parsed v2 configuration slice (settings `models.families`,
 * `models.rosters`, `models.bindings`, `models.region`, `models.allowances`).
 */
export interface ModelsConfig {
	readonly families: Readonly<Record<string, FamilyConfig>>;
	readonly rosters: Readonly<Record<string, RosterTiers>>;
	readonly bindings: Readonly<Record<string, BindingConfig>>;
	readonly region: RegionConfig;
	readonly allowances: Readonly<
		Record<SpawnableAgentType, AgentAllowanceConfig>
	>;
}
