// Reviewer verdict protocol. A typed reviewer ends its report with a
// structured verdict line; it is parsed mechanically (no LLM in the decision)
// for verification compatibility.

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
