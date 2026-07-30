// Which model an agent runs on.
//
// Until this existed, every agent inherited the seat's model. That is a
// defensible default and it is what happens still when no roster is configured
// — the resolver is deliberately dormant until one is — but it made two things
// impossible: a cheap model for cheap work, and a review that is a second
// OPINION rather than the same model asked twice.
//
// The four spawnable kinds here are the four the models package already routes
// for. `SPAWNABLE_AGENT_TYPES` is worker, explorer, reviewer, advisor, which is
// this system's agent kinds minus the maestro — the one that is never spawned.
// Nothing had to be converted, which is the useful kind of coincidence: two
// designs that arrived at the same axis separately.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SpawnableAgentType, ThinkingLevel } from "@vegardx/pi-contracts";
import {
	defaultTierForAgent,
	type InheritedModel,
	resolveModel,
	resolveModels,
	spreadForAgent,
} from "@vegardx/pi-models";
import type { AgentKind } from "./agent.js";

/** What a resolution comes to: a model, how hard it thinks, and its family. */
export interface RoutedModel {
	readonly modelId: string;
	readonly effort?: ThinkingLevel;
	/** The diversity axis. Two agents of one family are not two opinions. */
	readonly family?: string;
	/** Present when the tier produced nothing and the seat was used instead. */
	readonly fallbackReason?: string;
}

/** Every agent kind but the maestro, which is never spawned. */
export type RoutableKind = Exclude<AgentKind, "maestro">;

function asAgentType(kind: RoutableKind): SpawnableAgentType {
	return kind;
}

/**
 * The model this kind should run on, or `undefined` to inherit the caller's.
 *
 * `undefined` is not a failure. With no roster configured there is no tier to
 * draw from, and inheriting is the honest answer — the alternative would be
 * inventing a model nobody asked for. Routing stays dormant until someone
 * configures it, which is the models package's own documented intent.
 */
export async function routeModel(
	ctx: ExtensionContext,
	kind: RoutableKind,
	inherit?: InheritedModel,
): Promise<RoutedModel | undefined> {
	const tier = defaultTierForAgent(ctx, asAgentType(kind));
	if (!tier) return undefined;

	const resolved = await resolveModel(ctx, {
		agent: asAgentType(kind),
		tier,
		...(inherit ? { inherit } : {}),
	});
	return {
		modelId: resolved.modelId,
		...(resolved.effort ? { effort: resolved.effort } : {}),
		...(resolved.family ? { family: resolved.family } : {}),
		...(resolved.fallbackReason
			? { fallbackReason: resolved.fallbackReason }
			: {}),
	};
}

/**
 * Several models for one question, one per family.
 *
 * This is what makes a fan-out a fan-out. The resolver takes one slot per
 * family on purpose: a tier may list several aliases of the same family, and
 * two aliases of one family are not a second opinion. When every alias is
 * unavailable it degrades to ONE seat resolution rather than n copies of the
 * seat — a fan-out that looks diverse and is not is worse than admitting there
 * was only one model to ask.
 */
export async function routeSpread(
	ctx: ExtensionContext,
	kind: RoutableKind,
	inherit?: InheritedModel,
): Promise<readonly RoutedModel[]> {
	const tier = defaultTierForAgent(ctx, asAgentType(kind));
	const width = spreadForAgent(ctx, asAgentType(kind));
	if (!tier || width <= 1) {
		const single = await routeModel(ctx, kind, inherit);
		return single ? [single] : [];
	}

	const resolved = await resolveModels(
		ctx,
		{
			agent: asAgentType(kind),
			tier,
			...(inherit ? { inherit } : {}),
		},
		width,
	);
	return resolved.map((one) => ({
		modelId: one.modelId,
		...(one.effort ? { effort: one.effort } : {}),
		...(one.family ? { family: one.family } : {}),
		...(one.fallbackReason ? { fallbackReason: one.fallbackReason } : {}),
	}));
}

/**
 * How many distinct families a spread actually reached.
 *
 * Reported rather than assumed. A caller that asked for three opinions and got
 * one should be told so, because "three reviewers agreed" means nothing if they
 * were the same model — and that is precisely the sort of claim this system has
 * made before.
 */
export function familiesIn(models: readonly RoutedModel[]): number {
	return new Set(models.map((m) => m.family).filter(Boolean)).size;
}
