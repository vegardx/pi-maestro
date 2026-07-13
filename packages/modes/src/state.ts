import {
	ALL_MODES,
	type ExecutionStage,
	MODE_NAMES,
	type ModeName,
} from "@vegardx/pi-contracts";

export interface ExecutionState {
	readonly stage: ExecutionStage;
	readonly deliverableId?: string;
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
	return { mode: "plan", execution: { stage: "idle" }, updatedAt: now() };
}

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
	return { ...state, execution, updatedAt: now() };
}

export function isModeName(value: string): value is ModeName {
	return (ALL_MODES as readonly string[]).includes(value);
}

function isoNow(): string {
	return new Date().toISOString();
}
