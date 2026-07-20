// Reviewer verdict + structured-finding parsing and rendering. Re-homed from
// packages/modes/src/exec/{verdicts,findings}.ts so the v2 contract registry
// can use them as salvage tiers (contracts is the base package; modes
// re-exports for its existing callers). Pure string/JSON logic, no host deps.

import {
	FINDING_SEVERITIES,
	type FindingSeverity,
	type StructuredFinding,
	validateStructuredFinding,
} from "./plan.js";

export type Verdict = "approve" | "request-changes" | "none";

export interface ParsedVerdict {
	verdict: Verdict;
	/** One entry per finding bullet following the verdict line. */
	findings: string[];
}

/** Appended to a reviewer's summarize preamble so the summary carries a verdict. */
export const VERDICT_INSTRUCTION =
	"End your summary with a line `VERDICT: approve` or " +
	"`VERDICT: request-changes`. If requesting changes, follow the verdict " +
	'line with one markdown bullet per finding ("- file.ts:12 — description"). ' +
	"Approve unless a finding genuinely blocks shipping.";

/**
 * Tolerant verdict parser: takes the last `VERDICT:` line (case-insensitive)
 * and collects the `- ` bullets after it as findings. No verdict line — or a
 * value that isn't recognizable — yields "none": a reviewer that doesn't
 * object doesn't block.
 */
export function parseVerdict(summary: string): ParsedVerdict {
	const lines = summary.split("\n");
	let verdictIdx = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (/^\s*verdict\s*:/i.test(lines[i])) {
			verdictIdx = i;
			break;
		}
	}
	if (verdictIdx === -1) return { verdict: "none", findings: [] };

	const value = lines[verdictIdx]
		.replace(/^\s*verdict\s*:\s*/i, "")
		.trim()
		.toLowerCase();
	// Accept approve/request-changes and the historical PASS/BLOCK wire words.
	let verdict: Verdict = "none";
	if (/request[\s_-]*changes/.test(value) || value.startsWith("block"))
		verdict = "request-changes";
	else if (value.startsWith("approve") || value.startsWith("pass"))
		verdict = "approve";

	const findings: string[] = [];
	for (const line of lines.slice(verdictIdx + 1)) {
		const match = line.match(/^\s*-\s+(.*\S)\s*$/);
		if (match) findings.push(match[1]);
	}
	return { verdict, findings };
}

export function isBlockingSeverity(severity: FindingSeverity): boolean {
	return severity !== "minor";
}

export function computedVerdict(
	findings: readonly StructuredFinding[],
): "approve" | "request-changes" {
	return findings.some((finding) => isBlockingSeverity(finding.severity))
		? "request-changes"
		: "approve";
}

export function parseJsonFindings(report: string): StructuredFinding[] | null {
	const blocks = [...report.matchAll(/```json\s*\n([\s\S]*?)```/g)];
	const last = blocks.at(-1)?.[1];
	if (!last) return null;
	try {
		const parsed = JSON.parse(last) as {
			findings?: Array<Record<string, unknown>>;
		};
		if (!Array.isArray(parsed.findings)) return null;
		const findings = parsed.findings
			.map(normalizeFinding)
			.filter((finding): finding is StructuredFinding => finding !== null);
		return findings.every(
			(finding) => validateStructuredFinding(finding).length === 0,
		)
			? findings
			: null;
	} catch {
		return null;
	}
}

export function parseStructuredFindings(report: string): StructuredFinding[] {
	const json = parseJsonFindings(report);
	if (json) return json;
	return parseVerdict(report).findings.map((bullet, index) => {
		const match = bullet.match(/^`?([^\s`—:]+):(\d+)`?\s*—\s*(.*)$/);
		return {
			id: `F${index + 1}`,
			severity: "major" as const,
			category: "uncategorized",
			...(match ? { file: match[1], line: Number.parseInt(match[2], 10) } : {}),
			actual: match ? match[3] : bullet,
		};
	});
}

function normalizeFinding(
	finding: Record<string, unknown>,
	index: number,
): StructuredFinding | null {
	const actual = String(
		finding.actual ?? finding.summary ?? finding.description ?? "",
	).trim();
	if (!actual) return null;
	const severity = FINDING_SEVERITIES.includes(
		finding.severity as FindingSeverity,
	)
		? (finding.severity as FindingSeverity)
		: "major";
	const line = Number(finding.line);
	return {
		id:
			typeof finding.id === "string" && finding.id
				? finding.id
				: `F${index + 1}`,
		severity,
		category:
			typeof finding.category === "string" && finding.category
				? finding.category
				: "uncategorized",
		...(typeof finding.file === "string" && finding.file
			? { file: finding.file }
			: {}),
		...(Number.isFinite(line) && line > 0 ? { line } : {}),
		...(typeof finding.task === "string" && finding.task
			? { task: finding.task }
			: {}),
		...(typeof finding.claim === "string" && finding.claim
			? { claim: finding.claim }
			: {}),
		...(Array.isArray(finding.evidence)
			? {
					evidence: finding.evidence.filter(
						(item): item is string =>
							typeof item === "string" && item.trim().length > 0,
					),
				}
			: {}),
		actual,
	};
}

export function renderFinding(finding: StructuredFinding): string {
	const where = finding.file
		? `${finding.file}${finding.line ? `:${finding.line}` : ""} — `
		: "";
	return `${where}${finding.actual}`;
}
