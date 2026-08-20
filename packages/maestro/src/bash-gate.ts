import type { CommandAssessment } from "./bash-contracts.js";
import {
	assessBashCommand,
	type BashAssessmentInput,
	decideBashPolicy,
} from "./bash-policy.js";
import type { ExecutionPolicySettings } from "./execution-policy.js";
import type { Mode, ModeName } from "./mode.js";

export type GateDecision =
	| { readonly kind: "allow"; readonly reason: string }
	| { readonly kind: "confirm"; readonly reason: string }
	| { readonly kind: "deny"; readonly reason: string };

export interface GateInput {
	readonly command: string;
	readonly mode: Mode;
	readonly policy: ExecutionPolicySettings;
	readonly assessment?: CommandAssessment;
	readonly availableTools?: ReadonlySet<string>;
	readonly confirmBash?: boolean;
}

export function asModeName(mode: Mode): ModeName {
	if (mode.safeguards === "reduced") return "hack";
	return mode.cwd === "read" ? "plan" : "auto";
}

export function gateBash(input: GateInput): GateDecision {
	const policyInput: BashAssessmentInput = {
		command: input.command,
		mode: asModeName(input.mode),
		policy: input.policy,
		...(input.availableTools ? { availableTools: input.availableTools } : {}),
		...(input.confirmBash ? { confirmBash: true } : {}),
	};
	const assessment =
		input.assessment ?? assessBashCommand(input.command).assessment;
	const decision = decideBashPolicy(policyInput, assessment);
	switch (decision.action) {
		case "allow":
			return { kind: "allow", reason: decision.reason };
		case "confirm":
			return { kind: "confirm", reason: decision.reason };
		case "refuse":
			return { kind: "deny", reason: decision.reason };
	}
}

export function refusal(decision: GateDecision): string | null {
	return decision.kind === "deny" ? decision.reason : null;
}
