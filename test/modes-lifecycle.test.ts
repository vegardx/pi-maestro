import { describe, expect, it } from "vitest";
import {
	EXECUTION_SEED_ENTRY,
	hasExecutionSeed,
	hydrateModesState,
	MODES_STATE_ENTRY,
	toPersistedState,
} from "../packages/modes/src/session.js";
import {
	readExecutionLifecycleSettings,
	readModesCompactionSettings,
} from "../packages/modes/src/settings.js";
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

describe("execution lifecycle settings", () => {
	it("defaults stop grace to five seconds", () => {
		expect(readExecutionLifecycleSettings("/no/such/project").stopGraceMs).toBe(
			5000,
		);
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

	it("supports stopping and stopped transitions", () => {
		const working = setExecution(
			initialModesState(now),
			{ stage: "executing", deliverableId: "d1" },
			now,
		);
		const stopping = setExecution(
			working,
			{ stage: "stopping", deliverableId: "d1" },
			now,
		);
		const completedAt = 1_782_432_000_000;
		const stop = {
			kind: "interrupted" as const,
			requestedAt: completedAt - 10,
			completedAt,
			reason: "session shutdown",
			outcome: "accepted" as const,
			recoverable: true,
		};
		const stopped = setExecution(
			stopping,
			{ stage: "stopped", completedAt, stop },
			now,
		);
		expect(stopped.execution).toEqual({ stage: "stopped", completedAt, stop });
		const restarted = setExecution(
			stopped,
			{ stage: "executing", deliverableId: "d1" },
			now,
		);
		expect(restarted.execution).toEqual({
			stage: "executing",
			deliverableId: "d1",
		});
		expect(() =>
			setExecution(
				stopped,
				{
					stage: "stopped",
					completedAt: completedAt + 1,
					stop: { ...stop, completedAt: completedAt + 1 },
				},
				now,
			),
		).toThrow(/completion timestamp is immutable/);
	});

	it("rejects illegal execution stage jumps", () => {
		expect(() =>
			setExecution(initialModesState(now), { stage: "stopping" }, now),
		).toThrow(/illegal execution transition/);
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

	it("round-trips the forward-transition seed + plan-session paths", () => {
		const state = {
			...initialModesState(now),
			mode: "auto" as const,
			activePlanSlug: "p1",
			executionSeedPath: "/plans/p1/transitions/01-execution.md",
			planSessionPath: "/sessions/plan-abc.jsonl",
		};
		const hydrated = hydrateModesState([stateEntry(toPersistedState(state))]);
		expect(hydrated?.executionSeedPath).toBe(
			"/plans/p1/transitions/01-execution.md",
		);
		expect(hydrated?.planSessionPath).toBe("/sessions/plan-abc.jsonl");
	});

	it("rejects legacy execution entries with reset guidance", () => {
		expect(() =>
			hydrateModesState([
				stateEntry({
					version: 1,
					mode: "auto",
					activePlanSlug: "p1",
					updatedAt: now(),
				}),
			]),
		).toThrow(/archive or reset the old Maestro session state/);
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
