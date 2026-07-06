// Spawn-time model resolution for the group executor.
// Maps (slot, effort) from an AgentSpec/WorkerSpec to a concrete model
// via the preset system.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelSlot, ThinkingLevel } from "@vegardx/pi-contracts";
import {
	type ResolvedRoleModelFull,
	resolveRoleModel,
} from "@vegardx/pi-models";

export interface SpawnModelRequest {
	/** Model slot from the agent/worker spec. */
	slot: ModelSlot;
	/** Thinking effort from the agent/worker spec. */
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
 * Resolve a model for spawning an agent at execution time.
 *
 * Uses the preset system: the slot maps to the preset's default/alternate
 * entry. Effort overrides the preset's default effort if specified.
 *
 * Falls back to the session model if preset resolution fails.
 */
export async function resolveSpawnModel(
	ctx: ExtensionContext,
	request: SpawnModelRequest,
): Promise<ResolvedSpawnModel | null> {
	const result = await resolveRoleModel(ctx, {
		extension: "modes",
		role: slotToRole(request.slot),
		explicit: request.effort ? { effort: request.effort } : undefined,
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

// Map our ModelSlot to the role the resolver uses for settings lookup.
function slotToRole(slot: ModelSlot): string {
	return slot === "alternate" ? "agent-alternate" : "agent";
}

export type { ResolvedRoleModelFull };
