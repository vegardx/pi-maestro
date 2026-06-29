// Capability registry vocabulary. Versioned ids map to typed interfaces. A
// provider publishes a capability; a consumer resolves it through
// pi.capabilities (require() = hard dep, get() = soft dep) — never by
// importing the sibling extension. The CapabilityMap gives the registry its
// typed require<K>(id): CapabilityMap[K] signature (defined in core).

import type { Answers, Questionnaire } from "./ask.js";
import type { ModeName, ModesExecutionStatus } from "./modes.js";
import type { ShipDeliverableInput, ShipResult } from "./ship.js";

export const CAPABILITIES = {
	ask: "ask.v1",
	commit: "commit.v1",
	modes: "modes.v1",
	promptAssist: "prompt-assist.v1",
} as const;

export type CapabilityId = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

export interface AskCapabilityV1 {
	/** Blocking: present the questionnaire and resolve with answers. */
	ask(questions: Questionnaire): Promise<Answers>;
	/** Non-blocking: queue questions for the next flush (plan-mode driver). */
	queue(questions: Questionnaire): void;
}

export interface CommitCapabilityV1 {
	shipDeliverable(input: ShipDeliverableInput): Promise<ShipResult>;
}

export interface ModesCapabilityV1 {
	current(): ModeName;
	onChange(listener: (mode: ModeName, previous: ModeName) => void): () => void;
	/** Read-only execution lifecycle snapshot for cross-extension coordination. */
	execution(): ModesExecutionStatus;
}

export interface PromptAssistCapabilityV1 {
	suggest(text: string): void;
}

/** Maps each capability id to its interface for the typed registry. */
export interface CapabilityMap {
	[CAPABILITIES.ask]: AskCapabilityV1;
	[CAPABILITIES.commit]: CommitCapabilityV1;
	[CAPABILITIES.modes]: ModesCapabilityV1;
	[CAPABILITIES.promptAssist]: PromptAssistCapabilityV1;
}
