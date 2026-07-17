// Canonical structured-finding parsing and rendering shared by workflow stages.

import {
	FINDING_SEVERITIES,
	type FindingSeverity,
	type StructuredFinding,
	validateStructuredFinding,
} from "@vegardx/pi-contracts";
import { parseVerdict } from "./verdicts.js";

export type { FindingSeverity, StructuredFinding };
export { FINDING_SEVERITIES };

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
