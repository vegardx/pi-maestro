// The v2 contract system: fence extraction, envelope structure, per-contract
// validators with ENFORCED bounds, verdict projections (never agent-asserted),
// salvage tiers (the re-homed v1 parsers), and migrate-on-read.

import {
	CONTRACT_DEFINITIONS,
	type ContractDefinition,
	type ContractEnvelope,
	contractRetrySteer,
	extractContractBlock,
	type FindingsPayload,
	findingsVerdict,
	type PlanGateReportPayload,
	parseContractEnvelope,
	planGateVerdict,
	type SummaryAndDiffPayload,
	upgradeContractPayload,
	type VerdictPayload,
	validateContractEnvelope,
	verdictFromChecks,
} from "@vegardx/pi-contracts";
import { describe, expect, it } from "vitest";

function envelope<P>(
	contract: ContractEnvelope["contract"],
	payload: P,
	v = 1,
): ContractEnvelope {
	return { contract, v, status: "complete", payload } as ContractEnvelope;
}

const VALID_FINDINGS: FindingsPayload = {
	findings: [
		{
			id: "F1",
			severity: "major",
			category: "security",
			file: "src/rotate.ts",
			line: 88,
			actual: "old refresh token stays valid until TTL",
		},
	],
	scope: { reviewed: "feat/auth 9f31c2e..4b7d0aa" },
	summary: "One real gap in revocation ordering.",
};

describe("fence extraction", () => {
	it("takes the LAST pi-contract fence and ignores json fences", () => {
		const text = [
			"Here is an illustrative payload:",
			"```json",
			'{ "contract": "findings", "decoy": true }',
			"```",
			"```pi-contract",
			'{ "first": true }',
			"```",
			"Final version:",
			"```pi-contract",
			'{ "contract": "verdict", "v": 1, "status": "complete", "payload": { "verdict": "pass", "reason": "ok" } }',
			"```",
		].join("\n");
		expect(extractContractBlock(text)).toContain('"verdict"');
		expect(extractContractBlock(text)).not.toContain("decoy");
		expect(extractContractBlock(text)).not.toContain("first");
	});

	it("returns null when no fence exists", () => {
		expect(extractContractBlock("just prose, no block")).toBeNull();
	});

	it("parses and structurally validates the envelope", () => {
		const good = parseContractEnvelope(
			'```pi-contract\n{ "contract": "verdict", "v": 1, "status": "complete", "payload": { "verdict": "pass", "reason": "ok" } }\n```',
		);
		expect(good.errors).toEqual([]);
		expect(good.envelope?.contract).toBe("verdict");

		const badJson = parseContractEnvelope("```pi-contract\n{ nope\n```");
		expect(badJson.envelope).toBeNull();
		expect(badJson.errors[0]).toContain("not valid JSON");

		const badShape = parseContractEnvelope(
			'```pi-contract\n{ "contract": "nope", "v": 0, "status": "later", "payload": [] }\n```',
		);
		expect(badShape.envelope).toBeNull();
		expect(badShape.errors).toHaveLength(4);
	});
});

describe("payload validators", () => {
	it("accepts the spike's worker example and demands notes on non-done tasks", () => {
		const payload: SummaryAndDiffPayload = {
			summary: "Implemented token rotation.",
			outcome: "done",
			tasks: [
				{ id: "t1", state: "done" },
				{ id: "t2", state: "partial", note: "no fake-clock seam yet" },
			],
			validation: [{ command: "npm test", result: "pass" }],
		};
		expect(
			validateContractEnvelope(envelope("summary-and-diff", payload), "raw"),
		).toEqual([]);

		const missingNote = {
			...payload,
			tasks: [{ id: "t2", state: "partial" }],
		};
		expect(
			validateContractEnvelope(
				envelope("summary-and-diff", missingNote),
				"raw",
			).join(" "),
		).toContain("note is required");
	});

	it("requires blockedReason when blocked", () => {
		const errors = validateContractEnvelope(
			envelope("summary-and-diff", {
				summary: "s",
				outcome: "blocked",
				tasks: [],
			}),
			"raw",
		);
		expect(errors.join(" ")).toContain("blockedReason");
	});

	it("validates findings through the shared StructuredFinding validator", () => {
		expect(
			validateContractEnvelope(envelope("findings", VALID_FINDINGS), "raw"),
		).toEqual([]);
		const bad = {
			...VALID_FINDINGS,
			findings: [{ id: "F1", severity: "sev-high", actual: "x" }],
		};
		expect(
			validateContractEnvelope(envelope("findings", bad), "raw").join(" "),
		).toContain("findings[0]");
	});

	it("enforces the plan-gate rewrite rule and word bounds", () => {
		const good: PlanGateReportPayload = {
			verdict: "revise",
			findings: [
				{
					id: "P1",
					severity: "blocking",
					node: "build-auth",
					kind: "ambiguity",
					problem: "two readings of the fan-out instruction",
					rewrite: "spawn three coder candidates on distinct normal families",
				},
			],
			summary: "Fix P1 and proceed.",
		};
		expect(
			validateContractEnvelope(envelope("plan-gate-report", good), "short raw"),
		).toEqual([]);

		const noRewrite = {
			...good,
			findings: [{ ...good.findings[0], rewrite: undefined }],
		};
		expect(
			validateContractEnvelope(
				envelope("plan-gate-report", noRewrite),
				"short raw",
			).join(" "),
		).toContain("rewrite is required");

		// maxRawWords = 700 is ENFORCED (v1 declared it and never checked).
		const longRaw = Array.from({ length: 800 }, (_, i) => `w${i}`).join(" ");
		expect(
			validateContractEnvelope(
				envelope("plan-gate-report", good),
				longRaw,
			).join(" "),
		).toContain("700 words");
	});

	it("rejects report answers over 600 chars and facts without evidence", () => {
		const errors = validateContractEnvelope(
			envelope("report", {
				answer: "x".repeat(601),
				facts: [{ text: "fact", evidence: [] }],
				unknowns: [],
				confidence: "high",
			}),
			"raw",
		);
		expect(errors.join(" ")).toContain("600 chars");
		expect(errors.join(" ")).toContain("non-empty array");
	});
});

