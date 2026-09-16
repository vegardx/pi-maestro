// The Pi host adapter for @vegardx/pi-models.
//
// The router package knows families, rosters, tiers, regions and allowances and
// nothing about Pi. Everything Pi-shaped lives here: reading the merged
// `models` settings slice through SettingsManager, building the router's
// three-method `ModelCatalogPort` out of `ctx.modelRegistry`, and turning a
// resolved `provider/model` id back into a registry model plus credentials for
// the in-process callers that `complete()` rather than spawn a child.
//
// The registry surface is synchronous (`find`, `getProviderAuthStatus`,
// `getRegisteredProviderIds`), which is why the port and the whole router are
// synchronous: a resolution inside a footer render or a materializer cannot
// await one round trip per candidate attachment. Credentials are fetched once,
// after resolution, by the one caller that needs them.

import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type ExtensionContext,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	type CatalogModel,
	createModelRouter,
	type ModelCatalogPort,
	type ModelResolution,
	type ModelRole,
	type ModelRouter,
	type ModelsConfig,
	parseModelSpec,
	parseModelsSettings,
	personaForRole,
	type ThinkingLevel,
	type TierId,
} from "@vegardx/pi-models";

/**
 * Read the merged v2 slice (global + project, project winning per key).
 * Returns undefined when nothing v2 is configured — an empty models block is
 * inherit-all, not an error.
 */
export function readModelsConfig(
	cwd: string,
	agentDir?: string,
): ModelsConfig | undefined {
	const manager = SettingsManager.create(cwd, agentDir);
	return parseModelsSettings(
		manager.getGlobalSettings() as unknown,
		manager.getProjectSettings() as unknown,
	);
}

/** The live session model as a `provider/id` ref, or undefined if none. */
export function sessionModelId(ctx: ExtensionContext): string | undefined {
	const model = ctx.model as { provider?: string; id?: string } | undefined;
	return model?.provider && model.id
		? `${model.provider}/${model.id}`
		: undefined;
}

/** Pi's synchronous registry facade, as the router's three questions. */
export function modelCatalogPort(ctx: ExtensionContext): ModelCatalogPort {
	const registry = ctx.modelRegistry;
	return {
		findModel: (provider, id) =>
			registry.find(provider, id) as CatalogModel | undefined,
		isAuthenticated: (provider) =>
			registry.getProviderAuthStatus(provider).configured,
		registeredProviders: () => registry.getRegisteredProviderIds(),
	};
}

/**
 * The router for this session: the merged config, the seat, and a port over
 * the live registry. A config error means "no usable v2 config" here — the
 * refusal is fail-visible at read time elsewhere, and a router with no config
 * resolves by pure inheritance rather than throwing at every call site.
 */
export function modelRouterFor(ctx: ExtensionContext): ModelRouter {
	let models: ModelsConfig | undefined;
	try {
		models = readModelsConfig(ctx.cwd);
	} catch {
		models = undefined;
	}
	const seatEffort = (
		ctx as { getThinkingLevel?: () => ThinkingLevel }
	).getThinkingLevel?.();
	return createModelRouter(
		{
			...(models ? { models } : {}),
			...(sessionModelId(ctx) ? { seat: sessionModelId(ctx) } : {}),
			...(seatEffort ? { seatEffort } : {}),
		},
		modelCatalogPort(ctx),
	);
}

export interface ResolvedModelAuth {
	readonly model: Model<Api>;
	readonly apiKey?: string;
	readonly headers?: Record<string, string | null>;
}

/**
 * Resolve a `provider/model` id to a registered model plus its credentials,
 * for harness callers that complete() directly instead of spawning a pi child.
 * Null on anything missing — callers fail open to their deterministic behavior.
 */
export async function resolveModelAuth(
	ctx: ExtensionContext,
	modelId: string,
): Promise<ResolvedModelAuth | null> {
	const parsed = parseModelSpec(modelId);
	const model = parsed
		? (ctx.modelRegistry.find(parsed.provider, parsed.modelId) as
				| Model<Api>
				| undefined)
		: undefined;
	if (!model) return null;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return null;
	return {
		model,
		apiKey: auth.apiKey,
		...(auth.headers ? { headers: auth.headers } : {}),
	};
}

export interface RoleModel {
	readonly modelId: string;
	readonly effort?: ThinkingLevel;
	readonly model: Model<Api>;
	readonly apiKey: string;
	readonly headers?: Record<string, string | null>;
	/** The record the router produced, for a footer or an audit line. */
	readonly resolution: ModelResolution;
}

/**
 * Resolve a maestro role to a concrete model + credentials: map the role to the
 * persona whose allowance governs it, resolve through the active roster/tier
 * (which appends the session seat as the known-good last resort), then
 * authenticate. For harness callers that `complete()` in-process (summariser,
 * command auditor, compaction) rather than spawning a pi child.
 *
 * Null on anything missing (no model, unauthenticated) — callers fail open to
 * their deterministic behavior.
 */
export async function resolveModelForRole(
	ctx: ExtensionContext,
	role: ModelRole,
	opts: { tier?: TierId } = {},
): Promise<RoleModel | null> {
	const resolution = modelRouterFor(ctx).resolveForRole(personaForRole(role), {
		...(opts.tier ? { tier: opts.tier } : {}),
	});
	if (!resolution?.modelId) return null;
	const auth = await resolveModelAuth(ctx, resolution.modelId);
	if (!auth) return null;
	return {
		modelId: resolution.modelId,
		...(resolution.effort ? { effort: resolution.effort } : {}),
		model: auth.model,
		apiKey: auth.apiKey as string,
		...(auth.headers ? { headers: auth.headers } : {}),
		resolution,
	};
}

export interface ModelMeta {
	/** Compact label for tables/cards, e.g. "fable-5", "opus-4-8". */
	readonly shortName: string;
	/**
	 * True when the model uses adaptive thinking (decides its own depth) rather
	 * than a fixed reasoning budget. Anthropic exposes this as
	 * `model.compat.forceAdaptiveThinking`; telemetry renders `A/<level>`.
	 */
	readonly adaptive: boolean;
}

/** Strip provider, the `claude-` prefix, and a trailing `-YYYYMMDD` date. */
export function shortModelName(modelId: string): string {
	const id = modelId.split("/").pop() ?? modelId;
	return id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

interface RegistryLike {
	find?: (
		provider: string,
		id: string,
	) => { compat?: { forceAdaptiveThinking?: boolean } } | undefined;
}

/**
 * Display metadata for a resolved model id — the short name and whether the
 * model uses adaptive thinking. Resolved once at spawn time (where a live
 * ExtensionContext is available) and stored on the run/agent view, so the pure
 * telemetry renderers can show `A/<level>` without a ctx.
 */
export function getModelMeta(
	ctx: ExtensionContext,
	modelId: string,
): ModelMeta {
	const [provider, ...rest] = modelId.split("/");
	const id = rest.join("/");
	const registry = (ctx as unknown as { modelRegistry?: RegistryLike })
		.modelRegistry;
	const model = registry?.find?.(provider, id);
	return {
		shortName: shortModelName(modelId),
		adaptive: Boolean(model?.compat?.forceAdaptiveThinking),
	};
}
