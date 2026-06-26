import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	buildDeliverableSliceCompactionResult,
	buildSummariserPreamble,
	buildSummary,
	COMPACTION_SCHEMA_VERSION,
	countDeliverableSlicesOnBranch,
	decideCompactionOwnership,
	downstreamDependents,
	findLatestCompactionSummary,
	type ModesCompactionDetails,
	readModesCompactionDetails,
	type SummariseFn,
	summaryHash,
	transitiveDependencies,
} from "../packages/modes/src/compaction.js";
import type {
	Deliverable,
	Plan,
	PlanNode,
	WorkItem,
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

function task(id: string, done = false): WorkItem {
	return {
		type: "work-item",
		id,
		title: id,
		body: "",
		done,
		kind: "task",
		createdAt: "t",
		updatedAt: "t",
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

/** Minimal compaction SessionEntry stub for branch-walk tests. */
function compactionEntry(
	summary: string,
	details?: Partial<ModesCompactionDetails>,
): SessionEntry {
	return {
		type: "compaction",
		id: `c-${Math.random()}`,
		summary,
		firstKeptEntryId: "k",
		tokensBefore: 0,
		details,
	} as unknown as SessionEntry;
}

/** Minimal text user message for the raw slice. */
function userMessage(text: string) {
	return {
		role: "user" as const,
		content: [{ type: "text" as const, text }],
		timestamp: 0,
	};
}

const okSummarise: SummariseFn = async () => ({ text: "slice body" });
const failSummarise: SummariseFn = async () => null;

describe("compaction ownership decision", () => {
	it("declines without a marker, owns on match, leak-guards on mismatch", () => {
		const pending = {
			nonce: "n1",
			deliverableId: "a",
			reason: "modes-trigger",
		};
		expect(decideCompactionOwnership(undefined, pending).kind).toBe("decline");
		expect(
			decideCompactionOwnership("maestro:modes-deliverable-slice n1", pending)
				.kind,
		).toBe("own");
		expect(
			decideCompactionOwnership(
				"maestro:modes-deliverable-slice other",
				pending,
			).kind,
		).toBe("leak-guard");
		expect(
			decideCompactionOwnership("maestro:modes-deliverable-slice n1", undefined)
				.kind,
		).toBe("leak-guard");
	});
});

describe("dependency-aware preamble", () => {
	const p = plan([
		deliverable({ id: "a", title: "A", status: "shipped" }),
		deliverable({ id: "b", title: "B", status: "active", dependsOn: ["a"] }),
		deliverable({
			id: "c",
			title: "C",
			body: "build on B",
			status: "planned",
			dependsOn: ["b"],
		}),
	]);

	it("resolves transitive dependencies and downstream dependents", () => {
		expect(transitiveDependencies(p, "b").map((d) => d.id)).toEqual(["a"]);
		expect(downstreamDependents(p, "a").map((d) => d.id)).toEqual(["b", "c"]);
		// terminal dependencies are excluded from downstream-of-b reader set
		expect(downstreamDependents(p, "b").map((d) => d.id)).toEqual(["c"]);
	});

	it("names dependency chain and downstream readers", () => {
		const active = p.nodes[1] as Deliverable;
		const preamble = buildSummariserPreamble({
			plan: p,
			deliverable: active,
			maxTokens: 5000,
			partN: 1,
		});
		expect(preamble).toContain("Active deliverable `b` — B");
		expect(preamble).toContain("`a` — A");
		expect(preamble).toContain("`c` — C: build on B");
		expect(preamble).toContain("~5000 output tokens");
	});

	it("flags later parts so earlier slices are not restated", () => {
		const active = p.nodes[1] as Deliverable;
		const preamble = buildSummariserPreamble({
			plan: p,
			deliverable: active,
			maxTokens: 5000,
			partN: 3,
		});
		expect(preamble).toContain("**part 3**");
	});
});

describe("branch introspection", () => {
	it("finds the latest summary and counts slices per deliverable", () => {
		const entries = [
			compactionEntry("first", {
				modesKind: "deliverable-slice",
				planSlug: "p",
				deliverableId: "a",
			}),
			compactionEntry("first\n\nsecond", {
				modesKind: "deliverable-slice",
				planSlug: "p",
				deliverableId: "a",
			}),
		];
		expect(findLatestCompactionSummary(entries)).toBe("first\n\nsecond");
		expect(countDeliverableSlicesOnBranch(entries, "p", "a")).toBe(2);
		expect(countDeliverableSlicesOnBranch(entries, "p", "b")).toBe(0);
		expect(readModesCompactionDetails(entries[0])?.deliverableId).toBe("a");
	});

	it("ignores non-modes compactions when counting", () => {
		const entries = [compactionEntry("generic recap")];
		expect(countDeliverableSlicesOnBranch(entries, "p", "a")).toBe(0);
		expect(readModesCompactionDetails(entries[0])).toBeUndefined();
	});
});

describe("buildDeliverableSliceCompactionResult", () => {
	const p = plan([deliverable({ id: "a", title: "A", status: "active" })]);

	it("reuses the previous summary byte-for-byte as a prefix", async () => {
		const previousSummary =
			"## Deliverable `a` — A (part 1, in progress)\n\nfrozen";
		const result = await buildDeliverableSliceCompactionResult({
			entries: [
				compactionEntry(previousSummary, {
					modesKind: "deliverable-slice",
					planSlug: "p",
					deliverableId: "a",
				}),
			],
			plan: p,
			deliverableId: "a",
			summarise: okSummarise,
			rawMessages: [userMessage("did work")],
			previousSummary,
			firstKeptEntryId: "keep-1",
			tokensBefore: 1234,
			maxTokens: 5000,
			nonce: "n1",
			reason: "modes-trigger",
		});
		expect(result).not.toBeNull();
		expect(result?.summary.startsWith(previousSummary)).toBe(true);
		expect(result?.summary).toContain("(part 2, in progress)");
		expect(result?.firstKeptEntryId).toBe("keep-1");
		expect(result?.tokensBefore).toBe(1234);
	});

	it("only passes the raw slice (no prior summary) to the summariser", async () => {
		let seen: unknown[] = [];
		const capture: SummariseFn = async ({ messages }) => {
			seen = messages;
			return { text: "ok" };
		};
		await buildDeliverableSliceCompactionResult({
			entries: [],
			plan: p,
			deliverableId: "a",
			summarise: capture,
			rawMessages: [userMessage("raw only")],
			previousSummary: "earlier frozen summary",
			firstKeptEntryId: "k",
			tokensBefore: 0,
			maxTokens: 5000,
			nonce: "n",
			reason: "manual",
		});
		expect(seen).toHaveLength(1);
		expect(JSON.stringify(seen)).toContain("raw only");
		expect(JSON.stringify(seen)).not.toContain("earlier frozen summary");
	});

	it("records JSON-serializable metadata with schema + prev hash", async () => {
		const previousSummary = "frozen prefix";
		const result = await buildDeliverableSliceCompactionResult({
			entries: [],
			plan: p,
			deliverableId: "a",
			summarise: okSummarise,
			rawMessages: [userMessage("x")],
			previousSummary,
			firstKeptEntryId: "k",
			tokensBefore: 0,
			maxTokens: 5000,
			nonce: "nonce-7",
			reason: "threshold",
			buckets: {
				sys: 1,
				seed: 2,
				rollingSummary: 3,
				hotTail: 4,
				workingUsed: 5,
				summaryUsed: 5,
			},
		});
		const d = result?.details;
		expect(d).toMatchObject({
			schemaVersion: COMPACTION_SCHEMA_VERSION,
			modesKind: "deliverable-slice",
			planSlug: "p",
			deliverableId: "a",
			sliceNumber: 1,
			nonce: "nonce-7",
			reason: "threshold",
			previousSummaryLength: previousSummary.length,
			previousSummaryHash: summaryHash(previousSummary),
		});
		expect(d?.buckets?.workingUsed).toBe(5);
		expect(() => JSON.stringify(d)).not.toThrow();
	});

	it("redacts secrets in the new section but keeps the prefix intact", async () => {
		const leaky: SummariseFn = async () => ({
			text: "token=abcdefghijklmnopqrstuvwxyz0123456789",
		});
		const result = await buildDeliverableSliceCompactionResult({
			entries: [],
			plan: p,
			deliverableId: "a",
			summarise: leaky,
			rawMessages: [userMessage("x")],
			previousSummary: "",
			firstKeptEntryId: "k",
			tokensBefore: 0,
			maxTokens: 5000,
			nonce: "n",
			reason: "manual",
		});
		expect(result?.summary).not.toContain(
			"abcdefghijklmnopqrstuvwxyz0123456789",
		);
		expect(result?.summary).toContain("[redacted]");
	});

	it("returns null when the summariser soft-fails", async () => {
		const result = await buildDeliverableSliceCompactionResult({
			entries: [],
			plan: p,
			deliverableId: "a",
			summarise: failSummarise,
			rawMessages: [userMessage("x")],
			previousSummary: "",
			firstKeptEntryId: "k",
			tokensBefore: 0,
			maxTokens: 5000,
			nonce: "n",
			reason: "manual",
		});
		expect(result).toBeNull();
	});

	it("keeps the prior summary as an exact prefix across two consecutive slices", async () => {
		const first = await buildDeliverableSliceCompactionResult({
			entries: [],
			plan: p,
			deliverableId: "a",
			summarise: async () => ({ text: "first slice" }),
			rawMessages: [userMessage("work 1")],
			previousSummary: "",
			firstKeptEntryId: "k1",
			tokensBefore: 0,
			maxTokens: 5000,
			nonce: "n1",
			reason: "modes-trigger",
		});
		// Branch now carries the first slice's compaction entry.
		const second = await buildDeliverableSliceCompactionResult({
			entries: [compactionEntry(first?.summary ?? "", first?.details)],
			plan: p,
			deliverableId: "a",
			summarise: async () => ({ text: "second slice" }),
			rawMessages: [userMessage("work 2")],
			previousSummary: first?.summary,
			firstKeptEntryId: "k2",
			tokensBefore: 0,
			maxTokens: 5000,
			nonce: "n2",
			reason: "modes-trigger",
		});
		expect(second?.summary.startsWith(first?.summary ?? "x")).toBe(true);
		expect(second?.summary).toContain("first slice");
		expect(second?.summary).toContain("second slice");
		expect(second?.details.sliceNumber).toBe(2);
	});

	it("appends onto a generic (non-modes) prefix without rewriting it", async () => {
		const generic = "## Generic recap\n\nwhatever pi wrote";
		const result = await buildDeliverableSliceCompactionResult({
			entries: [compactionEntry(generic)],
			plan: p,
			deliverableId: "a",
			summarise: okSummarise,
			rawMessages: [userMessage("more work")],
			previousSummary: generic,
			firstKeptEntryId: "k",
			tokensBefore: 0,
			maxTokens: 5000,
			nonce: "n",
			reason: "modes-trigger",
		});
		expect(result?.summary.startsWith(generic)).toBe(true);
		// generic prefix had no modes slice, so this is part 1
		expect(result?.details.sliceNumber).toBe(1);
	});

	it("throws when the deliverable is not in the plan", async () => {
		await expect(
			buildDeliverableSliceCompactionResult({
				entries: [],
				plan: p,
				deliverableId: "missing",
				summarise: okSummarise,
				rawMessages: [],
				firstKeptEntryId: "k",
				tokensBefore: 0,
				maxTokens: 5000,
				nonce: "n",
				reason: "manual",
			}),
		).rejects.toThrow(/not found/);
	});
});

describe("buildSummary append-only", () => {
	it("returns the new section when no prefix exists", () => {
		expect(buildSummary("", "new")).toBe("new");
	});
	it("concatenates prefix then new section", () => {
		expect(buildSummary("old", "new")).toBe("old\n\nnew");
	});
});
