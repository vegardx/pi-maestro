// The v2 inheritance-first model resolver (docs/design/v2-primitives.md,
// "Model resolution"). Precedence:
//
//   1. No tier requested → INHERIT: the child runs its caller's model. Plans
//      carry no model fields; root spawns run the session model because the
//      root's model IS the session model.
//   2. A tier requested (persona fan-out instructions, policy rows) → resolve
//      through the active binding's roster: that tier's ordered alias refs,
//      each resolved to a concrete attachment. An alias prefers the resolving
//      agent's OWN gateway provider (keep traffic on one gateway), else the
//      first available attachment in the alias's order. The first alias that
//      yields an available attachment wins — bounded by the agent type's tier
//      allowance.
//   3. Nothing available (empty tier, every attachment struck, unknown roster)
//      → SESSION-MODEL FALLBACK with a notice: the judgment still happens, on
//      the seat, visibly. Never fail-open, never wedge.
//
// `inherit` and the fallback are exempt from tier allowances but labeled in the
// resolution record — the constraint bounds deliberate tier references, and
// nothing is ever silently laundered.

import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	AliasConfig,
	ModelsConfig,
	RegionConfig,
	SpawnableAgentType,
	ThinkingLevel,
	TierId,
} from "@vegardx/pi-contracts";
import {
	DEFAULT_AGENT_ALLOWANCES,
	MAX_SPREAD,
	THINKING_LEVELS,
} from "@vegardx/pi-contracts";
import { activeBinding, parseAliasRef, readModelsConfig } from "./catalog.js";
import { supportedEfforts } from "./efforts.js";
import { parseModelSpec, sessionModelId } from "./model-spec.js";
import { activeRegion, modelAllowedByRegion } from "./region.js";

/** What the caller passes down: its own model — the inheritance default. */
export interface InheritedModel {
	readonly modelId: string;
	readonly effort?: ThinkingLevel;
}

export interface ModelResolutionRequest {
	readonly agent: SpawnableAgentType;
	/** Explicit tier reference (persona instruction or policy row). Absent = inherit. */
	readonly tier?: TierId;
	/** The caller's model. Absent only at the root, where the session model is the caller. */
	readonly inherit?: InheritedModel;
	/** Skip auth checks (offline validation). */
	readonly requireApiKey?: boolean;
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
 * Serializable resolution record — the shape the plan ledger persists per node
 * (NodeResolution) and what explain output renders. Never re-rolled silently:
 * persisted records are revalidated, and a vanished model fails visibly.
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
	/** Present iff source === "fallback": why the tier produced nothing. */
	readonly fallbackReason?: string;
}

export class ModelResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelResolutionError";
	}
}

interface AttachmentCheck {
	/** The concrete `provider/model` ref. */
	readonly spec: string;
	readonly available: boolean;
	readonly reason?: string;
	/** The registry model when available. */
	readonly model?: Model<Api>;
}

async function checkAttachment(
	ctx: ExtensionContext,
	spec: string,
	region: RegionConfig | undefined,
	requireApiKey: boolean,
): Promise<AttachmentCheck> {
	// Region: the only hard filter — strikes before anything reasons.
	if (!modelAllowedByRegion(region, spec))
		return {
			spec,
			available: false,
			reason: `outside region ${activeRegion(region)}`,
		};
	const parsed = parseModelSpec(spec);
	const model = parsed
		? (ctx.modelRegistry.find(parsed.provider, parsed.modelId) as
				| Model<Api>
				| undefined)
		: undefined;
	if (!model) return { spec, available: false, reason: "not in registry" };
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	const authenticated = auth.ok && (!requireApiKey || Boolean(auth.apiKey));
	if (!authenticated)
		return { spec, available: false, reason: "not authenticated" };
	return { spec, available: true, model };
}

interface ResolvedAlias {
	readonly fact: ModelCandidateFact;
	readonly config: AliasConfig;
	/** The chosen registry model when the alias resolved. */
	readonly model?: Model<Api>;
}

/**
 * Resolve one alias to a concrete attachment: prefer an available attachment
 * on the resolving agent's own gateway (keep traffic on one gateway), else the
 * first available attachment in the alias's authored order. When none is
 * available, the fact carries why.
 */
async function resolveAlias(
	ctx: ExtensionContext,
	ref: string,
	family: string,
	alias: string,
	config: AliasConfig,
	agentProvider: string | undefined,
	region: RegionConfig | undefined,
	requireApiKey: boolean,
): Promise<ResolvedAlias> {
	const checks = await Promise.all(
		config.attach.map((spec) =>
			checkAttachment(ctx, spec, region, requireApiKey),
		),
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
		...(config.notes ? { notes: config.notes } : {}),
		...(config.effort ? { effort: config.effort } : {}),
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
			config,
		};
	}
	return {
		fact: {
			...base,
			available: true,
			model: preferred.spec,
			...(parseModelSpec(preferred.spec)?.provider
				? { provider: parseModelSpec(preferred.spec)?.provider }
				: {}),
		},
		config,
		model: preferred.model,
	};
}

