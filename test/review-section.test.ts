// The Review section: one pure rendering of a `reviews-<d>` record and the last
// check, shared by the ship dialog's Look first, an auto run's account and the
// pull-request body.
//
// The fixture is not hand-typed: `test/fixtures/reviews-record.json` was built
// by pi-workflow 8.0.0's own `clusterFindings`, `applyModelMerges`,
// `reviewerEntries`, `withDispositions` and `withAdjudications`, and validated
// against its `ReviewsRecordSchema` and `CheckReportSchema`; its `contested`
// is the ship summary entry pi-workflow's `reviewCounts` and
// `specLikelyAtFault` give for that record. Two reviewers read one lens at the
// `light` and `normal` tiers and agree on one finding, a third failed, and a
// `fast` sweep raised one lead. The resumed implementer fixed one finding,
// declined three and put one out of scope; the judge upheld one, overruled one
// and could not decide one, and never saw the sweep's lead.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	CLUSTER_STANDINGS,
	type ClusterView,
	isContested,
	MAX_RENDERED_REASONING,
	MAX_SECTION_CLUSTERS,
	MAX_SECTIONS_LENGTH,
	MAX_TOTAL_CLUSTERS,
	type ReviewSectionInput,
	type ReviewsView,
	readCheckReport,
	readReviewsRecord,
	renderReviewSection,
	renderReviewSections,
	reviewSectionsFrom,
	standing,
	tallyReviews,
} from "../packages/maestro/src/review-section.js";

const FIXTURE = JSON.parse(
	readFileSync(
		join(
			dirname(fileURLToPath(import.meta.url)),
			"fixtures",
			"reviews-record.json",
		),
		"utf8",
	),
) as {
	reviews: Record<string, unknown>;
	check: Record<string, unknown>;
	contested: {
		contested: number;
		upheld: number;
		overruled: number;
		undecidable: number;
		note?: string;
	};
};

const reviews = readReviewsRecord(FIXTURE.reviews) as ReviewsView;
const check = readCheckReport(FIXTURE.check);
const api: ReviewSectionInput = {
	id: "api",
	reviews,
	...(check ? { check } : {}),
};

/** The fixture's record with `n` copies of its clusters, ids renumbered. */
function widened(n: number, reasoning?: string): ReviewsView {
	const clusters: ClusterView[] = [];
	for (let i = 0; i < n; i++) {
		const base = reviews.clusters[i % reviews.clusters.length] as ClusterView;
		clusters.push({
			...base,
			id: `c${i + 1}`,
			...(base.disposition
				? {
						disposition: {
							...base.disposition,
							...(reasoning ? { reasoning } : {}),
						},
					}
				: {}),
		});
	}
	return { ...reviews, clusters };
}

describe("reading a record", () => {
	it("reads every reviewer, cluster and disposition the record carries", () => {
		expect(reviews.deliverable).toBe("api");
		expect(reviews.unreadable).toBe(0);
		expect(reviews.reviewers).toEqual([
			{
				lens: "correctness",
				model: "anthropic/claude-haiku-4-5",
				thinking: "low",
				tier: "light",
				status: "reported",
				findings: 2,
			},
			{
				lens: "correctness",
				model: "anthropic/claude-opus-4-5",
				thinking: "high",
				tier: "normal",
				status: "reported",
				findings: 3,
			},
			{
				lens: "security",
				model: "openai/gpt-5",
				thinking: "medium",
				tier: "normal",
				status: "failed",
				findings: 0,
			},
			{
				lens: "hygiene",
				model: "anthropic/claude-haiku-4-5",
				thinking: "off",
				tier: "fast",
				status: "reported",
				findings: 1,
			},
		]);
		expect(tallyReviews(reviews)).toEqual({
			reviewers: 4,
			reported: 3,
			clusters: 5,
			agreed: 1,
			fixed: 1,
			declined: 3,
			outOfScope: 1,
			unanswered: 0,
			contested: 3,
			upheld: 1,
			overruled: 1,
			undecidable: 1,
		});
	});

	// The second place pi-workflow's contested rule lives: the counts this seat
	// works out from the record are the counts pi-workflow wrote beside it.
	it("counts what was contested exactly as pi-workflow does", () => {
		const tally = tallyReviews(reviews);
		const { note: _, ...counts } = FIXTURE.contested;
		expect({
			contested: tally.contested,
			upheld: tally.upheld,
			overruled: tally.overruled,
			undecidable: tally.undecidable,
		}).toEqual(counts);
		// The sweep's lead was declined and is still not contested.
		const lead = reviews.clusters.find((cluster) => cluster.id === "c6");
		expect(lead?.disposition?.kind).toBe("declined");
		expect(lead && isContested(lead)).toBe(false);
	});

	it("reads each verdict and orders the standings worst first", () => {
		expect(
			reviews.clusters.map((cluster) => [cluster.id, standing(cluster)]),
		).toEqual([
			["c1", "overruled"],
			["c2", "fixed"],
			["c4", "declined"],
			["c5", "upheld"],
			["c6", "declined"],
		]);
		expect([...CLUSTER_STANDINGS]).toEqual([
			"upheld",
			"declined",
			"unanswered",
			"out-of-scope",
			"overruled",
			"fixed",
		]);
	});

	it("counts an entry it cannot read rather than dropping it unsaid", () => {
		const broken = readReviewsRecord({
			...FIXTURE.reviews,
			clusters: [
				...(FIXTURE.reviews.clusters as unknown[]),
				{ id: "c9", claim: "no location" },
			],
		});
		expect(broken?.clusters).toHaveLength(5);
		expect(broken?.unreadable).toBe(1);
		expect(
			renderReviewSection({ id: "api", reviews: broken as ReviewsView }),
		).toContain(
			"1 entry of the record could not be read here; the receipt has them.",
		);
	});

	it("is nothing for a value that is not a record", () => {
		expect(readReviewsRecord(undefined)).toBeUndefined();
		expect(readReviewsRecord({ findings: [] })).toBeUndefined();
		expect(readCheckReport({ summary: "no flag" })).toBeUndefined();
	});
});

