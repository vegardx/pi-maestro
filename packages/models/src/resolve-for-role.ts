// Resolve a maestro role to a concrete model + credentials, the v2 way.
//
// The single replacement for the retired v1 `resolveExactModelSelection`: map
// the role to its v2 agent type, resolve through the active roster/tier
// (resolveV2Model — which appends the session seat as the known-good last
// resort), then authenticate. For harness callers that `complete()` in-process
// (summariser, debug reviser, compaction) rather than spawning a pi child.
//
// Null on anything missing (no model, unauthenticated) — callers fail open to
// their deterministic behavior, exactly as the v1 resolver's `selected: null`
// contract did.

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelRole, ThinkingLevel, TierId } from "@vegardx/pi-contracts";
import { resolveModelAuth } from "./model-auth.js";
import {
	agentTypeForRole,
	defaultTierForAgent,
	resolveV2Model,
} from "./v2-resolver.js";

export interface RoleModel {
	readonly modelId: string;
	readonly effort?: ThinkingLevel;
	readonly model: Model<Api>;
	readonly apiKey: string;
	readonly headers?: Record<string, string>;
}

export async function resolveModelForRole(
	ctx: ExtensionContext,
	role: ModelRole,
	opts: { tier?: TierId } = {},
): Promise<RoleModel | null> {
	const agent = agentTypeForRole(role);
	// The role's own tier (worker→standard, reviewer→heavy, …) — the same
	// mapping a plan node of this agent type spawns at. Without it the resolver
	// falls back to inheriting the seat for every role, collapsing v2 routing.
	const tier = opts.tier ?? defaultTierForAgent(ctx, agent);
	const seat = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	let modelId: string | undefined;
	let effort: ThinkingLevel | undefined;
	try {
		const resolved = await resolveV2Model(ctx, {
			agent,
			...(tier ? { tier } : {}),
			...(seat ? { inherit: { modelId: seat } } : {}),
		});
		modelId = resolved.modelId;
		effort = resolved.effort as ThinkingLevel | undefined;
	} catch {
		return null;
	}
	if (!modelId) return null;
	const auth = await resolveModelAuth(ctx, modelId);
	if (!auth) return null;
	return {
		modelId,
		...(effort ? { effort } : {}),
		model: auth.model,
		apiKey: auth.apiKey as string,
		...(auth.headers ? { headers: auth.headers } : {}),
	};
}
