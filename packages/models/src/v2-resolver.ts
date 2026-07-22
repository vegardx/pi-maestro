// The v2 inheritance-first model resolver (docs/design/v2-primitives.md,
// "Model resolution"). Precedence:
//
//   1. No tier requested → INHERIT: the child runs its caller's model. Plans
//      carry no model fields; root spawns run the session model because the
//      root's model IS the session model.
//   2. A tier requested (persona fan-out instructions, policy rows) →
//      resolve through the active profile's catalog: that tier's NON-SEAT
//      entries, residency-filtered, availability-checked, first-available in
//      authored order — bounded by the agent type's tier allowlist. The
//      session model is excluded here and reached only via (3): seat-to-end,
//      so a deliberate tier choice prefers a real alternative to the seat and
//      never fails because of that choice.
//   3. Nothing available (empty tier, fully struck, unknown catalog) →
//      SESSION-MODEL FALLBACK with a notice: the judgment still happens, on
//      the seat, visibly. Never fail-open, never wedge.
//
// `inherit` and the fallback are exempt from tier allowlists but labeled in
// the resolution record — the constraint bounds deliberate tier references,
// and nothing is ever silently laundered. Library only for now: spawn wiring
// lands with the plan cutover; v1 role resolution keeps driving until then.

import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	CatalogEntry,
	SpawnableAgentType,
	ThinkingLevel,
	TierId,
	V2ModelsConfig,
} from "@vegardx/pi-contracts";
import { activeV2Profile, readV2Config } from "./catalog.js";
import { supportedEfforts } from "./efforts.js";
import { parseModelSpec } from "./model-spec.js";
import { readModelsConfig } from "./profiles.js";
import { activeResidency, modelAllowedByResidency } from "./residency.js";

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

/** Why each catalog entry was or wasn't usable — the explain output's rows. */
export interface V2CandidateFact {
	readonly model: string;
	readonly family?: string;
	readonly notes?: string;
	readonly effort?: ThinkingLevel;
	readonly available: boolean;
	readonly reason?: string;
}

export type V2ResolutionSource = "inherit" | "tier" | "fallback";

/**
 * Serializable resolution record — the shape the plan ledger persists per
 * node (NodeResolution) once the cutover lands, and what explain output
 * renders. Never re-rolled silently: persisted records are revalidated, and
 * a vanished model fails visibly.
 */
export interface V2Resolution {
	readonly source: V2ResolutionSource;
	readonly modelId: string;
	readonly effort?: ThinkingLevel;
	/** Authored family from the catalog entry (diversity checks compare these). */
	readonly family?: string;
	readonly tier?: TierId;
	readonly profileId?: string;
	readonly catalogId?: string;
	/** Per-entry facts when a tier was walked (explain output). */
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

interface CheckedEntry {
	readonly fact: V2CandidateFact;
	readonly model?: Model<Api>;
}

async function checkCatalogEntry(
	ctx: ExtensionContext,
	entry: CatalogEntry,
	requireApiKey: boolean,
): Promise<CheckedEntry> {
	const base: Omit<V2CandidateFact, "available" | "reason"> = {
		model: entry.model,
		...(entry.family ? { family: entry.family } : {}),
		...(entry.notes ? { notes: entry.notes } : {}),
		...(entry.effort ? { effort: entry.effort } : {}),
	};
	// Residency: the only hard filter — strikes before anything reasons.
	const v1Config = safeV1Config(ctx);
	if (!modelAllowedByResidency(v1Config, entry.model)) {
		return {
			fact: {
				...base,
				available: false,
				reason: `outside residency ${activeResidency(v1Config)}`,
			},
		};
	}
	const spec = parseModelSpec(entry.model);
	const model = spec
		? (ctx.modelRegistry.find(spec.provider, spec.modelId) as
				| Model<Api>
				| undefined)
		: undefined;
	if (!model) {
		return { fact: { ...base, available: false, reason: "not in registry" } };
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	const authenticated = auth.ok && (!requireApiKey || Boolean(auth.apiKey));
	if (!authenticated) {
		return {
			fact: { ...base, available: false, reason: "not authenticated" },
		};
	}
	return { fact: { ...base, available: true }, model };
}

/**
 * One entry's availability fact (residency, registry, auth) without
 * resolving anything — the /maestro catalog editor's live availability
 * word for entries in ANY catalog, active or not.
 */
export async function explainCatalogEntry(
	ctx: ExtensionContext,
	entry: CatalogEntry,
): Promise<V2CandidateFact> {
	const { fact } = await checkCatalogEntry(ctx, entry, false);
	return fact;
}

function safeV1Config(ctx: ExtensionContext) {
	try {
		return readModelsConfig(ctx.cwd);
	} catch {
		return undefined;
	}
}

function sessionModelId(ctx: ExtensionContext): string | undefined {
	const model = ctx.model as { provider?: string; id?: string } | undefined;
	return model?.provider && model.id
		? `${model.provider}/${model.id}`
		: undefined;
}

/**
 * Clamp an inherited/preferred effort into an entry's allowlist ∩ the
 * model's supported levels: exact when allowed, else nearest below, else
 * lowest above (the same rule v1's auto-effort uses).
 */
export function clampEffort(
	preferred: ThinkingLevel | undefined,
	entry: CatalogEntry,
	model: Model<Api> | undefined,
): ThinkingLevel | undefined {
	if (entry.effort && !entry.efforts) return entry.effort;
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
			(!entry.efforts || entry.efforts.includes(level)),
	);
	if (allowed.length === 0) return entry.effort;
	const wanted = entry.effort ?? preferred;
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
 * Resolve a spawn's model. Fail-visible, never fail-open: an unknown
 * catalog, an out-of-allowlist tier, or a missing session model at the
 * fallback throw {@link V2ResolutionError}; an empty/struck tier degrades
 * to the session model with `fallbackReason` set (the caller surfaces the
 * notice, deduped per agent — see {@link fallbackNotice}).
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
			`tier ${request.tier} requested but no v2 catalog is configured`,
		);
	// Deliberate tier references are bounded by the agent's allowlist.
	const allowed = config.agents[request.agent]?.models ?? [];
	if (!allowed.includes(request.tier))
		throw new V2ResolutionError(
			`tier ${request.tier} is outside agent ${request.agent}'s allowlist (${allowed.join(", ")})`,
		);
	const active = activeV2Profile(config, sessionModelId(ctx));
	if (!active)
		throw new V2ResolutionError(
			`tier ${request.tier} requested but no profile is active (no target match, no default profile)`,
		);
	const catalog = config.catalogs[active.profile.catalog];
	if (!catalog)
		throw new V2ResolutionError(
			`profile ${active.id} references unknown catalog ${active.profile.catalog}`,
		);

