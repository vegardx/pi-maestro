// Random agent names: adjective-noun pairs, unique per session, non-deterministic.

import { randomInt } from "node:crypto";

const adjectives = [
	"swift",
	"bold",
	"calm",
	"bright",
	"eager",
	"gentle",
	"keen",
	"lively",
	"neat",
	"quick",
	"sharp",
	"steady",
	"warm",
	"witty",
	"vivid",
	"crisp",
	"deft",
	"fair",
	"grand",
	"agile",
	"prime",
	"lucid",
	"fierce",
	"subtle",
	"sparse",
	"terse",
	"brisk",
	"quiet",
	"slick",
	"snug",
	"stark",
	"dry",
	"raw",
	"deep",
	"lean",
	"dense",
	"flat",
	"cool",
	"fresh",
	"glad",
	"pale",
	"soft",
	"thin",
	"wide",
	"dark",
	"lite",
	"pure",
	"rare",
];

const nouns = [
	"falcon",
	"panda",
	"tiger",
	"whale",
	"eagle",
	"fox",
	"wolf",
	"raven",
	"otter",
	"heron",
	"lynx",
	"crane",
	"bison",
	"finch",
	"hawk",
	"coral",
	"cedar",
	"flint",
	"spark",
	"drift",
	"frost",
	"ridge",
	"brook",
	"ember",
	"aspen",
	"birch",
	"cliff",
	"delta",
	"fern",
	"grove",
	"inlet",
	"jade",
	"moss",
	"oak",
	"peak",
	"quail",
	"reef",
	"sage",
	"thorn",
	"vale",
	"wren",
	"yew",
	"alder",
	"pike",
	"lark",
	"mars",
	"nova",
	"orbit",
];

// 48 adjectives × 48 nouns = 2304 unique combinations

/**
 * Generate a random agent name that is unique within the session.
 * Uses cryptographic randomness — not deterministic from deliverable ID.
 */
export function agentName(
	_deliverableId: string,
	taken: ReadonlySet<string>,
): string {
	// Try random picks first (fast path for small sessions)
	for (let i = 0; i < 100; i++) {
		const adj = adjectives[randomInt(adjectives.length)];
		const noun = nouns[randomInt(nouns.length)];
		const name = `${adj}-${noun}`;
		if (!taken.has(name)) return name;
	}

	// Exhaustive shuffle fallback (very large sessions)
	const all = shuffle(adjectives.flatMap((a) => nouns.map((n) => `${a}-${n}`)));
	for (const name of all) {
		if (!taken.has(name)) return name;
	}

	// Absolute fallback (>2304 agents — never in practice)
	return `agent-${randomInt(100000)}`;
}

function shuffle<T>(arr: T[]): T[] {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = randomInt(i + 1);
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}

/** Strip common verb prefixes for a short deliverable display name. */
export function shortDeliverableName(title: string): string {
	return title
		.replace(
			/^(implement|add|fix|build|create|set up|write|update|enable)\s+/i,
			"",
		)
		.trim();
}
