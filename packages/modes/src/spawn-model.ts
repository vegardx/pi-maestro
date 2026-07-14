// Spawn-time model resolution for model-consuming runtimes.
// Authenticates exact choices against the active ordered role pool.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	ModelRole,
	ThinkingLevel,
} from "@vegardx/pi-contracts";
import {
	type ResolvedRoleModelFull,
	resolveRolePool,
} from "@vegardx/pi-models";

export interface SpawnModelRequest {
	/** Curated policy role whose ordered pool constrains this spawn. */
	role: ModelRole;
	/** Optional exact authored model choice (must be in and available from the pool). */
	model?: string;
	/** Optional exact authored effort choice. */
	effort?: ThinkingLevel;
	/** Exclude candidates without an API key. */
	requireApiKey?: boolean;
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
	/** Resolution metadata retained for telemetry and diagnostics. */
	resolved: ResolvedRoleModelFull;
}

export class SpawnModelResolutionError extends Error {
	constructor(
		readonly request: SpawnModelRequest,
		readonly reasons: readonly string[],
	) {
		super(
			`No policy-compatible ${request.role} model resolved: ${reasons.join("; ") || "no model available"}`,
		);
		this.name = "SpawnModelResolutionError";
	}
}

/** Resolve an authenticated exact/default selection from a direct role pool. */
export async function resolveSpawnModel(
	ctx: ExtensionContext,
	request: SpawnModelRequest,
): Promise<ResolvedSpawnModel> {
	const resolution = await resolveRolePool(ctx, {
		role: request.role,
		choice:
			request.model || request.effort
				? { model: request.model, effort: request.effort }
				: undefined,
		requireApiKey: request.requireApiKey,
	});
	const result = resolution.selected;
	if (!result) {
		throw new SpawnModelResolutionError(
			request,
			resolution.errors.map((item) => item.message),
		);
	}

	return {
		modelId: result.modelId,
		effort: result.effort,
		apiKey: result.apiKey,
		headers: result.headers,
		resolved: result,
	};
}

/** Resolve with a hard 5s timeout while preserving visible policy failures. */
export async function resolveSpawnModelSafe(
	ctx: ExtensionContext,
	request: SpawnModelRequest,
): Promise<ResolvedSpawnModel> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new SpawnModelResolutionError(request, ["resolution timed out after 5s"]),
				),
			5_000,
		);
		timer.unref?.();
	});
	try {
		return await Promise.race([resolveSpawnModel(ctx, request), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export type { ResolvedRoleModelFull };
