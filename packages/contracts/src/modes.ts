// Permission modes. Ordered as the Shift+Tab cycle presents them.

export const MODE_NAMES = ["hack", "plan", "ask", "auto"] as const;

export type ModeName = (typeof MODE_NAMES)[number];

export interface ModeChange {
	readonly mode: ModeName;
	readonly previous: ModeName;
}

/** Execution lifecycle stage for the modes runtime in a single session. */
export type ExecutionStage = "idle" | "executing" | "exec-complete";

/**
 * Read-only snapshot of the modes runtime for cross-extension coordination
 * (e.g. smart-compact deciding whether to defer proactive compaction). This is
 * the single source of truth — consumers must use `execution()`, never a
 * second `status()` name.
 */
export interface ModesExecutionStatus {
	readonly mode: ModeName;
	readonly activePlanSlug?: string;
	readonly activeDeliverableId?: string;
	/** True while the session is actively executing a deliverable (ask/auto). */
	readonly executing: boolean;
	/** True while a modes-owned compaction is in flight. */
	readonly compactionInFlight: boolean;
}