describe("one deliverable's section", () => {
	// The whole rendering, quoted: this is what a person reads at Look first,
	// what an auto run posts after publishing, and what the pull request says.
	it("renders the fixture exactly", () => {
		expect(renderReviewSections([api])).toBe(
			[
				"Review of `api`: 3 of 4 reviewers reported; 5 findings, 1 raised by two or more; 1 fixed, 3 declined, 1 out of scope, 0 unanswered.",
				"Check: `npm run check` ran and passed.",
				"Adjudication: 3 contested (1 upheld, 1 overruled, 1 undecidable).",
				"Upheld by the judge, the reviewer's claim stands: c5.",
				"Declined, shipping as it is: c4, c5, c6.",
				"Did not report, so not counted in any agreement: security [normal] (openai/gpt-5, medium).",
				"- The timeout is read in seconds but passed as milliseconds. — src/config.ts:7 · found by correctness [light] (anthropic/claude-haiku-4-5, low) ×1 of 3 · medium · declined (TIMEOUT is documented in milliseconds and every caller passes milliseconds; converting it would break them.) · judge: upheld (The env file the README documents gives TIMEOUT in seconds, and setTimeout takes milliseconds.) [c5]",
				"- The error message includes the full request URL, query string and all. — src/client.ts:80 · found by correctness [normal] (anthropic/claude-opus-4-5, high) ×1 of 3 · medium · declined (The URL carries no credentials in this API, and the message is what an operator needs to find the failing call.) · judge: undecidable (Whether a URL may carry a token depends on callers this change does not show.) [c4]",
				"- An import in src/util.ts is unused. — src/util.ts:3 · found by hygiene [fast] (anthropic/claude-haiku-4-5, off) ×1 of 3 · low · declined (The import is used by a type-only re-export the sweep does not see.) [c6]",
				"- The README still documents the old flag name. — README.md · found by correctness [normal] (anthropic/claude-opus-4-5, high) ×1 of 3 · low · out-of-scope (The README is rewritten by the docs deliverable.) · judge: overruled (The docs deliverable rewrites the README, so the stale flag name is its to fix.) [c1]",
				"- The retry loop never gives up when the server answers 503. — src/client.ts:42 · found by correctness [light] (anthropic/claude-haiku-4-5, low), correctness [normal] (anthropic/claude-opus-4-5, high) ×2 of 3 · high · fixed (Bounded the loop by maxAttempts and added a test for the 503 path.) [c2]",
			].join("\n"),
		);
	});

	// Two entries with one lens and different tiers are two reviewers, and the
	// section says which tier, model and thinking level found what.
	it("names both reviewers of one lens, each with its tier, model and thinking", () => {
		const text = renderReviewSection(api);
		expect(text).toContain(
			"found by correctness [light] (anthropic/claude-haiku-4-5, low), correctness [normal] (anthropic/claude-opus-4-5, high) ×2 of 3",
		);
	});

	it("lists an upheld claim first, then unadjudicated declines, overruled before fixed", () => {
		const ids = renderReviewSection(api)
			.split("\n")
			.filter((line) => line.startsWith("- "))
			.map((line) => line.slice(line.lastIndexOf("[") + 1, -1));
		expect(ids).toEqual(["c5", "c4", "c6", "c1", "c2"]);
	});

	it("adds the spec note a ship summary carries, and only then", () => {
		const note = FIXTURE.contested.note as string;
		expect(renderReviewSection({ ...api, specNote: note })).toContain(
			`Adjudication: 3 contested (1 upheld, 1 overruled, 1 undecidable).\n${note}`,
		);
		expect(renderReviewSection(api)).not.toContain(
			"spec is the likely problem",
		);
	});

	it("says an unanswered finding is unanswered", () => {
		const unanswered: ReviewsView = {
			...reviews,
			clusters: reviews.clusters.map(({ disposition: _, ...rest }) => rest),
		};
		const text = renderReviewSection({ id: "api", reviews: unanswered });
		expect(text).toContain("0 fixed, 0 declined, 0 out of scope, 5 unanswered");
		expect(text).toContain("Adjudication: 0 contested");
		expect(text).toContain("· high · unanswered [c2]");
		expect(text).not.toContain("Declined, shipping");
		expect(text).toContain("Check: no report.");
	});

	it("says when nobody was asked to review", () => {
		expect(
			renderReviewSection({ id: "docs", check: { ran: false, passed: false } }),
		).toBe("Review of `docs`: no reviewers were asked.\nCheck: did not run.");
	});
});

