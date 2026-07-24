import type {
	CompactionEntry,
	CustomEntry,
	SessionEntry,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import {
	EXECUTION_STAGES,
	EXECUTION_STATE_SCHEMA_VERSION,
	type ModeName,
} from "@vegardx/pi-contracts";
import { type ExecutionState, isModeName, type ModesState } from "./state.js";

export const MODES_STATE_ENTRY = "maestro.modes.state";

/** Custom entry type for the byte-stable execution seed (see runtime). */
export const EXECUTION_SEED_ENTRY = "maestro.execution.seed";

/** Versioned worker/reviewer context persisted for audit and corpus extraction. */
export const AGENT_CONTEXT_ENTRY = "maestro.agent.context";

export interface PersistedModesState {
	readonly version: typeof EXECUTION_STATE_SCHEMA_VERSION;
	readonly mode: ModeName;
	readonly activePlanSlug?: string;
	readonly execution: ExecutionState;
	readonly updatedAt: string;
	readonly pendingHandoffSeedPath?: string;
	readonly executionSeedPath?: string;
	readonly planSessionPath?: string;
	readonly reconReturnSessionPath?: string;
}

export interface SessionStateSink {
	appendEntry<T = unknown>(customType: string, data?: T): void;
}

export class UnsupportedExecutionStateError extends Error {
	constructor(found: unknown) {
		super(
			`Unsupported Maestro execution state schema ${String(found)} (expected ${EXECUTION_STATE_SCHEMA_VERSION}). ` +
				"This release is a full cutover; archive or reset the old Maestro session state and retry.",
		);
		this.name = "UnsupportedExecutionStateError";
	}
}

export function toPersistedState(state: ModesState): PersistedModesState {
	return {
		version: EXECUTION_STATE_SCHEMA_VERSION,
		mode: state.mode,
		activePlanSlug: state.activePlanSlug,
		execution: state.execution,
		updatedAt: state.updatedAt,
		pendingHandoffSeedPath: state.pendingHandoffSeedPath,
		executionSeedPath: state.executionSeedPath,
		planSessionPath: state.planSessionPath,
		reconReturnSessionPath: state.reconReturnSessionPath,
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
		const data = entry.data;
		if (isObject(data) && data.version !== EXECUTION_STATE_SCHEMA_VERSION) {
			throw new UnsupportedExecutionStateError(data.version ?? "missing");
		}
		return parseStateEntry(entry);
	}
	return null;
}

function parseStateEntry(entry: CustomEntry): ModesState | null {
	const data = entry.data;
	if (!isObject(data)) return null;
	if (data.version !== EXECUTION_STATE_SCHEMA_VERSION) {
		throw new UnsupportedExecutionStateError(data.version ?? "missing");
	}
	if (typeof data.mode !== "string" || !isModeName(data.mode)) return null;
	if (typeof data.updatedAt !== "string") return null;
	const activePlanSlug =
		typeof data.activePlanSlug === "string" ? data.activePlanSlug : undefined;
	return {
		mode: data.mode,
		activePlanSlug,
		execution: parseExecution(data.execution),
		updatedAt: data.updatedAt,
		...(typeof data.pendingHandoffSeedPath === "string"
			? { pendingHandoffSeedPath: data.pendingHandoffSeedPath }
			: {}),
		...(typeof data.executionSeedPath === "string"
			? { executionSeedPath: data.executionSeedPath }
			: {}),
		...(typeof data.planSessionPath === "string"
			? { planSessionPath: data.planSessionPath }
			: {}),
		...(typeof data.reconReturnSessionPath === "string"
			? { reconReturnSessionPath: data.reconReturnSessionPath }
			: {}),
	};
}

function parseExecution(value: unknown): ExecutionState {
	if (!isObject(value)) {
		throw new Error(
			"Invalid Maestro execution state: execution must be an object",
		);
	}
	const stage = value.stage;
	if (
		typeof stage !== "string" ||
		!EXECUTION_STAGES.includes(stage as (typeof EXECUTION_STAGES)[number])
	) {
		throw new Error(
			`Invalid Maestro execution state: unsupported stage ${String(stage)}`,
		);
	}
	const completedAt =
		typeof value.completedAt === "number" && Number.isFinite(value.completedAt)
			? value.completedAt
			: undefined;
	const stop = parseStopRecord(value.stop);
	if (stage === "stopped" && (completedAt === undefined || !stop)) {
		throw new Error(
			"Invalid Maestro execution state: stopped requires completedAt and stop record",
		);
	}
	if (
		stage !== "stopped" &&
		(completedAt !== undefined || stop !== undefined)
	) {
		throw new Error(
			"Invalid Maestro execution state: completion metadata requires stopped",
		);
	}
	return {
		stage: stage as ExecutionState["stage"],
		deliverableId:
			typeof value.deliverableId === "string" ? value.deliverableId : undefined,
		...(completedAt !== undefined ? { completedAt } : {}),
		...(stop ? { stop } : {}),
	};
}

function parseStopRecord(value: unknown): ExecutionState["stop"] | undefined {
	if (!isObject(value)) return undefined;
	if (
		!["completed", "failed", "canceled", "interrupted", "timed-out"].includes(
			String(value.kind),
		) ||
		typeof value.completedAt !== "number" ||
		!Number.isFinite(value.completedAt) ||
		typeof value.recoverable !== "boolean"
	) {
		return undefined;
	}
	return value as unknown as NonNullable<ExecutionState["stop"]>;
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

/** Latest rolling summary + the raw message tail after it, for ship-time
 * carry-forward distillation (cut at the latest compaction entry). */
export interface CarryForwardInput {
	readonly rollingSummary: string;
	readonly rawTail: SessionMessageEntry["message"][];
}

export function collectCarryForwardInput(
	entries: readonly SessionEntry[],
): CarryForwardInput {
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
	const rawTail: SessionMessageEntry["message"][] = [];
	for (let i = compactionIdx + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type === "message") {
			rawTail.push((entry as SessionMessageEntry).message);
		}
	}
	return { rollingSummary, rawTail };
}

/**
 * Decide whether ship-time summarisation may read the current session for
 * `deliverable`. Ship summaries must distil the deliverable's OWN execution
 * session: if it recorded a different `sessionPath`, refuse (soft-fail). When
 * no path is recorded, the current session is taken as the execution session.
 */
export function resolveShipSummaryInput(
	entries: readonly SessionEntry[],
	deliverable: { readonly sessionPath?: string },
	currentSessionFile: string | undefined,
):
	| { readonly ok: true; readonly input: CarryForwardInput }
	| { readonly ok: false; readonly reason: string } {
	if (
		deliverable.sessionPath &&
		currentSessionFile &&
		deliverable.sessionPath !== currentSessionFile
	) {
		return {
			ok: false,
			reason: "ship runs from a different session than the deliverable's",
		};
	}
	const input = collectCarryForwardInput(entries);
	if (!input.rollingSummary && input.rawTail.length === 0) {
		return { ok: false, reason: "no session content to summarise" };
	}
	return { ok: true, input };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
