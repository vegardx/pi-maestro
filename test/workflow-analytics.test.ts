import { describe, expect, it } from "vitest";
import { buildLedger } from "../packages/modes/src/exec/findings.js";
import {
	applyWorkflowAnalyticsEvent,
	assignmentAnalytics,
	createWorkflowAnalyticsLedger,
	workflowAnalyticsTotals,
} from "../packages/modes/src/workflow-analytics.js";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T00:00:02.000Z";
const SHA = "a".repeat(40);
const assignment = {
	agentId: "correctness",
	kind: "correctness-review" as const,
	presetId: "review",
	modelSetId: "models",
	optionId: "one",
	modelId: "provider/model",
	effort: "high" as const,
	runtime: {
		mode: "read-only" as const,
		transport: "headless" as const,
		tools: {},
		session: "ephemeral" as const,
		isolation: "strong" as const,
	},
	focus: "Review",
	rationale: "independent check",
	inputContracts: ["implementation"],
	outputContracts: ["structured-review"],
	provenance: {
		source: "explicit" as const,
		presetId: "review",
		modelSetId: "models",
		optionId: "one",
		resolvedAt: NOW,
	},
	resolvedAt: NOW,
	source: "explicit" as const,
};

const usage = {
	input: 10,
	output: 5,
	cacheRead: 20,
	cacheWrite: 2,
	promptTokens: 32,
	totalTokens: 37,
	cost: 0.25,
	turns: 1,
};

describe("workflow analytics ledger", () => {
	it("upserts assignments idempotently and aggregates exact usage", () => {
		let ledger = createWorkflowAnalyticsLedger("delivery", NOW);
		const completed = assignmentAnalytics({
			assignment,
			stageId: "review",
			inputSha: SHA,
			outputSha: SHA,
			runId: "run-1",
			status: "succeeded",
			startedAt: NOW,
			completedAt: LATER,
			usage,
		});
		ledger = applyWorkflowAnalyticsEvent(
			ledger,
			{ type: "assignment", assignment: completed },
			LATER,
		);
		ledger = applyWorkflowAnalyticsEvent(
			ledger,
			{ type: "assignment", assignment: completed },
			LATER,
		);
		expect(ledger.assignments).toHaveLength(1);
		expect(ledger.assignments[0]).toMatchObject({
			modelId: "provider/model",
			effort: "high",
			runId: "run-1",
			inputSha: SHA,
		});
		expect(workflowAnalyticsTotals(ledger)).toEqual({
			usage,
			durationMs: 2_000,
		});
	});

	it("projects canonical findings, resolutions, and verification checks", () => {
		const review = buildLedger(
			[
				{
					reviewer: "correctness",
					findings: [
						{
							id: "ignored",
							severity: "major",
							category: "correctness",
							file: "src/a.ts",
							actual: "value is stale",
						},
					],
				},
			],
			NOW,
		);
		review.entries[0]!.resolution = {
			id: "correctness.1",
			status: "fixed",
			note: "fixed null path",
			fixCommit: SHA,
			at: LATER,
		};
		review.entries[0]!.check = {
			id: "correctness.1",
			result: "verified",
			note: "test covers null path",
			at: LATER,
		};
		const ledger = applyWorkflowAnalyticsEvent(
			createWorkflowAnalyticsLedger("delivery", NOW),
			{ type: "review-ledger", ledger: review },
			LATER,
		);
		expect(ledger.canonicalFindings[0]).toMatchObject({
			reviewer: "correctness",
			finding: { id: "correctness.1", severity: "major" },
			resolution: { status: "fixed", fixCommit: SHA },
			verification: { result: "verified" },
		});
	});
});
