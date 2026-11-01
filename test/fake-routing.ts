// The seat's routing, as the admission and routing providers ask about it.
//
// A REAL ROUTER over a fixture catalogue, never a stub of one: both providers
// answer with the router's own `isAuthorized` and `resolveForRole`, and a stub
// that agreed with whatever a test expected would prove nothing about the
// fence or the walk. Shared by both suites because a second fixture would be a
// second opinion about what the seat has.

import {
	type CatalogModel,
	createModelRouter,
	parseModelsSettings,
	type ThinkingLevel,
} from "@vegardx/pi-models";
import type { SeatRouting } from "../packages/maestro/src/model-router.js";

export const SEAT = "anthropic/opus";
export const LIGHT = "anthropic/haiku";
export const OTHER_NORMAL = "openai/sol";
export const OTHER_FRONTIER = "openai/sol-pro";
/** Registered and authenticated, and attached to no alias. */
export const LOOSE = "openai/plain";
/** A model that does no reasoning: `off` is the only level it runs at. */
export const FLAT = "openai/flat";
/** A reasoning model whose level map names `max` and not `xhigh`. */
export const MAX_ONLY = "anthropic/max-only";

export const MODELS_BLOCK = {
	families: {
		Anthropic: {
			aliases: {
				Opus: { attach: [SEAT] },
				Haiku: { attach: [LIGHT], effort: "low" },
			},
		},
		OpenAI: {
			aliases: {
				Sol: { attach: [OTHER_NORMAL] },
				SolPro: { attach: [OTHER_FRONTIER], effort: "high" },
			},
		},
	},
	rosters: {
		r: {
			fast: ["Anthropic/Haiku"],
			light: ["Anthropic/Haiku"],
			normal: ["Anthropic/Opus", "OpenAI/Sol"],
			frontier: ["Anthropic/Opus", "OpenAI/SolPro"],
		},
	},
	bindings: { r: { roster: "r" } },
} as const;

const CATALOG: Readonly<Record<string, CatalogModel>> = {
	[SEAT]: { reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
	[LIGHT]: { reasoning: true },
	[OTHER_NORMAL]: { reasoning: true },
	[OTHER_FRONTIER]: { reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
	[LOOSE]: { reasoning: true },
	[FLAT]: { reasoning: false },
	[MAX_ONLY]: { reasoning: true, thinkingLevelMap: { max: "max" } },
};

export interface FakeRoutingOptions {
	/** The `models` settings block; `null` for a seat with none configured. */
	readonly models?: Record<string, unknown> | null;
	readonly seat?: string;
	readonly effort?: ThinkingLevel;
	/** Providers with credentials. Defaults to every provider in the catalogue. */
	readonly authenticated?: readonly string[];
}

function split(ref: string): { provider: string; id: string } {
	const slash = ref.indexOf("/");
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

/** The seat a test describes, routed by the real router. */
export function fakeRouting(options: FakeRoutingOptions = {}): SeatRouting {
	const seat = options.seat ?? SEAT;
	const models =
		options.models === null
			? undefined
			: parseModelsSettings({ models: options.models ?? MODELS_BLOCK }, {});
	const providers = [
		...new Set(Object.keys(CATALOG).map((ref) => split(ref).provider)),
	];
	const authenticated = options.authenticated ?? providers;
	const catalog = {
		findModel: (provider: string, id: string) => CATALOG[`${provider}/${id}`],
		isAuthenticated: (provider: string) => authenticated.includes(provider),
		registeredProviders: () => providers,
	};
	return {
		router: createModelRouter(
			{
				...(models ? { models } : {}),
				seat,
				...(options.effort ? { seatEffort: options.effort } : {}),
			},
			catalog,
		),
		catalog,
		seat: {
			modelId: seat,
			...(options.effort ? { effort: options.effort } : {}),
		},
	};
}

export function exact(
	ref: string,
	thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
) {
	return { ...split(ref), thinking };
}
