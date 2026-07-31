// Resolve a maestro role to a concrete model + credentials, the v2 way.
//
// The single replacement for the retired v1 `resolveExactModelSelection`: map
// the role to the persona whose allowance governs it, resolve through the
// active roster/tier (resolveModel — which appends the session seat as the
// known-good last resort), then authenticate. For harness callers that
// `complete()` in-process (summariser, debug reviser, compaction) rather than
// spawning a pi child.
//
// Null on anything missing (no model, unauthenticated) — callers fail open to
// their deterministic behavior, exactly as the v1 resolver's `selected: null`
// contract did.

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelRole, ThinkingLevel, TierId } from "@vegardx/pi-contracts";
import { resolveModelAuth } from "./model-auth.js";
import { defaultTierFor, personaForRole, resolveModel } from "./resolver.js";

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
	const persona = personaForRole(role);
	// The persona's own tier (deliverable-worker→standard, code-review→heavy, …)
	// — the same tier a spawn of that persona resolves at. Without it the
	// resolver falls back to inheriting the seat for every role, collapsing v2
	// routing.
	const tier = opts.tier ?? defaultTierFor(ctx, persona);
	const seat = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	let modelId: string | undefined;
	let effort: ThinkingLevel | undefined;
	try {
		const resolved = await resolveModel(ctx, {
			persona,
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
