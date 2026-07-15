// Run a deliverable's review panel: spawn each SubAgentSpec as a headless
// one-shot reviewer (buildPersonaProfile) through the subagents capability,
// await its verdict, and return the normalized results. The worker calls this
// (via the review tool), reasons over the findings, fixes, and re-runs; the
// executor gates ship on the `required` entries' latest verdicts.

import type {
	SpawnProfile,
	SubagentsCapabilityV1,
} from "@vegardx/pi-contracts";
import {
	computedVerdict,
	parseJsonFindings,
	type StructuredFinding,
} from "./exec/findings.js";
import { parseVerdict, type Verdict } from "./exec/verdicts.js";
import { buildPersonaProfile } from "./personas.js";
import type { SubAgentSpec } from "./schema.js";

/**
 * Terminal outcome of one panel entry's SINGLE run. Every value except
 * approve/request-changes/helper means "did not report" — the entry stays in
 * that state until an explicit review({action:"repair"}); nothing here is
 * ever retried implicitly.
 */
export type PanelRunStatus =
	| "approve"
	| "request-changes"
	| "helper"
	| "failed"
	| "interrupted"
	| "timed-out"
	| "malformed";

export interface PanelResult {
	readonly name: string;
	readonly persona: string;
	readonly required: boolean;
	readonly kind: "review" | "helper";
	readonly status: PanelRunStatus;
	readonly verdict: Verdict;
	readonly findings: readonly string[];
	/**
	 * Ledger-eligible structured findings, from the report's fenced JSON block.
	 * The verdict is COMPUTED from their severities — the stated VERDICT line
	 * loses on mismatch. A report without a valid JSON block is `malformed`
	 * and contributes nothing: bullets never fabricate ledger findings.
	 */
	readonly structured: readonly StructuredFinding[];
	/** The reviewer's full report (or an error line when it failed). */
	readonly report: string;
	/** True iff the entry reported validly (approve/request-changes/helper). */
	readonly ok: boolean;
	/** The subagent run that produced this result (audit/debug linkage). */
	readonly runId?: string;
	/** Exact resolved selection for verdict/ledger telemetry. */
	readonly model?: string;
	readonly effort?: import("@vegardx/pi-contracts").ThinkingLevel;
}

export interface RunPanelDeps {
	readonly subagents: SubagentsCapabilityV1;
	/** The worker's worktree — reviewers read the change here (read-only). */
	readonly cwd: string;
	/** Resolve each reviewer independently against reviewer policy. */
	readonly resolveModel?: (spec: SubAgentSpec) => Promise<{
		model: string;
		effort?: import("@vegardx/pi-contracts").ThinkingLevel;
	}>;
	readonly timeoutMs?: number;
}

// The panel's share of the graduated deadline table (REVIEW_WATCHDOG in
// personas.ts owns the in-run boundaries: stall 2min / soft wrap-up 4min /
// reviewer hard cap 8min). This is the WHOLE-PANEL bound: reviewers run
// concurrently and exactly once, so the panel settles within the reviewer
// cap plus a margin for spawn/summarize overhead. It backstops the watchdog
// (it fires only if the runner's own protection didn't) and is the single
// number the executor derives its in-flight guard from — a guard shorter
// than a legitimate round reopens the kill-mid-review hole (a 5-minute cap
// killed honest 4–6 min deep reviews, radicalai dogfood 2026-07-11); one
// sized for retries that no longer exist left dead rounds hanging ~25 min.
export const PANEL_HARD_TIMEOUT_MS = 8.5 * 60_000;
export const DEFAULT_TIMEOUT_MS = PANEL_HARD_TIMEOUT_MS;

/**
 * One panel entry's spawned run. The spawn happens eagerly (the run id is
 * known before any result settles) so the review tool can acknowledge the
 * round immediately and let the worker's turn end; `settled` never rejects.
 */
export interface PanelRunStart {
	readonly name: string;
	readonly runId?: string;
	readonly settled: Promise<PanelResult>;
}

