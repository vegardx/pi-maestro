// Which model an agent runs on.
//
// Until this existed, every agent inherited the seat's model. That is a
// defensible default and it is what happens still when no roster is configured
// — the resolver is deliberately dormant until one is — but it made two things
// impossible: a cheap model for cheap work, and a review that is a second
// OPINION rather than the same model asked twice.
//
// Routing is keyed by PERSONA, end to end: `code-review` wanting a heavy tier
// is a statement about the work, not about a posture. The allowances the
// models package reads are persona-keyed too, so the persona flows straight
// through — the interim persona→agent-type bridge that used to live here is
// gone with the vocabulary it bridged to.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@vegardx/pi-contracts";
import {
	defaultTierFor,
	directFor,
	type InheritedModel,
	type ModelResolution,
	resolveFamily,
	resolveModel,
	resolveModels,
	resolveOtherFamily,
	spreadFor,
} from "@vegardx/pi-models";

/** What a resolution comes to: a model, how hard it thinks, and its family. */
export interface RoutedModel {
	readonly modelId: string;
	readonly effort?: ThinkingLevel;
	/** The diversity axis. Two agents of one family are not two opinions. */
	readonly family?: string;
	/** Present when resolution degraded (tier exhausted, or an `other-family`
	 *  request with nowhere to go) — surfaced, never swallowed. */
	readonly fallbackReason?: string;
}

function asRouted(resolved: ModelResolution): RoutedModel {
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
 * The model this DIRECT (non-fanned) spawn should run on, or `undefined` to
 * inherit the caller's.
 *
 * `undefined` is not a failure. With no roster configured there is no tier to
 * draw from, and inheriting is the honest answer — the alternative would be
 * inventing a model nobody asked for. The same holds for a persona with no
 * allowance: routing stays dormant until someone configures it, which is the
 * models package's own documented intent.
 *
 * The allowance's `direct` selector is honored here: `other-family` picks the
 * first entry in the allowance's tiers whose family differs from the caller's
 * ("a reviewer never marks its own homework"), which needs `inherit` — without
 * it the resolver falls back with a reason rather than guessing whose homework
 * this is.
 */
export async function routeModel(
	ctx: ExtensionContext,
	persona: string,
	inherit?: InheritedModel,
): Promise<RoutedModel | undefined> {
	if (directFor(ctx, persona) === "other-family") {
		const resolved = await resolveOtherFamily(ctx, {
			persona,
			...(inherit ? { inherit } : {}),
		});
		return asRouted(resolved);
	}
	const tier = defaultTierFor(ctx, persona);
	if (!tier) return undefined;

	const resolved = await resolveModel(ctx, {
		persona,
		tier,
		...(inherit ? { inherit } : {}),
	});
	return asRouted(resolved);
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
 *
 * `direct` does not apply here: it selects for NON-fanned spawns, and a
 * fan-out already gets its diversity from the one-slot-per-family rule.
 */
export async function routeSpread(
	ctx: ExtensionContext,
	persona: string,
	inherit?: InheritedModel,
): Promise<readonly RoutedModel[]> {
	const tier = defaultTierFor(ctx, persona);
	const width = spreadFor(ctx, persona);
	if (!tier || width <= 1) {
		const single = await routeModel(ctx, persona, inherit);
		return single ? [single] : [];
	}

	const resolved = await resolveModels(
		ctx,
		{
			persona,
			tier,
			...(inherit ? { inherit } : {}),
		},
		width,
	);
	return resolved.map(asRouted);
}

/**
 * A NAMED family's model, resolved through the caller's binding and roster.
 *
 * This is the `family` parameter on the subagent tool: it is how a fan-out
 * lead starts one member per family its brief listed. The resolver throws on
 * an unknown or unavailable family, naming the families the persona's tiers
 * reach — the lookup is the guard, and there is deliberately no fallback: a
 * member requested as one family and run as another would be the fan-out
 * lying about its own diversity.
 */
export async function routeFamily(
	ctx: ExtensionContext,
	persona: string,
	family: string,
	inherit?: InheritedModel,
): Promise<RoutedModel> {
	const resolved = await resolveFamily(ctx, {
		persona,
		family,
		...(inherit ? { inherit } : {}),
	});
	return asRouted(resolved);
}

/**
 * The subagent tool's one routing entry: a request names at most one of
 * `family` (a member start — exactly that family, or a refusal) or `fanOut`
 * (the spread), and a bare request is a direct start. Kept here rather than
 * inlined at each wiring site because the seat and the agent runtime used to
 * carry identical copies of this dispatch, and two copies of a dispatch is
 * how one of them stops being wired.
 */
export async function routeSpawn(
	ctx: ExtensionContext,
	request: {
		readonly persona: string;
		readonly fanOut: boolean;
		readonly family?: string;
	},
): Promise<readonly RoutedModel[]> {
	if (request.family)
		return [await routeFamily(ctx, request.persona, request.family)];
	if (request.fanOut) return routeSpread(ctx, request.persona);
	const one = await routeModel(ctx, request.persona);
	return one ? [one] : [];
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
