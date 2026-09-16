// The host seam. @vegardx/pi-models knows families, rosters, tiers and regions;
// it knows nothing about Pi, its extension context, or its model registry. The
// three questions it has to ask a host are declared here, and a host answers
// them however it likes — from `ctx.modelRegistry`, from a fixture, from a
// static table in a test.
//
// Every member is synchronous. Resolution happens inside a materializer, a
// declaration, or a footer render, none of which can await a network round
// trip per candidate attachment; a host whose answers are expensive caches them
// when it builds the port.

import type { ThinkingLevel } from "./thinking.js";

/**
 * What the router needs to know about one concrete model. Structural on
 * purpose: Pi's `Model<Api>` satisfies it, and so does a three-key object
 * literal in a test.
 */
export interface CatalogModel {
	/** False when the model does no reasoning at all; only `off` is supported. */
	readonly reasoning?: boolean;
	/** Pi's level map; a `null` entry means the level is explicitly unsupported. */
	readonly thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

/**
 * The host's answers about its own model catalogue. Nothing here reasons: the
 * router asks whether a `provider/id` exists and whether its provider has
 * credentials, and applies its own region, roster and allowance rules on top.
 */
export interface ModelCatalogPort {
	/** The registered model, or undefined when the host does not have it. */
	findModel(provider: string, id: string): CatalogModel | undefined;
	/** Whether the host holds usable credentials for `provider`. */
	isAuthenticated(provider: string): boolean;
	/** Every provider id the host has registered, for teaching refusals. */
	registeredProviders(): readonly string[];
}

/**
 * A port that knows nothing: every model is unregistered. Useful as the
 * explicit "no host" case — resolution then degrades to the seat with a
 * `fallbackReason`, which is the documented never-fail-open behaviour.
 */
export const EMPTY_CATALOG_PORT: ModelCatalogPort = Object.freeze({
	findModel: () => undefined,
	isAuthenticated: () => false,
	registeredProviders: () => Object.freeze([]) as readonly string[],
});
