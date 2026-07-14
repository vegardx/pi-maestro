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
	parseStructuredFindings,
	type StructuredFinding,
} from "./exec/findings.js";
import { parseVerdict, type Verdict } from "./exec/verdicts.js";
import { buildPersonaProfile } from "./personas.js";
import type { SubAgentSpec } from "./schema.js";

export interface PanelResult {
	readonly name: string;
	readonly persona: string;
	readonly required: boolean;
	readonly kind: "review" | "helper";
	readonly verdict: Verdict;
	readonly findings: readonly string[];
	/**
	 * Ledger-eligible structured findings. From the report's JSON block when
	 * the reviewer complied (and then the verdict is COMPUTED from severity —
	 * the stated VERDICT line loses on mismatch); for non-compliant reviewers,
	 * fallback-parsed bullets count only when the reviewer itself blocked, so
	 * a PASS with suggestion bullets never fabricates blocking findings.
	 */
	readonly structured: readonly StructuredFinding[];
	/** The reviewer's full report (or an error line when it failed). */
	readonly report: string;
	readonly ok: boolean;
	/** Exact resolved selection for verdict/ledger telemetry. */
	readonly model?: string;
	readonly effort?: import("@vegardx/pi-contracts").ThinkingLevel;
}

export interface RunPanelDeps {
	readonly subagents: SubagentsCapabilityV1;
	/** The worker's worktree — reviewers read the change here (read-only). */
	readonly cwd: string;
	/** Resolve each reviewer independently against reviewer policy. */
	readonly resolveModel?: (
		spec: SubAgentSpec,
	) => Promise<{ model: string; effort?: import("@vegardx/pi-contracts").ThinkingLevel }>;
	readonly timeoutMs?: number;
}

// Deep reviews on slow gateway routes routinely take 4–6 minutes; a 5-minute
// cap killed thorough required reviewers mid-read and blocked ship with
// "timed out" instead of a verdict (radicalai dogfood, 2026-07-11). Exported
// so the executor derives its in-flight protection window from it — a guard
// shorter than a legitimate round reopens the kill-mid-review hole.
export const DEFAULT_TIMEOUT_MS = 600_000;

/** Spawn every panel entry concurrently and collect normalized verdicts. */
export async function runReviewPanel(
	specs: readonly SubAgentSpec[],
	deps: RunPanelDeps,
): Promise<PanelResult[]> {
	return Promise.all(specs.map((spec) => runOne(spec, deps)));
}

async function runOne(
	spec: SubAgentSpec,
	deps: RunPanelDeps,
): Promise<PanelResult> {
	const kind = spec.kind ?? "review";
	const required = Boolean(spec.required);
	const base: Omit<
		PanelResult,
		"verdict" | "findings" | "structured" | "report" | "ok"
	> = {
		name: spec.name,
		persona: spec.persona,
		required,
		kind,
	};

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
			...base,
			verdict: "none",
			findings: [],
			structured: [],
			report: `(unknown persona: ${spec.persona})`,
			ok: false,
		};
	}

	try {
		const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		let result = await settle(
			deps.subagents.spawn(REVIEW_KICKOFF, profile),
			timeoutMs,
		);
		let report = result.summary?.trim() ?? "";
		// One retry for the two transient failure modes: a gateway model ending
		// the run with no final text, and a reviewer killed by the timeout. A
		// silently missing REQUIRED verdict holds the ship gate with nothing to
		// show the human — a second attempt is cheap next to that.
		const transient =
			(result.status === "succeeded" && !report) ||
			(result.status === "failed" && result.error === "timed out");
		if (transient) {
			result = await settle(
				deps.subagents.spawn(REVIEW_KICKOFF, profile),
				timeoutMs,
			);
			report = result.summary?.trim() ?? "";
		}
		// A reviewer that SUCCEEDED twice (initial + retry) with an empty report
		// found nothing and said nothing. Treating that as "never reported" held
		// the ship gate with no actionable finding — send-back just reproduced
		// the same clean run (live dogfood: three deliverables looped on this).
		// A clean run is an approve; the report line keeps it auditable.
		if (result.status === "succeeded" && !report && kind === "review") {
			return {
				...base,
				verdict: "approve",
				findings: [],
				structured: [],
				report:
					"(clean run — reviewer completed twice with no findings and no report; counted as approve)",
				ok: true,
			};
		}
		if (result.status !== "succeeded" || !report) {
			return {
				...base,
				verdict: "none",
				findings: [],
				structured: [],
				report: `(reviewer ${result.status}: ${result.error ?? "no report"})`,
				ok: false,
			};
		}
		// Helpers produce info, not a gating verdict.
		if (kind !== "review") {
			return {
				...base,
				verdict: "none",
				findings: [],
				structured: [],
				report,
				ok: true,
			};
		}
		const parsed = parseVerdict(report);
		const json = parseJsonFindings(report);
		// JSON-compliant: severity decides the verdict — a stated BLOCK over
		// three minors normalizes to approve, a stated PASS over a critical
		// blocks. Non-compliant: the stated verdict stands, and its bullets
		// become (major) findings only when the reviewer itself blocked.
		const structured =
			json ??
			(parsed.verdict === "request-changes"
				? parseStructuredFindings(report)
				: []);
		const verdict = json ? computedVerdict(json) : parsed.verdict;
		return {
			...base,
			verdict,
			findings: parsed.findings,
			structured,
			report,
			ok: true,
		};
	} catch (err) {
		return {
			...base,
			verdict: "none",
			findings: [],
			structured: [],
			report: `(spawn failed: ${err instanceof Error ? err.message : String(err)})`,
			ok: false,
		};
	}
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
	result(): Promise<{ status: string; summary?: string; error?: string }>;
	stop(reason?: string): void;
}

async function settle(
	handle: HandleLike,
	timeoutMs: number,
): Promise<{ status: string; summary?: string; error?: string }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<{ status: string; error: string }>((resolve) => {
		timer = setTimeout(() => {
			handle.stop("timeout");
			resolve({ status: "failed", error: "timed out" });
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
