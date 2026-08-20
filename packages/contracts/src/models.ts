import type { ThinkingLevel } from "./thinking.js";

/** Current in-process harness callers that resolve a support model. */
export const MODEL_ROLES = ["classifier", "compact-summarizer"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export type OptionEffort = ThinkingLevel | "auto";
export type ModelConfigScope = "global" | "project" | "session";

export interface ExactModelCandidateFact {
	readonly optionId: string;
	readonly authoredModel: string;
	readonly modelId?: string;
	readonly effort: OptionEffort;
	readonly summary: string;
	readonly registered: boolean;
	readonly authenticated: boolean;
	readonly effortSupported: boolean;
	readonly available: boolean;
	readonly reason?: string;
}
