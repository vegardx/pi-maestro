// The inheritance-first model router. Precedence:
//
//   1. No tier requested → INHERIT: the child runs its caller's model. Plans
//      carry no model fields; root spawns run the seat model because the
//      root's caller IS the seat.
//   2. A tier requested (persona fan-out instructions, policy rows) → resolve
//      through the active binding's roster: that tier's ordered alias refs,
//      each resolved to a concrete attachment. An alias prefers the resolving
//      agent's OWN gateway provider (keep traffic on one gateway), else the
//      first available attachment in the alias's order. The first alias that
//      yields an available attachment wins — bounded by the persona's tier
//      allowance.
//   3. Nothing available (empty tier, every attachment struck, unknown roster)
//      → SEAT-MODEL FALLBACK with a notice: the judgment still happens, on the
//      seat, visibly. Never fail-open, never wedge.
//
// `inherit` and the fallback are exempt from tier allowances but labeled in the
// resolution record — the constraint bounds deliberate tier references, and
// nothing is ever silently laundered.
//
// The router is a closure over a parsed config, a seat, and a host
// {@link ModelCatalogPort}. It reads no files, no environment and no clock, so
// the same three inputs always produce the same `ModelResolution` — which is
// what lets a caller hash the result into a task identity.

import { activeBinding, familyOfModel, parseAliasRef } from "./config.js";
import { supportedEfforts } from "./efforts.js";
import { parseModelSpec } from "./model-spec.js";
import type { CatalogModel, ModelCatalogPort } from "./port.js";
import { activeRegion, modelAllowedByRegion } from "./region.js";
import { THINKING_LEVELS, type ThinkingLevel } from "./thinking.js";
import {
	type AliasConfig,
	DEFAULT_PERSONA_ALLOWANCES,
	type DirectSelector,
	MAX_SPREAD,
	type ModelsConfig,
	type RegionConfig,
	type TierId,
} from "./vocabulary.js";

/** What the caller passes down: its own model — the inheritance default. */
export interface InheritedModel {
	readonly modelId: string;
	readonly effort?: ThinkingLevel;
}

export interface ModelResolutionRequest {
	/** The persona whose allowance bounds this resolution (free-text id). */
	readonly persona: string;
	/** Explicit tier reference (persona instruction or policy row). Absent = inherit. */
	readonly tier?: TierId;
	/** The caller's model. Absent only at the root, where the seat is the caller. */
	readonly inherit?: InheritedModel;
}

/** Why each roster alias ref was or wasn't usable — the explain output's rows. */
export interface ModelCandidateFact {
	/** The `"Family/Alias"` roster ref. */
	readonly ref: string;
	readonly family: string;
	readonly alias: string;
	/** The chosen attachment `provider/model`, when one was available. */
	readonly model?: string;
	/** Gateway prefix of the chosen attachment. */
	readonly provider?: string;
	readonly notes?: string;
	readonly effort?: ThinkingLevel;
	readonly available: boolean;
	readonly reason?: string;
}

export type ModelResolutionSource = "inherit" | "tier" | "fallback";

/**
 * Serializable resolution record — the shape a caller persists as evidence (a
 * workflow task's routing evidence, a plan ledger's NodeResolution) and what
 * explain output renders. Never re-rolled silently: persisted records are
 * revalidated, and a vanished model fails visibly.
 */
export interface ModelResolution {
	readonly source: ModelResolutionSource;
	readonly modelId: string;
	readonly effort?: ThinkingLevel;
	/** Resolved family (the diversity axis; checks compare these). */
	readonly family?: string;
	/** Resolved alias name. */
	readonly alias?: string;
	/** Gateway prefix of the chosen attachment. */
	readonly attachmentProvider?: string;
	readonly tier?: TierId;
	readonly bindingId?: string;
	readonly rosterId?: string;
	/** Per-ref facts when a tier was walked (explain output). */
	readonly candidates?: readonly ModelCandidateFact[];
	/**
	 * Why resolution degraded. Present when source === "fallback" (the tier
	 * produced nothing), and on source === "inherit" when an `other-family`
	 * request had nowhere to go — never silently.
	 */
	readonly fallbackReason?: string;
}

export class ModelResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelResolutionError";
	}
}

