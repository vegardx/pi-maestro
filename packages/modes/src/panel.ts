// Run a deliverable's review panel: spawn each SubAgentSpec as a headless
// one-shot reviewer (buildPersonaProfile) through the subagents capability,
// await its verdict, and return the normalized results. The worker calls this
// (via the review tool), reasons over the findings, fixes, and re-runs; the
// executor gates ship on the `required` entries' latest verdicts.

import type {
	SpawnProfile,
	SubagentsCapabilityV1,
} from "@vegardx/pi-contracts";
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
	/** The reviewer's full report (or an error line when it failed). */
	readonly report: string;
	readonly ok: boolean;
}

export interface RunPanelDeps {
	readonly subagents: SubagentsCapabilityV1;
	/** The worker's worktree — reviewers read the change here (read-only). */
	readonly cwd: string;
	/**
	 * The `review` tier model id for every reviewer, or undefined when the tier
	 * tracks the session model (⇒ inherit the default).
	 */
	readonly resolveModel?: () => Promise<string | undefined>;
	readonly timeoutMs?: number;
}

// Deep reviews on slow gateway routes routinely take 4–6 minutes; a 5-minute
// cap killed thorough required reviewers mid-read and blocked ship with
// "timed out" instead of a verdict (radicalai dogfood, 2026-07-11).
const DEFAULT_TIMEOUT_MS = 600_000;

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
	const base: Omit<PanelResult, "verdict" | "findings" | "report" | "ok"> = {
		name: spec.name,
		persona: spec.persona,
		required,
		kind,
	};

	const model = await deps.resolveModel?.();
	const profile = buildPersonaProfile(spec, { cwd: deps.cwd, model });
	if (!profile) {
		return {
			...base,
			verdict: "none",
			findings: [],
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
		if (result.status !== "succeeded" || !report) {
			return {
				...base,
				verdict: "none",
				findings: [],
				report: `(reviewer ${result.status}: ${result.error ?? "no report"})`,
				ok: false,
			};
		}
		// Helpers produce info, not a gating verdict.
		const parsed = kind === "review" ? parseVerdict(report) : null;
		return {
			...base,
			verdict: parsed?.verdict ?? "none",
			findings: parsed?.findings ?? [],
			report,
			ok: true,
		};
	} catch (err) {
		return {
			...base,
			verdict: "none",
			findings: [],
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