describe("bounded, and it says so", () => {
	it("lists at most the cap and says how many more are in the receipt", () => {
		const text = renderReviewSection({ id: "api", reviews: widened(30) });
		expect(
			text.split("\n").filter((line) => line.startsWith("- ")),
		).toHaveLength(MAX_SECTION_CLUSTERS);
		expect(text).toContain(
			`${30 - MAX_SECTION_CLUSTERS} more findings not shown; the full record is in the run's receipt (\`reviews-api\`).`,
		);
		// Every decline is still named, shown or not.
		expect(text).toContain(
			"Declined, shipping as it is: c3, c4, c5, c8, c9, c10, c13, c14, c15, c18, c19, c20, c23, c24, c25, c28, c29, c30.",
		);
	});

	it("cuts a long reasoning and keeps the cut visible", () => {
		const long = "because ".repeat(200).trim();
		const text = renderReviewSection({
			id: "api",
			reviews: widened(3, long),
		});
		const line = text
			.split("\n")
			.find((entry) => entry.includes("declined (b"));
		const reasoning = line?.match(/declined \((.*?)\) · judge/)?.[1] ?? "";
		expect(reasoning.length).toBe(MAX_RENDERED_REASONING);
		expect(reasoning.endsWith("…")).toBe(true);
	});

	it("shares the clusters out across deliverables and stays under the body limit", () => {
		const long = "x".repeat(2048);
		const many: ReviewSectionInput[] = Array.from({ length: 16 }, (_, i) => ({
			id: `d${i}`,
			reviews: { ...widened(64, long), deliverable: `d${i}` },
		}));
		const text = renderReviewSections(many);
		const shown = text.split("\n").filter((line) => line.startsWith("- "));
		expect(shown.length).toBeLessThanOrEqual(MAX_TOTAL_CLUSTERS);
		expect(text.length).toBeLessThanOrEqual(MAX_SECTIONS_LENGTH);
		for (let i = 0; i < 16; i++) expect(text).toContain(`Review of \`d${i}\``);
		expect(text).toContain("more findings not shown");
	});
});

describe("where the two values come from", () => {
	const gate = {
		tasks: [
			{
				kind: "checkpoint",
				key: "ship",
				checkpoint: {
					inputs: {
						plan: {},
						"summary-api": { summary: "s" },
						"reviews-api": FIXTURE.reviews,
						"check-api": FIXTURE.check,
						"summary-docs": { summary: "d" },
						"check-docs": { ...FIXTURE.check, checkRan: false },
					},
				},
			},
		],
	};

	it("reads a gated run's sections off the ship gate's inputs", () => {
		const sections = reviewSectionsFrom(gate);
		expect(sections.map((section) => section.id)).toEqual(["api", "docs"]);
		expect(renderReviewSections(sections)).toBe(
			`${renderReviewSections([api])}\n\nReview of \`docs\`: no reviewers were asked.\nCheck: \`npm run check\` did not run.`,
		);
	});

	it("reads an auto run's sections off its shipSummary, to the same text", () => {
		const auto = {
			run: {
				output: {
					shipSummary: {
						deliverables: [
							{
								id: "api",
								summary: {},
								reviews: FIXTURE.reviews,
								contested: FIXTURE.contested,
								check: FIXTURE.check,
							},
						],
					},
				},
			},
		};
		expect(renderReviewSections(reviewSectionsFrom(auto))).toBe(
			renderReviewSections([
				{ ...api, specNote: FIXTURE.contested.note as string },
			]),
		);
	});

	it("falls back to the output's records and check flags", () => {
		const output = {
			output: {
				deliverables: [{ id: "api", checkRan: true, checkPassed: false }],
				reviews: [FIXTURE.reviews],
			},
		};
		const [section] = reviewSectionsFrom(output);
		expect(section?.reviews?.clusters).toHaveLength(5);
		expect(section?.check).toEqual({ ran: true, passed: false });
	});
});
