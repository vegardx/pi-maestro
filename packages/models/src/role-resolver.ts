// Tier-based role-model resolver.
//
// Resolves a model + effort level for a named extension role. Each role maps to a
// tier (the caller passes `opts.tier`); the tier resolves through the active
// profile. Resolution priority (high → low):
//
//   1. opts.explicit       — per-invocation override (CLI arg)
//   2. opts.env            — per-session override (env var)
//   3. extensionConfig.<ext>.models.<role>.model — per-role escape hatch
//   4. the role's TIER, resolved through the active profile (or tracking plan)
//   5. null                — feature disabled (no session model to fall back to)

import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	ResolvedRoleModel,
	RoleModelConfig,
	ThinkingLevel,
	Tier,
} from "@vegardx/pi-contracts";
import {
	type ExtensionConfigMap,
	getConfigObject,
	readLayeredExtensionConfig,
} from "@vegardx/pi-settings";
import { readModelsConfig, resolveTierConfig } from "./profiles.js";
import { parseModelSpec } from "./resolver.js";

// ─── Public types ────────────────────────────────────────────────────────────

export interface RoleResolveOptions {
	/** Extension short name (e.g. "modes", "smart-compact"). */
	extension: string;
	/** Role within the extension (e.g. "agent", "analyze"). */
	role: string;
	/** Tier this role resolves through the active profile. Defaults to "work". */
	tier?: Tier;
	/** Highest-priority override — typically from a CLI arg. */
	explicit?: { model?: string; effort?: ThinkingLevel };
	/** Second-priority override — typically from an env var. */
	env?: { model?: string; effort?: ThinkingLevel };
	/** Skip candidates whose auth is ok but yields no apiKey. */
	requireApiKey?: boolean;
}

export interface ResolvedRoleModelFull extends ResolvedRoleModel {
	/** The resolved pi Model object (with provider/id). */
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
}

// ─── Validation ──────────────────────────────────────────────────────────────

const EFFORT_LEVELS: ReadonlySet<string> = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);

/**
 * Validate a raw object as a RoleModelConfig. Returns undefined if the shape
 * is invalid (fail-closed: invalid config is skipped, not errored).
 */
