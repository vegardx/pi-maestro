import { canonicalTokenSnapshot } from "@vegardx/pi-contracts";
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
			turns: 0,
		});
		snap = accumulate(snap, {
			input: 50,
			cacheRead: 30,
			cost: { total: 0.005 },
		});
		expect(snap.input).toBe(150);
		expect(snap.cacheRead).toBe(30);
		expect(snap.cost).toBeCloseTo(0.015);
		expect(snap.turns).toBe(0);
		expect(snap.promptTokens).toBe(180);
		expect(snap.totalTokens).toBe(200);
	});

	it("records per-source and aggregates totals", () => {
		const ledger = new UsageLedger();
		ledger.record(
			{ kind: "maestro" },
			accumulate(undefined, { input: 10, cost: { total: 1 } }),
		);
		ledger.record(
			{ kind: "agent", id: "a1" },
			accumulate(undefined, { input: 20, cost: { total: 2 } }),
		);
		const { bySource, totals } = ledger.snapshot();
		expect(bySource.size).toBe(2);
		expect(totals.input).toBe(30);
		expect(totals.cost).toBeCloseTo(3);
		expect(totals.turns).toBe(0);
	});

	it("add() folds per-turn deltas and counts each as a turn", () => {
		const ledger = new UsageLedger();
		const source = { kind: "agent", id: "run-1" } as const;
		ledger.add(source, { input: 100, output: 20, cost: { total: 0.01 } });
		ledger.add(source, { input: 50, output: 10, cacheRead: 30 });
		const { bySource, totals } = ledger.snapshot();
		const snap = bySource.get("agent:run-1");
		expect(snap).toMatchObject({ input: 150, output: 30, cacheRead: 30 });
		expect(snap?.turns).toBe(2);
		expect(totals.promptTokens).toBe(180);
		expect(totals.totalTokens).toBe(210);
		expect(totals.cost).toBeCloseTo(0.01);
	});

	it("derives prompt and total tokens instead of trusting provider totals", () => {
		expect(
			canonicalTokenSnapshot({
				input: 10,
				output: 3,
				cacheRead: 20,
				cacheWrite: 5,
				promptTokens: 999,
				totalTokens: 1,
			}),
		).toMatchObject({ promptTokens: 35, totalTokens: 38 });
	});

	it("retains prior worker generations and rejects stale revisions", () => {
		const ledger = new UsageLedger();
		const snapshot = (input: number) => canonicalTokenSnapshot({ input });
		expect(
			ledger.recordCheckpoint({
				source: { kind: "agent", id: "d/worker", generation: 1 },
				revision: 2,
				snapshot: snapshot(20),
				updatedAt: 2,
			}),
		).toBe(true);
		expect(
			ledger.recordCheckpoint({
				source: { kind: "agent", id: "d/worker", generation: 1 },
				revision: 2,
				snapshot: snapshot(99),
				updatedAt: 3,
			}),
		).toBe(false);
		expect(
			ledger.recordCheckpoint({
				source: { kind: "agent", id: "d/worker", generation: 2 },
				revision: 1,
				snapshot: snapshot(5),
				updatedAt: 4,
			}),
		).toBe(true);
		expect(ledger.snapshot().totals.input).toBe(25);
	});

	it("fences stale run owners without double-counting a reattached run", () => {
		const ledger = new UsageLedger();
		const checkpoint = (
			ownerGeneration: number,
			revision: number,
			input: number,
		) => ({
			source: {
				kind: "run" as const,
				id: "review-1",
				ownerId: "d/worker",
				ownerGeneration,
			},
			revision,
			snapshot: canonicalTokenSnapshot({ input }),
			updatedAt: revision,
		});
		expect(ledger.recordCheckpoint(checkpoint(1, 2, 10))).toBe(true);
		expect(ledger.recordCheckpoint(checkpoint(2, 3, 15))).toBe(true);
		expect(ledger.recordCheckpoint(checkpoint(1, 4, 50))).toBe(false);
		expect(ledger.snapshot().totals.input).toBe(15);
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
