// Modes: three properties, and everything else follows.
//
// A mode used to be a name with a bag of behaviour behind it, and every new
// question ("can it delegate here?", "does bash get classified?") was answered
// by adding another field to the bag. So the answers drifted from each other.
//
// Here a mode is exactly three facts — may the session touch the working tree,
// are the safeguards on, and what happens at the end of a plan run it started —
// and the names are just the four coherent combinations of those facts.
// Delegation and the run's gate policy are derived. Nothing is stored twice.
//
// THE THIRD FACT IS WHAT BROUGHT `ask` BACK. `ask` and `auto` are the same
// permissions: both write the tree, both keep the safeguards on, both bound a
// delegation to a worktree. They differ in one thing only — whether the run
// parks at its ship gate and asks, or publishes the moment it is done — and that
// difference used to be a special case beside the table. It is a column now, so
// the derivation stays a table and a fifth mode cannot be added without
// answering all three questions.

import type { PlanGates } from "./plan.js";

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

/**
 * What happens at the end of a plan run started from this mode.
 *
 *   - `ask`  — the run parks at its ship gate and the session asks, in a dialog,
 *     with the gate's inputs rendered.
 *   - `auto` — the run has no ship gate; it completes and the seat publishes the
 *     pull request immediately. Leaving plan mode to `auto` IS the approval for
 *     publication, and there is no second question.
 *   - `none` — this mode forms no plan run at all. `plan` is where a plan is
 *     written and `hack` is the escape hatch; neither decides an end.
 */
export type Publication = "ask" | "auto" | "none";

export const MODE_NAMES = ["plan", "ask", "auto", "hack"] as const;
export type ModeName = (typeof MODE_NAMES)[number];

/**
 * The postures a hand-off out of plan mode can be heading for.
 *
 * Named here rather than written out wherever the exit reads it, because
 * `plan` is the one mode an exit can never be heading *for*: the exit starts
 * in plan mode and its whole point is leaving it, eventually.
 */
export const EXIT_MODES = ["ask", "auto", "hack"] as const;

export type ExitMode = (typeof EXIT_MODES)[number];

export function isExitMode(value: unknown): value is ExitMode {
	return (EXIT_MODES as readonly unknown[]).includes(value);
}

export interface Mode {
	readonly name: ModeName;
	readonly cwd: CwdAccess;
	readonly safeguards: Safeguards;
	readonly publication: Publication;
}

/**
 * Four modes, because there are only four coherent combinations.
 *
 * `read` + reduced safeguards is missing on purpose: a read-oriented posture
 * must retain its mutation refusals. Hack reduces ordinary steering while its
 * explicit policy may still confirm privileged or destructive effects.
 *
 * And `write` + safeguards on is TWO modes, not one, because the third fact
 * splits it: `ask` and `auto` are the same permissions and different endings.
 * A publication answer on `plan` or `hack` would be a promise about a run
 * neither of them forms.
 */
const MODES: readonly Mode[] = [
	{ name: "plan", cwd: "read", safeguards: "on", publication: "none" },
	{ name: "ask", cwd: "write", safeguards: "on", publication: "ask" },
	{ name: "auto", cwd: "write", safeguards: "on", publication: "auto" },
	{ name: "hack", cwd: "write", safeguards: "reduced", publication: "none" },
];

export function mode(name: ModeName): Mode {
	const found = MODES.find((m) => m.name === name);
	if (!found) throw new Error(`no mode named \`${name}\``);
	return found;
}

/** The mode these three facts describe, or `null` if they describe none. */
export function modeOf(
	cwd: CwdAccess,
	safeguards: Safeguards,
	publication: Publication,
): Mode | null {
	return (
		MODES.find(
			(m) =>
				m.cwd === cwd &&
				m.safeguards === safeguards &&
				m.publication === publication,
		) ?? null
	);
}

export function modes(): readonly Mode[] {
	return MODES;
}

/**
 * The exit modes that FORM A PLAN RUN, which is not all of them.
 *
 * `hack` is an exit and is not a hand-off: leaving plan mode to it only switches.
 * Written as a filter over the table rather than as a second list, so the fact
 * that decides it — `publication` — is the only place the answer lives.
 */
export const PLAN_EXIT_MODES = EXIT_MODES.filter(
	(name) => mode(name).publication !== "none",
) as readonly Extract<ExitMode, "ask" | "auto">[];

export type PlanExitMode = (typeof PLAN_EXIT_MODES)[number];

export function isPlanExitMode(value: unknown): value is PlanExitMode {
	return (PLAN_EXIT_MODES as readonly unknown[]).includes(value);
}

// ── What the mode decides about the end of a run ─────────────────────────────

/**
 * The gate policy a run started from this mode is given, or `undefined`.
 *
 * DERIVED FROM THE PUBLICATION FACT, in one place, because three callers ask it
 * — the plan-mode hand-off, `/plan run`, and the docs that describe them — and
 * three copies of "which mode ships by itself" is exactly how the effort dial
 * outlived every surface that mentioned it.
 *
 *   - **ask** → `ship`. The run works through the plan and stops at its ship
 *     decision, which the session then asks in a dialog.
 *   - **auto** → `none`. No ship gate: the run completes, its terminal output
 *     carries the same receipt and the same ship-gate inputs, and the seat
 *     publishes.
 *   - **plan**, **hack** → `undefined`. Neither forms a run, so neither has an
 *     end to decide, and a caller asked to start one from here refuses by name
 *     rather than picking a policy nobody chose.
 */
export function planGatesFor(name: PlanExitMode): PlanGates;
export function planGatesFor(name: ModeName): PlanGates | undefined;
export function planGatesFor(name: ModeName): PlanGates | undefined {
	const posture = mode(name);
	if (posture.publication === "ask") return "ship";
	if (posture.publication === "auto") return "none";
	return undefined;
}

/** What a caller is told when the mode it is standing in decides no ending. */
export const NO_GATES_REFUSAL =
	"start it from ask or auto: ask parks the run at its ship decision and this session asks you, auto publishes the pull request when the run is done";

// ── The ceiling a mode is ────────────────────────────────────────────────────
//
// THE MODE IS A PERMISSION DIAL AND NOTHING ELSE, and this is the one place it
// says so to anybody outside this package. A mode used to travel by name —
// "plan mode refuses `workflow_run`" — which meant every runtime that could
// launch anything had to know what pi-maestro's mode names meant, and two of
// them disagreed. So the bound travels in pi-subagent's OWN vocabulary instead:
// workspace modes and tool names, stated once, here, at the translation point.
//
// No mode name crosses this line. `plan`, `ask`, `auto` and `hack` are words
// this repository uses about itself.

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
 * same question asked one level down — and the fourth mode was added without
 * answering it again.
 *
 *   - **plan** — read-only. A delegation from a conversation reads; it does not
 *     produce work.
 *   - **ask**, **auto** — read-only or a worktree. Work happens in a worktree,
 *     never in the tree the person is sitting in. The two postures differ in
 *     what happens when the run is over, which is not a permission.
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
