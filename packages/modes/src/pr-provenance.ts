import { redactSecrets } from "@vegardx/pi-core";
import type { Deliverable } from "./schema.js";
import type {
	AssignmentAnalytics,
	CanonicalFindingAnalytics,
	WorkflowAnalyticsLedger,
} from "./workflow-analytics.js";
import { workflowAnalyticsTotals } from "./workflow-analytics.js";

export const MAESTRO_PR_BEGIN = "<!-- maestro:provenance:start -->";
export const MAESTRO_PR_END = "<!-- maestro:provenance:end -->";
export const GITHUB_PR_BODY_BYTES = 65_536;
export const DEFAULT_MAESTRO_SECTION_BYTES = 48 * 1024;

export interface PrProvenanceRenderOptions {
	readonly maxBytes?: number;
}

/** Render the visible canonical review state followed by bounded audit details. */
export function renderMaestroPrSection(
	deliverable: Pick<Deliverable, "id" | "workflowAnalytics">,
	options: PrProvenanceRenderOptions = {},
): string {
	const maxBytes = options.maxBytes ?? DEFAULT_MAESTRO_SECTION_BYTES;
	const ledger = deliverable.workflowAnalytics;
	const findings = ledger?.canonicalFindings ?? [];
	const blocking = findings.filter(
		(entry) => entry.finding.severity !== "minor" && !findingSettled(entry, false),
	);
	const state = ledger
		? blocking.length > 0
			? `Changes requested — ${blocking.length} blocking finding${blocking.length === 1 ? "" : "s"} open`
			: ledger.finalVerification?.status === "failed"
					? "Verification failed"
					: "Approved — no blocking findings open"
		: "Review provenance not recorded";

	const canonical = [
		MAESTRO_PR_BEGIN,
		"## Maestro review provenance",
		"",
		`**Overall review state:** ${safe(state, 240)}`,
		"",
		...renderTotals(ledger),
		"### Canonical findings and resolutions",
		"",
		findings.length === 0
			? "No canonical findings were reported."
			: "| ID | Severity | Finding | Resolution | Verification |",
		...(findings.length === 0
			? []
			: [
					"| --- | --- | --- | --- | --- |",
					...findings.map((entry) => renderFindingRow(entry, false)),
				]),
	].join("\n");
	const ending = `\n${MAESTRO_PR_END}`;
	if (bytes(canonical + ending) > maxBytes) {
		throw new Error(
			`Maestro's canonical blocking evidence exceeds the ${maxBytes}-byte PR section budget; refusing to omit it`,
		);
	}

	let rendered = canonical;
	let omitted = 0;
	for (const details of renderAssignmentDetails(ledger)) {
		if (bytes(`${rendered}\n\n${details}${ending}`) <= maxBytes) {
			rendered += `\n\n${details}`;
		} else {
			omitted += 1;
		}
	}
	if (omitted > 0) {
		const note = `\n\n_${omitted} optional evidence section${omitted === 1 ? " was" : "s were"} omitted to stay within the PR body budget._`;
		if (bytes(rendered + note + ending) <= maxBytes) rendered += note;
	}
	return `${rendered}${ending}`;
}

/**
 * Replace exactly one owned section, preserving every byte of user-authored
 * text outside it. Malformed/duplicate markers fail closed.
 */
export function updateMaestroPrBody(
	body: string,
	section: string,
	maxBytes = GITHUB_PR_BODY_BYTES,
): string {
	assertCompleteSection(section);
	const starts = occurrences(body, MAESTRO_PR_BEGIN);
	const ends = occurrences(body, MAESTRO_PR_END);
	if (starts > 1 || ends > 1 || starts !== ends) {
		throw new Error(
			"PR body has malformed or duplicate Maestro provenance markers",
		);
	}
	let updated: string;
	if (starts === 0) {
		updated = body.trimEnd() ? `${body.trimEnd()}\n\n${section}` : section;
	} else {
		const start = body.indexOf(MAESTRO_PR_BEGIN);
		const end = body.indexOf(MAESTRO_PR_END, start);
		if (end < start) throw new Error("PR body has reversed Maestro markers");
		updated = `${body.slice(0, start)}${section}${body.slice(end + MAESTRO_PR_END.length)}`;
	}
	if (bytes(updated) > maxBytes) {
		throw new Error(
			`PR body would be ${bytes(updated)} bytes, exceeding GitHub's ${maxBytes}-byte budget`,
		);
	}
	return updated;
}

function renderTotals(ledger: WorkflowAnalyticsLedger | undefined): string[] {
	if (!ledger) return [];
	const totals = workflowAnalyticsTotals(ledger);
	const usage = totals.usage;
	return [
		`**Workflow analytics:** ${ledger.assignments.length} assignment${ledger.assignments.length === 1 ? "" : "s"} · ${usage.totalTokens.toLocaleString("en-US")} tokens · $${usage.cost.toFixed(4)} · ${duration(totals.durationMs)}`,
		"",
	];
}

