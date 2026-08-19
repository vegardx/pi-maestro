// Capability registry vocabulary. Versioned ids map to typed interfaces.

import type { ModeName, ModesExecutionStatus } from "./modes.js";

export const CAPABILITIES = {
	modes: "modes.v1",
	promptAssist: "prompt-assist.v1",
} as const;

export type CapabilityId = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

export interface ModesCapabilityV1 {
	current(): ModeName;
	onChange(listener: (mode: ModeName, previous: ModeName) => void): () => void;
	execution(): ModesExecutionStatus;
}

export interface PromptAssistCapabilityV1 {
	suggest(text: string): void;
}

export interface CapabilityMap {
	[CAPABILITIES.modes]: ModesCapabilityV1;
	[CAPABILITIES.promptAssist]: PromptAssistCapabilityV1;
}
