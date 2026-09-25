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
export type Safeguards = "on" | "reduced";

export const MODE_NAMES = ["plan", "auto", "hack"] as const;
export type ModeName = (typeof MODE_NAMES)[number];

/**
 * The postures a hand-off out of plan mode can be heading for.
 *
 * Named here rather than written out wherever the exit reads it, because
 * `plan` is the one mode an exit can never be heading *for*: the exit starts
 * in plan mode and its whole point is leaving it, eventually.
 */
export const EXIT_MODES = ["auto", "hack"] as const;

export type ExitMode = (typeof EXIT_MODES)[number];

export function isExitMode(value: unknown): value is ExitMode {
	return (EXIT_MODES as readonly unknown[]).includes(value);
}

export interface Mode {
	readonly name: ModeName;
	readonly cwd: CwdAccess;
	readonly safeguards: Safeguards;
}

/**
 * Three modes, because there are only three coherent combinations.
 *
 * `read` + reduced safeguards is missing on purpose: a read-oriented posture
 * must retain its mutation refusals. Hack reduces ordinary steering while its
 * explicit policy may still confirm privileged or destructive effects.
 */
const MODES: readonly Mode[] = [
	{ name: "plan", cwd: "read", safeguards: "on" },
	{ name: "auto", cwd: "write", safeguards: "on" },
	{ name: "hack", cwd: "write", safeguards: "reduced" },
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

// ── The ceiling a mode is ────────────────────────────────────────────────────
//
// THE MODE IS A PERMISSION DIAL AND NOTHING ELSE, and this is the one place it
// says so to anybody outside this package. A mode used to travel by name —
// "plan mode refuses `workflow_run`" — which meant every runtime that could
// launch anything had to know what pi-maestro's mode names meant, and two of
// them disagreed. So the bound travels in pi-subagent's OWN vocabulary instead:
// workspace modes and tool names, stated once, here, at the translation point.
//
// No mode name crosses this line. `plan`, `auto` and `hack` are words this
// repository uses about itself.

/** A workspace pi-subagent knows how to give a delegated attempt. */
export type WorkspaceMode = "read-only" | "worktree";

/**
 * A bound the host puts on one delegation.
 *
 * It never widens an agent definition: the effective allowance is the
 * definition's own declaration intersected with this. `undefined` is no bound at
 * all, which is what hack means and what an unregistered host means.
 */
export interface DelegationCeiling {
	workspaceModes?: WorkspaceMode[];
	tools?: string[];
}

/**
 * What a mode lets a delegation do.
 *
 * Derived from the mode's `cwd` fact rather than written out per name, because
 * "may this session change a tree?" and "may something it launches?" are the
 * same question asked one level down — and a fourth mode could not be added
 * without answering it.
 *
 *   - **plan** — read-only. A delegation from a conversation reads; it does not
 *     produce work.
 *   - **auto** — read-only or a worktree. Work happens in a worktree, never in
 *     the tree the person is sitting in.
 *   - **hack** — no ceiling. The posture whose whole meaning is that the
 *     restrictions are off does not get to keep one here.
 *
 * PUBLICATION IS NEVER INSIDE A CEILING. Pushing is pi-maestro's own act, under
 * its own audited Bash policy and a durable human decision, and it is not a
 * delegation.
 */
export function modeCeiling(name: ModeName): DelegationCeiling | undefined {
	const posture = mode(name);
	if (posture.safeguards === "reduced") return undefined;
	return posture.cwd === "write"
		? { workspaceModes: ["read-only", "worktree"] }
		: { workspaceModes: ["read-only"] };
}
