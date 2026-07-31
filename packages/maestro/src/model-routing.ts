// Which model an agent runs on.
//
// Until this existed, every agent inherited the seat's model. That is a
// defensible default and it is what happens still when no roster is configured
// — the resolver is deliberately dormant until one is — but it made two things
// impossible: a cheap model for cheap work, and a review that is a second
// OPINION rather than the same model asked twice.
//
// Routing is keyed by PERSONA: `code-review` wanting a heavy tier is a
// statement about the work, not about a posture. The models package still
// keys its allowances by the old four agent types, so a bridge table below
// maps the built-in personas onto them until allowances re-key by persona.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SpawnableAgentType, ThinkingLevel } from "@vegardx/pi-contracts";
import {
	defaultTierForAgent,
	type InheritedModel,
	resolveModel,
	resolveModels,
	spreadForAgent,
} from "@vegardx/pi-models";
import {
	CODE_REVIEW,
	CODEBASE_RESEARCH,
	DELIVERABLE_WORKER,
	STANDBY,
} from "./personas.js";

/** What a resolution comes to: a model, how hard it thinks, and its family. */
export interface RoutedModel {
	readonly modelId: string;
	readonly effort?: ThinkingLevel;
	/** The diversity axis. Two agents of one family are not two opinions. */
	readonly family?: string;
	/** Present when the tier produced nothing and the seat was used instead. */
	readonly fallbackReason?: string;
}

/**
 * INTERIM until allowances re-key by persona: the models package still keys
 * allowances by the old agent types, so the built-in personas map onto them
 * here. A persona not in this table routes as `undefined` — inherit — because
 * a guessed tier for an unknown persona would be a model nobody asked for.
 */
const PERSONA_AGENT_TYPE: Readonly<Record<string, SpawnableAgentType>> = {
	[DELIVERABLE_WORKER]: "worker",
	[CODEBASE_RESEARCH]: "explorer",
	[CODE_REVIEW]: "reviewer",
	[STANDBY]: "advisor",
};

function asAgentType(persona: string): SpawnableAgentType | undefined {
	return PERSONA_AGENT_TYPE[persona];
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
	persona: string,
	inherit?: InheritedModel,
): Promise<RoutedModel | undefined> {
	const agent = asAgentType(persona);
	if (!agent) return undefined;
	const tier = defaultTierForAgent(ctx, agent);
	if (!tier) return undefined;

	const resolved = await resolveModel(ctx, {
		agent,
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
	persona: string,
	inherit?: InheritedModel,
): Promise<readonly RoutedModel[]> {
	const agent = asAgentType(persona);
	const tier = agent ? defaultTierForAgent(ctx, agent) : undefined;
	const width = agent ? spreadForAgent(ctx, agent) : 0;
	if (!agent || !tier || width <= 1) {
		const single = await routeModel(ctx, persona, inherit);
		return single ? [single] : [];
	}

	const resolved = await resolveModels(
		ctx,
		{
			agent,
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