export function validateRoleModelConfig(
	raw: Record<string, unknown>,
): RoleModelConfig | undefined {
	const model =
		typeof raw.model === "string" && raw.model.length > 0
			? raw.model
			: undefined;
	const effort =
		typeof raw.effort === "string" && EFFORT_LEVELS.has(raw.effort)
			? (raw.effort as ThinkingLevel)
			: undefined;

	if (!model && !effort) return undefined;
	return { model, effort };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function lookup(ctx: ExtensionContext, spec: string): Model<Api> | undefined {
	const parsed = parseModelSpec(spec);
	if (!parsed) return undefined;
	return ctx.modelRegistry.find(parsed.provider, parsed.modelId);
}

async function tryAuth(
	ctx: ExtensionContext,
	spec: string,
	requireApiKey?: boolean,
): Promise<{
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
} | null> {
	const model = lookup(ctx, spec);
	if (!model) return null;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return null;
	if (requireApiKey && !auth.apiKey) return null;
	return { model, apiKey: auth.apiKey, headers: auth.headers };
}

function sessionModelId(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function readRoleConfig(
	merged: ExtensionConfigMap,
	extension: string,
	role: string,
): RoleModelConfig | undefined {
	const raw = getConfigObject(merged, extension, `models.${role}`);
	if (!raw) return undefined;
	return validateRoleModelConfig(raw);
}

/**
 * Resolve a tier directly to a model, with auth — regardless of any role config.
 * Use when you want "the review tier model" for a spawn (workers, reviewers,
 * advisor). Returns null when the tier can't resolve (no session model) or auth
 * fails.
 */
export async function resolveTierModel(
	ctx: ExtensionContext,
	tier: Tier,
	opts?: { effort?: ThinkingLevel; requireApiKey?: boolean },
): Promise<ResolvedRoleModelFull | null> {
	const cfg = readModelsConfig(ctx.cwd);
	const resolution = resolveTierConfig(cfg, tier, session(ctx));
	if (!resolution) return null;
	const result = await tryAuth(ctx, resolution.modelId, opts?.requireApiKey);
	if (!result) return null;
	return {
		...result,
		modelId: resolution.modelId,
		effort: opts?.effort ?? resolution.effort,
		source: resolution.tracksPlan ? "session" : "profile",
		profile: resolution.profile,
		tier,
	};
}

function session(
	ctx: ExtensionContext,
): { modelId: string; effort?: ThinkingLevel } | undefined {
	const modelId = sessionModelId(ctx);
	return modelId ? { modelId } : undefined;
}

// ─── Main resolver ───────────────────────────────────────────────────────────

/**
 * Resolve a model + effort level for a named extension role.
 * Returns null when no model can be resolved (feature should be disabled).
 */
export async function resolveRoleModel(
	ctx: ExtensionContext,
	opts: RoleResolveOptions,
): Promise<ResolvedRoleModelFull | null> {
	const { extension, role, requireApiKey } = opts;
	const tier: Tier = opts.tier ?? "work";

	// Priority 1: explicit override (CLI arg)
	if (opts.explicit?.model) {
		const result = await tryAuth(ctx, opts.explicit.model, requireApiKey);
		if (result) {
			return {
				...result,
				modelId: opts.explicit.model,
				effort: opts.explicit.effort,
				source: "explicit",
			};
		}
	}

	// Priority 2: env var override
	if (opts.env?.model) {
		const result = await tryAuth(ctx, opts.env.model, requireApiKey);
		if (result) {
			return {
				...result,
				modelId: opts.env.model,
				effort: opts.env.effort,
				source: "env",
			};
		}
	}

	// Priority 3: per-role escape hatch (extensionConfig.<ext>.models.<role>.model)
	const { merged } = readLayeredExtensionConfig(ctx.cwd);
	const roleConfig = readRoleConfig(merged, extension, role);
	if (roleConfig?.model) {
		const result = await tryAuth(ctx, roleConfig.model, requireApiKey);
		if (result) {
			return {
				...result,
				modelId: roleConfig.model,
				effort: roleConfig.effort ?? opts.env?.effort,
				source: "profile",
			};
		}
	}

	// Priority 4: the role's TIER, resolved through the active profile.
	const cfg = readModelsConfig(ctx.cwd);
	const resolution = resolveTierConfig(cfg, tier, session(ctx));
	if (resolution) {
		const result = await tryAuth(ctx, resolution.modelId, requireApiKey);
		if (result) {
			return {
				...result,
				modelId: resolution.modelId,
				effort: roleConfig?.effort ?? resolution.effort ?? opts.env?.effort,
				source: resolution.tracksPlan ? "session" : "profile",
				profile: resolution.profile,
				tier,
			};
		}
	}

	// Priority 5: bare session model (covers a role-config effort-only override).
	if (ctx.model) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (auth.ok && (!requireApiKey || auth.apiKey)) {
			return {
				model: ctx.model,
				modelId: `${ctx.model.provider}/${ctx.model.id}`,
				effort: roleConfig?.effort ?? opts.env?.effort ?? opts.explicit?.effort,
				source: "session",
				apiKey: auth.apiKey,
				headers: auth.headers,
			};
		}
	}

	return null;
}

/** resolveRoleModel with a hard timeout; returns null if it doesn't settle. */
export async function resolveRoleModelWithin(
	ctx: ExtensionContext,
	opts: RoleResolveOptions,
	timeoutMs: number,
): Promise<ResolvedRoleModelFull | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), timeoutMs);
		timer.unref?.();
	});
	try {
		return await Promise.race([resolveRoleModel(ctx, opts), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
