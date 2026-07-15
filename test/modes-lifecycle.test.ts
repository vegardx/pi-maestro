import { describe, expect, it } from "vitest";
import {
	EXECUTION_SEED_ENTRY,
	hasExecutionSeed,
	hydrateModesState,
	MODES_STATE_ENTRY,
	toPersistedState,
} from "../packages/modes/src/session.js";
import { readModesCompactionSettings } from "../packages/modes/src/settings.js";
import {
	initialModesState,
	setExecution,
} from "../packages/modes/src/state.js";
import { renderModeFooter } from "../packages/modes/src/ui.js";

const now = () => "2026-06-26T00:00:00.000Z";

describe("modes compaction settings", () => {
	it("returns documented defaults for an unconfigured cwd", () => {
		const s = readModesCompactionSettings("/no/such/project");
		expect(s.phaseTokens).toBe(10000);
		expect(s.timeoutMs).toBe(90000);
	});
});

describe("execution lifecycle state", () => {
	it("starts idle", () => {
		expect(initialModesState(now).execution).toEqual({ stage: "idle" });
	});

	it("records an executing deliverable", () => {
		const next = setExecution(
			initialModesState(now),
			{ stage: "executing", deliverableId: "d1" },
			now,
		);
		expect(next.execution).toEqual({
			stage: "executing",
			deliverableId: "d1",
		});
	});
});

describe("execution lifecycle persistence", () => {
	function stateEntry(data: unknown) {
		return {
			type: "custom" as const,
			id: "1",
			parentId: null,
			timestamp: "t",
			customType: MODES_STATE_ENTRY,
			data,
		};
	}

	it("round-trips execution stage through persisted v2 state", () => {
		const state = setExecution(
			{ ...initialModesState(now), mode: "auto", activePlanSlug: "p1" },
			{ stage: "executing", deliverableId: "d1" },
			now,
		);
		const hydrated = hydrateModesState([stateEntry(toPersistedState(state))]);
		expect(hydrated?.execution).toEqual({
			stage: "executing",
			deliverableId: "d1",
		});
		expect(hydrated?.mode).toBe("auto");
	});

	it("defaults execution to idle for legacy v1 state entries", () => {
		const hydrated = hydrateModesState([
			stateEntry({
				version: 1,
				mode: "auto",
				activePlanSlug: "p1",
				updatedAt: now(),
			}),
		]);
		expect(hydrated?.execution).toEqual({ stage: "idle" });
		expect(hydrated?.mode).toBe("auto");
	});
});

describe("stable execution seed detection", () => {
	function seedEntry(deliverableId: string) {
		return {
			type: "custom_message" as const,
			id: "1",
			parentId: null,
			timestamp: "t",
			customType: EXECUTION_SEED_ENTRY,
			content: "seed body",
			display: true,
			details: { deliverableId },
		};
	}

	it("detects an existing seed for a deliverable", () => {
		expect(hasExecutionSeed([seedEntry("d1")], "d1")).toBe(true);
		expect(hasExecutionSeed([seedEntry("d1")], "d2")).toBe(false);
		expect(hasExecutionSeed([], "d1")).toBe(false);
	});
});

describe("footer telemetry", () => {
	it("renders the bare mode when nothing else is set", () => {
		const footer = renderModeFooter({ mode: "hack" });
		expect(footer).toBe("maestro:hack");
	});
});
