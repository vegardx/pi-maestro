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

import { decideBashPolicy } from "./bash-policy.js";
import type { ExecutionPolicySettings } from "./execution-policy.js";
import type { Mode, ModeName } from "./mode.js";
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
 * There is no `strong` either, any more. It named a separate backend whose
 * supplier was `packages/modes`, so after the flip every command routed there
 * was refused for want of a backend that could not exist. What it promised —
 * denied network, deny-read on secrets, kernel-confined writes — is what the
 * ambient profile already delivers.
 */
export type GateDecision =
	| { readonly kind: "allow"; readonly reason: string }
	| { readonly kind: "confirm"; readonly reason: string }
	| { readonly kind: "deny"; readonly reason: string };

export interface GateInput {
	readonly command: string;
	readonly mode: Mode;
	readonly holder: Holder;
	readonly policy: ExecutionPolicySettings;
}

/**
 * The classifier's mode name, from a mode.
 *
 * The only conversion left, and it is not a seam: a `Mode` is two properties
 * (cwd access x safeguards) and the classifier wants the single name those
 * combine into. Its sibling — an `asActor` translating `read-only` into the
 * classifier's `reviewer` — is gone: `BashActor` is now `Holder`, so there is
 * nothing to translate.
 */
export function asModeName(mode: Mode): ModeName {
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
		actor: input.holder,
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
 * Deliberately not a boolean on the decision itself: `allow` and `confirm`
 * both run eventually and by very different means, and collapsing them into
 * `allowed: true` is how a confirmation requirement gets dropped.
 */
export function refusal(decision: GateDecision): string | null {
	return decision.kind === "deny" ? decision.reason : null;
}
