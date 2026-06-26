import { describe, expect, it } from "vitest";
import {
	buildCarryForwardSummary,
	buildEndSummaryPreamble,
	collectDependencySummaries,
	type SummariseFn,
} from "../packages/modes/src/compaction.js";
import { renderPlanSeed } from "../packages/modes/src/markdown.js";
import type {
	Deliverable,
	Plan,
	PlanNode,
} from "../packages/modes/src/schema.js";
import {
	collectCarryForwardInput,
	resolveShipSummaryInput,
} from "../packages/modes/src/session.js";

function deliverable(over: Partial<Deliverable> = {}): Deliverable {
	return {
		type: "deliverable",
		id: "d",
		title: "D",
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

// a → b → c chain, plus an independent d.
const chain = plan([
	deliverable({ id: "a", title: "A", status: "shipped", summary: "A-summary" }),
	deliverable({
		id: "b",
		title: "B",
		status: "shipped",
		summary: "B-summary",
		dependsOn: ["a"],
	}),
	deliverable({ id: "c", title: "C", status: "active", dependsOn: ["b"] }),
	deliverable({
		id: "d",
		title: "D",
		status: "shipped",
		summary: "D-summary",
		dependsOn: [],
	}),
]);

const ok =
	(text: string): SummariseFn =>
	async () => ({ text });

describe("collectDependencySummaries", () => {
	it("returns transitive dependency summaries, direct-first", () => {
		expect(collectDependencySummaries(chain, "c")).toEqual([
			{ id: "b", title: "B", summary: "B-summary" },
			{ id: "a", title: "A", summary: "A-summary" },
		]);
	});

	it("excludes unrelated parallel branches", () => {
		const ids = collectDependencySummaries(chain, "c").map((d) => d.id);
		expect(ids).not.toContain("d");
	});

	it("skips dependencies that have no summary", () => {
		const p = plan([
			deliverable({ id: "x", title: "X", status: "shipped" }),
			deliverable({ id: "y", title: "Y", status: "active", dependsOn: ["x"] }),
		]);
		expect(collectDependencySummaries(p, "y")).toEqual([]);
	});
});

describe("renderPlanSeed carry-forward", () => {
	it("injects only the dependency closure's summaries, verbatim", () => {
		const seed = renderPlanSeed(chain, "c");
		expect(seed).toContain("## Carry-forward from dependencies");
		expect(seed).toContain("A-summary");
		expect(seed).toContain("B-summary");
		// The independent shipped sibling is never pulled in.
		expect(seed).not.toContain("D-summary");
	});

	it("omits the section when no dependency has a summary", () => {
		const seed = renderPlanSeed(chain, "a");
		expect(seed).not.toContain("## Carry-forward from dependencies");
	});

	it("is deterministic for identical input", () => {
		expect(renderPlanSeed(chain, "c")).toBe(renderPlanSeed(chain, "c"));
	});
});

describe("buildEndSummaryPreamble", () => {
	it("names non-terminal downstream dependents and asks for forward-looking value", () => {
		const active = chain.nodes[0] as Deliverable; // a; b is shipped, c is active
		const preamble = buildEndSummaryPreamble({
			plan: chain,
			deliverable: active,
			maxTokens: 4000,
		});
		// Only c still needs the hand-off; b is already shipped (terminal).
		expect(preamble).toContain("`c`");
		expect(preamble).not.toContain("depends\n  - `b`");
		expect(preamble).toContain("Discoveries");
		expect(preamble).toContain("Reusable details");
	});

	it("requests a short archival summary when nothing depends on it", () => {
		const leaf = deliverable({ id: "z", title: "Z", status: "active" });
		const preamble = buildEndSummaryPreamble({
			plan: plan([leaf]),
			deliverable: leaf,
			maxTokens: 4000,
		});
		expect(preamble).toContain("No other deliverable depends");
	});
});

describe("buildCarryForwardSummary", () => {
	const active = chain.nodes[2] as Deliverable; // c

	it("distils rolling summary + raw tail and redacts secrets", async () => {
		const out = await buildCarryForwardSummary({
			plan: chain,
			deliverable: active,
			rollingSummary: "prior rolling text",
			rawTail: [
				{ role: "user", content: [{ type: "text", text: "x" }], timestamp: 0 },
			],
			summarise: ok("done; token=abcdefghijklmnopqrstuvwxyz0123456789"),
			maxTokens: 2000,
		});
		expect(out).toContain("done;");
		expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
	});

	it("works from a rolling summary alone (fully-compacted session)", async () => {
		const out = await buildCarryForwardSummary({
			plan: chain,
			deliverable: active,
			rollingSummary: "only rolling",
			rawTail: [],
			summarise: ok("distilled"),
			maxTokens: 2000,
		});
		expect(out).toBe("distilled");
	});

	it("returns null when there is nothing to summarise", async () => {
		const out = await buildCarryForwardSummary({
			plan: chain,
			deliverable: active,
			rawTail: [],
			summarise: ok("unused"),
			maxTokens: 2000,
		});
		expect(out).toBeNull();
	});

	it("soft-fails to null when the summariser fails", async () => {
		const out = await buildCarryForwardSummary({
			plan: chain,
			deliverable: active,
			rawTail: [
				{ role: "user", content: [{ type: "text", text: "x" }], timestamp: 0 },
			],
			summarise: async () => null,
			maxTokens: 2000,
		});
		expect(out).toBeNull();
	});
});

describe("resolveShipSummaryInput", () => {
	const compaction = {
		type: "compaction",
		id: "c1",
		summary: "rolling",
		firstKeptEntryId: "k",
		tokensBefore: 0,
	} as never;
	const message = {
		type: "message",
		id: "m1",
		message: {
			role: "user",
			content: [{ type: "text", text: "hi" }],
			timestamp: 0,
		},
	} as never;

	it("reads the current session when no sessionPath is recorded", () => {
		const r = resolveShipSummaryInput([compaction, message], {}, "/cur.jsonl");
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.input.rollingSummary).toBe("rolling");
			expect(r.input.rawTail).toHaveLength(1);
		}
	});

	it("reads the current session when sessionPath matches", () => {
		const r = resolveShipSummaryInput(
			[message],
			{ sessionPath: "/cur.jsonl" },
			"/cur.jsonl",
		);
		expect(r.ok).toBe(true);
	});

	it("soft-fails when /ship runs from a different session", () => {
		const r = resolveShipSummaryInput(
			[message],
			{ sessionPath: "/other.jsonl" },
			"/cur.jsonl",
		);
		expect(r.ok).toBe(false);
	});

	it("soft-fails when there is no content to summarise", () => {
		const r = resolveShipSummaryInput([], {}, "/cur.jsonl");
		expect(r.ok).toBe(false);
	});

	it("collectCarryForwardInput takes the tail after the last compaction", () => {
		const input = collectCarryForwardInput([message, compaction, message]);
		expect(input.rollingSummary).toBe("rolling");
		expect(input.rawTail).toHaveLength(1);
	});
});
