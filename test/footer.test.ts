import { describe, expect, it } from "vitest";
import { composeFooterLine } from "../packages/modes/src/footer.js";
import {
	formatCacheHitRate,
	formatContextUsage,
	formatSessionUsage,
} from "../packages/modes/src/install-footer.js";
import { UsageLedger } from "../packages/modes/src/usage-ledger.js";

describe("composeFooterLine", () => {
	it("renders left and right with gap", () => {
		const line = composeFooterLine(
			"left",
			[{ visible: "right", styled: "right" }],
			20,
		);
		expect(line).toBe("left           right");
	});

	it("returns empty string for zero width", () => {
		expect(
			composeFooterLine("left", [{ visible: "right", styled: "right" }], 0),
		).toBe("");
	});

	it("truncates left when right takes most of the space", () => {
		const line = composeFooterLine(
			"very long left text",
			[{ visible: "right", styled: "right" }],
			12,
		);
		// Right side should still be present
		expect(line).toContain("right");
		// Left part should be truncated (not full original)
		expect(line).not.toContain("very long left text");
	});

	it("falls through to sparsest candidate when full does not fit", () => {
		const candidates = [
			{
				visible: "this is very long and will not fit",
				styled: "this is very long and will not fit",
			},
			{ visible: "short", styled: "SHORT" },
		];
		const line = composeFooterLine("L", candidates, 10);
		expect(line).toContain("SHORT");
	});

	it("uses empty sentinel when nothing fits", () => {
		const candidates = [
			{ visible: "way too long for 5 cols", styled: "way too long for 5 cols" },
		];
		const line = composeFooterLine("AB", candidates, 5);
		// Should fall through to empty sentinel, rendering only left (no gap)
		expect(line).toBe("AB");
	});
});

describe("formatSessionUsage", () => {
	it("returns null for empty ledger", () => {
		const ledger = new UsageLedger();
		expect(formatSessionUsage(ledger)).toBeNull();
	});

	it("formats input/output with arrows", () => {
		const ledger = new UsageLedger();
		ledger.record(
			{ kind: "maestro" },
			{
				input: 50000,
				output: 12000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 62000,
				cost: 0,
				turns: 1,
			},
		);
		expect(formatSessionUsage(ledger)).toBe("↑50k ↓12k");
	});

	it("sums across multiple sources", () => {
		const ledger = new UsageLedger();
		ledger.record(
			{ kind: "maestro" },
			{
				input: 10000,
				output: 5000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15000,
				cost: 0,
				turns: 1,
			},
		);
		ledger.record(
			{ kind: "agent", id: "a1" },
			{
				input: 20000,
				output: 8000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 28000,
				cost: 0,
				turns: 2,
			},
		);
		expect(formatSessionUsage(ledger)).toBe("↑30k ↓13k");
	});

	it("shows raw numbers below 1000", () => {
		const ledger = new UsageLedger();
		ledger.record(
			{ kind: "maestro" },
			{
				input: 500,
				output: 200,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 700,
				cost: 0,
				turns: 1,
			},
		);
		expect(formatSessionUsage(ledger)).toBe("↑500 ↓200");
	});
});

describe("formatCacheHitRate", () => {
	it("returns null for empty ledger", () => {
		const ledger = new UsageLedger();
		expect(formatCacheHitRate(ledger)).toBeNull();
	});

	it("returns null when no source has input", () => {
		const ledger = new UsageLedger();
		ledger.record(
			{ kind: "maestro" },
			{
				input: 0,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: 0,
				turns: 1,
			},
		);
		expect(formatCacheHitRate(ledger)).toBeNull();
	});

	it("computes rate for single source", () => {
		const ledger = new UsageLedger();
		ledger.record(
			{ kind: "maestro" },
			{
				input: 20000,
				output: 5000,
				cacheRead: 80000,
				cacheWrite: 0,
				totalTokens: 25000,
				cost: 0,
				turns: 3,
			},
		);
		// rate = 80000 / (20000 + 80000) = 0.8 → 80%
		expect(formatCacheHitRate(ledger)).toBe("CH 80%");
	});

	it("uses a token-weighted fleet rate across differently sized sources", () => {
		const ledger = new UsageLedger();
		// Source 1: 50% cache hit
		ledger.record(
			{ kind: "maestro" },
			{
				input: 10000,
				output: 5000,
				cacheRead: 10000,
				cacheWrite: 0,
				totalTokens: 15000,
				cost: 0,
				turns: 1,
			},
		);
		// Source 2: 80% cache hit
		ledger.record(
			{ kind: "agent", id: "a1" },
			{
				input: 4000,
				output: 2000,
				cacheRead: 16000,
				cacheWrite: 0,
				totalTokens: 6000,
				cost: 0,
				turns: 1,
			},
		);
		// Weighted: (10000 + 16000) / (20000 + 20000) = 65%.
		expect(formatCacheHitRate(ledger)).toBe("CH 65%");
	});

	it("counts cache writes as prompt misses", () => {
		const ledger = new UsageLedger();
		ledger.record(
			{ kind: "maestro" },
			{
				input: 10,
				output: 0,
				cacheRead: 80,
				cacheWrite: 10,
				totalTokens: 1,
				cost: 0,
				turns: 1,
			},
		);
		expect(formatCacheHitRate(ledger)).toBe("CH 80%");
	});

	it("ignores output-only sources in the prompt denominator", () => {
		const ledger = new UsageLedger();
		// Source 1: has input, 75% cache hit
		ledger.record(
			{ kind: "maestro" },
			{
				input: 5000,
				output: 1000,
				cacheRead: 15000,
				cacheWrite: 0,
				totalTokens: 6000,
				cost: 0,
				turns: 1,
			},
		);
		// Source 2: zero input and zero cacheRead (skipped)
		ledger.record(
			{ kind: "agent", id: "a1" },
			{
				input: 0,
				output: 500,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 500,
				cost: 0,
				turns: 1,
			},
		);
		// Output-only source does not change 15000 / 20000 = 75%.
		expect(formatCacheHitRate(ledger)).toBe("CH 75%");
	});
});

describe("formatContextUsage", () => {
	const fake = (usage: unknown) =>
		({ getContextUsage: () => usage }) as unknown as Parameters<
			typeof formatContextUsage
		>[0];

	it("returns null when no usage is available", () => {
		expect(formatContextUsage(fake(undefined))).toBeNull();
		expect(
			formatContextUsage(fake({ tokens: 5, contextWindow: 0, percent: 0 })),
		).toBeNull();
	});

	it("formats tokens/window and stays muted at low fill", () => {
		expect(
			formatContextUsage(
				fake({ tokens: 84_000, contextWindow: 200_000, percent: 42 }),
			),
		).toEqual({ visible: "84k/200k", color: "muted" });
	});

	it("escalates warning past 70% and error past 90%", () => {
		expect(
			formatContextUsage(
				fake({ tokens: 150_000, contextWindow: 200_000, percent: 75 }),
			)?.color,
		).toBe("warning");
		expect(
			formatContextUsage(
				fake({ tokens: 186_000, contextWindow: 200_000, percent: 93 }),
			)?.color,
		).toBe("error");
	});

	it("shows ?/window right after compaction (tokens unknown)", () => {
		expect(
			formatContextUsage(
				fake({ tokens: null, contextWindow: 200_000, percent: null }),
			),
		).toEqual({ visible: "?/200k", color: "muted" });
	});
});
