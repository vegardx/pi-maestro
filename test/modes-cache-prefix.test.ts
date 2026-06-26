import { describe, expect, it } from "vitest";
import { redactSecrets } from "../packages/core/src/redact.js";
import { computeBuckets, formatBudget } from "../packages/modes/src/budget.js";
import {
	buildDeliverableSliceCompactionResult,
	buildSummariserPreamble,
	buildSummary,
	type SummariseFn,
} from "../packages/modes/src/compaction.js";
import { renderPlanSeed } from "../packages/modes/src/markdown.js";
import type {
	Deliverable,
	Plan,
	PlanNode,
} from "../packages/modes/src/schema.js";

function deliverable(over: Partial<Deliverable> = {}): Deliverable {
	return {
		type: "deliverable",
		id: "d1",
		title: "D1",
		body: "",
		status: "planned",
		children: [],
		createdAt: "t",
		updatedAt: "t",
		...over,
	};
}

function plan(nodes: PlanNode[]): Plan {
	return {
		slug: "p",
		title: "P",
		repoPath: "/repo",
		nodes,
		createdAt: "t",
		updatedAt: "t",
	};
}

function compactionEntry(summary: string, details?: unknown) {
	return {
		type: "compaction",
		id: `c-${summary.length}`,
		summary,
		firstKeptEntryId: "k",
		tokensBefore: 0,
		details,
	} as never;
}

const slice =
	(text: string): SummariseFn =>
	async () => ({ text });

const p = plan([
	deliverable({ id: "a", title: "A", body: "do A", status: "active" }),
	deliverable({ id: "b", title: "B", body: "do B", dependsOn: ["a"] }),
]);

describe("cache-prefix invariants", () => {
	it("(1) previous rolling summary is an exact byte prefix across slices", async () => {
		const first = await buildDeliverableSliceCompactionResult({
			entries: [],
			plan: p,
			deliverableId: "a",
			summarise: slice("slice 1"),
			rawMessages: [
				{ role: "user", content: [{ type: "text", text: "w1" }], timestamp: 0 },
			],
			previousSummary: "",
			firstKeptEntryId: "k1",
			tokensBefore: 0,
			maxTokens: 4000,
			nonce: "n1",
			reason: "modes-trigger",
		});
		const second = await buildDeliverableSliceCompactionResult({
			entries: [compactionEntry(first?.summary ?? "", first?.details)],
			plan: p,
			deliverableId: "a",
			summarise: slice("slice 2"),
			rawMessages: [
				{ role: "user", content: [{ type: "text", text: "w2" }], timestamp: 0 },
			],
			previousSummary: first?.summary,
			firstKeptEntryId: "k2",
			tokensBefore: 0,
			maxTokens: 4000,
			nonce: "n2",
			reason: "modes-trigger",
		});
		expect(second?.summary.startsWith(first?.summary ?? "x")).toBe(true);
	});

	it("(2) a generic compaction interleaved between slices stays append-only", async () => {
		// modes slice 1 → generic smart-compact appends → modes slice 2.
		const first = await buildDeliverableSliceCompactionResult({
			entries: [],
			plan: p,
			deliverableId: "a",
			summarise: slice("modes 1"),
			rawMessages: [
				{ role: "user", content: [{ type: "text", text: "w1" }], timestamp: 0 },
			],
			previousSummary: "",
			firstKeptEntryId: "k1",
			tokensBefore: 0,
			maxTokens: 4000,
			nonce: "n1",
			reason: "modes-trigger",
		});
		// Generic compaction reuses the prior summary byte-for-byte and appends.
		const generic = buildSummary(first?.summary ?? "", "## Generic recap\n\nx");
		expect(generic.startsWith(first?.summary ?? "z")).toBe(true);

		const third = await buildDeliverableSliceCompactionResult({
			entries: [compactionEntry(generic)],
			plan: p,
			deliverableId: "a",
			summarise: slice("modes 2"),
			rawMessages: [
				{ role: "user", content: [{ type: "text", text: "w3" }], timestamp: 0 },
			],
			previousSummary: generic,
			firstKeptEntryId: "k3",
			tokensBefore: 0,
			maxTokens: 4000,
			nonce: "n3",
			reason: "modes-trigger",
		});
		expect(third?.summary.startsWith(generic)).toBe(true);
	});

	it("(3) the plan seed bytes are constant across repeated renders", () => {
		const a = renderPlanSeed(p, "a");
		const b = renderPlanSeed(p, "a");
		expect(a).toBe(b);
		// Independent of unrelated calls / ordering.
		expect(renderPlanSeed(p, "a")).toBe(a);
	});

	it("(4) preamble + redaction are deterministic for identical input", () => {
		const active = p.nodes[0] as Deliverable;
		const a = buildSummariserPreamble({
			plan: p,
			deliverable: active,
			maxTokens: 4000,
			partN: 1,
		});
		const b = buildSummariserPreamble({
			plan: p,
			deliverable: active,
			maxTokens: 4000,
			partN: 1,
		});
		expect(a).toBe(b);
		const secret = "token=abcdefghijklmnopqrstuvwxyz0123456789";
		expect(redactSecrets(secret)).toBe(redactSecrets(secret));
	});

	it("(5) budget recomputation never mutates its input and is pure", () => {
		const input = {
			total: 200_000,
			sys: 5000,
			seed: 1000,
			rollingSummary: 2000,
		};
		const frozen = Object.freeze({ ...input });
		const a = computeBuckets(frozen);
		const b = computeBuckets(frozen);
		expect(a).toEqual(b);
		// Input untouched.
		expect(frozen).toEqual(input);
		// Formatting is pure too.
		expect(formatBudget(a, 250_000)).toBe(formatBudget(b, 250_000));
	});
});
