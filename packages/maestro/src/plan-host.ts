// The Pi side of `PlanHostPort`: the two questions a pinned review answers.
//
// A review may pin a `model` and a `skill`, and neither is a claim about the
// document — one names a model this machine either has or does not, the other
// names a skill Pi either loaded or did not. `inspectPlan` asks them through a
// port so it stays pure; this module is the only place that knows the port's
// answers come from a live Pi session.
//
// TWO SOURCES, BECAUSE PI HAS TWO. Models come from the session's
// `ModelCatalogPort` over `ctx.modelRegistry` — the same seam the model router
// resolves through, so the plan is checked against exactly the catalogue a run
// would route in. Skills are not on `ExtensionContext` at all: the resource
// loader that holds them (`ResourceLoader.getSkills()`) is a session field, and
// what an extension is given is `ExtensionAPI.getCommands()`, which reports
// every loaded skill as a command with `source: "skill"` and a `skill:`-
// prefixed name.
//
// EVERY ANSWER FAILS CLOSED. A stale context throws from its own session, and
// a Pi that does not implement `getCommands` answers nothing; both come back as
// "no such model" and "no skills loaded", which refuses the pin rather than
// accepting it unchecked. That is the same direction `inspectPlan` takes when
// there is no host at all.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelCatalogPort } from "./model-router.js";
import type { PlanHostPort } from "./plan.js";

/** How Pi names a loaded skill among its commands. */
export const SKILL_COMMAND_PREFIX = "skill:";

/**
 * The `getCommands` slice of `ExtensionAPI`, and nothing else.
 *
 * Declared here rather than imported so a test can answer it with a literal,
 * and optional because a host that does not offer the method is a host with no
 * skills to name — not a crash while a plan is being validated.
 */
export interface SkillHost {
	getCommands?: () => readonly {
		readonly name: string;
		readonly source: string;
	}[];
}

/** Every skill Pi has loaded in this session, by the name a plan would pin. */
export function loadedSkillNames(host: SkillHost): string[] {
	let commands: readonly { name: string; source: string }[] = [];
	try {
		commands = host.getCommands?.() ?? [];
	} catch {
		// A replaced session throws from its own context. Nothing is loaded as
		// far as this plan is concerned, which is the refusing answer.
		return [];
	}
	return commands
		.filter((command) => command.source === "skill")
		.map((command) =>
			command.name.startsWith(SKILL_COMMAND_PREFIX)
				? command.name.slice(SKILL_COMMAND_PREFIX.length)
				: command.name,
		);
}

/**
 * The port for this session, or nothing when there is no session to ask.
 *
 * `undefined` is deliberate and is not the same as an empty host: it is what
 * makes `inspectPlan` refuse a pinned model or skill by name for want of
 * anything to check it against, instead of quietly accepting it.
 */
export function planHostPort(
	ctx: ExtensionContext | undefined,
	skills: SkillHost,
): PlanHostPort | undefined {
	if (!ctx) return undefined;
	return {
		hasModel: (provider, id) => {
			try {
				return modelCatalogPort(ctx).findModel(provider, id) !== undefined;
			} catch {
				return false;
			}
		},
		registeredProviders: () => {
			try {
				return modelCatalogPort(ctx).registeredProviders();
			} catch {
				return [];
			}
		},
		loadedSkills: () => loadedSkillNames(skills),
	};
}