/** Spawn every panel entry concurrently; results settle behind the starts. */
export async function startReviewPanel(
	specs: readonly SubAgentSpec[],
	deps: RunPanelDeps,
): Promise<PanelRunStart[]> {
	return Promise.all(specs.map((spec) => startOne(spec, deps)));
}

/** Spawn every panel entry concurrently and collect normalized verdicts. */
export async function runReviewPanel(
	specs: readonly SubAgentSpec[],
	deps: RunPanelDeps,
): Promise<PanelResult[]> {
	const started = await startReviewPanel(specs, deps);
	return Promise.all(started.map((s) => s.settled));
}

/** The identity/spec half of a PanelResult, known before the run settles. */
export type PanelResultSeed = Omit<
	PanelResult,
	"status" | "verdict" | "findings" | "structured" | "report" | "ok"
>;
type PanelResultBase = PanelResultSeed;

async function startOne(
	spec: SubAgentSpec,
	deps: RunPanelDeps,
): Promise<PanelRunStart> {
	const kind = spec.kind ?? "review";
	const required = Boolean(spec.required);
	const base: PanelResultBase = {
		name: spec.name,
		persona: spec.persona,
		required,
		kind,
	};

	try {
		const resolved = await deps.resolveModel?.(spec);
		const model = resolved?.model;
		const profile = buildPersonaProfile(
			{ ...spec, ...(resolved?.effort ? { effort: resolved.effort } : {}) },
			{ cwd: deps.cwd, model },
		);
		if (resolved) {
			Object.assign(base, { model: resolved.model, effort: resolved.effort });
		}
		if (!profile) {
			return {
				name: spec.name,
				settled: Promise.resolve(
					notReported(base, "failed", `(unknown persona: ${spec.persona})`),
				),
			};
		}

		const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		// Exactly ONE attempt. The implicit "retry transient failures" here
		// stacked with the review tool's own rerun layer to run one reviewer up
		// to four times, so a wedged panel outlived every deadline derived from
		// this cap. A failed reviewer now stays failed — visible in the ledger,
		// recoverable only through an explicit review({action:"repair"}).
		const handle = deps.subagents.spawn(REVIEW_KICKOFF, profile);
		if (handle.id) Object.assign(base, { runId: handle.id });
		return {
			name: spec.name,
			...(handle.id ? { runId: handle.id } : {}),
			settled: settleOne(base, kind, handle, timeoutMs),
		};
	} catch (err) {
		return {
			name: spec.name,
			settled: Promise.resolve(
				notReported(
					base,
					"failed",
					`(spawn failed: ${err instanceof Error ? err.message : String(err)})`,
				),
			),
		};
	}
}

async function settleOne(
	base: PanelResultBase,
	kind: "review" | "helper",
	handle: HandleLike,
	timeoutMs: number,
): Promise<PanelResult> {
	try {
		const result = await settle(handle, timeoutMs);
		return panelResultFromRun(base, kind, result);
	} catch (err) {
		return notReported(
			base,
			"failed",
			`(run failed: ${err instanceof Error ? err.message : String(err)})`,
		);
	}
}

/**
 * Normalize one TERMINAL run outcome into a PanelResult — the single
 * validation gate for reviewer output. Shared by the live settle path and
 * the reattach-after-respawn path (review-tool harvesting the run store), so
 * a report reconstructed from a stored summary obeys exactly the same strict
 * contract — same verdict/JSON parsing, same terminal-status mapping — as a
 * live one.
 */
