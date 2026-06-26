import type {
	CompactionEntry,
	CustomEntry,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ModeName } from "@vegardx/pi-contracts";
import { type ExecutionState, isModeName, type ModesState } from "./state.js";

export const MODES_STATE_ENTRY = "maestro.modes.state";

/** Custom entry type for the byte-stable execution seed (see runtime). */
export const EXECUTION_SEED_ENTRY = "maestro.execution.seed";

export interface PersistedModesState {
	readonly version: 2;
	readonly mode: ModeName;
	readonly activePlanSlug?: string;
	readonly execution: ExecutionState;
	readonly updatedAt: string;
}

export interface SessionStateSink {
	appendEntry<T = unknown>(customType: string, data?: T): void;
}

export function toPersistedState(state: ModesState): PersistedModesState {
	return {
		version: 2,
		mode: state.mode,
		activePlanSlug: state.activePlanSlug,
		execution: state.execution,
		updatedAt: state.updatedAt,
	};
}

export function appendModesState(
	sink: SessionStateSink,
	state: ModesState,
): void {
	sink.appendEntry(MODES_STATE_ENTRY, toPersistedState(state));
}

export function hydrateModesState(
	entries: readonly SessionEntry[],
): ModesState | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== MODES_STATE_ENTRY) {
			continue;
		}
		return parseStateEntry(entry);
	}
	return null;
}

function parseStateEntry(entry: CustomEntry): ModesState | null {
	const data = entry.data;
	if (!isObject(data)) return null;
	if (data.version !== 1 && data.version !== 2) return null;
	if (typeof data.mode !== "string" || !isModeName(data.mode)) return null;
	if (typeof data.updatedAt !== "string") return null;
	const activePlanSlug =
		typeof data.activePlanSlug === "string" ? data.activePlanSlug : undefined;
	return {
		mode: data.mode,
		activePlanSlug,
		execution: parseExecution(data.execution),
		updatedAt: data.updatedAt,
	};
}

function parseExecution(value: unknown): ExecutionState {
	if (!isObject(value)) return { stage: "idle" };
	const stage = value.stage;
	const valid =
		stage === "idle" || stage === "executing" || stage === "exec-complete";
	return {
		stage: valid ? stage : "idle",
		deliverableId:
			typeof value.deliverableId === "string" ? value.deliverableId : undefined,
	};
}

/** True when a stable execution seed for `deliverableId` is already in session. */
export function hasExecutionSeed(
	entries: readonly SessionEntry[],
	deliverableId: string,
): boolean {
	return entries.some(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === EXECUTION_SEED_ENTRY &&
			isObject(entry.details) &&
			(entry.details as { deliverableId?: unknown }).deliverableId ===
				deliverableId,
	);
}

export interface BudgetText {
	/** Latest execution-seed content (seed bucket). */
	readonly seed: string;
	/** Latest compaction summary (rolling-summary bucket). */
	readonly rollingSummary: string;
	/** Live message tail since the latest compaction (hot-tail bucket). */
	readonly hotTail: string;
}

/**
 * Extract the raw text behind each context bucket so the caller can estimate
 * tokens. Session-coupled extraction lives here; the arithmetic lives in
 * budget.ts. The seed and rolling summary are excluded from the hot tail.
 */
export function collectBudgetText(
	entries: readonly SessionEntry[],
): BudgetText {
	let compactionIdx = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			compactionIdx = i;
			break;
		}
	}
	const rollingSummary =
		compactionIdx >= 0
			? ((entries[compactionIdx] as CompactionEntry).summary ?? "")
			: "";

	let seed = "";
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (
			entry.type === "custom_message" &&
			entry.customType === EXECUTION_SEED_ENTRY
		) {
			seed =
				typeof entry.content === "string"
					? entry.content
					: JSON.stringify(entry.content);
			break;
		}
	}

	const tail: string[] = [];
	for (let i = compactionIdx + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type === "message") {
			tail.push(JSON.stringify(entry.message));
		} else if (entry.type === "custom_message") {
			if (entry.customType === EXECUTION_SEED_ENTRY) continue;
			tail.push(
				typeof entry.content === "string"
					? entry.content
					: JSON.stringify(entry.content),
			);
		}
	}
	return { seed, rollingSummary, hotTail: tail.join("\n") };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
