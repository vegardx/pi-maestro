// The review ledger: minted identity, resolution completeness, dispute-once,
// duplicate merging, verification cycles, and gate math. These invariants are
// what let models exercise judgment while the machine owns bookkeeping.

import { describe, expect, it } from "vitest";
import {
	applyChecks,
	applyResolutions,
	buildLedger,
	computedVerdict,
	isBlockingSeverity,
	ledgerSummary,
	mintFindings,
	openBlocking,
	openDisputed,
	type ReviewLedger,
	renderLedger,
	type StructuredFinding,
} from "../packages/modes/src/exec/findings.js";

const NOW = "2026-07-12T00:00:00.000Z";

const finding = (over: Partial<StructuredFinding> = {}): StructuredFinding => ({
	id: "model-made-this-up",
	severity: "major",
	category: "correctness",
	actual: "the code does the wrong thing",
	...over,
});

const twoReviewerLedger = (): ReviewLedger =>
	buildLedger(
		[
			{
				reviewer: "correctness",
				findings: [
					finding({ severity: "critical", actual: "boom on empty input" }),
					finding({ severity: "minor", actual: "naming nit" }),
				],
			},
			{
				reviewer: "security-alt",
				findings: [finding({ severity: "major", actual: "same boom, again" })],
			},
		],
		NOW,
	);

describe("mintFindings", () => {
	it("mints <reviewer>.<n> and discards model-provided ids", () => {
		const minted = mintFindings("security-audit", [finding(), finding()]);
		expect(minted.map((f) => f.id)).toEqual([
			"security-audit.1",
			"security-audit.2",
		]);
	});
});

describe("computedVerdict", () => {
	it("blocks on any critical/major, approves on minors alone", () => {
		expect(computedVerdict([finding({ severity: "minor" })])).toBe("approve");
		expect(
			computedVerdict([
				finding({ severity: "minor" }),
				finding({ severity: "major" }),
			]),
		).toBe("request-changes");
		expect(computedVerdict([])).toBe("approve");
	});

	it("severity buckets: minor is advisory, the rest block", () => {
		expect(isBlockingSeverity("critical")).toBe(true);
		expect(isBlockingSeverity("major")).toBe(true);
		expect(isBlockingSeverity("minor")).toBe(false);
	});
});

describe("applyResolutions — completeness", () => {
	it("rejects when a blocking finding is unaccounted", () => {
		const ledger = twoReviewerLedger();
		const result = applyResolutions(
			ledger,
			[{ id: "correctness.1", status: "fixed", note: "commit abc" }],
			NOW,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.join(" ")).toContain("security-alt.1");
			expect(result.errors.join(" ")).toContain("unaccounted");
		}
	});

	it("accepts full coverage and leaves minors open without complaint", () => {
		const ledger = twoReviewerLedger();
		const result = applyResolutions(
			ledger,
			[
				{ id: "correctness.1", status: "fixed", note: "commit abc" },
				{
					id: "security-alt.1",
					status: "duplicateOf",
					note: "same root cause",
					canonical: "correctness.1",
				},
			],
			NOW,
		);
		expect(result.ok).toBe(true);
	});

	it("rejects unknown ids, duplicate resolutions, and empty notes", () => {
		const ledger = twoReviewerLedger();
		const result = applyResolutions(
			ledger,
			[
				{ id: "ghost.9", status: "fixed", note: "x" },
				{ id: "correctness.1", status: "fixed", note: "a" },
				{ id: "correctness.1", status: "fixed", note: "b" },
				{ id: "security-alt.1", status: "disputed", note: "  " },
			],
			NOW,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			const text = result.errors.join("\n");
			expect(text).toContain("unknown finding id: ghost.9");
			expect(text).toContain("duplicate resolution for correctness.1");
			expect(text).toContain("security-alt.1: a non-empty note is required");
		}
	});

	it("wont-fix is minors-only; disputes are blocking-only", () => {
		const ledger = twoReviewerLedger();
		const result = applyResolutions(
			ledger,
			[
				{ id: "correctness.1", status: "wont-fix", note: "meh" },
				{ id: "correctness.2", status: "disputed", note: "argument" },
				{ id: "security-alt.1", status: "fixed", note: "commit" },
			],
			NOW,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			const text = result.errors.join("\n");
			expect(text).toContain("wont-fix is only legal for minor findings");
			expect(text).toContain("minors are yours to decide");
		}
	});

	it("nothing is applied when any resolution is invalid", () => {
		const ledger = twoReviewerLedger();
		const result = applyResolutions(
			ledger,
			[
				{ id: "correctness.1", status: "fixed", note: "commit" },
				{ id: "security-alt.1", status: "fixed", note: "" },
			],
			NOW,
		);
		expect(result.ok).toBe(false);
		expect(ledger.entries.every((e) => e.resolution === undefined)).toBe(true);
	});
});

