// The `bash` an agent actually gets.
//
// pi builds its bash tool over a `BashOperations`, so the gate goes in front of
// the operations rather than in front of the tool: every path that reaches a
// shell reaches it through here, including a command pi runs for its own
// reasons. Wrapping the TOOL would leave the operations reachable, and the
// whole lesson of this rebuild is that a guard with a way around it is a guard
// that will be gone round.

import {
	type BashOperations,
	createBashToolDefinition,
	createLocalBashOperations,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type GateDecision, gateBash } from "./bash-gate.js";
import type { ExecutionPolicySettings } from "./execution-policy.js";
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
	/** The unguarded host shell. Injected so a test needs no shell. */
	readonly direct?: BashOperations;
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
 * `BashOperations` with the advisory/refusal gate in front.
 *
 * A refusal throws rather than returning a non-zero exit code. An agent reads a
 * failed command as something to work around, while a policy refusal is an
 * answer. There is deliberately no OS write boundary in auto or hack mode.
 */

export function createGatedBashOperations(deps: BashToolDeps): BashOperations {
	const host = deps.direct ?? createLocalBashOperations();

	return {
		...host,
		exec: async (command, cwd, options) => {
			// Read together: the profile depends on the posture, and the posture
			// changes under a running agent. Resolving them at different moments
			// is how a command gets classified under the wrong posture.
			const mode = deps.mode();
			const decision = gateBash({
				command,
				mode,
				holder: deps.holder,
				policy: deps.policy(),
			});
			deps.onDecision?.(command, decision);

			switch (decision.kind) {
				case "allow":
					return host.exec(command, cwd, options);

				case "confirm": {
					if (!deps.confirm)
						throw new Refused(
							`${decision.reason} — and there is nobody to ask`,
						);
					const allowed = await deps.confirm(command, decision.reason);
					if (!allowed) throw new Refused("you declined this command");
					return host.exec(command, cwd, options);
				}

				default:
					throw new Refused(decision.reason);
			}
		},
	};
}

/** The `bash` tool for a holder, with its safeguards attached. */
export function createBashTool(deps: BashToolDeps): ToolDefinition {
	const base = createBashToolDefinition(deps.cwd, {
		operations: createGatedBashOperations(deps),
	}) as ToolDefinition;

	// Pi's default description does not explain mode-aware classification or
	// ownership boundaries, so describe those before the model discovers them
	// through a refusal.
	//
	// A refusal is still the backstop. This is the part that means an agent
	// rarely has to hit it.
	return {
		...base,
		description:
			"Run a host shell command. Every command is classified first so consequential " +
			"or disallowed effects are explained before execution. Auto and hack do not " +
			"provide an OS write boundary. " +
			"Some commands are refused with a reason and something to do instead — " +
			"read the reason rather than retrying: it is an answer, not a failure. " +
			(deps.holder === "worker"
				? "Committing is not one of these commands; use the commit tool. Pushing and pull requests are the maestro's."
				: "Committing and pushing belong to the workers and to shipping, not here."),
		promptSnippet:
			deps.holder === "worker"
				? "run a classified shell command. Not for committing — that is the commit tool."
				: "run a host shell command after mode-aware classification.",
	};
}
