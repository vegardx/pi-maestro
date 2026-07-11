// Persisted verification reports: each /verify round writes
// <planDir>/verification/round-NN.{md,json}. The markdown is the human
// decision surface — a per-deliverable view (reopen vs waive) and a
// cross-cutting theme rollup (copied broken patterns get ONE strategy, not N
// independent fixes). The JSON is what the remediation flow consumes.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StructuredFinding, VerifyEntry } from "./verify.js";

export interface VerificationReportPaths {
	readonly round: number;
	readonly mdPath: string;
	readonly jsonPath: string;
}

const VERDICT_ICON: Record<VerifyEntry["verdict"], string> = {
	pass: "✓",
	fail: "✗",
	inconclusive: "?",
	error: "!",
};

/** Theme rollup: category → the deliverables it appears in + finding count. */
export function themeRollup(
	entries: readonly VerifyEntry[],
): Array<{ category: string; count: number; deliverables: string[] }> {
	const byCategory = new Map<
		string,
		{ count: number; deliverables: Set<string> }
	>();
	for (const e of entries) {
		for (const f of e.structured) {
			const t = byCategory.get(f.category) ?? {
				count: 0,
				deliverables: new Set<string>(),
			};
			t.count++;
			t.deliverables.add(e.id);
			byCategory.set(f.category, t);
		}
	}
	return [...byCategory.entries()]
		.map(([category, t]) => ({
			category,
			count: t.count,
			deliverables: [...t.deliverables],
		}))
		.sort((a, b) => b.count - a.count);
}

function severityCounts(findings: readonly StructuredFinding[]): string {
	const counts = { critical: 0, major: 0, minor: 0 };
	for (const f of findings) counts[f.severity]++;
	const parts = (["critical", "major", "minor"] as const)
		.filter((s) => counts[s] > 0)
		.map((s) => `${counts[s]} ${s}`);
	return parts.join(", ");
}

/** The full markdown report for one verification round. */
export function renderVerificationReport(
	entries: readonly VerifyEntry[],
	round: number,
	at: string,
): string {
	const counts = { pass: 0, fail: 0, inconclusive: 0, error: 0 };
	for (const e of entries) counts[e.verdict]++;
	const lines: string[] = [
		`# Verification round ${round} — ${at}`,
		"",
		`Verified ${entries.length}: ${counts.pass} pass, ${counts.fail} fail` +
			`${counts.inconclusive ? `, ${counts.inconclusive} inconclusive` : ""}` +
			`${counts.error ? `, ${counts.error} error` : ""}.`,
	];

	const themes = themeRollup(entries).filter(
		(t) => t.deliverables.length > 1 || t.count > 1,
	);
	if (themes.length > 0) {
		lines.push("", "## Themes (cross-cutting patterns)", "");
		for (const t of themes) {
			lines.push(
				`- **${t.category}** — ${t.count} finding(s) across ` +
					`${t.deliverables.length} deliverable(s): ${t.deliverables.join(", ")}`,
			);
		}
	}

	for (const e of entries) {
		const sev = severityCounts(e.structured);
		lines.push(
			"",
			`## ${e.id} — ${VERDICT_ICON[e.verdict]} ${e.verdict}${sev ? ` (${sev})` : ""}`,
			"",
		);
		if (e.error) lines.push(`- error: ${e.error}`);
		for (const p of e.problems) lines.push(`- ⚠ mechanical: ${p}`);
		for (const f of e.structured) {
			const where = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : "";
			lines.push(`- ${f.id} [${f.severity}|${f.category}]${where}`);
			if (f.claim) lines.push(`  claimed: ${f.claim}`);
			lines.push(`  actual:  ${f.actual}`);
			if (f.task) lines.push(`  task:    ${f.task}`);
		}
		if (
			!e.error &&
			e.problems.length === 0 &&
			e.structured.length === 0 &&
			e.verdict === "pass"
		) {
			lines.push("- no findings");
		}
	}
	return `${lines.join("\n")}\n`;
}

/**
 * Persist a verification round under <planDir>/verification/. Round numbers
 * continue from whatever rounds already exist on disk.
 */
export function writeVerificationReport(
	planDir: string,
	entries: readonly VerifyEntry[],
	now: () => Date = () => new Date(),
): VerificationReportPaths {
	const dir = join(planDir, "verification");
	mkdirSync(dir, { recursive: true });
	let round = 1;
	if (existsSync(dir)) {
		for (const name of readdirSync(dir)) {
			const m = name.match(/^round-(\d+)\.json$/);
			if (m) round = Math.max(round, Number.parseInt(m[1], 10) + 1);
		}
	}
	const at = now().toISOString();
	const stamp = String(round).padStart(2, "0");
	const mdPath = join(dir, `round-${stamp}.md`);
	const jsonPath = join(dir, `round-${stamp}.json`);
	writeFileSync(mdPath, renderVerificationReport(entries, round, at));
	writeFileSync(
		jsonPath,
		`${JSON.stringify({ round, at, entries }, null, 2)}\n`,
	);
	return { round, mdPath, jsonPath };
}