describe("applyResolutions — disputes and duplicates", () => {
	it("dispute-once: the second dispute is a tool error", () => {
		const ledger = twoReviewerLedger();
		const first = applyResolutions(
			ledger,
			[
				{ id: "correctness.1", status: "disputed", note: "unreachable path" },
				{ id: "security-alt.1", status: "fixed", note: "commit" },
			],
			NOW,
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const again = applyResolutions(
			first.ledger,
			[{ id: "correctness.1", status: "disputed", note: "still disagree" }],
			NOW,
		);
		expect(again.ok).toBe(false);
		if (!again.ok) {
			expect(again.errors.join(" ")).toContain("already disputed once");
		}
	});

	it("duplicateOf merges severity upward and hides the duplicate", () => {
		const ledger = buildLedger(
			[
				{
					reviewer: "a",
					findings: [finding({ severity: "major", actual: "flaw" })],
				},
				{
					reviewer: "b",
					findings: [finding({ severity: "critical", actual: "same flaw" })],
				},
			],
			NOW,
		);
		const result = applyResolutions(
			ledger,
			[
				{ id: "a.1", status: "fixed", note: "commit" },
				{
					id: "b.1",
					status: "duplicateOf",
					note: "same flaw",
					canonical: "a.1",
				},
			],
			NOW,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const canonical = result.ledger.entries.find((e) => e.finding.id === "a.1");
		expect(canonical?.finding.severity).toBe("critical");
		expect(canonical?.duplicates).toEqual(["b.1"]);
		// The duplicate no longer counts as open.
		const open = openBlocking(result.ledger);
		expect(open.map((e) => e.finding.id)).toEqual(["a.1"]);
	});

	it("rejects self-duplicates and chained duplicates", () => {
		const ledger = buildLedger(
			[
				{ reviewer: "a", findings: [finding({})] },
				{ reviewer: "b", findings: [finding({})] },
				{ reviewer: "c", findings: [finding({})] },
			],
			NOW,
		);
		const first = applyResolutions(
			ledger,
			[
				{ id: "a.1", status: "fixed", note: "commit" },
				{ id: "b.1", status: "duplicateOf", note: "dup", canonical: "a.1" },
				{ id: "c.1", status: "fixed", note: "commit" },
			],
			NOW,
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const self = applyResolutions(
			first.ledger,
			[
				{ id: "a.1", status: "duplicateOf", note: "dup", canonical: "a.1" },
				{ id: "c.1", status: "fixed", note: "commit" },
			],
			NOW,
		);
		expect(self.ok).toBe(false);
		const chain = applyResolutions(
			first.ledger,
			[
				{ id: "a.1", status: "fixed", note: "commit" },
				{ id: "c.1", status: "duplicateOf", note: "dup", canonical: "b.1" },
			],
			NOW,
		);
		expect(chain.ok).toBe(false);
		if (!chain.ok) {
			expect(chain.errors.join(" ")).toContain("itself a duplicate");
		}
	});
});

describe("applyChecks — the fix+verify cycle", () => {
	const resolved = (): ReviewLedger => {
		const result = applyResolutions(
			twoReviewerLedger(),
			[
				{ id: "correctness.1", status: "fixed", note: "commit abc" },
				{ id: "security-alt.1", status: "fixed", note: "commit abc" },
			],
			NOW,
		);
		if (!result.ok) throw new Error("fixture invalid");
		return result.ledger;
	};

	it("verified fixes close the gate; still-open keeps it held", () => {
		const { ledger } = applyChecks(
			resolved(),
			[
				{ id: "correctness.1", result: "verified", note: "test added at x" },
				{ id: "security-alt.1", result: "still-open", note: "path B remains" },
			],
			[],
			"verifier-1",
			NOW,
		);
		expect(ledger.cycle).toBe(1);
		expect(openBlocking(ledger).map((e) => e.finding.id)).toEqual([
			"security-alt.1",
		]);
	});

	it("a re-filed fix clears the previous still-open check", () => {
		const once = applyChecks(
			resolved(),
			[{ id: "correctness.1", result: "still-open" }],
			[],
			"verifier-1",
			NOW,
		).ledger;
		const refiled = applyResolutions(
			once,
			[
				{ id: "correctness.1", status: "fixed", note: "commit def" },
				{ id: "security-alt.1", status: "fixed", note: "commit def" },
			],
			NOW,
		);
		expect(refiled.ok).toBe(true);
		if (!refiled.ok) return;
		const entry = refiled.ledger.entries.find(
			(e) => e.finding.id === "correctness.1",
		);
		expect(entry?.check).toBeUndefined();
	});

	it("regressions get minted verifier ids and open the gate", () => {
		const { ledger } = applyChecks(
			resolved(),
			[
				{ id: "correctness.1", result: "verified" },
				{ id: "security-alt.1", result: "verified" },
			],
			[finding({ severity: "major", actual: "fix broke the cache path" })],
			"verifier-1",
			NOW,
		);
		expect(openBlocking(ledger).map((e) => e.finding.id)).toEqual([
			"verifier-1.1",
		]);
	});

	it("checking an unfixed claim is an error", () => {
		const { errors } = applyChecks(
			twoReviewerLedger(),
			[{ id: "correctness.1", result: "verified" }],
			[],
			"verifier-1",
			NOW,
		);
		expect(errors.join(" ")).toContain("no fixed claim");
	});
});

describe("gate math", () => {
	it("waived findings stop counting", () => {
		const ledger = twoReviewerLedger();
		expect(openBlocking(ledger)).toHaveLength(2);
		expect(
			openBlocking(ledger, new Set(["correctness.1"])).map((e) => e.finding.id),
		).toEqual(["security-alt.1"]);
	});

	it("disputed blockers stay open (an argument is not an override)", () => {
		const result = applyResolutions(
			twoReviewerLedger(),
			[
				{ id: "correctness.1", status: "disputed", note: "unreachable" },
				{ id: "security-alt.1", status: "fixed", note: "commit" },
			],
			NOW,
		);
		if (!result.ok) throw new Error("fixture invalid");
		expect(openBlocking(result.ledger).map((e) => e.finding.id)).toContain(
			"correctness.1",
		);
		expect(openDisputed(result.ledger).map((e) => e.finding.id)).toEqual([
			"correctness.1",
		]);
	});

	it("summary reads at a glance", () => {
		const result = applyResolutions(
			twoReviewerLedger(),
			[
				{ id: "correctness.1", status: "disputed", note: "unreachable" },
				{ id: "security-alt.1", status: "fixed", note: "commit" },
			],
			NOW,
		);
		if (!result.ok) throw new Error("fixture invalid");
		expect(ledgerSummary(result.ledger, 3)).toBe(
			"cycle 0/3 · 2 blocking open · 1 disputed",
		);
	});

	it("renderLedger skips duplicates and marks waived entries", () => {
		const merged = applyResolutions(
			twoReviewerLedger(),
			[
				{ id: "correctness.1", status: "fixed", note: "commit" },
				{
					id: "security-alt.1",
					status: "duplicateOf",
					note: "same",
					canonical: "correctness.1",
				},
			],
			NOW,
		);
		if (!merged.ok) throw new Error("fixture invalid");
		const text = renderLedger(merged.ledger, new Set(["correctness.2"]));
		expect(text).toContain("correctness.1");
		expect(text).not.toContain("security-alt.1 [");
		expect(text).toContain("(+1 duplicate)");
		expect(text).toContain("WAIVED");
	});
});

describe("structured finding normalization", () => {
	it("mints stable ids and conservatively merges exact duplicate assertions", async () => {
		const { normalizeFindingAssertions } = await import(
			"../packages/modes/src/exec/findings.js"
		);
		const ledger = normalizeFindingAssertions([
			{
				reviewer: "correctness",
				stageId: "review",
				modelId: "model/a",
				commit: "a".repeat(40),
				reportedAt: NOW,
				findings: [
					finding({
						file: "src/a.ts",
						line: 4,
						actual: "Null input crashes",
						evidence: ["src/a.ts:4 dereferences value"],
					}),
				],
			},
			{
				reviewer: "adversarial",
				stageId: "review",
				modelId: "model/b",
				commit: "a".repeat(40),
				reportedAt: NOW,
				findings: [
					finding({
						severity: "critical",
						file: "src/a.ts",
						line: 4,
						actual: "  null input CRASHES ",
						evidence: ["test reproduces"],
					}),
				],
			},
		]);
		expect(ledger.entries).toHaveLength(1);
		expect(ledger.entries[0]?.finding.id).toBe("finding-0001");
		expect(ledger.entries[0]?.finding.severity).toBe("critical");
		expect(ledger.entries[0]?.finding.provenance).toHaveLength(2);
		expect(ledger.entries[0]?.duplicates).toEqual(["finding-0002"]);
	});

	it("preserves disagreements at the same source address", async () => {
		const { normalizeFindingAssertions } = await import(
			"../packages/modes/src/exec/findings.js"
		);
		const base = {
			stageId: "review",
			commit: "a".repeat(40),
			reportedAt: NOW,
		};
		const ledger = normalizeFindingAssertions([
			{
				...base,
				reviewer: "a",
				modelId: "one",
				findings: [finding({ file: "x.ts", line: 1, actual: "should reject" })],
			},
			{
				...base,
				reviewer: "b",
				modelId: "two",
				findings: [finding({ file: "x.ts", line: 1, actual: "should accept" })],
			},
		]);
		expect(ledger.entries).toHaveLength(2);
	});
});

describe("new-path resolution barriers", () => {
	const committedLedger = (): ReviewLedger => {
		const ledger = twoReviewerLedger();
		ledger.entries = ledger.entries.map((entry) => ({
			...entry,
			finding: {
				...entry.finding,
				provenance: [
					{
						agentId: entry.reviewer,
						stageId: "review",
						modelId: "model/a",
						commit: "a".repeat(40),
						reportedAt: NOW,
					},
				],
			},
		}));
		return ledger;
	};

	it("requires meaningful immutable fix commits", () => {
		const result = applyResolutions(
			committedLedger(),
			[
				{ id: "correctness.1", status: "fixed", note: "fixed" },
				{
					id: "security-alt.1",
					status: "fixed",
					note: "fixed",
					fixCommit: "b".repeat(40),
				},
			],
			NOW,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors.join(" ")).toContain("fixCommit");
	});

	it("keeps evidence-bearing disputes and user escalations blocking", () => {
		const result = applyResolutions(
			committedLedger(),
			[
				{
					id: "correctness.1",
					status: "needs-user",
					note: "API behavior is ambiguous",
					evidence: ["spec section 4 conflicts with test x"],
				},
				{
					id: "security-alt.1",
					status: "disputed",
					note: "branch is unreachable",
					evidence: ["src/a.ts:8 guards the branch"],
				},
			],
			NOW,
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(openBlocking(result.ledger)).toHaveLength(2);
	});
});