/** One attachment's availability fact (region, registry, auth) — the editor's live word. */
export async function explainAttachment(
	ctx: ExtensionContext,
	spec: string,
): Promise<{ available: boolean; reason?: string }> {
	const region = readConfigSafe(ctx)?.region;
	const check = await checkAttachment(ctx, spec, region, false);
	return {
		available: check.available,
		...(check.reason ? { reason: check.reason } : {}),
	};
}

/**
 * Clamp an inherited/preferred effort into an alias's allowlist ∩ the model's
 * supported levels: exact when allowed, else nearest below, else lowest above
 * (the same rule v1's auto-effort uses).
 */
export function clampEffort(
	preferred: ThinkingLevel | undefined,
	alias: Pick<AliasConfig, "effort" | "efforts">,
	model: Model<Api> | undefined,
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
 * Resolve a spawn's model. Fail-visible, never fail-open: an unknown roster,
 * an out-of-allowance tier, or a missing session model at the fallback throw
 * {@link ModelResolutionError}; an empty/struck tier degrades to the session
 * model with `fallbackReason` set (the caller surfaces the notice, deduped per
 * agent — see {@link fallbackNotice}).
 */
export async function resolveModel(
	ctx: ExtensionContext,
	request: ModelResolutionRequest,
): Promise<ModelResolution> {
	// 1. Inheritance is the rule: nothing asked for → the caller's model.
	const tier = request.tier;
	if (!tier) return inheritResolution(ctx, request);
	const walk = await walkTier(ctx, request, tier);
	// 2. The first alias that yields an available attachment wins.
	const winner = walk.resolved.find((entry) => entry.fact.available);
	// 3. Nothing available → session-model fallback, visibly.
	return winner
		? tierResolution(request, tier, walk, winner)
		: seatFallback(request, tier, walk);
}

/**
 * Resolve up to `n` models for ONE spawn request, each from a DISTINCT family —
 * the primitive behind multi-modal review. Genuine diversity is the entire
 * point, so this never pads: it returns fewer slots rather than the same model
 * twice, and a caller that gets one slot runs one review.
 *
 * `n <= 1`, or a request with no tier (inheritance has no roster to spread
 * across), is exactly {@link resolveModel} in a one-element array.
 */
export async function resolveModels(
	ctx: ExtensionContext,
	request: ModelResolutionRequest,
	n: number,
): Promise<ModelResolution[]> {
	const tier = request.tier;
	if (n <= 1 || !tier) return [await resolveModel(ctx, request)];
	const walk = await walkTier(ctx, request, tier);
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
	// Every alias struck (or an empty tier): degrade to the single seat fallback,
	// exactly as resolveModel does. NOT n copies of the seat — running the same
	// model n times is a fan-out that looks diverse and is not.
	return picks.length > 0 ? picks : [seatFallback(request, tier, walk)];
}

/** The caller's own model, for a request that asked for no tier. */
function inheritResolution(
	ctx: ExtensionContext,
	request: ModelResolutionRequest,
): ModelResolution {
	const inherited = request.inherit ?? {
		modelId: sessionModelId(ctx) ?? "",
		effort: (
			ctx as { getThinkingLevel?: () => ThinkingLevel }
		).getThinkingLevel?.(),
	};
	if (!inherited.modelId)
		throw new ModelResolutionError(
			"nothing to inherit: no caller model and no live session model",
		);
	return {
		source: "inherit",
		modelId: inherited.modelId,
		...(inherited.effort ? { effort: inherited.effort } : {}),
	};
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
 * Validate the request against config/allowance/binding/roster and resolve EVERY
 * alias ref in the tier. Shared by the one-model and top-N entry points so they
 * cannot drift on validation, ordering, or the own-gateway preference.
 */
async function walkTier(
	ctx: ExtensionContext,
	request: ModelResolutionRequest,
	tier: TierId,
): Promise<TierWalk> {
	const config = readConfigSafe(ctx);
	if (!config)
		throw new ModelResolutionError(
			`tier ${tier} requested but no v2 roster is configured`,
		);
	// Deliberate tier references are bounded by the agent's allowance.
	const allowed = config.allowances[request.agent]?.tiers ?? [];
	if (!allowed.includes(tier))
		throw new ModelResolutionError(
			`tier ${tier} is outside agent ${request.agent}'s allowance (${allowed.join(", ")})`,
		);
	const active = activeBinding(config, sessionModelId(ctx));
	if (!active)
		throw new ModelResolutionError(
			`tier ${tier} requested but no binding is active (no target match, no default binding)`,
		);
	const roster = config.rosters[active.binding.roster];
	if (!roster)
		throw new ModelResolutionError(
			`binding ${active.id} references unknown roster ${active.binding.roster}`,
		);

	// 2. Walk the tier's ordered alias refs; each resolves to a concrete
	//    attachment (own-gateway preference, else first available). The first
	//    alias that yields an available attachment wins.
	const seat = sessionModelId(ctx);
	const agentProvider = parseModelSpec(
		request.inherit?.modelId ?? seat ?? "",
	)?.provider;
	const refs = roster[tier];
	const resolved = await Promise.all(
		refs.map((ref) => {
			const parsed = parseAliasRef(ref);
			// validateModelsConfig guarantees the ref resolves; guard defensively.
			const aliasConfig = parsed
				? config.families[parsed.family]?.aliases[parsed.alias]
				: undefined;
			if (!parsed || !aliasConfig)
				return Promise.resolve<ResolvedAlias>({
					fact: {
						ref,
						family: parsed?.family ?? "",
						alias: parsed?.alias ?? "",
						available: false,
						reason: "unknown alias ref",
					},
					config: { attach: [] },
				});
			return resolveAlias(
				ctx,
				ref,
				parsed.family,
				parsed.alias,
				aliasConfig,
				agentProvider,
				config.region,
				request.requireApiKey ?? false,
			);
		}),
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
		...(entry.fact.provider ? { attachmentProvider: entry.fact.provider } : {}),
		tier,
		bindingId: walk.bindingId,
		rosterId: walk.rosterId,
		candidates: walk.candidates,
	};
}

/**
 * Every alias was unavailable (or the tier is empty), so the judgment still
 * happens — on the seat — visibly. Throws when there is no seat to fall back to.
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

/**
 * How wide a MULTI-MODAL review by this agent type fans out. Answers HOW WIDE,
 * never WHETHER — the plan node decides that, so a reviewer the plan did not
 * mark multi-modal runs on one model no matter what this returns.
 *
 * Falls back to the shipped default when the merged config carries no spread:
 * `allowances` merges shallowly, so authoring `reviewer: { tiers: [...] }` to
 * narrow tiers would otherwise silently disable multi-modal review. Absent
 * everywhere → 1, so an authored flag degrades to a single review rather than
 * erroring.
 */
export function spreadForAgent(
	ctx: ExtensionContext,
	agent: SpawnableAgentType,
): number {
	const configured =
		readConfigSafe(ctx)?.allowances[agent]?.spread ??
		DEFAULT_AGENT_ALLOWANCES[agent]?.spread ??
		1;
	return Math.min(Math.max(1, configured), MAX_SPREAD);
}

/**
 * The default tier a plan node of this agent type spawns at: the first tier in
 * the agent's allowance (its preference order). Undefined when no v2 config
 * exists — the caller then falls through to pure inheritance (the seat), so
 * routing stays dormant until a roster is configured.
 */
export function defaultTierForAgent(
	ctx: ExtensionContext,
	agent: SpawnableAgentType,
): TierId | undefined {
	return readConfigSafe(ctx)?.allowances[agent]?.tiers[0];
}

function readConfigSafe(ctx: ExtensionContext): ModelsConfig | undefined {
	// Config errors are fail-visible at read time elsewhere; here they mean
	// "no usable v2 config", which the caller surfaces via ModelResolutionError.
	try {
		return readModelsConfig(ctx.cwd);
	} catch {
		return undefined;
	}
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

/** Explain a tier without resolving: every ref's fact, for /models-style output. */
export async function explainTier(
	ctx: ExtensionContext,
	agent: SpawnableAgentType,
	tier: TierId,
): Promise<{
	bindingId?: string;
	rosterId?: string;
	allowed: boolean;
	candidates: readonly ModelCandidateFact[];
}> {
	const config = readConfigSafe(ctx);
	if (!config) return { allowed: false, candidates: [] };
	const active = activeBinding(config, sessionModelId(ctx));
	const roster = active ? config.rosters[active.binding.roster] : undefined;
	const seat = sessionModelId(ctx);
	const agentProvider = parseModelSpec(seat ?? "")?.provider;
	const checked = roster
		? await Promise.all(
				roster[tier].map((ref) => {
					const parsed = parseAliasRef(ref);
					const aliasConfig = parsed
						? config.families[parsed.family]?.aliases[parsed.alias]
						: undefined;
					if (!parsed || !aliasConfig)
						return Promise.resolve<ResolvedAlias>({
							fact: {
								ref,
								family: parsed?.family ?? "",
								alias: parsed?.alias ?? "",
								available: false,
								reason: "unknown alias ref",
							},
							config: { attach: [] },
						});
					return resolveAlias(
						ctx,
						ref,
						parsed.family,
						parsed.alias,
						aliasConfig,
						agentProvider,
						config.region,
						false,
					);
				}),
			)
		: [];
	return {
		...(active ? { bindingId: active.id } : {}),
		...(active ? { rosterId: active.binding.roster } : {}),
		allowed: (config.allowances[agent]?.tiers ?? []).includes(tier),
		candidates: checked.map((entry) => entry.fact),
	};
}

/**
 * Which v2 agent type a v1 subagent role runs as.
 *
 * Reviews judge (`reviewer`), implementation and delivery verification act
 * (`worker`), advice consults (`advisor`), and the classify/summarize/research
 * roles only read (`explorer`). Mirrors the DUTY_AGENT lens the policy table
 * uses.
 */
export function agentTypeForRole(
	role: string,
): "worker" | "explorer" | "reviewer" | "advisor" {
	if (role.endsWith("-review")) return "reviewer";
	if (role === "worker" || role === "verifier") return "worker";
	if (role === "advisor") return "advisor";
	return "explorer";
}
