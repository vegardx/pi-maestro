// Preset-based role-model resolver.
//
// Resolves a model + thinking level for a named extension role using the
// preset system. Resolution priority (high → low):
//
//   1. opts.explicit       — per-invocation override (CLI arg)
//   2. opts.env            — per-session override (env var)
//   3. extensionConfig.<ext>.models.<role> from settings:
//      a. role.model (explicit provider/id) → try auth
//      b. role.tier  → resolve preset → walk fallback array
//   4. ctx.model           — active session model
//   5. null                — feature disabled
//
// The fallback array per tier is walked in order; the first model with valid
// auth wins. This handles provider diversity and key availability gracefully.

import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	ResolvedRoleModel,
	RoleModelConfig,
	ThinkingLevel,
	Tier,
} from "@vegardx/pi-contracts";
import { TIERS } from "@vegardx/pi-contracts";
import {
	type ExtensionConfigMap,
	getConfigObject,
	readLayeredExtensionConfig,
} from "@vegardx/pi-settings";
import { readModelsConfig } from "./presets.js";
import { parseModelSpec } from "./resolver.js";

// ─── Public types ────────────────────────────────────────────────────────────

export interface RoleResolveOptions {
	/** Extension short name (e.g. "modes", "smart-compact"). */
	extension: string;
	/** Role within the extension (e.g. "worker", "analyze"). */
	role: string;
	/** Highest-priority override — typically from a CLI arg. */
	explicit?: { model?: string; thinking?: ThinkingLevel };
	/** Second-priority override — typically from an env var. */
	env?: { model?: string; thinking?: ThinkingLevel };
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

const THINKING_LEVELS: ReadonlySet<string> = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
]);
const TIER_SET: ReadonlySet<string> = new Set(TIERS);

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
	const tier =
		typeof raw.tier === "string" && TIER_SET.has(raw.tier)
			? (raw.tier as Tier)
			: undefined;
	const preset =
		typeof raw.preset === "string" && raw.preset.length > 0
			? raw.preset
			: undefined;
	const thinking =
		typeof raw.thinking === "string" && THINKING_LEVELS.has(raw.thinking)
			? (raw.thinking as ThinkingLevel)
			: undefined;

	// Mutual exclusion: model and tier can't both be set
	if (model && tier) return undefined;
	// At least one of model or tier must be present for the config to be useful
	if (!model && !tier) {
		// But thinking-only config is valid (inherits model from elsewhere)
		if (thinking) return { thinking };
		return undefined;
	}

	return { model, tier, preset, thinking };
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

function readRoleConfig(
	merged: ExtensionConfigMap,
	extension: string,
	role: string,
): RoleModelConfig | undefined {
	const raw = getConfigObject(merged, extension, `models.${role}`);
	if (!raw) return undefined;
	return validateRoleModelConfig(raw);
}

// ─── Main resolver ───────────────────────────────────────────────────────────

/**
 * Resolve a model + thinking level for a named extension role.
 * Returns null when no model can be resolved (feature should be disabled).
 */
export async function resolveRoleModel(
	ctx: ExtensionContext,
	opts: RoleResolveOptions,
): Promise<ResolvedRoleModelFull | null> {
	const { extension, role, requireApiKey } = opts;

	// Priority 1: explicit override (CLI arg)
	if (opts.explicit?.model) {
		const result = await tryAuth(ctx, opts.explicit.model, requireApiKey);
		if (result) {
			return {
				...result,
				modelId: opts.explicit.model,
				thinking: opts.explicit.thinking,
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
				thinking: opts.env.thinking,
				source: "env",
			};
		}
	}

	// Priority 3: settings (extensionConfig.<ext>.models.<role>)
	const { merged } = readLayeredExtensionConfig(ctx.cwd);
	const roleConfig = readRoleConfig(merged, extension, role);

	if (roleConfig) {
		// 3a: explicit model on the role config
		if (roleConfig.model) {
			const result = await tryAuth(ctx, roleConfig.model, requireApiKey);
			if (result) {
				return {
					...result,
					modelId: roleConfig.model,
					thinking: roleConfig.thinking ?? opts.env?.thinking,
					source: "preset",
				};
			}
		}

		// 3b: tier-based resolution via presets
		if (roleConfig.tier) {
			const modelsConfig = readModelsConfig(ctx.cwd);
			if (modelsConfig) {
				const presetName = roleConfig.preset ?? modelsConfig.active;
				const preset = modelsConfig.presets[presetName];
				const tierEntry = preset?.[roleConfig.tier];

				if (tierEntry) {
					const result = await tryAuth(ctx, tierEntry.model, requireApiKey);
					if (result) {
						return {
							...result,
							modelId: tierEntry.model,
							thinking:
								roleConfig.thinking ?? tierEntry.effort ?? opts.env?.thinking,
							source: "preset",
							preset: presetName,
							tier: roleConfig.tier,
						};
					}
				}
			}
		}

		// Role config has only thinking (no model/tier) — continue to session
		// but carry the thinking level forward
		if (roleConfig.thinking && !roleConfig.model && !roleConfig.tier) {
			if (ctx.model) {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
				if (auth.ok && (!requireApiKey || auth.apiKey)) {
					return {
						model: ctx.model,
						modelId: `${ctx.model.provider}/${ctx.model.id}`,
						thinking: roleConfig.thinking,
						source: "session",
						apiKey: auth.apiKey,
						headers: auth.headers,
					};
				}
			}
		}
	}

	// Priority 4: session model fallback
	if (ctx.model) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (auth.ok && (!requireApiKey || auth.apiKey)) {
			return {
				model: ctx.model,
				modelId: `${ctx.model.provider}/${ctx.model.id}`,
				thinking: opts.env?.thinking ?? opts.explicit?.thinking,
				source: "session",
				apiKey: auth.apiKey,
				headers: auth.headers,
			};
		}
	}

	// Nothing resolved
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
