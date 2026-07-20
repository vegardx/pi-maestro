// Capability registry vocabulary. Versioned ids map to typed interfaces. A
// provider publishes a capability; a consumer resolves it through
// pi.capabilities (require() = hard dep, get() = soft dep) — never by
// importing the sibling extension. The CapabilityMap gives the registry its
// typed require<K>(id): CapabilityMap[K] signature (defined in core).

import type {
	AgentsCapabilityV1,
	ChildRunProjectionSourceV1,
} from "./agents.js";
import type { Answers, PendingAsk, Questionnaire } from "./ask.js";
import type { RunId } from "./ids.js";
import type { ModeName, ModesExecutionStatus } from "./modes.js";
import type {
	InterruptResult,
	RunHandle,
	RunRecord,
	SpawnProfile,
} from "./runs.js";
import type { SettingsCapabilityV1 } from "./settings.js";
import type { ShipResult } from "./ship.js";
import type { TokenSnapshot, UsageCheckpoint, UsageSource } from "./usage.js";

export const CAPABILITIES = {
	subagents: "subagents.v1",
	agents: "agents.v1",
	childRunProjections: "child-run-projections.v1",
	ask: "ask.v1",
	askTransport: "ask-transport.v1",
	usage: "usage.v1",
	commit: "commit.v1",
	ship: "ship.v1",
	modes: "modes.v1",
	personas: "personas.v1",
	promptAssist: "prompt-assist.v1",
	overlays: "overlays.v1",
	settings: "settings.v1",
} as const;

export type CapabilityId = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

/**
 * A persona as seen across the extension boundary (personas.v1). The
 * subagents extension owns the layered skill.md registry; consumers (modes'
 * live spawn, plan validation) look personas up here instead of importing
 * the loader — extensions talk via capabilities, never value imports.
 */
export interface PersonaSummaryV1 {
	readonly name: string;
	/** Agent types this persona may run on. */
	readonly agents: readonly string[];
	/** The return contract its runs fulfill. */
	readonly contract: string;
	/** Skills always loaded with this persona. */
	readonly skills: readonly string[];
	/** The system prompt (markdown body, frontmatter stripped). */
	readonly prompt: string;
}

export interface PersonasCapabilityV1 {
	get(name: string): PersonaSummaryV1 | undefined;
	list(): readonly PersonaSummaryV1[];
	/** Load-time failures (bad frontmatter, unknown ids) — fail-visible. */
	errors(): readonly string[];
}

export interface SubagentsCapabilityV1 {
	spawn(prompt: string, profile: SpawnProfile): RunHandle;
	get(runId: RunId): RunRecord | undefined;
	list(): readonly RunRecord[];
	steer(runId: RunId, guidance: string): void;
	interrupt?(runId: RunId, reason?: string): Promise<InterruptResult>;
	/** Compatibility alias for interrupting one-shot work. */
	stop(runId: RunId, reason?: string): void;
	capture?(runId: RunId, lines?: number): Promise<string | undefined>;
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
	/**
	 * Open the interactive answer editor for a pending question (the HUD's
	 * Questions tab Enter action). No-op when the id is unknown. Optional:
	 * only the interactive engine provides it.
	 */
	open?(questionId: string): void;
}

export interface AskPresentOptions {
	/**
	 * The maestro's own turn awaits this answer (a blocking / promoted ask).
	 * Absent/false ⇒ non-blocking: the transport surfaces the questions but the
	 * caller does not wait, and answers arrive later as a follow-up.
	 */
	readonly blocking?: boolean;
}

/**
 * A remote sink for questions. When present, the ask engine routes questions
 * here instead of rendering a local dialog. Two registrations use it: an agent
 * routes its `ask` tool up to the parent maestro over RPC; and the top maestro
 * in rpc mode routes questions out to the driver as extension_ui_request
 * dialogs. Absent otherwise (the engine falls back to local UI).
 */
export interface AskTransportV1 {
	present(questions: Questionnaire, opts?: AskPresentOptions): Promise<Answers>;
}

/**
 * Central usage ledger. Every source (maestro, each agent)
 * records its cumulative snapshot; the ledger aggregates by source so cost
 * and tokens are real and attributable. Registered by modes.
 */
export interface UsageLedgerV1 {
	/** Upsert a local cumulative snapshot for a source. */
	record(source: UsageSource, snapshot: TokenSnapshot): void;
	/** Accept a durable cumulative checkpoint iff its revision is newer. */
	recordCheckpoint(checkpoint: UsageCheckpoint): boolean;
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
		/** Optional compact workflow boundary id, emitted as Maestro-Stage. */
		readonly maestroStage?: string;
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
	/**
	 * @deprecated Blocking asks no longer capture input — the answer editor
	 * takeover (ask engine) presents them instead. Kept for contract
	 * stability; no current caller.
	 */
	blockInput(): void;
	/**
	 * @deprecated See {@link OverlaysCapabilityV1.blockInput}.
	 */
	unblockInput(): void;
	/** Whether input is currently blocked. Always false since the ask redesign. */
	readonly isInputBlocked: boolean;
}

export interface CapabilityMap {
	[CAPABILITIES.subagents]: SubagentsCapabilityV1;
	[CAPABILITIES.agents]: AgentsCapabilityV1;
	[CAPABILITIES.childRunProjections]: ChildRunProjectionSourceV1;
	[CAPABILITIES.ask]: AskCapabilityV1;
	[CAPABILITIES.askTransport]: AskTransportV1;
	[CAPABILITIES.usage]: UsageLedgerV1;
	[CAPABILITIES.commit]: CommitCapabilityV1;
	[CAPABILITIES.ship]: ShipCapabilityV1;
	[CAPABILITIES.modes]: ModesCapabilityV1;
	[CAPABILITIES.personas]: PersonasCapabilityV1;
	[CAPABILITIES.promptAssist]: PromptAssistCapabilityV1;
	[CAPABILITIES.overlays]: OverlaysCapabilityV1;
	[CAPABILITIES.settings]: SettingsCapabilityV1;
}