/** Everything the router needs that is not a host lookup. */
export interface ModelRouterConfig {
	/**
	 * The parsed `models` settings slice, or undefined when nothing v2 is
	 * configured (an empty models block = inherit-all).
	 */
	readonly models?: ModelsConfig;
	/**
	 * The seat model as `provider/id`: the binding activation key and the
	 * known-good floor every degraded resolution lands on.
	 */
	readonly seat?: string;
	/** The seat's own thinking level, inherited by a root spawn. */
	readonly seatEffort?: ThinkingLevel;
}

/** The facts a tier explanation reports without resolving anything. */
export interface TierExplanation {
	readonly bindingId?: string;
	readonly rosterId?: string;
	readonly allowed: boolean;
	readonly candidates: readonly ModelCandidateFact[];
}

/** How a role asks for a model: the routing vocabulary, not a model name. */
export interface RoleRouteRequest {
	readonly tier?: TierId;
	/** Preferred thinking level, clamped to the alias and model allowlists. */
	readonly effort?: ThinkingLevel;
	/** `"other"` means "not the caller's family" — the own-homework rule. */
	readonly family?: string;
	/** The caller's model, when there is one. */
	readonly inherit?: InheritedModel;
}

export interface ModelRouter {
	/**
	 * The entry point a host binds a role through: a persona plus the routing
	 * vocabulary in, one serializable {@link ModelResolution} out, or null when
	 * the request cannot be honoured (an out-of-allowance tier, an unknown
	 * family, no seat to fall back to). Null, never a guess.
	 */
	resolveForRole(
		role: string,
		request?: RoleRouteRequest,
	): ModelResolution | null;
	/** Resolve without swallowing the refusal; throws {@link ModelResolutionError}. */
	resolve(request: ModelResolutionRequest): ModelResolution;
	/** Up to `n` resolutions for ONE request, each from a DISTINCT family. */
	resolveMany(
		request: ModelResolutionRequest,
		n: number,
	): readonly ModelResolution[];
	/** The first available entry whose family differs from the caller's. */
	resolveOtherFamily(request: ModelResolutionRequest): ModelResolution;
	/** The first available entry belonging to a NAMED family; throws otherwise. */
	resolveFamily(
		request: ModelResolutionRequest & { readonly family: string },
	): ModelResolution;
	/** Every ref's fact for one persona and tier, resolving nothing. */
	explain(persona: string, tier: TierId): TierExplanation;
	/** One attachment's availability fact (region, registry, auth). */
	explainAttachment(spec: string): { available: boolean; reason?: string };
	/** The first tier in the persona's allowance — its preference order. */
	defaultTierFor(persona: string): TierId | undefined;
	/** How wide a MULTI-MODAL review by this persona fans out. */
	spreadFor(persona: string): number;
	/** How a DIRECT (non-fanned) spawn of this persona picks its model. */
	directFor(persona: string): DirectSelector;
	/** Still registered, authenticated and in region — the replay revalidation. */
	isAuthorized(modelId: string): boolean;
}

interface AttachmentCheck {
	readonly spec: string;
	readonly available: boolean;
	readonly reason?: string;
	readonly model?: CatalogModel;
}

interface ResolvedAlias {
	readonly fact: ModelCandidateFact;
	readonly config: AliasConfig;
	readonly model?: CatalogModel;
}

/** Everything a tier walk produces, before anyone picks a winner from it. */
interface TierWalk {
	readonly resolved: readonly ResolvedAlias[];
	readonly candidates: readonly ModelCandidateFact[];
	readonly refs: readonly string[];
	readonly bindingId: string;
	readonly rosterId: string;
	readonly seat: string | undefined;
}

/**
 * Clamp an inherited/preferred effort into an alias's allowlist ∩ the model's
 * supported levels: exact when allowed, else nearest below, else lowest above.
 */
export function clampEffort(
	preferred: ThinkingLevel | undefined,
	alias: Pick<AliasConfig, "effort" | "efforts">,
	model: CatalogModel | undefined,
): ThinkingLevel | undefined {
	if (alias.effort && !alias.efforts) return alias.effort;
	const order = THINKING_LEVELS;
	const supported = model ? supportedEfforts(model) : order;
	const allowed = order.filter(
		(level) =>
			supported.includes(level) &&
			(!alias.efforts || alias.efforts.includes(level)),
	);
	if (allowed.length === 0) return alias.effort;
	const wanted = alias.effort ?? preferred;
	if (!wanted) return allowed[0];
	if (allowed.includes(wanted)) return wanted;
	const at = order.indexOf(wanted);
	for (let i = at - 1; i >= 0; i--)
		if (allowed.includes(order[i])) return order[i];
	for (let i = at + 1; i < order.length; i++)
		if (allowed.includes(order[i])) return order[i];
	return allowed[0];
}

