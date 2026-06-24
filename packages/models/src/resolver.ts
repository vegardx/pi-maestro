// Background-model resolver. Extensions call this for any side-task LLM work
// (auto-titles, ghost-text, subagent review). Resolution order (high → low):
//
//   1. opts.explicit              — caller override (CLI flag, command).
//   2. extensionConfig.<name>.model — full "provider/id" escape hatch.
//   3. backgroundModels.<set>.<tier> — the user's tier mapping (with the
//      secondary→primary fallback).
//   4. ctx.model                  — the active session model (always has auth).
//   5. null                       — caller disables the feature this session.
//
// No hard-coded provider/model ids.

import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getConfigString,
	readLayeredExtensionConfig,
} from "@vegardx/pi-settings";
import { getTierModel, readBackgroundModels } from "./background.js";
import type { BackgroundSet, Tier } from "./types.js";

export interface ResolvedBackgroundModel {
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
}

export interface ResolveOptions {
	/** Extension short name; keys extensionConfig.<name>.model. */
	name: string;
	tier: Tier;
	/** Which set to read; secondary falls back to primary per tier. */
	set?: BackgroundSet;
	/** Highest-precedence override, "provider/id". */
	explicit?: string;
	/** Skip candidates whose auth is ok but yields no apiKey. */
	requireApiKey?: boolean;
}

/** Parse "provider/id"; null unless it splits into two non-empty sides. */
export function parseModelSpec(
	spec: string,
): { provider: string; modelId: string } | null {
	const idx = spec.indexOf("/");
	if (idx <= 0 || idx === spec.length - 1) return null;
	return { provider: spec.slice(0, idx), modelId: spec.slice(idx + 1) };
}

function lookup(ctx: ExtensionContext, spec: string): Model<Api> | undefined {
	const parsed = parseModelSpec(spec);
	if (!parsed) return undefined;
	return ctx.modelRegistry.find(parsed.provider, parsed.modelId);
}

export async function resolveModel(
	ctx: ExtensionContext,
	opts: ResolveOptions,
): Promise<ResolvedBackgroundModel | null> {
	const set: BackgroundSet = opts.set ?? "primary";
	const { merged } = readLayeredExtensionConfig(ctx.cwd);
	const background = readBackgroundModels(ctx.cwd);

	const candidates: Array<string | undefined> = [
		opts.explicit,
		getConfigString(merged, opts.name, "model", "") || undefined,
		getTierModel(background, opts.tier, set),
	];

	for (const spec of candidates) {
		if (!spec) continue;
		const model = lookup(ctx, spec);
		if (!model) continue;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) continue;
		if (opts.requireApiKey && !auth.apiKey) continue;
		return { model, apiKey: auth.apiKey, headers: auth.headers };
	}

	if (ctx.model) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (auth.ok && (!opts.requireApiKey || auth.apiKey)) {
			return { model: ctx.model, apiKey: auth.apiKey, headers: auth.headers };
		}
	}

	return null;
}

/** resolveModel with a hard timeout; returns null if it doesn't settle. */
export async function resolveModelWithin(
	ctx: ExtensionContext,
	opts: ResolveOptions,
	timeoutMs: number,
): Promise<ResolvedBackgroundModel | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), timeoutMs);
		timer.unref?.();
	});
	try {
		return await Promise.race([resolveModel(ctx, opts), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
