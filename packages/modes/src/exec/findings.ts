// The shared structured-finding vocabulary and the review LEDGER — one schema
// for panel reviewers, the scoped verifier, /verify, the gate UI, triage, and
// remediation. Identity is mechanical: reviewer-emitted ids are DISCARDED and
// the harness mints canonical ids (`<reviewer-name>.<n>`), so models exercise
// judgment (severity, sameness, disputes) while the machine owns bookkeeping
// (uniqueness, completeness, termination).

import { parseVerdict } from "./verdicts.js";

/** Severity buckets — "critical" is un-ship-this, "minor" is note-for-later. */
export const FINDING_SEVERITIES = ["critical", "major", "minor"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * One structured finding. The claim/actual pair is what makes a finding
 * decidable without reading the full report; `category` groups cross-cutting
 * themes across deliverables; `task` links back to the WorkItem whose claimed
 * completion it contradicts.
 */
export interface StructuredFinding {
	readonly id: string;
	readonly severity: FindingSeverity;
	readonly category: string;
	readonly file?: string;
	readonly line?: number;
	readonly task?: string;
	readonly claim?: string;
	readonly actual: string;
}

/** critical/major hold the gate; minor is advisory (worker's discretion). */
export function isBlockingSeverity(s: FindingSeverity): boolean {
	return s !== "minor";
}

/**
 * The verdict a findings list IMPLIES. Reviewers still write a VERDICT line,
 * but on mismatch this computed one wins — "request-changes over three minors"
 * normalizes to approve, and "PASS with a critical on the books" blocks.
 */
export function computedVerdict(
	findings: readonly StructuredFinding[],
): "approve" | "request-changes" {
	return findings.some((f) => isBlockingSeverity(f.severity))
		? "request-changes"
		: "approve";
}

/**
 * Extract findings from the fenced ```json block only — null when the report
 * has no valid block. Callers that normalize verdicts from severity must use
 * this strict form: fallback-parsed bullets carry made-up severities, so they
 * are display material, never verdict material.
 */
export function parseJsonFindings(report: string): StructuredFinding[] | null {
	const blocks = [...report.matchAll(/```json\s*\n([\s\S]*?)```/g)];
	const last = blocks.at(-1)?.[1];
	if (!last) return null;
	try {
		const parsed = JSON.parse(last) as {
			findings?: Array<Record<string, unknown>>;
		};
		if (Array.isArray(parsed.findings)) {
			return parsed.findings
				.map((f, i) => normalizeFinding(f, i))
				.filter((f): f is StructuredFinding => f !== null);
		}
	} catch {
		// fall through to the bullet fallback
	}
	return null;
}

/**
 * Extract structured findings from a reviewer report: the fenced ```json
 * block after the verdict line. Tolerant — a model that answers with plain
 * bullets instead falls back to parsing "file.ts:12 — description" lines, so
 * older reports and non-compliant runs still yield usable structure.
 */
export function parseStructuredFindings(report: string): StructuredFinding[] {
	const json = parseJsonFindings(report);
	if (json) return json;
	return parseVerdict(report).findings.map((bullet, i) => {
		const m = bullet.match(/^`?([^\s`—:]+):(\d+)`?\s*—\s*(.*)$/);
		return {
			id: `F${i + 1}`,
			severity: "major" as const,
			category: "uncategorized",
			...(m ? { file: m[1], line: Number.parseInt(m[2], 10) } : {}),
			actual: m ? m[3] : bullet,
		};
	});
}

function normalizeFinding(
	f: Record<string, unknown>,
	index: number,
): StructuredFinding | null {
	const actual = String(f.actual ?? f.summary ?? f.description ?? "").trim();
	if (!actual) return null;
	const severity = FINDING_SEVERITIES.includes(f.severity as FindingSeverity)
		? (f.severity as FindingSeverity)
		: "major";
	const line = Number(f.line);
	return {
		id: typeof f.id === "string" && f.id ? f.id : `F${index + 1}`,
		severity,
		category:
			typeof f.category === "string" && f.category
				? f.category
				: "uncategorized",
		...(typeof f.file === "string" && f.file ? { file: f.file } : {}),
		...(Number.isFinite(line) && line > 0 ? { line } : {}),
		...(typeof f.task === "string" && f.task ? { task: f.task } : {}),
		...(typeof f.claim === "string" && f.claim ? { claim: f.claim } : {}),
		actual,
	};
}

/** One-line rendering of a structured finding for notify-style output. */
export function renderFinding(f: StructuredFinding): string {
	const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""} — ` : "";
	return `${where}${f.actual}`;
}

// ─── The review ledger ───────────────────────────────────────────────────────

/**
 * How the worker may resolve a canonical finding. `wont-fix` is legal only for
 * minors (blocking findings cannot be waved off by the worker); `disputed` is
 * legal only for blocking findings (minors need no argument — just decide) and
 * only ONCE per finding — a re-dispute after triage backed the reviewer is a
 * tool error, not another loop.
 */
export const RESOLUTION_STATUSES = [
	"fixed",
	"wont-fix",
	"disputed",
	"duplicateOf",
] as const;
export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

export interface FindingResolution {
	readonly id: string;
	readonly status: ResolutionStatus;
	/** Mandatory rationale: commit for fixed, reason for wont-fix/disputed. */
	readonly note: string;
	/** duplicateOf only: the canonical id this finding merges into. */
	readonly canonical?: string;
}

/** The scoped verifier's judgment of one `fixed` claim. */
export interface ClaimCheck {
	readonly id: string;
	readonly result: "verified" | "still-open";
	/** Evidence for verified; what's still wrong for still-open. */
	readonly note?: string;
}

export interface LedgerEntry {
	/** finding.id is the MINTED canonical id (`<reviewer>.<n>`). */
	readonly finding: StructuredFinding;
	/** Panel entry that raised it (provenance; part of the minted id). */
	readonly reviewer: string;
	/** Latest worker resolution (re-filed each fix cycle until terminal). */
	resolution?: FindingResolution & { at: string };
	/** Latest verifier judgment of a `fixed` claim. */
	check?: ClaimCheck & { at: string };
	/** Minted ids merged into this canonical entry. */
	duplicates?: string[];
	/** Dispute count — enforces dispute-once. */
	disputes?: number;
}

/**
 * A review round that has spawned but not yet settled. Persisted on the
 * ledger the moment the round starts (before the review tool's ack returns),
 * because the settle continuation lives only in the worker's memory: if the
 * process dies mid-round, this marker is what lets a respawned worker
 * REATTACH to the recorded runs in the shared store instead of spawning a
 * duplicate round. It doubles as the delivery latch — the settle path that
 * clears it (reports the ledger without it) owns the round's single
 * report + delivery.
 */
export interface PendingReviewRound {
	/** What kind of round is settling — decides how a reattach merges it. */
	readonly kind: "panel" | "repair" | "verification";
	/** The spawned runs; ids resolve in the subagents run store. */
	readonly runs: ReadonlyArray<{
		readonly name: string;
		readonly runId: string;
	}>;
	/** Round start — the panel deadline is measured from here, so time that
	 *  elapsed before a respawn still counts against the round. */
	readonly startedAt: string;
}

/**
 * The per-deliverable review ledger: minted findings + their resolution state
 * across fix cycles. Persisted on the Deliverable so it survives worker
 * respawns and maestro restarts; the gate reads it, the human sees it, /verify
 * and the PR body inherit it.
 */
export interface ReviewLedger {
	/** Panel rounds this episode (panel-once ⇒ normally 1). */
	round: number;
	/** Fix+verify cycles run against this ledger. */
	cycle: number;
	entries: LedgerEntry[];
	/**
	 * Panel reviewers that ran this episode and whether they reported. The
	 * gate needs this independently of the in-memory verdict cache: a
	 * required reviewer that never reported must hold ship even after a
	 * maestro restart rehydrates from the plan. `ok` is the gate bit
	 * (reported validly); status/attempt/error carry the audit trail —
	 * status is the latest run's terminal outcome (approve/request-changes/
	 * failed/interrupted/timed-out/malformed), attempt counts runs this
	 * episode (explicit repair increments it), error is the first line of
	 * the failure diagnostic.
	 */
	participants?: Array<{
		name: string;
		ok: boolean;
		status?: string;
		attempt?: number;
		/** The subagent run behind the latest attempt (audit/debug linkage). */
		runId?: string;
		error?: string;
	}>;
	/** The round currently settling behind the review tool, if any. */
	pendingRound?: PendingReviewRound;
	updatedAt: string;
}

/**
 * Mint canonical ids for one reviewer's findings: `<reviewer>.<n>` in report
 * order. Whatever id the model wrote is discarded — uniqueness comes from
 * panel entry names being unique, not from model discipline.
 */
export function mintFindings(
	reviewer: string,
	findings: readonly StructuredFinding[],
): StructuredFinding[] {
	return findings.map((f, i) => ({ ...f, id: `${reviewer}.${i + 1}` }));
}

/** Assemble a fresh ledger from a completed panel round. */
export function buildLedger(
	perReviewer: ReadonlyArray<{
		reviewer: string;
		findings: readonly StructuredFinding[];
	}>,
	now: string,
): ReviewLedger {
	const entries: LedgerEntry[] = [];
	for (const { reviewer, findings } of perReviewer) {
		for (const finding of mintFindings(reviewer, findings)) {
			entries.push({ finding, reviewer });
		}
	}
	return { round: 1, cycle: 0, entries, updatedAt: now };
}

const SEVERITY_RANK: Record<FindingSeverity, number> = {
	critical: 0,
	major: 1,
	minor: 2,
};

function maxSeverity(a: FindingSeverity, b: FindingSeverity): FindingSeverity {
	return SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
}

const isDuplicate = (e: LedgerEntry): boolean =>
	e.resolution?.status === "duplicateOf";

/** Terminal = nothing left to do for this entry (gate-wise). */
export function isTerminal(
	e: LedgerEntry,
	waived: ReadonlySet<string>,
): boolean {
	if (waived.has(e.finding.id)) return true;
	if (isDuplicate(e)) return true;
	if (e.resolution?.status === "wont-fix") return true; // minors only (enforced on apply)
	if (e.resolution?.status === "fixed" && e.check?.result === "verified")
		return true;
	return false;
}

/** Canonical blocking entries still holding the gate. */
export function openBlocking(
	ledger: ReviewLedger,
	waived: ReadonlySet<string> = new Set(),
): LedgerEntry[] {
	return ledger.entries.filter(
		(e) => isBlockingSeverity(e.finding.severity) && !isTerminal(e, waived),
	);
}

/** Open blocking entries the worker has disputed (awaiting triage/human). */
export function openDisputed(
	ledger: ReviewLedger,
	waived: ReadonlySet<string> = new Set(),
): LedgerEntry[] {
	return openBlocking(ledger, waived).filter(
		(e) => e.resolution?.status === "disputed",
	);
}

/**
 * Apply a worker's resolutions to the ledger — the completeness check lives
 * here: every OPEN canonical blocking entry must be covered exactly once (a
 * status or a duplicateOf pointer). A worker that "normalizes away" a critical
 * gets an error listing the unaccounted ids, not a silent pass. Mutates a copy;
 * returns errors without applying anything when invalid.
 */
export function applyResolutions(
	ledger: ReviewLedger,
	resolutions: readonly FindingResolution[],
	now: string,
	waived: ReadonlySet<string> = new Set(),
): { ok: true; ledger: ReviewLedger } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	const entries = ledger.entries.map((e) => ({ ...e }));
	const index = new Map(entries.map((e) => [e.finding.id, e]));

	const seen = new Set<string>();
	for (const r of resolutions) {
		const entry = index.get(r.id);
		if (!entry) {
			errors.push(`unknown finding id: ${r.id}`);
			continue;
		}
		if (seen.has(r.id)) {
			errors.push(`duplicate resolution for ${r.id}`);
			continue;
		}
		seen.add(r.id);
		if (!r.note?.trim()) {
			errors.push(`${r.id}: a non-empty note is required (${r.status})`);
			continue;
		}
		if (isTerminal(entry, waived)) {
			errors.push(`${r.id}: already settled (${describeState(entry)})`);
			continue;
		}
		switch (r.status) {
			case "wont-fix":
				if (isBlockingSeverity(entry.finding.severity)) {
					errors.push(
						`${r.id}: wont-fix is only legal for minor findings — ${entry.finding.severity} findings must be fixed or disputed`,
					);
				}
				break;
			case "disputed":
				if (!isBlockingSeverity(entry.finding.severity)) {
					errors.push(
						`${r.id}: minors are yours to decide — use wont-fix with a note instead of disputing`,
					);
				} else if ((entry.disputes ?? 0) >= 1) {
					errors.push(
						`${r.id}: already disputed once and triage stands — fix it or let the gate surface it to the human`,
					);
				}
				break;
			case "duplicateOf": {
				const target = r.canonical ? index.get(r.canonical) : undefined;
				if (!r.canonical || !target) {
					errors.push(`${r.id}: duplicateOf needs a valid canonical id`);
				} else if (r.canonical === r.id) {
					errors.push(`${r.id}: cannot be a duplicate of itself`);
				} else if (isDuplicate(target)) {
					errors.push(
						`${r.id}: canonical ${r.canonical} is itself a duplicate — point at ${target.resolution?.canonical}`,
					);
				}
				break;
			}
			case "fixed":
				break;
		}
	}

	// Completeness: every open blocking canonical entry needs a resolution this
	// call. (Minors may be left open — they never hold the gate — but once the
	// worker starts resolving, unresolved blockers are named explicitly.)
	const unaccounted = openBlocking({ ...ledger, entries }, waived)
		.filter((e) => !seen.has(e.finding.id))
		.map((e) => e.finding.id);
	if (unaccounted.length > 0) {
		errors.push(
			`unaccounted blocking findings (every one needs a resolution or duplicateOf): ${unaccounted.join(", ")}`,
		);
	}

	if (errors.length > 0) return { ok: false, errors };

	for (const r of resolutions) {
		const entry = index.get(r.id);
		if (!entry) continue;
		entry.resolution = { ...r, at: now };
		// A re-filed fix supersedes the previous cycle's still-open check.
		if (r.status === "fixed") entry.check = undefined;
		if (r.status === "disputed") entry.disputes = (entry.disputes ?? 0) + 1;
		if (r.status === "duplicateOf" && r.canonical) {
			const target = index.get(r.canonical);
			if (target) {
				target.duplicates = [...(target.duplicates ?? []), r.id];
				// The merged group takes the max severity of its members.
				if (
					SEVERITY_RANK[entry.finding.severity] <
					SEVERITY_RANK[target.finding.severity]
				) {
					target.finding = {
						...target.finding,
						severity: maxSeverity(
							target.finding.severity,
							entry.finding.severity,
						),
					};
				}
			}
		}
	}
	return {
		ok: true,
		ledger: { ...ledger, entries, updatedAt: now },
	};
}

/**
 * Apply a verification run: the verifier's per-claim checks plus any
 * regressions it raised (minted under the verifier's name). Bumps the cycle.
 */
export function applyChecks(
	ledger: ReviewLedger,
	checks: readonly ClaimCheck[],
	regressions: readonly StructuredFinding[],
	verifierName: string,
	now: string,
): { ledger: ReviewLedger; errors: string[] } {
	const errors: string[] = [];
	const entries = ledger.entries.map((e) => ({ ...e }));
	const index = new Map(entries.map((e) => [e.finding.id, e]));
	for (const c of checks) {
		const entry = index.get(c.id);
		if (!entry) {
			errors.push(`verifier referenced unknown finding id: ${c.id}`);
			continue;
		}
		if (entry.resolution?.status !== "fixed") {
			errors.push(
				`verifier checked ${c.id}, which has no fixed claim (${describeState(entry)})`,
			);
			continue;
		}
		entry.check = { ...c, at: now };
	}
	for (const finding of mintFindings(verifierName, regressions)) {
		entries.push({ finding, reviewer: verifierName });
	}
	return {
		ledger: { ...ledger, cycle: ledger.cycle + 1, entries, updatedAt: now },
		errors,
	};
}

function describeState(e: LedgerEntry): string {
	if (!e.resolution) return "unresolved";
	if (e.resolution.status === "duplicateOf")
		return `duplicate of ${e.resolution.canonical}`;
	if (e.resolution.status === "fixed")
		return e.check
			? `fixed, ${e.check.result}`
			: "fixed, awaiting verification";
	return e.resolution.status;
}

/** "cycle 1/3 · 2 blocking open · 1 disputed" — the loop at a glance. */
export function ledgerSummary(
	ledger: ReviewLedger,
	maxCycles: number,
	waived: ReadonlySet<string> = new Set(),
): string {
	const open = openBlocking(ledger, waived);
	const disputed = openDisputed(ledger, waived).length;
	const parts = [
		`cycle ${ledger.cycle}/${maxCycles}`,
		`${open.length} blocking open`,
	];
	if (disputed > 0) parts.push(`${disputed} disputed`);
	return parts.join(" · ");
}

/** Render the ledger for a worker/human: state per canonical entry. */
export function renderLedger(
	ledger: ReviewLedger,
	waived: ReadonlySet<string> = new Set(),
): string {
	const lines: string[] = [];
	for (const e of ledger.entries) {
		if (isDuplicate(e)) continue;
		const waivedMark = waived.has(e.finding.id) ? " · WAIVED" : "";
		const dupes = e.duplicates?.length
			? ` (+${e.duplicates.length} duplicate${e.duplicates.length === 1 ? "" : "s"})`
			: "";
		lines.push(
			`- ${e.finding.id} [${e.finding.severity}] ${renderFinding(e.finding)}${dupes} — ${describeState(e)}${waivedMark}`,
		);
	}
	return lines.join("\n");
}
