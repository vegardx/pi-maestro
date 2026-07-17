// Permission modes and orchestration workflow vocabulary.

export const MODE_NAMES = ["plan", "auto"] as const;
export const ALL_MODES = ["recon", "plan", "auto", "hack", "agent"] as const;
export type ModeName = (typeof ALL_MODES)[number];
export type CycleModeName = (typeof MODE_NAMES)[number];

export interface ModeChange {
	readonly mode: ModeName;
	readonly previous: ModeName;
}

/** Persisted execution-state schema. Older session entries must be reset. */
export const EXECUTION_STATE_SCHEMA_VERSION = 3 as const;

export const WORKFLOW_STAGES = [
	"exploring",
	"structuring",
	"ready",
	"executing",
	"reviewing",
	"shipping",
	"complete",
	"failed",
	"stopping",
	"stopped",
] as const;
export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

export const EXECUTION_STAGES = [
	"idle",
	"executing",
	"stopping",
	"stopped",
	"exec-complete",
] as const;
export type ExecutionStage = (typeof EXECUTION_STAGES)[number];

export const EXECUTION_STAGE_TRANSITIONS = {
	idle: ["executing", "stopped"],
	executing: ["stopping", "exec-complete"],
	stopping: ["stopped"],
	stopped: ["idle", "executing"],
	"exec-complete": ["idle", "executing"],
} as const satisfies Record<ExecutionStage, readonly ExecutionStage[]>;

export function canTransitionExecutionStage(
	from: ExecutionStage,
	to: ExecutionStage,
): boolean {
	return (
		EXECUTION_STAGE_TRANSITIONS[from] as readonly ExecutionStage[]
	).includes(to);
}

export interface ModesExecutionStatus {
	readonly mode: ModeName;
	readonly activePlanSlug?: string;
	readonly activeDeliverableId?: string;
	readonly stage?: ExecutionStage;
	readonly workflowStage?: WorkflowStage;
	readonly executing: boolean;
	readonly compactionInFlight: boolean;
}