	// 2. Walk the tier: residency-filtered, availability-checked, authored order.
	//    Seat-to-end (docs/design/multi-model-agents.md §1): the session model
	//    never competes as a tier choice — it is the known-good fallback, tried
	//    only after every non-seat entry (step 3). So a tier that lists the seat
	//    still prefers a real alternative and lands on the seat last.
	const seat = sessionModelId(ctx);
	const tierEntries = catalog[request.tier].filter(
		(entry) => entry.model !== seat,
	);
	const checked = await Promise.all(
		tierEntries.map((entry) =>
			checkCatalogEntry(ctx, entry, request.requireApiKey ?? false),
		),
	);
	const candidates = checked.map((entry) => entry.fact);
	const winnerIndex = checked.findIndex((entry) => entry.fact.available);
	if (winnerIndex >= 0) {
		const winner = checked[winnerIndex];
		const entry = tierEntries[winnerIndex];
		const effort = clampEffort(request.inherit?.effort, entry, winner.model);
		return {
			source: "tier",
			modelId: entry.model,
			...(effort ? { effort } : {}),
			...(entry.family ? { family: entry.family } : {}),
			tier: request.tier,
			profileId: active.id,
			catalogId: active.profile.catalog,
			candidates,
		};
	}

	// 3. Session-model fallback: every non-seat entry was unavailable (or the
	//    tier held nothing but the seat), so the judgment still happens — on the
	//    seat, the known-good end of the seat-to-end order — visibly.
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
		profileId: active.id,
		catalogId: active.profile.catalog,
		candidates,
		fallbackReason:
			catalog[request.tier].length === 0
				? `tier ${request.tier} is empty in catalog ${active.profile.catalog}`
				: candidates.length === 0
					? `tier ${request.tier} lists only the session model in catalog ${active.profile.catalog}`
					: `all ${struck} ${request.tier} entr${struck === 1 ? "y is" : "ies are"} unavailable`,
	};
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
 * The one deduped notice per agent for fallback resolutions. Callers keep
 * the set (keyed however their agent identity works) and notify only when
 * add() returns true.
 */
export function fallbackNotice(resolution: V2Resolution): string {
	return (
		`configured tier ${resolution.tier} unavailable — running on the session ` +
		`model (${resolution.modelId}). ${resolution.fallbackReason ?? ""}`.trim()
	);
}

/** Explain a tier without resolving: every entry's fact, for /models-style output. */
export async function explainTier(
	ctx: ExtensionContext,
	agent: SpawnableAgentType,
	tier: TierId,
): Promise<{
	profileId?: string;
	catalogId?: string;
	allowed: boolean;
	candidates: readonly V2CandidateFact[];
}> {
	const config = readV2ConfigSafe(ctx);
	if (!config) return { allowed: false, candidates: [] };
	const active = activeV2Profile(config, sessionModelId(ctx));
	const catalog = active ? config.catalogs[active.profile.catalog] : undefined;
	const checked = catalog
		? await Promise.all(
				catalog[tier].map((entry) => checkCatalogEntry(ctx, entry, false)),
			)
		: [];
	return {
		...(active ? { profileId: active.id } : {}),
		...(active ? { catalogId: active.profile.catalog } : {}),
		allowed: (config.agents[agent]?.models ?? []).includes(tier),
		candidates: checked.map((entry) => entry.fact),
	};
}

/**
 * Which v2 agent type a v1 subagent role runs as.
 *
 * The v2 vocabulary has three agent types; `agents.run` still speaks the
 * fifteen v1 roles. Reviews judge (`reviewer`), implementation and delivery
 * verification act (`worker`), and the classify/summarize/research roles only
 * read (`explorer`). Mirrors the DUTY_AGENT lens the policy table uses.
 */
export function agentTypeForRole(
	role: string,
): "worker" | "explorer" | "reviewer" | "advisor" {
	if (role.endsWith("-review")) return "reviewer";
	if (role === "worker" || role === "verifier") return "worker";
	if (role === "advisor") return "advisor";
	return "explorer";
}
