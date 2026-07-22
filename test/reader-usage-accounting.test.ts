// Reader-run usage accounting (docs/design/multi-model-agents.md §8).
//
// Tool-spawned readers (agent spawn / ask) go through the SAME runner as
// node-writers, so each run's usage reaches the ledger as a {kind:"run"}
// source via the shared run-bus → publishUsage path — including cache buckets.
// This locks the invariant the design warns about: the workflow total must
// aggregate reader runs, not "silently count only node-writers". A reader is
// linked to the worker that spawned it by the run source's ownerId (the
// run-parent rollup), and every source lands in one ledger total.

import type { UsageSource } from "@vegardx/pi-contracts";
import { describe, expect, it } from "vitest";
import { UsageLedger } from "../packages/modes/src/usage-ledger.js";

const runSource = (id: string, ownerId?: string): UsageSource => ({
	kind: "run",
	id,
	...(ownerId ? { ownerId } : {}),
});

describe("reader-run usage accounting", () => {
	it("aggregates tool-spawned reader runs into the workflow total, with cache metrics", () => {
		const ledger = new UsageLedger({ now: () => 1 });

		// The maestro's own usage.
		ledger.record(
			{ kind: "maestro" },
			{ input: 100, output: 40, cacheRead: 200, cacheWrite: 10, cost: 0.01 },
		);
		// A node-writer worker.
		ledger.record(runSource("worker-1"), {
			input: 500,
			output: 300,
			cacheRead: 1000,
			cacheWrite: 50,
			cost: 0.05,
		});
		// Two readers the worker fanned out (linked by ownerId → the run-parent
		// rollup). Without a registered source these would be invisible.
		ledger.record(runSource("reviewer-a", "worker-1"), {
			input: 200,
			output: 60,
			cacheRead: 400,
			cacheWrite: 5,
			cost: 0.02,
		});
		ledger.record(runSource("reviewer-b", "worker-1"), {
			input: 150,
			output: 30,
			cacheRead: 300,
			cacheWrite: 5,
			cost: 0.015,
		});

		const { bySource, totals } = ledger.snapshot();

		// Every run is its own source — per-run capture is preserved.
		expect(bySource.size).toBe(4);

		// The reader runs are counted in the total, not just the writer.
		expect(totals.input).toBe(100 + 500 + 200 + 150);
		expect(totals.output).toBe(40 + 300 + 60 + 30);
		expect(totals.cacheRead).toBe(200 + 1000 + 400 + 300);
		expect(totals.cacheWrite).toBe(10 + 50 + 5 + 5);
		expect(totals.cost).toBeCloseTo(0.01 + 0.05 + 0.02 + 0.015, 10);

		// Cache-hit rate over the aggregated total = cacheRead / (input + cacheRead).
		const hitRate = totals.cacheRead / (totals.input + totals.cacheRead);
		expect(hitRate).toBeCloseTo(1900 / (950 + 1900), 10);

		// Dropping the reader sources would understate the total — the exact
		// regression §8 warns against (maestro + worker alone = 600 input).
		expect(totals.input - (200 + 150)).toBe(600);
	});

	it("a later cumulative checkpoint for a reader replaces its prior revision (no double count)", () => {
		const ledger = new UsageLedger({ now: () => 1 });
		ledger.record(runSource("reviewer-a", "worker-1"), {
			input: 100,
			output: 10,
			cacheRead: 100,
			cacheWrite: 0,
			cost: 0.01,
		});
		// Same run, more work — cumulative, replaces the prior snapshot.
		ledger.record(runSource("reviewer-a", "worker-1"), {
			input: 250,
			output: 25,
			cacheRead: 260,
			cacheWrite: 0,
			cost: 0.025,
		});
		const { bySource, totals } = ledger.snapshot();
		expect(bySource.size).toBe(1);
		expect(totals.input).toBe(250); // replaced, not 100 + 250
	});
});
