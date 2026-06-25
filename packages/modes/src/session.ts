import type {
	CustomEntry,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ModeName } from "@vegardx/pi-contracts";
import { isModeName, type ModesState } from "./state.js";

export const MODES_STATE_ENTRY = "maestro.modes.state";

export interface PersistedModesState {
	readonly version: 1;
	readonly mode: ModeName;
	readonly activePlanSlug?: string;
	readonly updatedAt: string;
}

export interface SessionStateSink {
	appendEntry<T = unknown>(customType: string, data?: T): void;
}

export function toPersistedState(state: ModesState): PersistedModesState {
	return {
		version: 1,
		mode: state.mode,
		activePlanSlug: state.activePlanSlug,
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
	if (data.version !== 1) return null;
	if (typeof data.mode !== "string" || !isModeName(data.mode)) return null;
	if (typeof data.updatedAt !== "string") return null;
	const activePlanSlug =
		typeof data.activePlanSlug === "string" ? data.activePlanSlug : undefined;
	return { mode: data.mode, activePlanSlug, updatedAt: data.updatedAt };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