function renderFindingRow(
	entry: CanonicalFindingAnalytics,
	waived: boolean,
): string {
	const finding = entry.finding;
	const where = finding.file
		? `\`${safe(finding.file, 180)}${finding.line ? `:${finding.line}` : ""}\` — `
		: "";
	const description = safe(`${where}${finding.actual}`, 640);
	const resolution = waived
		? "Waived by human"
		: entry.resolution
			? `${entry.resolution.status}: ${safe(entry.resolution.note, 360)}${entry.resolution.fixCommit ? ` (\`${renderSha(entry.resolution.fixCommit)}\`)` : ""}`
			: "Open";
	const verification = entry.verification
		? `${entry.verification.result}${entry.verification.note ? `: ${safe(entry.verification.note, 300)}` : ""}`
		: "—";
	return `| ${safe(finding.id, 100)} | ${finding.severity} | ${description} | ${resolution} | ${verification} |`;
}

function renderAssignmentDetails(
	ledger: WorkflowAnalyticsLedger | undefined,
): string[] {
	if (!ledger) return [];
	const details = ledger.assignments.map(renderAssignment);
	if (ledger.finalVerification) {
		const verification = ledger.finalVerification;
		details.push(
			[
				"<details>",
				`<summary>Final verification — ${safeHtml(verification.status, 80)}</summary>`,
				"",
				`- Assignment: \`${safe(verification.assignmentId, 120)}\``,
				`- Model / effort: \`${safe(verification.modelId, 180)}\`${verification.effort ? ` / \`${safe(verification.effort, 40)}\`` : ""}`,
				`- Run: ${verification.runId ? `\`${safe(verification.runId, 140)}\`` : "not recorded"}`,
				`- Reviewed SHA: \`${renderSha(verification.reviewedSha)}\``,
				`- Duration: ${duration(elapsed(verification.startedAt, verification.completedAt))}`,
				...renderUsage(verification.usage),
				...renderEvidence(verification.evidence),
				"",
				"</details>",
			].join("\n"),
		);
	}
	return details;
}

function renderAssignment(assignment: AssignmentAnalytics): string {
	return [
		"<details>",
		`<summary>${safeHtml(assignment.assignmentId, 120)} — ${safeHtml(assignment.status, 40)}</summary>`,
		"",
		`- Stage / kind: \`${safe(assignment.stageId, 100)}\` / \`${safe(assignment.kind, 80)}\``,
		`- Model / effort: \`${safe(assignment.modelId, 180)}\`${assignment.effort ? ` / \`${safe(assignment.effort, 40)}\`` : ""}`,
		`- Run: ${assignment.runId ? `\`${safe(assignment.runId, 140)}\`` : "not recorded"}`,
		`- Input SHA: \`${renderSha(assignment.inputSha)}\``,
		...(assignment.outputSha
			? [`- Output SHA: \`${renderSha(assignment.outputSha)}\``]
			: []),
		`- Duration: ${duration(elapsed(assignment.startedAt, assignment.completedAt))}`,
		...renderUsage(assignment.usage),
		...renderEvidence(assignment.evidence),
		"",
		"</details>",
	].join("\n");
}

function renderUsage(usage: AssignmentAnalytics["usage"]): string[] {
	if (!usage) return [];
	return [
		`- Usage: ${usage.totalTokens.toLocaleString("en-US")} tokens (${usage.input.toLocaleString("en-US")} input, ${usage.cacheRead.toLocaleString("en-US")} cache read, ${usage.cacheWrite.toLocaleString("en-US")} cache write, ${usage.output.toLocaleString("en-US")} output) · $${usage.cost.toFixed(4)}`,
	];
}

function renderEvidence(evidence: readonly string[] | undefined): string[] {
	if (!evidence?.length) return [];
	const publishable = evidence
		.filter(
			(item) =>
				!/(system|developer) prompt|raw transcript|tool (call|trace)/i.test(
					item,
				),
		)
		.slice(0, 12)
		.map((item) => `  - ${safe(item, 500)}`);
	return publishable.length > 0 ? ["- Evidence:", ...publishable] : [];
}

function findingSettled(
	entry: CanonicalFindingAnalytics,
	waived: boolean,
): boolean {
	if (waived || entry.resolution?.status === "duplicateOf") return true;
	return (
		entry.resolution?.status === "fixed" &&
		entry.verification?.result === "verified"
	);
}

function assertCompleteSection(section: string): void {
	if (
		occurrences(section, MAESTRO_PR_BEGIN) !== 1 ||
		occurrences(section, MAESTRO_PR_END) !== 1 ||
		section.indexOf(MAESTRO_PR_BEGIN) > section.indexOf(MAESTRO_PR_END)
	) {
		throw new Error("generated Maestro provenance section is malformed");
	}
}

function safe(value: string, limit: number): string {
	const redacted = redactSecrets(value)
		.replace(/\r?\n/g, " ")
		.replace(/\|/g, "\\|")
		.replace(/<!--/g, "&lt;!--")
		.trim();
	return redacted.length <= limit
		? redacted
		: `${redacted.slice(0, limit - 1)}…`;
}

function safeHtml(value: string, limit: number): string {
	return safe(value, limit)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function renderSha(value: string): string {
	return /^[0-9a-f]{40}$/i.test(value) ? value : safe(value, 80);
}

function elapsed(startedAt: string, completedAt?: string): number {
	if (!completedAt) return 0;
	const start = Date.parse(startedAt);
	const end = Date.parse(completedAt);
	return Number.isFinite(start) && Number.isFinite(end)
		? Math.max(0, end - start)
		: 0;
}

function duration(ms: number): string {
	if (ms < 1_000) return `${ms}ms`;
	const seconds = Math.round(ms / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

function occurrences(value: string, needle: string): number {
	return value.split(needle).length - 1;
}

function bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}