export function panelResultFromRun(
	base: PanelResultSeed,
	kind: "review" | "helper",
	result: { status: string; summary?: string; error?: string },
): PanelResult {
	const report = result.summary?.trim() ?? "";
	if (result.status !== "succeeded") {
		const status: PanelRunStatus =
			result.status === "timed-out"
				? "timed-out"
				: result.status === "stopped"
					? "interrupted"
					: "failed";
		return notReported(
			base,
			status,
			`(reviewer ${status}: ${result.error ?? "no report"})`,
			report,
		);
	}
	// Helpers produce info, not a gating verdict — but silence is still not
	// information.
	if (kind !== "review") {
		return report
			? {
					...base,
					status: "helper",
					verdict: "none",
					findings: [],
					structured: [],
					report,
					ok: true,
				}
			: notReported(base, "malformed", "(helper completed with no report)");
	}
	// Strict output contract: a review counts as reported ONLY with both a
	// parseable VERDICT line and a valid fenced findings JSON block (empty
	// findings array = clean approve). Anything less — empty output, prose
	// without a verdict, a verdict without the block — is malformed and
	// holds the gate as "never reported". An empty report is NEVER an
	// approve: the old clean-run rule turned silent gateway failures into
	// shipped deliverables.
	const parsed = parseVerdict(report);
	const json = parseJsonFindings(report);
	if (!report || parsed.verdict === "none" || json === null) {
		const why = !report
			? "empty report"
			: parsed.verdict === "none"
				? "no parseable VERDICT line"
				: "no valid fenced findings JSON block";
		return notReported(base, "malformed", `(malformed report: ${why})`, report);
	}
	// Severity decides the verdict — a stated BLOCK over three minors
	// normalizes to approve, a stated PASS over a critical blocks.
	const verdict = computedVerdict(json);
	return {
		...base,
		status: verdict === "approve" ? "approve" : "request-changes",
		verdict,
		findings: parsed.findings,
		structured: json,
		report,
		ok: true,
	};
}

/** A non-reporting terminal result; the raw partial output stays diagnostic. */
function notReported(
	base: Omit<
		PanelResult,
		"status" | "verdict" | "findings" | "structured" | "report" | "ok"
	>,
	status: PanelRunStatus,
	line: string,
	partial?: string,
): PanelResult {
	return {
		...base,
		status,
		verdict: "none",
		findings: [],
		structured: [],
		report: partial ? `${line}\n\n${partial}` : line,
		ok: false,
	};
}

/** True when every REQUIRED review reached an approving verdict (ship-gate). */
export function panelGateSatisfied(results: readonly PanelResult[]): boolean {
	return results
		.filter((r) => r.required && r.kind === "review")
		.every((r) => r.verdict === "approve");
}

/**
 * The executor's ship gate, computed from the PLAN's required reviewers (source
 * of truth) against the latest reported verdicts. A required reviewer with no
 * verdict yet — worker never ran it, or it's still running — blocks ship. This
 * is deliberately independent of the worker's own "done" claim.
 */
export function requiredGateSatisfied(
	requiredNames: readonly string[],
	latest: readonly { name: string; verdict: string }[] | undefined,
): boolean {
	if (requiredNames.length === 0) return true;
	if (!latest) return false;
	const approved = new Set(
		latest.filter((v) => v.verdict === "approve").map((v) => v.name),
	);
	return requiredNames.every((n) => approved.has(n));
}

// A constant, mechanical trigger — identical for every reviewer. The persona
// (who you are) and the deliverable focus (what to scrutinize) are set
// deterministically by buildPersonaProfile in the system prompt, never
// re-derived from this prose.
const REVIEW_KICKOFF =
	"Review the current change in this worktree. Start with `git diff` against " +
	"the base branch, read enough surrounding code to judge intent, then report " +
	"strictly within your assigned scope.";

interface HandleLike {
	readonly id?: string;
	result(): Promise<{ status: string; summary?: string; error?: string }>;
	stop(reason?: string): void;
}

// The deadline is installed BEFORE the run settles and reports "timed-out"
// distinctly from a child-side failure: timeouts are terminal for the attempt
// (never retried), and the ledger records which boundary killed the run.
async function settle(
	handle: HandleLike,
	timeoutMs: number,
): Promise<{ status: string; summary?: string; error?: string }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<{ status: string; error: string }>((resolve) => {
		timer = setTimeout(() => {
			handle.stop("timeout");
			resolve({ status: "timed-out", error: "timed out" });
		}, timeoutMs);
		timer.unref?.();
	});
	try {
		return await Promise.race([handle.result(), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export type { SpawnProfile };
