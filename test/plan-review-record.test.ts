// The reviewed-fingerprint stamp. `/review` and the transition gate write to
// the SAME ledger, so "was this exact plan reviewed?" has one answer regardless
// of which surface ran the review — that lookup is what lets starting work tell
// you the plan drifted since it was judged.

import { describe, expect, it } from "vitest";
import type { Plan } from "../packages/modes/src/plan/schema.js";
import {
	lastReviewedFingerprint,
	recordPlanReview,
} from "../packages/modes/src/transition-gates.js";

type GateRow = { id: string } & Record<string, unknown>;

/** Minimal engine stub: setTransitionGate upserts by id, like the real one. */
function ledger() {
	const plan = { transitionGates: [] as GateRow[] } as unknown as Plan;
	const rows = plan.transitionGates as unknown as GateRow[];
	const engine = {
		get: () => plan,
		setTransitionGate: (row: GateRow) => {
			const at = rows.findIndex((existing) => existing.id === row.id);
			if (at >= 0) rows[at] = row;
			else rows.push(row);
		},
	} as unknown as Parameters<typeof recordPlanReview>[0];
	return { plan, engine, rows };
}

describe("recordPlanReview", () => {
	it("stamps a clean review as settled at that fingerprint", () => {
		const { plan, engine } = ledger();
		recordPlanReview(engine, {
			mode: "plan",
			fingerprint: "abc123",
			at: "2026-07-27T00:00:00.000Z",
			validations: [],
			reviewSummary: "looks fine",
		});
		expect(lastReviewedFingerprint(plan)).toBe("abc123");
	});

	it("does not stamp a blocked review", () => {
		// A review that could not run says nothing about the plan's quality —
		// treating it as "reviewed" would silently skip the drift warning.
		const { plan, engine } = ledger();
		recordPlanReview(engine, {
			mode: "plan",
			fingerprint: "abc123",
			at: "2026-07-27T00:00:00.000Z",
			validations: [],
			blocked: "reviewer failed",
		});
		expect(lastReviewedFingerprint(plan)).toBeUndefined();
	});

	it("records no ruling — reviewing is not deciding to execute", () => {
		const { engine, rows } = ledger();
		recordPlanReview(engine, {
			mode: "plan",
			fingerprint: "abc123",
			at: "2026-07-27T00:00:00.000Z",
			validations: [],
		});
		expect(rows[0].rulingDetail).toBeUndefined();
		expect(rows[0].ruling).toBe("settled");
	});
});

describe("lastReviewedFingerprint", () => {
	it("is undefined for a plan that was never reviewed", () => {
		expect(lastReviewedFingerprint({} as Plan)).toBeUndefined();
	});

	it("takes the most recent clearing review", () => {
		const { plan, engine } = ledger();
		for (const [at, fingerprint] of [
			["2026-07-27T00:00:00.000Z", "first"],
			["2026-07-27T01:00:00.000Z", "second"],
		]) {
			recordPlanReview(engine, {
				mode: "plan",
				fingerprint,
				at,
				validations: [],
			});
		}
		expect(lastReviewedFingerprint(plan)).toBe("second");
	});

	it("reads the gate's own settled ruling too", () => {
		// The transition gate records decision values rather than "settled".
		const plan = {
			transitionGates: [
				{
					id: "mode-transition:plan:auto:x",
					ruling: "enter-without",
					planFingerprint: "gated",
				},
			],
		} as unknown as Plan;
		expect(lastReviewedFingerprint(plan)).toBe("gated");
	});

	it("ignores a cancelled or blocked gate", () => {
		const plan = {
			transitionGates: [
				{ id: "a", ruling: "stay-in-plan", planFingerprint: "cancelled" },
				{ id: "b", ruling: "blocked", planFingerprint: "blocked" },
			],
		} as unknown as Plan;
		expect(lastReviewedFingerprint(plan)).toBeUndefined();
	});
});
