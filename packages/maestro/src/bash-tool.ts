// The `bash` an agent actually gets.
//
// pi builds its bash tool over a `BashOperations`, so the gate goes in front of
// the operations rather than in front of the tool: every path that reaches a
// shell reaches it through here, including a command pi runs for its own
// reasons. Wrapping the TOOL would leave the operations reachable, and the
// whole lesson of this rebuild is that a guard with a way around it is a guard
// that will be gone round.

import { appendFileSync } from "node:fs";
import {
	type BashOperations,
	createBashToolDefinition,
	createLocalBashOperations,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { asModeName, type GateDecision, gateBash } from "./bash-gate.js";
import type { ExecutionPolicySettings } from "./execution-policy.js";
import {
	createEnforcingBashOperations,
	createShadowBashOperations,
	defaultSandboxWrap,
} from "./isolation/realtree-sandbox.js";
import type { Mode } from "./mode.js";
import type { Holder } from "./tool-registry.js";

export interface BashToolDeps {
	readonly holder: Holder;
	/** Where the agent runs. pi's bash tool is built around one. */
	readonly cwd: string;
	/** Read per call: the seat's posture changes under the agent's feet. */
	readonly mode: () => Mode;
	readonly policy: () => ExecutionPolicySettings;
	/** Ask the human. Absent = nobody to ask, which is a worker. */
	readonly confirm?: (command: string, reason: string) => Promise<boolean>;
	/**
	 * The strong backend: a separate filesystem and network, not a write profile.
	 * Absent = no such backend here, and a command routed to one is refused.
	 */
	readonly strong?: () => BashOperations;
	/** The unguarded host shell. Injected so a test needs no shell. */
	readonly direct?: BashOperations;
	/**
	 * Wrap the host shell in the actor's write profile. Injected only by tests —
	 * production confines through the OS, and a test that needed a real sandbox
	 * would be a test nobody could run on CI.
	 */
	readonly confine?: (
		base: BashOperations,
		deps: BashToolDeps,
		mode: Mode,
	) => BashOperations;
	/** Told about every decision, for narration and for after the fact. */
	readonly onDecision?: (command: string, decision: GateDecision) => void;
}

class Refused extends Error {
	constructor(reason: string) {
		super(`refused: ${reason}`);
		this.name = "Refused";
	}
}

/**
 * `BashOperations` with the gate in front.
 *
 * A refusal throws rather than returning a non-zero exit code. An agent reads a
 * failed command as something to work around — retry, rephrase, try another
 * flag — and a policy refusal is not that. It is an answer.
 */
/**
 * The host shell, confined to the actor's write profile by the OS.
 *
 * `MAESTRO_SANDBOX=off` disables it — the escape hatch — and
 * `MAESTRO_SANDBOX_SHADOW=<file>` logs what WOULD have been confined without
 * confining it, which is how a new profile is proven before it is trusted.
 */
function confineToProfile(
	base: BashOperations,
	deps: BashToolDeps,
	mode: Mode,
): BashOperations {
	if (process.env.MAESTRO_SANDBOX === "off") return base;
	const actor = deps.holder;
	const modeName = asModeName(mode);
	const logPath = process.env.MAESTRO_SANDBOX_SHADOW;
	if (logPath)
		return createShadowBashOperations(base, {
			actor,
			mode: modeName,
			log: (line) => {
				try {
					appendFileSync(logPath, `${line}\n`);
				} catch {
					// A shadow-log write must never affect execution.
				}
			},
		});
	return createEnforcingBashOperations(base, {
		actor,
		mode: modeName,
		wrap: defaultSandboxWrap,
	});
}

export function createGatedBashOperations(deps: BashToolDeps): BashOperations {
	const host = deps.direct ?? createLocalBashOperations();
	const confine = deps.confine ?? confineToProfile;

	return {
		...host,
		exec: async (command, cwd, options) => {
			// Read together: the profile depends on the posture, and the posture
			// changes under a running agent. Resolving them at different moments
			// is how a command gets classified in one mode and confined for
			// another.
			const mode = deps.mode();
			const decision = gateBash({
				command,
				mode,
				holder: deps.holder,
				policy: deps.policy(),
			});
			deps.onDecision?.(command, decision);

			// Confinement is not a branch. Every route that runs at all runs
			// through the write profile, so a command the classifier got WRONG is
			// still contained to the actor's scope. A gate that confines only what
			// it already recognised as dangerous protects against nothing it did
			// not already catch.
			const confined = confine(host, deps, mode);

			switch (decision.kind) {
				case "allow":
					return confined.exec(command, cwd, options);

				case "strong": {
					const backend = deps.strong?.();
					// No backend is not "run it anyway". This was routed away from
					// the real tree because the real tree was the thing to avoid,
					// and having no elsewhere to run it does not change that.
					if (!backend)
						throw new Refused(
							`${decision.reason} — this needs strong isolation, and no backend for it is available here`,
						);
					return backend.exec(command, cwd, options);
				}

				case "confirm": {
					if (!deps.confirm)
						throw new Refused(
							`${decision.reason} — and there is nobody to ask`,
						);
					const allowed = await deps.confirm(command, decision.reason);
					if (!allowed) throw new Refused("you declined this command");
					// Consent is to the COMMAND, never to running it unconfined.
					return confined.exec(command, cwd, options);
				}

				default:
					throw new Refused(decision.reason);
			}
		},
	};
}

/** The `bash` tool for a holder, with its safeguards attached. */
export function createBashTool(deps: BashToolDeps): ToolDefinition {
	return createBashToolDefinition(deps.cwd, {
		operations: createGatedBashOperations(deps),
	}) as ToolDefinition;
}
