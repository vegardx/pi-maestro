// Modes: two properties, and everything else follows.
//
// A mode used to be a name with a bag of behaviour behind it, and every new
// question ("can it delegate here?", "does bash get classified?") was answered
// by adding another field to the bag. So the answers drifted from each other.
//
// Here a mode is exactly two facts — may the session touch the working tree,
// and are the safeguards on — and the names are just the three coherent
// combinations of those facts. Delegation is derived. Nothing is stored twice.

/** May this session change the tree it is sitting in? */
export type CwdAccess = "read" | "write";

/**
 * The bash classifier and the confirmation rail.
 *
 * This is what makes `read` real. Without it, a session with no write tool can
 * still rewrite the repository through bash — which is not a hypothetical, it
 * is the forcing bug this system shipped.
 */
export type Safeguards = "on" | "off";

export const MODE_NAMES = ["plan", "auto", "hack"] as const;
export type ModeName = (typeof MODE_NAMES)[number];

export interface Mode {
	readonly name: ModeName;
	readonly cwd: CwdAccess;
	readonly safeguards: Safeguards;
}

/**
 * Three modes, because there are only three coherent combinations.
 *
 * `read` + safeguards `off` is missing on purpose rather than by omission: with
 * the classifier off, bash can rewrite anything, so a read-only session with no
 * safeguards is read-only in name only. A mode that lies about what it permits
 * is worse than one that does not exist.
 */
const MODES: readonly Mode[] = [
	{ name: "plan", cwd: "read", safeguards: "on" },
	{ name: "auto", cwd: "write", safeguards: "on" },
	{ name: "hack", cwd: "write", safeguards: "off" },
];

export function mode(name: ModeName): Mode {
	const found = MODES.find((m) => m.name === name);
	if (!found) throw new Error(`no mode named \`${name}\``);
	return found;
}

/** The mode these two facts describe, or `null` if they describe none. */
export function modeOf(cwd: CwdAccess, safeguards: Safeguards): Mode | null {
	return (
		MODES.find((m) => m.cwd === cwd && m.safeguards === safeguards) ?? null
	);
}

export function modes(): readonly Mode[] {
	return MODES;
}
