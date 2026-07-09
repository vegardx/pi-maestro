// Spawn-time model resolution for the deliverable executor.
// Resolves a tier (work/review/fast) to a concrete model via the active profile.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel, Tier } from "@vegardx/pi-contracts";
import {
	type ResolvedRoleModelFull,
	resolveTierModel,
} from "@vegardx/pi-models";

export interface SpawnModelRequest {
	/** Which tier to resolve (work for the implementer, review for reviewers, …). */
	tier: Tier;
	/** Thinking effort override. */
	effort?: ThinkingLevel;
}

export interface ResolvedSpawnModel {
	/** Provider/model-id string (e.g. "anthropic/claude-sonnet-4-20250514"). */
	modelId: string;
	/** Thinking effort to apply. */
	effort?: ThinkingLevel;
	/** API key for the resolved model. */
	apiKey?: string;
	/** Extra headers for the resolved model. */
	headers?: Record<string, string>;
}

/**
 * Resolve a model for spawning an agent at execution time. The tier resolves
 * through the active profile (pinned model, or tracking the session model when
 * the tier is unset). Effort from the request overrides the tier default.
 */
export async function resolveSpawnModel(
	ctx: ExtensionContext,
	request: SpawnModelRequest,
): Promise<ResolvedSpawnModel | null> {
	const result = await resolveTierModel(ctx, request.tier, {
		effort: request.effort,
	});
	if (!result) return null;

	return {
		modelId: result.modelId,
		effort: request.effort ?? result.effort,
		apiKey: result.apiKey,
		headers: result.headers,
	};
}

/**
 * Resolve with a hard 5s timeout. Returns null if resolution doesn't settle
 * (e.g. provider is unreachable for auth check).
 */
export async function resolveSpawnModelSafe(
	ctx: ExtensionContext,
	request: SpawnModelRequest,
): Promise<ResolvedSpawnModel | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), 5_000);
		timer.unref?.();
	});
	try {
		return await Promise.race([resolveSpawnModel(ctx, request), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export type { ResolvedRoleModelFull };
