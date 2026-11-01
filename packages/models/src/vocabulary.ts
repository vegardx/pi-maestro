// v2 model configuration vocabulary: families (ranked; each holds free-text
// aliases with ordered per-provider attachments), rosters (four fixed-meaning
// tiers holding ordered alias refs), bindings (thin seat→roster bindings),
// region (the active model allowlist), and per-persona tier allowances.
// See docs/design/v2-primitives.md and memory/project-model-families-design.

import type { ThinkingLevel } from "./thinking.js";

/**
 * The four tiers with fixed meanings. The structure IS the routing; personas
 * and rules reference tiers by these names, in this order of capability.
 *
 * - `fast` — narrow mechanical checks and classification. Executes, never
 *   decides.
 * - `light` — the default implementer and the in-package review lens.
 * - `normal` — work that crosses a boundary, touches a persisted format,
 *   concurrency or security, reads large input, or validates `fast` work.
 * - `frontier` — judgement only: adjudication and synthesis. Never an
 *   implementer, never fanned out.
 */
export const TIER_IDS = ["fast", "light", "normal", "frontier"] as const;
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
 * The `direct` selectors: how a DIRECT (non-fanned) spawn picks its model.
 * `inherit` (the default) is today's behavior — resolve the allowance's first
 * tier, and with no tiers run the caller's model. `other-family` walks the
 * allowance's tiers in order through the bound roster and takes the first
 * entry whose family differs from the caller's — a reviewer never marks its
 * own homework. With nowhere to go it falls back to inherit WITH a
 * fallbackReason, never silently.
 */
export const DIRECT_SELECTORS = ["inherit", "other-family"] as const;
export type DirectSelector = (typeof DIRECT_SELECTORS)[number];

/**
 * Per-persona tier allowance: which tiers work of this kind may draw from.
 * Keyed by PERSONA id (free text): `code-review` wanting a normal tier is a
 * statement about the work, not about a posture. Harness callers (classifier,
 * summarizer, command-auditor, watcher) are tuned via rules, not allowances.
 */
export interface AgentAllowanceConfig {
	readonly tiers: readonly TierId[];
	/**
	 * Fan-out width WHEN a review is authored multi-modal — never always-on. A
	 * reviewer whose plan node did not ask for multi-modal resolves to exactly
	 * one model regardless of this, so config cannot widen a fan-out behind the
	 * plan's back. The plan decides WHETHER; this decides HOW WIDE.
	 */
	readonly spread?: number;
	/** Model selector for a direct spawn; absent = "inherit". */
	readonly direct?: DirectSelector;
}

/**
 * Ceiling on `spread`. Every extra slot is another full review of the same
 * diff — real money and real latency — so an authored value above this is
 * rejected rather than silently honored.
 */
export const MAX_SPREAD = 5;

/**
 * Generic resolver defaults retained for configured personas. `tiers[0]` is
 * the tier a persona resolves at when the caller names none. Current
 * pi-maestro callers use only `codebase-research`; workflow execution belongs
 * to the future standalone workflow package.
 */
export const DEFAULT_PERSONA_ALLOWANCES: Readonly<
	Record<string, AgentAllowanceConfig>
> = {
	"deliverable-worker": { tiers: [] },
	"codebase-research": { tiers: ["light", "fast", "normal"] },
	"code-review": { tiers: ["light", "normal"], spread: 3 },
	adjudication: { tiers: ["frontier", "normal"] },
	standby: { tiers: ["frontier", "normal"], spread: 2 },
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
	/** Keyed by persona id — free text; unknown personas simply never match. */
	readonly allowances: Readonly<Record<string, AgentAllowanceConfig>>;
}
