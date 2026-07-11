// Structured verifier findings (fenced JSON after the verdict, with a
// bullet fallback) and the persisted per-round verification report.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	parseStructuredFindings,
	type VerifyEntry,
} from "../packages/modes/src/exec/verify.js";
import {
	renderVerificationReport,
	themeRollup,
	writeVerificationReport,
} from "../packages/modes/src/exec/verify-report.js";

const REPORT_WITH_JSON = `Task-by-task, the parity suite is fake.
VERDICT: block
\`\`\`json
{"findings": [
  {"severity": "critical", "category": "fake-verification", "file": "test/parity.test.mjs", "line": 5,
   "task": "port-parity-suite", "claim": "black-box parity suite executes workflows",
   "actual": "only asserts scenario names occur in a JSON catalog"},
  {"severity": "unknown-severity", "category": "", "actual": "run-matrix fabricates passed results"}
]}
\`\`\``;

describe("parseStructuredFindings", () => {
	it("parses the fenced JSON block and normalizes loose fields", () => {
		const findings = parseStructuredFindings(REPORT_WITH_JSON);
		expect(findings).toHaveLength(2);
		expect(findings[0]).toMatchObject({
			id: "F1",
			severity: "critical",
			category: "fake-verification",
			file: "test/parity.test.mjs",
			line: 5,
			task: "port-parity-suite",
			claim: "black-box parity suite executes workflows",
		});
		// Unknown severity → major; empty category → uncategorized.
		expect(findings[1]).toMatchObject({
			id: "F2",
			severity: "major",
			category: "uncategorized",
			actual: "run-matrix fabricates passed results",
		});
	});

	it("falls back to verdict bullets when no JSON block exists", () => {
		const findings = parseStructuredFindings(
			"bad\nVERDICT: block\n- src/x.ts:12 — logout is a stub\n- something broader",
		);
		expect(findings).toHaveLength(2);
		expect(findings[0]).toMatchObject({
			file: "src/x.ts",
			line: 12,
			actual: "logout is a stub",
			category: "uncategorized",
		});
		expect(findings[1].actual).toBe("something broader");
	});

	it("malformed JSON falls back to bullets instead of throwing", () => {
		const findings = parseStructuredFindings(
			"VERDICT: block\n- a finding\n```json\n{nope\n```",
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].actual).toBe("a finding");
	});

	it("a passing report with an empty findings array yields none", () => {
		expect(
			parseStructuredFindings('VERDICT: pass\n```json\n{"findings": []}\n```'),
		).toEqual([]);
	});
});

function entry(overrides: Partial<VerifyEntry>): VerifyEntry {
	return {
		id: "d",
		title: "D",
		status: "shipped",
		verdict: "fail",
		findings: [],
		structured: [],
		problems: [],
		facts: [],
		...overrides,
	};
}

const ENTRIES: VerifyEntry[] = [
	entry({
		id: "ask-slice",
		structured: [
			{
				id: "F1",
				severity: "major",
				category: "packaging",
				file: "package.json",
				line: 43,
				claim: "installable package",
				actual: "file: dependency on sibling repo",
			},
		],
	}),
	entry({
		id: "review-plugin",
		structured: [
			{
				id: "F1",
				severity: "major",
				category: "packaging",
				actual: "absolute developer-machine file: paths",
			},
			{
				id: "F2",
				severity: "critical",
				category: "correctness-bug",
				file: "src/scope.ts",
				line: 52,
				actual: "symlink traversal escapes the review root",
			},
		],
	}),
	entry({ id: "provision-repositories", verdict: "pass" }),
];

describe("themeRollup", () => {
	it("groups findings by category across deliverables, largest first", () => {
		const themes = themeRollup(ENTRIES);
		expect(themes[0]).toEqual({
			category: "packaging",
			count: 2,
			deliverables: ["ask-slice", "review-plugin"],
		});
	});
});

describe("verification report", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "verify-report-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("renders themes, per-deliverable findings with claim/actual, and problems", () => {
		const md = renderVerificationReport(
			[
				...ENTRIES,
				entry({
					id: "gone",
					problems: ["branch feat/gone not found — work may be lost"],
				}),
			],
			1,
			"2026-07-11T10:00:00Z",
		);
		expect(md).toContain("# Verification round 1");
		expect(md).toContain(
			"**packaging** — 2 finding(s) across 2 deliverable(s): ask-slice, review-plugin",
		);
		expect(md).toContain("## review-plugin — ✗ fail (1 critical, 1 major)");
		expect(md).toContain("claimed: installable package");
		expect(md).toContain("actual:  file: dependency on sibling repo");
		expect(md).toContain("⚠ mechanical: branch feat/gone not found");
		expect(md).toContain("## provision-repositories — ✓ pass");
	});

	it("writes round-NN.{md,json} and increments the round across runs", () => {
		const first = writeVerificationReport(dir, ENTRIES, () => new Date(0));
		expect(first.round).toBe(1);
		expect(readFileSync(first.mdPath, "utf8")).toContain(
			"# Verification round 1",
		);
		const parsed = JSON.parse(readFileSync(first.jsonPath, "utf8"));
		expect(parsed.entries).toHaveLength(3);

		const second = writeVerificationReport(dir, ENTRIES, () => new Date(0));
		expect(second.round).toBe(2);
		expect(second.mdPath).toContain("round-02.md");
	});
});
