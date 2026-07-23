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
	RegionConfig,
	SpawnableAgentType,
	ThinkingLevel,
	TierId,
	V2ModelsConfig,
} from "@vegardx/pi-contracts";
import { activeV2Binding, parseAliasRef, readV2Config } from "./catalog.js";
import { supportedEfforts } from "./efforts.js";
import { parseModelSpec } from "./model-spec.js";
import { activeRegion, modelAllowedByRegion } from "./region.js";

/** What the caller passes down: its own model — the inheritance default. */
export interface InheritedModel {
	readonly modelId: string;
	readonly effort?: ThinkingLevel;
}

export interface V2ResolutionRequest {
	readonly agent: SpawnableAgentType;
	/** Explicit tier reference (persona instruction or policy row). Absent = inherit. */
	readonly tier?: TierId;
	/** The caller's model. Absent only at the root, where the session model is the caller. */
	readonly inherit?: InheritedModel;
	/** Skip auth checks (offline validation). */
	readonly requireApiKey?: boolean;
}

/** Why each roster alias ref was or wasn't usable — the explain output's rows. */
export interface V2CandidateFact {
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

export type V2ResolutionSource = "inherit" | "tier" | "fallback";

/**
 * Serializable resolution record — the shape the plan ledger persists per node
 * (NodeResolution) and what explain output renders. Never re-rolled silently:
 * persisted records are revalidated, and a vanished model fails visibly.
 */
export interface V2Resolution {
	readonly source: V2ResolutionSource;
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
	readonly candidates?: readonly V2CandidateFact[];
	/** Present iff source === "fallback": why the tier produced nothing. */
	readonly fallbackReason?: string;
}

export class V2ResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "V2ResolutionError";
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
	readonly fact: V2CandidateFact;
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
	const region = readV2ConfigSafe(ctx)?.region;
	const check = await checkAttachment(ctx, spec, region, false);
	return {
		available: check.available,
		...(check.reason ? { reason: check.reason } : {}),
	};
}

function sessionModelId(ctx: ExtensionContext): string | undefined {
	const model = ctx.model as { provider?: string; id?: string } | undefined;
	return model?.provider && model.id
		? `${model.provider}/${model.id}`
		: undefined;
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
	const order: readonly ThinkingLevel[] = [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	];
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
 * {@link V2ResolutionError}; an empty/struck tier degrades to the session
 * model with `fallbackReason` set (the caller surfaces the notice, deduped per
 * agent — see {@link fallbackNotice}).
 */
export async function resolveV2Model(
	ctx: ExtensionContext,
	request: V2ResolutionRequest,
): Promise<V2Resolution> {
	// 1. Inheritance is the rule: nothing asked for → the caller's model.
	if (!request.tier) {
		const inherited = request.inherit ?? {
			modelId: sessionModelId(ctx) ?? "",
			effort: (
				ctx as { getThinkingLevel?: () => ThinkingLevel }
			).getThinkingLevel?.(),
		};
		if (!inherited.modelId)
			throw new V2ResolutionError(
				"nothing to inherit: no caller model and no live session model",
			);
		return {
			source: "inherit",
			modelId: inherited.modelId,
			...(inherited.effort ? { effort: inherited.effort } : {}),
		};
	}

	const config = readV2ConfigSafe(ctx);
	if (!config)
		throw new V2ResolutionError(
			`tier ${request.tier} requested but no v2 roster is configured`,
		);
	// Deliberate tier references are bounded by the agent's allowance.
	const allowed = config.allowances[request.agent]?.tiers ?? [];
	if (!allowed.includes(request.tier))
		throw new V2ResolutionError(
			`tier ${request.tier} is outside agent ${request.agent}'s allowance (${allowed.join(", ")})`,
		);
	const active = activeV2Binding(config, sessionModelId(ctx));
	if (!active)
		throw new V2ResolutionError(
			`tier ${request.tier} requested but no binding is active (no target match, no default binding)`,
		);
	const roster = config.rosters[active.binding.roster];
	if (!roster)
		throw new V2ResolutionError(
			`binding ${active.id} references unknown roster ${active.binding.roster}`,
		);

	// 2. Walk the tier's ordered alias refs; each resolves to a concrete
	//    attachment (own-gateway preference, else first available). The first
	//    alias that yields an available attachment wins.
	const seat = sessionModelId(ctx);
	const agentProvider = parseModelSpec(
		request.inherit?.modelId ?? seat ?? "",
	)?.provider;
	const refs = roster[request.tier];
	const resolved = await Promise.all(
		refs.map((ref) => {
			const parsed = parseAliasRef(ref);
			// validateV2Config guarantees the ref resolves; guard defensively.
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
	const candidates = resolved.map((entry) => entry.fact);
	const winnerIndex = resolved.findIndex((entry) => entry.fact.available);
	if (winnerIndex >= 0) {
		const winner = resolved[winnerIndex];
		const effort = clampEffort(
			request.inherit?.effort,
			winner.config,
			winner.model,
		);
		return {
			source: "tier",
			modelId: winner.fact.model as string,
			...(effort ? { effort } : {}),
			family: winner.fact.family,
			alias: winner.fact.alias,
			...(winner.fact.provider
				? { attachmentProvider: winner.fact.provider }
				: {}),
			tier: request.tier,
			bindingId: active.id,
			rosterId: active.binding.roster,
			candidates,
		};
	}

	// 3. Session-model fallback: every alias was unavailable (or the tier is
	//    empty), so the judgment still happens — on the seat — visibly.
	if (!seat)
		throw new V2ResolutionError(
			`tier ${request.tier} has no available model and there is no session model to fall back to`,
		);
	const struck = candidates.filter((fact) => !fact.available).length;
	return {
		source: "fallback",
		modelId: seat,
		...(request.inherit?.effort ? { effort: request.inherit.effort } : {}),
		tier: request.tier,
		bindingId: active.id,
		rosterId: active.binding.roster,
		candidates,
		fallbackReason:
			refs.length === 0
				? `tier ${request.tier} is empty in roster ${active.binding.roster}`
				: `all ${struck} ${request.tier} alias${struck === 1 ? "" : "es"} unavailable`,
	};
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
	return readV2ConfigSafe(ctx)?.allowances[agent]?.tiers[0];
}

function readV2ConfigSafe(ctx: ExtensionContext): V2ModelsConfig | undefined {
	// Config errors are fail-visible at read time elsewhere; here they mean
	// "no usable v2 config", which the caller surfaces via V2ResolutionError.
	try {
		return readV2Config(ctx.cwd);
	} catch {
		return undefined;
	}
}

/**
 * The one deduped notice per agent for fallback resolutions. Callers keep the
 * set (keyed however their agent identity works) and notify only when add()
 * returns true.
 */
export function fallbackNotice(resolution: V2Resolution): string {
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
	candidates: readonly V2CandidateFact[];
}> {
	const config = readV2ConfigSafe(ctx);
	if (!config) return { allowed: false, candidates: [] };
	const active = activeV2Binding(config, sessionModelId(ctx));
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
