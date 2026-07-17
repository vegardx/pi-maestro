import { describe, expect, it } from "vitest";
import {
	MAESTRO_PR_BEGIN,
	MAESTRO_PR_END,
	renderMaestroPrSection,
	updateMaestroPrBody,
} from "../packages/modes/src/pr-provenance.js";
import type { Deliverable } from "../packages/modes/src/schema.js";
import type { WorkflowAnalyticsLedger } from "../packages/modes/src/workflow-analytics.js";

const NOW = "2026-01-01T00:00:00.000Z";
const SHA = "a".repeat(40);

function analytics(
	overrides: Partial<WorkflowAnalyticsLedger> = {},
): WorkflowAnalyticsLedger {
	return {
		version: 1,
		deliverableId: "delivery",
		revision: 4,
		stages: [
			{
				stageId: "review",
				inputSha: SHA,
				outputSha: SHA,
				status: "succeeded",
				startedAt: NOW,
				completedAt: "2026-01-01T00:00:01.000Z",
			},
		],
		assignments: [
			{
				assignmentId: "security",
				stageId: "review",
				kind: "security-review",
				modelId: "provider/model",
				effort: "high",
				runId: "run-1",
				inputSha: SHA,
				outputSha: SHA,
				status: "succeeded",
				startedAt: NOW,
				completedAt: "2026-01-01T00:00:01.000Z",
				evidence: ["src/auth.ts:42 proves the guard", "token=super-secret"],
				usage: {
					input: 10,
					output: 5,
					cacheRead: 20,
					cacheWrite: 1,
					promptTokens: 31,
					totalTokens: 36,
					cost: 0.125,
					turns: 1,
				},
			},
		],
		rawFindings: [],
		canonicalFindings: [
			{
				finding: {
					id: "finding-0001",
					severity: "major",
					category: "security",
					file: "src/auth.ts",
					line: 42,
					actual: "Bearer abcdefghijklmnopqrstuvwxyz123456 leaks",
				},
				reviewer: "security",
				duplicateIds: ["finding-0002"],
				resolution: {
					id: "finding-0001",
					status: "fixed",
					note: "remove secret from log",
					fixCommit: SHA,
					at: NOW,
				},
				verification: {
					id: "finding-0001",
					result: "verified",
					note: "regression test passes",
					at: NOW,
				},
			},
		],
		finalVerification: {
			assignmentId: "verifier",
			modelId: "provider/verifier",
			effort: "medium",
			runId: "verify-1",
			reviewedSha: SHA,
			status: "passed",
			startedAt: NOW,
			completedAt: "2026-01-01T00:00:02.000Z",
			evidence: ["test/auth.test.ts passes"],
		},
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

function deliverable(overrides: Partial<Deliverable> = {}): Deliverable {
	return {
		type: "deliverable",
		id: "delivery",
		title: "Delivery",
		body: "Body",
		status: "complete",
		worker: { mode: "full" },
		agents: [],
		tasks: [],
		workflowAnalytics: analytics(),
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

describe("PR provenance rendering", () => {
	it("renders canonical table and collapsible assignment/verification evidence", () => {
		const section = renderMaestroPrSection(deliverable());
		expect(section).toContain("**Overall review state:** Approved");
		expect(section).toContain("| finding-0001 | major |");
		expect(section).toContain("fixed: remove secret from log");
		expect(section).toContain("verified: regression test passes");
		expect(section).toContain("<summary>security — succeeded</summary>");
		expect(section).toContain("<summary>Final verification — passed</summary>");
		expect(section).toContain("provider/model");
		expect(section).toContain("run-1");
		expect(section).toContain(SHA.slice(0, 12));
		expect(section).not.toContain("super-secret");
		expect(section).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
	});

	it("keeps all canonical findings when optional details exceed the budget", () => {
		const manyAssignments = Array.from({ length: 20 }, (_, index) => ({
			...analytics().assignments[0]!,
			assignmentId: `reviewer-${index}`,
			evidence: ["x".repeat(500)],
		}));
		const section = renderMaestroPrSection(
			deliverable({
				workflowAnalytics: analytics({ assignments: manyAssignments }),
			}),
			{ maxBytes: 2_000 },
		);
		expect(section).toContain("finding-0001");
		expect(section).toContain("optional evidence section");
		expect(Buffer.byteLength(section)).toBeLessThanOrEqual(2_000);
	});

	it("fails rather than dropping canonical evidence", () => {
		const huge = analytics().canonicalFindings.map((entry) => ({
			...entry,
			finding: { ...entry.finding, actual: "x".repeat(10_000) },
		}));
		expect(() =>
			renderMaestroPrSection(
				deliverable({
					workflowAnalytics: analytics({ canonicalFindings: huge }),
				}),
				{ maxBytes: 300 },
			),
		).toThrow("refusing to omit");
	});
});

describe("marker-bounded PR updates", () => {
	it("preserves user text and replaces the owned section idempotently", () => {
		const first = renderMaestroPrSection(deliverable());
		const old = `${MAESTRO_PR_BEGIN}\nold generated content\n${MAESTRO_PR_END}`;
		const body = `User intro\n\n${old}\n\nUser footer`;
		const updated = updateMaestroPrBody(body, first);
		expect(updated.startsWith("User intro\n\n")).toBe(true);
		expect(updated.endsWith("\n\nUser footer")).toBe(true);
		expect(updated).not.toContain("old generated content");
		expect(updateMaestroPrBody(updated, first)).toBe(updated);
	});

	it("rejects malformed markers and oversized complete bodies", () => {
		const section = renderMaestroPrSection(deliverable());
		expect(() =>
			updateMaestroPrBody(`${MAESTRO_PR_BEGIN}\nbroken`, section),
		).toThrow("malformed");
		expect(() => updateMaestroPrBody("user text", section, 100)).toThrow(
			"exceeding GitHub",
		);
	});
});
