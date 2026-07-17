import { describe, expect, it } from "vitest";
import { assessDelivery, renderVerificationScope } from "../packages/modes/src/exec/assessment.js";
import { buildLedger } from "../packages/modes/src/exec/findings.js";

const SHA = "a".repeat(40);
const FIX = "b".repeat(40);
const NOW = "2026-01-01T00:00:00Z";
const assignment = {
	agentId: "correctness",
	kind: "correctness-review" as const,
	presetId: "review",
	modelSetId: "set",
	optionId: "one",
	modelId: "model/a",
	runtime: {
		mode: "read-only" as const,
		transport: "headless" as const,
		tools: {},
		session: "ephemeral" as const,
		isolation: "strong" as const,
	},
	focus: "Review",
	rationale: "Required review",
	inputContracts: [],
	outputContracts: ["structured-review"],
	provenance: {
		source: "explicit" as const,
		presetId: "review",
		modelSetId: "set",
		optionId: "one",
		resolvedAt: NOW,
	},
	resolvedAt: NOW,
	source: "explicit" as const,
};

describe("final delivery assessment", () => {
	it("scopes fix verification to original and fix ranges", () => {
		const prompt = renderVerificationScope({
			findingId: "finding-0001",
			original: { base: SHA, head: SHA },
			fixCommit: FIX,
			fixHead: FIX,
		});
		expect(prompt).toContain(`${SHA}..${FIX}`);
		expect(prompt).toContain("Do not issue an open-ended reviewer verdict");
	});

	it("requires every assigned report and no unresolved blocker", () => {
		const ledger = buildLedger(
			[
				{
					reviewer: "correctness",
					findings: [
						{ id: "x", severity: "major", category: "bug", actual: "broken" },
					],
				},
			],
			NOW,
		);
		ledger.participants = [{ name: "correctness", ok: true }];
		const assessment = assessDelivery({
			head: SHA,
			expectedHead: SHA,
			assignedReviews: [assignment],
			ledger,
			assessedAt: NOW,
		});
		expect(assessment.complete).toBe(false);
		expect(assessment.blockers).toContain(
			"blocking finding correctness.1 is unresolved",
		);
	});

	it("does not accept bare assignment completion without a report", () => {
		const assessment = assessDelivery({
			head: SHA,
			expectedHead: SHA,
			assignedReviews: [assignment],
			assessedAt: NOW,
		});
		expect(assessment.complete).toBe(false);
		expect(assessment.blockers).toContain("assigned reviews produced no canonical report");
	});
});
