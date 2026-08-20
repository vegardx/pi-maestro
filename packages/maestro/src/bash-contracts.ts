import type { ModeName } from "./mode.js";

export const BASH_EFFECTS = [
	"filesystem-read",
	"workspace-write",
	"host-write",
	"remote-read",
	"remote-write",
	"code-execution",
	"privileged",
	"destructive",
] as const;

export type BashEffect = (typeof BASH_EFFECTS)[number];
export type AssessmentConfidence = "low" | "medium" | "high";

export type CommandAssessment =
	| {
			readonly assessment: "read-only";
			readonly effects?: readonly ("filesystem-read" | "remote-read")[];
			readonly confidence: AssessmentConfidence;
			readonly rationale: string;
	  }
	| {
			readonly assessment: "effects";
			readonly effects: readonly BashEffect[];
			readonly confidence: AssessmentConfidence;
			readonly rationale: string;
	  }
	| {
			readonly assessment: "uncertain";
			readonly effects?: readonly BashEffect[];
			readonly confidence: "low";
			readonly rationale: string;
	  };

export interface DeterministicAssessment {
	readonly assessment: CommandAssessment;
	readonly unresolved: readonly string[];
}

export const BASH_ACTIONS = ["allow", "confirm", "refuse"] as const;
export type BashAction = (typeof BASH_ACTIONS)[number];
export type BashPolicyKey = BashEffect | "uncertain";
export type ModeBashPolicy = Readonly<Record<BashPolicyKey, BashAction>>;
export type BashModePolicies = Readonly<Record<ModeName, ModeBashPolicy>>;

export interface BashDecision {
	readonly action: BashAction;
	readonly assessment: CommandAssessment;
	readonly reason: string;
	readonly suggestedTool?: SuggestableTool;
}

export const SUGGESTABLE_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"delete",
] as const;
export type SuggestableTool = (typeof SUGGESTABLE_TOOLS)[number];