describe("verdict projections", () => {
	it("computes the reviewer verdict from severities — never agent-asserted", () => {
		expect(findingsVerdict(VALID_FINDINGS)).toBe("request-changes");
		expect(findingsVerdict({ ...VALID_FINDINGS, findings: [] })).toBe(
			"approve",
		);
		expect(
			findingsVerdict({
				...VALID_FINDINGS,
				findings: [{ ...VALID_FINDINGS.findings[0], severity: "minor" }],
			}),
		).toBe("approve");
	});

	it("recomputes verdicts from checks; recomputation wins", () => {
		const payload: VerdictPayload = {
			verdict: "pass", // the agent says pass…
			reason: "looks fine",
			checks: [
				{ ref: "F1", state: "verified" },
				{ ref: "F3", state: "still-open" }, // …but a check is open
			],
		};
		expect(verdictFromChecks(payload)).toBe("block");
		expect(verdictFromChecks({ verdict: "block", reason: "r" })).toBeNull();
		expect(
			verdictFromChecks({
				verdict: "block",
				reason: "r",
				checks: [{ ref: "F1", state: "not-checkable" }],
			}),
		).toBe("pass"); // not-checkable does not block
	});

	it("recomputes the plan-gate verdict from blocking findings", () => {
		const advisoryOnly: PlanGateReportPayload = {
			verdict: "revise", // agent says revise, but nothing blocks
			findings: [
				{
					id: "P1",
					severity: "advisory",
					kind: "advisory-nudge",
					problem: "missing shipping-conventions skill",
				},
			],
			summary: "ok",
		};
		expect(planGateVerdict(advisoryOnly)).toBe("proceed");
	});
});

describe("salvage tiers (v1 parsers re-homed)", () => {
	it("salvages a verdict from VERDICT: wire words, escalates on silence", () => {
		const def = CONTRACT_DEFINITIONS.verdict;
		expect(def.salvage("…report…\nVERDICT: PASS")).toMatchObject({
			verdict: "pass",
		});
		expect(
			def.salvage(
				"VERDICT: request-changes\n- rotate.ts:88 — unchecked revoke",
			),
		).toMatchObject({ verdict: "block" });
		expect(def.salvage("no verdict anywhere")).toBeNull();
	});

	it("salvages findings from bullets, but never reads silence as clean", () => {
		const def = CONTRACT_DEFINITIONS.findings;
		const salvaged = def.salvage(
			"VERDICT: request-changes\n- `src/a.ts:12` — off-by-one in loop",
		) as FindingsPayload;
		expect(salvaged.findings).toHaveLength(1);
		expect(salvaged.findings[0]).toMatchObject({
			severity: "major",
			file: "src/a.ts",
			line: 12,
		});
		expect(def.salvage("VERDICT: approve")).toMatchObject({ findings: [] });
		expect(def.salvage("rambling with no verdict")).toBeNull();
	});

	it("salvages a report from the Digest section", () => {
		const def = CONTRACT_DEFINITIONS.report;
		const salvaged = def.salvage(
			"long prose…\n## Digest\nSessions are JSONL appended in place.\n",
		);
		expect(salvaged).toMatchObject({
			answer: "Sessions are JSONL appended in place.",
			confidence: "low",
		});
	});

	it("salvages a worker summary as partial, never fabricating tasks", () => {
		const def = CONTRACT_DEFINITIONS["summary-and-diff"];
		expect(def.salvage("## Summary\nbuilt the widget")).toMatchObject({
			outcome: "partial",
			tasks: [],
		});
		expect(def.salvage("   ")).toBeNull();
	});
});

describe("versioning", () => {
	it("upgrades through the migration chain, in memory only", () => {
		const def: ContractDefinition = {
			id: "report",
			latest: 3,
			instruction: "",
			validate: () => [],
			salvage: () => null,
			migrations: [
				(p) => ({ ...(p as object), b: 2 }),
				(p) => ({ ...(p as object), c: 3 }),
			],
		};
		expect(upgradeContractPayload(def, { a: 1 }, 1)).toEqual({
			a: 1,
			b: 2,
			c: 3,
		});
		expect(upgradeContractPayload(def, { a: 1, b: 2 }, 2)).toEqual({
			a: 1,
			b: 2,
			c: 3,
		});
		expect(() => upgradeContractPayload(def, {}, 4)).toThrow("newer");
	});

	it("rejects envelopes newer than the harness supports", () => {
		const errors = validateContractEnvelope(
			envelope("verdict", { verdict: "pass", reason: "r" }, 99),
			"raw",
		);
		expect(errors.join(" ")).toContain("newer than this harness supports");
	});
});

describe("retry steer", () => {
	it("renders validator errors into a short corrective steer", () => {
		const steer = contractRetrySteer("findings", [
			"payload.scope.reviewed is required",
		]);
		expect(steer).toContain("```pi-contract");
		expect(steer).toContain("findings v1");
		expect(steer).toContain("scope.reviewed");
		expect(steer).toContain("Re-emit only the corrected block");
	});
});