/**
 * The one deduped notice per agent for fallback resolutions. Callers keep the
 * set (keyed however their agent identity works) and notify only when add()
 * returns true.
 */
export function fallbackNotice(resolution: ModelResolution): string {
	return (
		`configured tier ${resolution.tier} unavailable — running on the session ` +
		`model (${resolution.modelId}). ${resolution.fallbackReason ?? ""}`.trim()
	);
}

/**
 * Build a router over one parsed config, one seat, and one host port. Nothing
 * is read at construction: every method answers from these three inputs alone.
 */
export function createModelRouter(
	config: ModelRouterConfig,
	port: ModelCatalogPort,
): ModelRouter {
	const models = config.models;
	const seat = config.seat;

	function checkAttachment(
		spec: string,
		region: RegionConfig | undefined,
	): AttachmentCheck {
		// Region: the only hard filter — strikes before anything reasons.
		if (!modelAllowedByRegion(region, spec))
			return {
				spec,
				available: false,
				reason: `outside region ${activeRegion(region)}`,
			};
		const parsed = parseModelSpec(spec);
		if (!parsed)
			return { spec, available: false, reason: "not a provider/model ref" };
		const model = port.findModel(parsed.provider, parsed.modelId);
		if (!model) {
			// A missing PROVIDER and a missing model inside a known provider are
			// different mistakes, and the refusal should say which.
			const providers = port.registeredProviders();
			return {
				spec,
				available: false,
				reason: providers.includes(parsed.provider)
					? "not in registry"
					: `provider ${parsed.provider} is not registered (registered: ${providers.join(", ") || "none"})`,
			};
		}
		if (!port.isAuthenticated(parsed.provider))
			return { spec, available: false, reason: "not authenticated" };
		return { spec, available: true, model };
	}

	/**
	 * Resolve one alias to a concrete attachment: prefer an available attachment
	 * on the resolving agent's own gateway (keep traffic on one gateway), else
	 * the first available attachment in the alias's authored order. When none is
	 * available, the fact carries why.
	 */
	function resolveAlias(
		ref: string,
		family: string,
		alias: string,
		aliasConfig: AliasConfig,
		agentProvider: string | undefined,
		region: RegionConfig | undefined,
	): ResolvedAlias {
		const checks = aliasConfig.attach.map((spec) =>
			checkAttachment(spec, region),
		);
		const available = checks.filter((check) => check.available);
		const preferred =
			(agentProvider &&
				available.find(
					(check) => parseModelSpec(check.spec)?.provider === agentProvider,
				)) ||
			available[0];
		const base = {
			ref,
			family,
			alias,
			...(aliasConfig.notes ? { notes: aliasConfig.notes } : {}),
			...(aliasConfig.effort ? { effort: aliasConfig.effort } : {}),
		};
		if (!preferred) {
			const reasons = checks.map((check) => `${check.spec} (${check.reason})`);
			return {
				fact: {
					...base,
					available: false,
					reason:
						checks.length === 0
							? "alias has no attachments"
							: `no attachment available: ${reasons.join(", ")}`,
				},
				config: aliasConfig,
			};
		}
		const provider = parseModelSpec(preferred.spec)?.provider;
		return {
			fact: {
				...base,
				available: true,
				model: preferred.spec,
				...(provider ? { provider } : {}),
			},
			config: aliasConfig,
			model: preferred.model,
		};
	}

	function resolveRef(
		ref: string,
		agentProvider: string | undefined,
		region: RegionConfig | undefined,
	): ResolvedAlias {
		const parsed = parseAliasRef(ref);
		const aliasConfig = parsed
			? models?.families[parsed.family]?.aliases[parsed.alias]
			: undefined;
		// validateModelsConfig guarantees the ref resolves; guard defensively.
		if (!parsed || !aliasConfig)
			return {
				fact: {
					ref,
					family: parsed?.family ?? "",
					alias: parsed?.alias ?? "",
					available: false,
					reason: "unknown alias ref",
				},
				config: { attach: [] },
			};
		return resolveAlias(
			ref,
			parsed.family,
			parsed.alias,
			aliasConfig,
			agentProvider,
			region,
		);
	}

	/**
	 * Validate the request against config/allowance/binding/roster and resolve
	 * EVERY alias ref in the tier. Shared by the one-model and top-N entry points
	 * so they cannot drift on validation, ordering, or the own-gateway preference.
	 */
	function walkTier(request: ModelResolutionRequest, tier: TierId): TierWalk {
		if (!models)
			throw new ModelResolutionError(
				`tier ${tier} requested but no v2 roster is configured`,
			);
		// Deliberate tier references are bounded by the persona's allowance.
		const allowed = models.allowances[request.persona]?.tiers ?? [];
		if (!allowed.includes(tier))
			throw new ModelResolutionError(
				`tier ${tier} is outside persona ${request.persona}'s allowance (${allowed.join(", ")})`,
			);
		const active = activeBinding(models, seat);
		if (!active)
			throw new ModelResolutionError(
				`tier ${tier} requested but no binding is active (no target match, no default binding)`,
			);
		const roster = models.rosters[active.binding.roster];
		if (!roster)
			throw new ModelResolutionError(
				`binding ${active.id} references unknown roster ${active.binding.roster}`,
			);
		const agentProvider = parseModelSpec(
			request.inherit?.modelId ?? seat ?? "",
		)?.provider;
		const refs = roster[tier];
		const resolved = refs.map((ref) =>
			resolveRef(ref, agentProvider, models.region),
		);
		return {
			resolved,
			candidates: resolved.map((entry) => entry.fact),
			refs,
			bindingId: active.id,
			rosterId: active.binding.roster,
			seat,
		};
	}

	/**
	 * The caller's own model, for a request that asked for no tier. `reason` is
	 * set when this inherit is a DEGRADATION (an `other-family` request with
	 * nowhere to go) — recorded so nothing degrades silently.
	 */
	function inheritResolution(
		request: ModelResolutionRequest,
		reason?: string,
	): ModelResolution {
		const inherited = request.inherit ?? {
			modelId: seat ?? "",
			effort: config.seatEffort,
		};
		if (!inherited.modelId)
			throw new ModelResolutionError(
				"nothing to inherit: no caller model and no live session model",
			);
		return {
			source: "inherit",
			modelId: inherited.modelId,
			...(inherited.effort ? { effort: inherited.effort } : {}),
			...(reason ? { fallbackReason: reason } : {}),
		};
	}

	/** One available alias → the resolution record for that slot. */
	function tierResolution(
		request: ModelResolutionRequest,
		tier: TierId,
		walk: TierWalk,
		entry: ResolvedAlias,
	): ModelResolution {
		const effort = clampEffort(
			request.inherit?.effort,
			entry.config,
			entry.model,
		);
		return {
			source: "tier",
			modelId: entry.fact.model as string,
			...(effort ? { effort } : {}),
			family: entry.fact.family,
			alias: entry.fact.alias,
			...(entry.fact.provider
				? { attachmentProvider: entry.fact.provider }
				: {}),
			tier,
			bindingId: walk.bindingId,
			rosterId: walk.rosterId,
			candidates: walk.candidates,
		};
	}

	/**
	 * Every alias was unavailable (or the tier is empty), so the judgment still
	 * happens — on the seat — visibly. Throws when there is no seat.
	 */
	function seatFallback(
		request: ModelResolutionRequest,
		tier: TierId,
		walk: TierWalk,
	): ModelResolution {
		if (!walk.seat)
			throw new ModelResolutionError(
				`tier ${tier} has no available model and there is no session model to fall back to`,
			);
		const struck = walk.candidates.filter((fact) => !fact.available).length;
		return {
			source: "fallback",
			modelId: walk.seat,
			...(request.inherit?.effort ? { effort: request.inherit.effort } : {}),
			tier,
			bindingId: walk.bindingId,
			rosterId: walk.rosterId,
			candidates: walk.candidates,
			fallbackReason:
				walk.refs.length === 0
					? `tier ${tier} is empty in roster ${walk.rosterId}`
					: `all ${struck} ${tier} alias${struck === 1 ? "" : "es"} unavailable`,
		};
	}

	function resolve(request: ModelResolutionRequest): ModelResolution {
		// 1. Inheritance is the rule: nothing asked for → the caller's model.
		const tier = request.tier;
		if (!tier) return inheritResolution(request);
		const walk = walkTier(request, tier);
		// 2. The first alias that yields an available attachment wins.
		const winner = walk.resolved.find((entry) => entry.fact.available);
		// 3. Nothing available → seat-model fallback, visibly.
		return winner
			? tierResolution(request, tier, walk, winner)
			: seatFallback(request, tier, walk);
	}

	/**
	 * `family: "other"` — a reviewer never marks its own homework. Walks the
	 * persona allowance's tiers IN ORDER through the bound roster and takes the
	 * first available entry whose family differs from the caller's.
	 * Deterministic: allowance order × roster order, nothing ranked at runtime.
	 *
	 * Nowhere to go — the caller's family is unknown (no caller model, or a model
	 * attached to no alias), the roster holds no foreign family, or every foreign
	 * entry is struck — falls back to plain inheritance WITH a fallbackReason.
	 * Falling back to a tier pick instead could still land on the caller's own
	 * family, which is precisely the outcome this selector rules out.
	 */
	function resolveOtherFamily(
		request: ModelResolutionRequest,
	): ModelResolution {
		const callerModel = request.inherit?.modelId;
		if (!callerModel)
			return inheritResolution(
				request,
				"other-family requested but the caller's model is unknown — cannot pick a differing family",
			);
		const callerFamily = familyOfModel(models, callerModel)?.family;
		if (!callerFamily)
			return inheritResolution(
				request,
				`other-family requested but ${callerModel} belongs to no configured family — nothing to differ from`,
			);
		const tiers = models?.allowances[request.persona]?.tiers ?? [];
		for (const tier of tiers) {
			let walk: TierWalk;
			try {
				walk = walkTier(request, tier);
			} catch {
				// No binding/roster to walk — this tier offers nowhere to go; the
				// degradation is reported once, below, rather than thrown per tier.
				continue;
			}
			const winner = walk.resolved.find(
				(entry) => entry.fact.available && entry.fact.family !== callerFamily,
			);
			if (winner) return tierResolution(request, tier, walk, winner);
		}
		return inheritResolution(
			request,
			`no model outside family ${callerFamily} is available in persona ${request.persona}'s tiers (${tiers.join(", ") || "none"})`,
		);
	}

	/**
	 * Resolve a NAMED family through the caller's binding and roster: walk the
	 * persona allowance's tiers in order and take the first available entry
	 * belonging to that family. This is the `family` parameter on the subagent
	 * tool — how a fan-out lead starts one member per family the spread named.
	 *
	 * The lookup IS the guard. An unknown or unavailable family throws, naming
	 * the families the persona's tiers actually reach, so the refusal teaches the
	 * caller what it could have asked for. It never falls back: a member
	 * requested as one family that silently ran as another would be the fan-out
	 * lying about its own diversity.
	 */
	function resolveFamily(
		request: ModelResolutionRequest & { readonly family: string },
	): ModelResolution {
		if (!models)
			throw new ModelResolutionError(
				`family ${request.family} requested but no v2 roster is configured`,
			);
		const tiers = models.allowances[request.persona]?.tiers ?? [];
		const reachable = new Set<string>();
		for (const tier of tiers) {
			let walk: TierWalk;
			try {
				walk = walkTier(request, tier);
			} catch {
				// No binding or roster to walk — this tier reaches nothing; the
				// refusal below reports the whole picture rather than throwing per tier.
				continue;
			}
			for (const entry of walk.resolved)
				if (entry.fact.family) reachable.add(entry.fact.family);
			const winner = walk.resolved.find(
				(entry) => entry.fact.available && entry.fact.family === request.family,
			);
			if (winner) return tierResolution(request, tier, walk, winner);
		}
		throw new ModelResolutionError(
			`no available model in family ${request.family} for persona ${request.persona} — ` +
				`the bound roster reaches: ${[...reachable].join(", ") || "none"}`,
		);
	}

	/**
	 * The default tier a spawn of this persona resolves at: the first tier in the
	 * persona's allowance (its preference order). Undefined when no v2 config
	 * exists, and for a persona with no allowance — the caller then falls through
	 * to pure inheritance, because a guessed tier for an unknown persona would be
	 * a model nobody asked for.
	 */
	function defaultTierFor(persona: string): TierId | undefined {
		return models?.allowances[persona]?.tiers[0];
	}

	function resolveForRole(
		role: string,
		request: RoleRouteRequest = {},
	): ModelResolution | null {
		const tier = request.tier ?? defaultTierFor(role);
		const inheritBase =
			request.inherit ?? (seat ? { modelId: seat } : undefined);
		const inherit =
			inheritBase && request.effort
				? { ...inheritBase, effort: request.effort }
				: inheritBase;
		const base: ModelResolutionRequest = {
			persona: role,
			...(tier ? { tier } : {}),
			...(inherit ? { inherit } : {}),
		};
		try {
			if (request.family === "other") return resolveOtherFamily(base);
			if (request.family !== undefined && request.family !== "same")
				return resolveFamily({ ...base, family: request.family });
			return resolve(base);
		} catch {
			// Fail-visible belongs to `resolve`, which callers may use directly.
			// This entry point is the one a host binds a role through, and a host
			// degrades to its own deterministic behaviour rather than wedging.
			return null;
		}
	}

	function resolveMany(
		request: ModelResolutionRequest,
		n: number,
	): readonly ModelResolution[] {
		const tier = request.tier;
		if (n <= 1 || !tier) return [resolve(request)];
		const walk = walkTier(request, tier);
		const picks: ModelResolution[] = [];
		const seen = new Set<string>();
		for (const entry of walk.resolved) {
			if (!entry.fact.available) continue;
			// One slot per family: a tier may list several aliases of the same
			// family, and two aliases of one family are not a second opinion.
			if (seen.has(entry.fact.family)) continue;
			seen.add(entry.fact.family);
			picks.push(tierResolution(request, tier, walk, entry));
			if (picks.length === n) break;
		}
		// Every alias struck (or an empty tier): degrade to the single seat
		// fallback, exactly as resolve does. NOT n copies of the seat — running the
		// same model n times is a fan-out that looks diverse and is not.
		return picks.length > 0 ? picks : [seatFallback(request, tier, walk)];
	}

	function explain(persona: string, tier: TierId): TierExplanation {
		if (!models) return { allowed: false, candidates: [] };
		const active = activeBinding(models, seat);
		const roster = active ? models.rosters[active.binding.roster] : undefined;
		const agentProvider = parseModelSpec(seat ?? "")?.provider;
		const checked = roster
			? roster[tier].map((ref) => resolveRef(ref, agentProvider, models.region))
			: [];
		return {
			...(active ? { bindingId: active.id } : {}),
			...(active ? { rosterId: active.binding.roster } : {}),
			allowed: (models.allowances[persona]?.tiers ?? []).includes(tier),
			candidates: checked.map((entry) => entry.fact),
		};
	}

	return Object.freeze({
		resolve,
		resolveMany,
		resolveOtherFamily,
		resolveFamily,
		resolveForRole,
		defaultTierFor,
		explain,

		explainAttachment(spec: string): { available: boolean; reason?: string } {
			const check = checkAttachment(spec, models?.region);
			return {
				available: check.available,
				...(check.reason ? { reason: check.reason } : {}),
			};
		},

		/**
		 * How wide a MULTI-MODAL review by this persona fans out. Answers HOW
		 * WIDE, never WHETHER — the plan node decides that, so a reviewer the plan
		 * did not mark multi-modal runs on one model no matter what this returns.
		 *
		 * Falls back to the shipped default when the merged config carries no
		 * spread: `allowances` merges shallowly, so authoring `code-review: {
		 * tiers: [...] }` to narrow tiers would otherwise silently disable
		 * multi-modal review. Absent everywhere → 1, so an authored flag degrades
		 * to a single review rather than erroring.
		 */
		spreadFor(persona: string): number {
			const configured =
				models?.allowances[persona]?.spread ??
				DEFAULT_PERSONA_ALLOWANCES[persona]?.spread ??
				1;
			return Math.min(Math.max(1, configured), MAX_SPREAD);
		},

		/**
		 * The persona allowance's `direct` selector — how a DIRECT (non-fanned)
		 * spawn picks its model. Absent everywhere (including no config at all) →
		 * "inherit", so the selector stays dormant until someone authors it.
		 */
		directFor(persona: string): DirectSelector {
			return (
				models?.allowances[persona]?.direct ??
				DEFAULT_PERSONA_ALLOWANCES[persona]?.direct ??
				"inherit"
			);
		},

		/**
		 * The replay revalidation: a stored resolution is re-used verbatim, and
		 * only this question is asked again. A model that has vanished from the
		 * registry, lost its credentials, or fallen outside the active region is
		 * no longer authorized, and the caller fails the task by name rather than
		 * silently rerouting it.
		 */
		isAuthorized(modelId: string): boolean {
			return checkAttachment(modelId, models?.region).available;
		},
	});
}
