import {
	ALL_MODES,
	canTransitionExecutionStage,
	type ExecutionStage,
	MODE_NAMES,
	type ModeName,
	type StopRecord,
} from "@vegardx/pi-contracts";

export interface ExecutionState {
	readonly stage: ExecutionStage;
	readonly deliverableId?: string;
	/** Set exactly once when execution first reaches stopped. */
	readonly completedAt?: number;
	/** Compact durable provenance for the bounded stop. */
	readonly stop?: StopRecord;
}

export interface ModesState {
	mode: ModeName;
	activePlanSlug?: string;
	execution: ExecutionState;
	updatedAt: string;
	/**
	 * Path of the /handoff seed document this session was opened from. While
	 * set (and no plan is active) the doc rides the plan-mode system prompt as
	 * raw material for the next plan; session_start uses it to render the
	 * arrival card + fire the orientation turn exactly once.
	 */
	pendingHandoffSeedPath?: string;
}

export const MODE_CYCLE: readonly ModeName[] = MODE_NAMES;

export function initialModesState(now: () => string = isoNow): ModesState {
	return { mode: "recon", execution: { stage: "idle" }, updatedAt: now() };
}

/**
 * Next mode in the Shift+Tab cycle. Off-cycle modes (recon/hack/agent) are
 * not in MODE_CYCLE — indexOf yields -1, so they all exit into the cycle's
 * first entry, plan. That IS the exit ramp, not an accident.
 */
export function nextMode(mode: ModeName): ModeName {
	const idx = MODE_CYCLE.indexOf(mode);
	return MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
}

export function transitionMode(
	state: ModesState,
	mode: ModeName,
	now: () => string = isoNow,
): { state: ModesState; previous: ModeName } {
	return {
		previous: state.mode,
		state: { ...state, mode, updatedAt: now() },
	};
}

export function setActivePlan(
	state: ModesState,
	activePlanSlug: string | undefined,
	now: () => string = isoNow,
): ModesState {
	return { ...state, activePlanSlug, updatedAt: now() };
}

export function setExecution(
	state: ModesState,
	execution: ExecutionState,
	now: () => string = isoNow,
): ModesState {
	if (
		state.execution.stage !== execution.stage &&
		!canTransitionExecutionStage(state.execution.stage, execution.stage)
	) {
		throw new Error(
			`illegal execution transition: ${state.execution.stage} → ${execution.stage}`,
		);
	}
	if (
		state.execution.completedAt !== undefined &&
		execution.completedAt !== state.execution.completedAt
	) {
		throw new Error("execution completion timestamp is immutable");
	}
	if (execution.stage === "stopped") {
		if (execution.completedAt === undefined || execution.stop === undefined) {
			throw new Error("stopped execution requires completedAt and stop record");
		}
		if (execution.stop.completedAt !== execution.completedAt) {
			throw new Error("execution stop timestamp must match completedAt");
		}
	} else if (execution.completedAt !== undefined || execution.stop !== undefined) {
		throw new Error("only stopped execution may carry completion metadata");
	}
	return { ...state, execution, updatedAt: now() };
}

export function isModeName(value: string): value is ModeName {
	return (ALL_MODES as readonly string[]).includes(value);
}

function isoNow(): string {
	return new Date().toISOString();
}
