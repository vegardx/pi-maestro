// Capability registry vocabulary. Versioned ids map to typed interfaces. A
// provider publishes a capability; a consumer resolves it through
// pi.capabilities (require() = hard dep, get() = soft dep) — never by
// importing the sibling extension. The CapabilityMap gives the registry its
// typed require<K>(id): CapabilityMap[K] signature (defined in core).

import type { Answers, PendingAsk, Questionnaire } from "./ask.js";
import type { RunId } from "./ids.js";
import type { ModeName, ModesExecutionStatus } from "./modes.js";
import type { RunHandle, RunRecord, SpawnProfile } from "./runs.js";
import type { SettingsCapabilityV1 } from "./settings.js";
import type { ShipResult } from "./ship.js";
import type { TokenSnapshot, UsageSource } from "./usage.js";

export const CAPABILITIES = {
	subagents: "subagents.v1",
	ask: "ask.v1",
	askTransport: "ask-transport.v1",
	usage: "usage.v1",
	commit: "commit.v1",
	ship: "ship.v1",
	modes: "modes.v1",
	promptAssist: "prompt-assist.v1",
	overlays: "overlays.v1",
	settings: "settings.v1",
} as const;

export type CapabilityId = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

export interface SubagentsCapabilityV1 {
	spawn(prompt: string, profile: SpawnProfile): RunHandle;
	get(runId: RunId): RunRecord | undefined;
	list(): readonly RunRecord[];
	steer(runId: RunId, guidance: string): void;
	stop(runId: RunId, reason?: string): void;
}

export interface AskCapabilityV1 {
	/** Blocking: present the questionnaire and resolve with answers. */
	ask(questions: Questionnaire): Promise<Answers>;
	/** Non-blocking: queue questions for the next flush (plan-mode driver). */
	queue(questions: Questionnaire): void;
	/**
	 * Non-blocking: merge questions into the pending set (badge widget) and
	 * return immediately. Answers are delivered to the agent as a follow-up
	 * user message when the user commits them.
	 */
	post(questions: Questionnaire): void;
	/** Posted-but-unanswered questions, for turn-start context lines. */
	pending(): readonly PendingAsk[];
}

/**
 * A remote sink for questions. When present, the ask engine routes blocking
 * `ask()` calls here instead of rendering a local dialog — this is how an
 * agent's `ask` tool reaches the maestro over RPC. Registered by
 * modes only in agent mode; absent otherwise (engine falls back to local UI).
 */
export interface AskTransportV1 {
	present(questions: Questionnaire): Promise<Answers>;
}

/**
 * Central usage ledger. Every source (maestro, each agent)
 * records its cumulative snapshot; the ledger aggregates by source so cost
 * and tokens are real and attributable. Registered by modes.
 */
export interface UsageLedgerV1 {
	/** Upsert the cumulative snapshot for a source. */
	record(source: UsageSource, snapshot: TokenSnapshot): void;
	/** Per-source snapshots plus an aggregate total. */
	snapshot(): {
		bySource: ReadonlyMap<string, TokenSnapshot>;
		totals: TokenSnapshot;
	};
}

export interface CommitCapabilityV1 {
	commitLocal(input: {
		readonly paths?: readonly string[];
		readonly message?: string;
		readonly cwd?: string;
	}): Promise<{
		readonly committed: boolean;
		readonly sha?: string;
		readonly message?: string;
		readonly error?: string;
	}>;
}

export interface ShipCapabilityV1 {
	ship(input: {
		readonly cwd?: string;
		readonly autoApprove?: boolean;
		readonly title?: string;
		readonly body?: string;
	}): Promise<ShipResult>;
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
export interface OverlaysCapabilityV1 {
	/** Mount an overlay widget above the editor. */
	mount(id: string, component: unknown): void;
	/** Unmount an overlay widget. */
	unmount(id: string): void;
	/** Expand + focus a specific overlay. */
	focusOverlay(id: string): void;
	/** Return focus to input, collapse all. */
	focusInput(): void;
	/** Block input (main-agent questions). Auto-expands ask overlay. */
	blockInput(): void;
	/** Unblock input. */
	unblockInput(): void;
	/** Whether input is currently blocked. */
	readonly isInputBlocked: boolean;
}

export interface CapabilityMap {
	[CAPABILITIES.subagents]: SubagentsCapabilityV1;
	[CAPABILITIES.ask]: AskCapabilityV1;
	[CAPABILITIES.askTransport]: AskTransportV1;
	[CAPABILITIES.usage]: UsageLedgerV1;
	[CAPABILITIES.commit]: CommitCapabilityV1;
	[CAPABILITIES.ship]: ShipCapabilityV1;
	[CAPABILITIES.modes]: ModesCapabilityV1;
	[CAPABILITIES.promptAssist]: PromptAssistCapabilityV1;
	[CAPABILITIES.overlays]: OverlaysCapabilityV1;
	[CAPABILITIES.settings]: SettingsCapabilityV1;
}
