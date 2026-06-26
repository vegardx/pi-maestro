import { describe, expect, it } from "vitest";
import {
	calibrateSys,
	calibrationKey,
	computeBuckets,
	estimateTokens,
	formatBudget,
} from "../packages/modes/src/budget.js";
import {
	collectBudgetText,
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

describe("budget bucket math", () => {
	it("estimates tokens at ~chars/4", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcde")).toBe(2);
	});

	it("splits a known total into working and summary buckets", () => {
		const b = computeBuckets({
			total: 1000,
			sys: 200,
			seed: 100,
			rollingSummary: 300,
		});
		expect(b.hotTail).toBe(400);
		expect(b.workingUsed).toBe(600); // sys + hotTail
		expect(b.summaryUsed).toBe(400); // seed + rollingSummary
	});

	it("reports hotTail=0 and never goes negative when total is unknown", () => {
		const b = computeBuckets({
			total: null,
			sys: 200,
			seed: 100,
			rollingSummary: 300,
		});
		expect(b.hotTail).toBe(0);
		expect(b.workingUsed).toBe(200);
		expect(b.summaryUsed).toBe(400);
	});

	it("clamps hotTail at zero when stable buckets exceed total", () => {
		const b = computeBuckets({
			total: 100,
			sys: 200,
			seed: 100,
			rollingSummary: 300,
		});
		expect(b.hotTail).toBe(0);
	});

	it("calibrates sys from a usage sample and never goes negative", () => {
		expect(
			calibrateSys({
				total: 1000,
				seed: 100,
				rollingSummary: 300,
				hotTailEstimate: 200,
			}),
		).toBe(400);
		expect(
			calibrateSys({
				total: 100,
				seed: 100,
				rollingSummary: 300,
				hotTailEstimate: 200,
			}),
		).toBe(0);
	});

	it("invalidates calibration when mode/tools/prompt length change", () => {
		const base = {
			mode: "auto",
			toolSignature: "read,edit",
			systemPromptLength: 1000,
		};
		expect(calibrationKey(base)).toBe(calibrationKey({ ...base }));
		expect(calibrationKey(base)).not.toBe(
			calibrationKey({ ...base, mode: "ask" }),
		);
		expect(calibrationKey(base)).not.toBe(
			calibrationKey({ ...base, toolSignature: "read" }),
		);
		expect(calibrationKey(base)).not.toBe(
			calibrationKey({ ...base, systemPromptLength: 1001 }),
		);
	});

	it("formats budget as total/limit (sys/summary/work)", () => {
		const b = computeBuckets({
			total: 1000,
			sys: 200,
			seed: 100,
			rollingSummary: 300,
		});
		expect(formatBudget(b, 250000)).toBe("1000/250000 (200/400/400)");
	});

	it("renders ? for an unknown total", () => {
		const b = computeBuckets({
			total: null,
			sys: 200,
			seed: 100,
			rollingSummary: 300,
		});
		expect(formatBudget(b, 250000)).toBe("?/250000 (200/400/0)");
	});
});

describe("modes compaction settings", () => {
	it("returns documented defaults for an unconfigured cwd", () => {
		const s = readModesCompactionSettings("/no/such/project");
		expect(s.phaseTokens).toBe(10000);
		expect(s.workingTokens).toBe(150000);
		expect(s.summaryTokens).toBe(100000);
		expect(s.timeoutMs).toBe(90000);
		expect(s.planMaxContextTokens).toBeUndefined();
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
				mode: "ask",
				activePlanSlug: "p1",
				updatedAt: now(),
			}),
		]);
		expect(hydrated?.execution).toEqual({ stage: "idle" });
		expect(hydrated?.mode).toBe("ask");
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

describe("budget text extraction", () => {
	it("separates seed, rolling summary, and hot tail", () => {
		const entries = [
			{
				type: "compaction" as const,
				id: "1",
				parentId: null,
				timestamp: "t",
				summary: "rolling summary text",
				firstKeptEntryId: "x",
				tokensBefore: 0,
			},
			{
				type: "custom_message" as const,
				id: "2",
				parentId: null,
				timestamp: "t",
				customType: EXECUTION_SEED_ENTRY,
				content: "seed body",
				display: true,
				details: { deliverableId: "d1" },
			},
			{
				type: "message" as const,
				id: "3",
				parentId: null,
				timestamp: "t",
				message: { role: "user", content: "hello tail" },
			},
		];
		const text = collectBudgetText(entries as never);
		expect(text.rollingSummary).toBe("rolling summary text");
		expect(text.seed).toBe("seed body");
		expect(text.hotTail).toContain("hello tail");
		// The seed must not be double-counted in the hot tail.
		expect(text.hotTail).not.toContain("seed body");
	});
});

describe("footer telemetry", () => {
	it("includes a pre-formatted budget breakdown when provided", () => {
		const footer = renderModeFooter({
			mode: "auto",
			budget: "1000/250000 (200/400/400)",
		});
		expect(footer).toContain("1000/250000 (200/400/400)");
	});

	it("omits budget when not provided", () => {
		const footer = renderModeFooter({ mode: "hack" });
		expect(footer).toBe("maestro:hack");
	});
});
