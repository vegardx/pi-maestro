import { describe, expect, it } from "vitest";
import { accumulate, UsageLedger } from "../packages/modes/src/usage-ledger.js";

describe("usage ledger", () => {
	it("accumulates per-response usage into a cumulative snapshot", () => {
		let snap = accumulate(undefined, {
			input: 100,
			output: 20,
			cost: { total: 0.01 },
		});
		expect(snap).toMatchObject({
			input: 100,
			output: 20,
			cost: 0.01,
			turns: 1,
		});
		snap = accumulate(snap, {
			input: 50,
			cacheRead: 30,
			cost: { total: 0.005 },
		});
		expect(snap.input).toBe(150);
		expect(snap.cacheRead).toBe(30);
		expect(snap.cost).toBeCloseTo(0.015);
		expect(snap.turns).toBe(2);
		expect(snap.totalTokens).toBe(170);
	});

	it("records per-source and aggregates totals", () => {
		const ledger = new UsageLedger();
		ledger.record(
			{ kind: "orchestrator" },
			accumulate(undefined, { input: 10, cost: { total: 1 } }),
		);
		ledger.record(
			{ kind: "agent", id: "a1" },
			accumulate(undefined, { input: 20, cost: { total: 2 } }),
		);
		ledger.record(
			{ kind: "lens", parentAgentId: "a1", lens: "review" },
			accumulate(undefined, { input: 5, cost: { total: 0.5 } }),
		);
		const { bySource, totals } = ledger.snapshot();
		expect(bySource.size).toBe(3);
		expect(totals.input).toBe(35);
		expect(totals.cost).toBeCloseTo(3.5);
		expect(totals.turns).toBe(3);
	});

	it("upserts the snapshot for a source key", () => {
		const ledger = new UsageLedger();
		ledger.record(
			{ kind: "agent", id: "a1" },
			accumulate(undefined, { input: 1 }),
		);
		ledger.record(
			{ kind: "agent", id: "a1" },
			accumulate(undefined, { input: 9 }),
		);
		expect(ledger.snapshot().totals.input).toBe(9);
	});
});
