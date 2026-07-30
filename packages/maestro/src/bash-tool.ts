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
	/** Run a command under isolation. Absent = no sandbox is available. */
	readonly isolate?: (tier: "lightweight" | "strong") => BashOperations;
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
 * `BashOperations` with the gate in front.
 *
 * A refusal throws rather than returning a non-zero exit code. An agent reads a
 * failed command as something to work around — retry, rephrase, try another
 * flag — and a policy refusal is not that. It is an answer.
 */
export function createGatedBashOperations(deps: BashToolDeps): BashOperations {
	const direct = deps.direct ?? createLocalBashOperations();

	return {
		...direct,
		exec: async (command, cwd, options) => {
			const decision = gateBash({
				command,
				mode: deps.mode(),
				holder: deps.holder,
				policy: deps.policy(),
			});
			deps.onDecision?.(command, decision);

			switch (decision.kind) {
				case "allow":
					return direct.exec(command, cwd, options);

				case "isolate": {
					const sandbox = deps.isolate?.(decision.tier);
					// No sandbox is not "run it anyway". The command was routed to
					// isolation because running it on the host was the thing to
					// avoid, and losing the sandbox does not change that.
					if (!sandbox)
						throw new Refused(
							`${decision.reason} — this needs ${decision.tier} isolation and none is available here`,
						);
					return sandbox.exec(command, cwd, options);
				}

				case "confirm": {
					if (!deps.confirm)
						throw new Refused(
							`${decision.reason} — and there is nobody to ask`,
						);
					const allowed = await deps.confirm(command, decision.reason);
					if (!allowed) throw new Refused("you declined this command");
					return direct.exec(command, cwd, options);
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
