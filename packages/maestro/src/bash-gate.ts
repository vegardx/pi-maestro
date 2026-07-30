// The safeguards, made real.
//
// `bash-policy.ts` classifies a command — what it touches, and which route it
// belongs on. Nothing in the rebuilt system was asking it. That made hack mode's
// "safeguards off" meaningless, because nothing was on: a worker could rewrite
// anything through the shell, which is the forcing bug this rebuild exists to
// close and which it had quietly reintroduced.
//
// THE RULE WORTH READING: a route that needs a human is a refusal for anything
// unattended. The maestro has someone to ask. A worker does not — it is a
// detached process whose human is looking at something else — so a command that
// would have prompted is denied outright, with the reason, and the worker can
// report that it could not proceed. Prompting into a void is how a fleet hangs.

import { type BashActor, decideBashPolicy } from "./bash-policy.js";
import type { ExecutionPolicySettings } from "./execution-policy.js";
import type { Mode } from "./mode.js";
import type { Holder } from "./tool-registry.js";

/**
 * What to do with a command.
 *
 * There is no `isolate` here, and that absence is the point. Confinement is not
 * somewhere a command is SENT — it is the condition every command already runs
 * under, applied in front of the route rather than instead of it. A decision
 * that could say "isolate this one" implies the others need no confining, which
 * is how the ordinary path ends up on an unguarded host shell.
 *
 * `strong` is the exception, and only because it is a different MECHANISM: a
 * separate backend with its own filesystem and network, not a write profile
 * over the real tree.
 */
export type GateDecision =
	| { readonly kind: "allow"; readonly reason: string }
	| { readonly kind: "strong"; readonly reason: string }
	| { readonly kind: "confirm"; readonly reason: string }
	| { readonly kind: "deny"; readonly reason: string };

export interface GateInput {
	readonly command: string;
	readonly mode: Mode;
	readonly holder: Holder;
	readonly policy: ExecutionPolicySettings;
}

/**
 * Speak the classifier's existing vocabulary.
 *
 * TEMPORARY, and it dies with `packages/modes`. The classifier types its actor
 * as `maestro | worker | reviewer` and its mode as the old five-name enum, and
 * retyping it now would change the safeguard behaviour of the system still in
 * daily use. So the new model converts at this one labelled point instead —
 * six lines, in one direction, deleted when the old model is.
 *
 * It also answers a question the rebuild plan left open: the actor axis IS
 * right, because it is the POSTURE axis with one name wrong. `reviewer` is a
 * kind; the thing that decides shell access is `read-only`, which explorers and
 * advisors share. Three actors, three holders, one rename apart.
 */
export function asActor(holder: Holder): BashActor {
	return holder === "read-only" ? "reviewer" : holder;
}

export function asModeName(mode: Mode): "plan" | "auto" | "hack" {
	if (mode.safeguards === "off") return "hack";
	return mode.cwd === "read" ? "plan" : "auto";
}

/**
 * What to do with a command.
 *
 * Hack is still the operator's authorisation boundary and the classifier
 * honours it — but only for the seat. Safeguards do not propagate, so a worker
 * is never in hack, and this is where that stops being a claim in a comment.
 */
export function gateBash(input: GateInput): GateDecision {
	const decision = decideBashPolicy({
		command: input.command,
		actor: asActor(input.holder),
		mode: asModeName(input.mode),
		policy: input.policy,
	});
	return decideFromRoute(
		decision.route,
		decision.reason,
		input.holder === "maestro",
	);
}

/**
 * A route, turned into what to do about it.
 *
 * Separate from `gateBash` so every route can be tested directly. The
 * classifier decides most cases before they reach here — it already refuses a
 * worker for consequential effects, with a better reason than this file could
 * write — so the branches below are reachable only for some inputs, and a
 * backstop nothing can exercise is a backstop nobody knows is broken.
 */
export function decideFromRoute(
	route: string,
	reason: string,
	attended: boolean,
): GateDecision {
	switch (route) {
		case "direct":
		case "host-read":
			return { kind: "allow", reason };

		// The COPY tier is retired, and `lightweight` no longer names a place to
		// send a command — it names the confinement every route already gets.
		// Reads stay open on the real tree so builds and `git status` work; the
		// write guard is the kernel, which is what makes a classifier miss stop
		// being an escape rather than merely unlikely.
		case "lightweight":
			return { kind: "allow", reason };

		case "strong":
			return { kind: "strong", reason };

		case "confirm":
			// Nobody is watching a worker. A prompt it cannot answer is a worker
			// that stops responding, which reads exactly like one that crashed.
			return attended
				? { kind: "confirm", reason }
				: {
						kind: "deny",
						reason: `${reason} — and there is nobody to ask: an agent runs unattended, so a command that needs a human is refused. Do it a way that does not, or report that you could not.`,
					};

		case "deny":
			return { kind: "deny", reason };

		default:
			// An unrecognised route is not an allowance. The classifier gains
			// routes over time and this is the only place that would silently
			// widen if one arrived unhandled.
			return {
				kind: "deny",
				reason: `unrecognised route \`${route}\` — refused rather than guessed at`,
			};
	}
}

/**
 * Whether a decision lets the command run at all, in some form.
 *
 * Deliberately not a boolean on the decision itself: `strong` and `confirm`
 * both allow eventually and by very different means, and collapsing them into
 * `allowed: true` is how a backend requirement gets dropped.
 */
export function refusal(decision: GateDecision): string | null {
	return decision.kind === "deny" ? decision.reason : null;
}
