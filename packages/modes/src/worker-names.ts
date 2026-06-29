// Memorable adjective-noun worker names, deterministically derived from the
// deliverable ID so the same deliverable always gets the same name (unless it
// collides with an already-taken name in the session).

const adjectives = [
	"swift",
	"bold",
	"calm",
	"bright",
	"eager",
	"flying",
	"gentle",
	"happy",
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
];

function hashCode(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) {
		h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
	}
	return h >>> 0;
}

export function workerName(
	deliverableId: string,
	taken: ReadonlySet<string>,
): string {
	const h = hashCode(deliverableId);
	for (let i = 0; i < 200; i++) {
		const adj = adjectives[(h + i) % adjectives.length];
		const noun = nouns[((h + i * 7) >>> 0) % nouns.length];
		const name = `${adj}-${noun}`;
		if (!taken.has(name)) return name;
	}
	return `worker-${deliverableId.slice(0, 8)}`;
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
