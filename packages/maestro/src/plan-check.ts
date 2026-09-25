// The plan check: one fresh-context read of the plan, and what the harness
// does with it.
//
// It replaces the blind review, and the difference is not the reviewer — it is
// WHO ANSWERS IT. The blind review put every blocking finding in front of a
// person, one dialog each, with a patch to accept or a reason to type; the
// findings walk was the largest dialog surface in the seat and it asked a human
// to arbitrate between two models about a document neither of them had run yet.
//
// THE HARNESS ANSWERS THE FINDINGS ITSELF. A blocking finding goes straight
// back to the same mini-conversation the document came from, the model rewrites
// the whole document, and the check runs again — silently, at most
// `MAX_PLAN_CHECK_REVISIONS` times. A person is asked exactly once, and only
// when the check says a person is the one who has to answer (`needsPerson`) or
// when the bound is spent with something still blocking. Everything else is one
// line in the confirmation that starts the run.
//
// The reviewer itself is a ONE-SHOT SUBAGENT, not a workflow run: it reads the
// document and the agreed description in a fresh context, may read the
// repositories the plan names, and returns findings. `PlanCheck` is that seam —
// a single async function — so this module, the exit flow and every test of
// either need nothing but a plan and a promise. A seat that cannot reach a
// reviewer gets `{unavailable}`, which is never a refusal: the confirmation
// says the check could not run and why, and the person still decides.

import { Type } from "typebox";
import type { Plan } from "./plan.js";

/** Most severe first. The order IS the severity ordering; nothing else ranks. */
export const PLAN_CHECK_SEVERITIES = ["blocking", "major", "minor"] as const;

export type PlanCheckSeverity = (typeof PLAN_CHECK_SEVERITIES)[number];

/** What the reviewer says about the plan as a whole. */
export const PLAN_CHECK_VERDICTS = ["approve", "gaps", "blocked"] as const;

export type PlanCheckVerdict = (typeof PLAN_CHECK_VERDICTS)[number];

/**
 * One thing the check found.
 *
 * `direction` is what the model is told to do about it and `question` is what
 * a PERSON is asked — two different audiences, so two fields. `needsPerson`
 * is the reviewer saying which: a finding about a trade-off nobody has made,
 * or about intent the document cannot settle, is not one another model turn
 * answers, and sending it round the revise loop twice would only produce a
 * document that guesses.
 */
export interface PlanCheckFinding {
	readonly id: string;
	readonly severity: PlanCheckSeverity;
	/** Where in the plan, in the reviewer's own words. */
	readonly where: string;
	readonly summary: string;
	/** What to change, for the model. */
	readonly direction?: string;
	/** Only a person can answer this. */
	readonly needsPerson?: boolean;
	/** What to ask them, when `needsPerson`. */
	readonly question?: string;
}

export interface PlanCheckResult {
	readonly verdict: PlanCheckVerdict;
	readonly findings: readonly PlanCheckFinding[];
	readonly notes: string;
}

/**
 * The reviewer was not reached, in one sanitized sentence.
 *
 * Never an exception and never a refusal. A seat with no subagent runtime, a
 * launch that failed, a timeout, an output nothing could read — all of them are
 * the same thing to the flow: the confirmation says the check could not run and
 * names the reason, and the person decides with what they have.
 */
export interface PlanCheckUnavailable {
	readonly unavailable: string;
}

export function isPlanCheckUnavailable(
	value: PlanCheckResult | PlanCheckUnavailable,
): value is PlanCheckUnavailable {
	return "unavailable" in value;
}

/**
 * The seam: the stored plan and the agreed description in, findings out.
 *
 * One function, because that is all the exit needs of it — no client, no
 * runtime, no allowlist. The implementation launches a one-shot subagent
 * (`subagent-provider.ts`); a seat without one supplies
 * {@link unavailablePlanCheck}.
 */
export type PlanCheck = (
	plan: Plan,
	description: string,
	signal?: AbortSignal,
) => Promise<PlanCheckResult | PlanCheckUnavailable>;

/** What a seat with no reviewer says, once, in the confirmation. */
export const NO_PLAN_CHECK_REASON =
	"this session has no subagent runtime to run it in";

/** The seam for a seat that cannot reach a reviewer at all. */
export const unavailablePlanCheck: PlanCheck = async () => ({
	unavailable: NO_PLAN_CHECK_REASON,
});

/**
 * How many times the document is rewritten to answer a check, silently.
 *
 * Two, and then a person hears about it. The loop between the author and the
 * reviewer is bounded or it is not a loop anybody approved, and a third
 * rewrite is where the flow stops checking a plan and starts arguing with
 * itself about one.
 */
export const MAX_PLAN_CHECK_REVISIONS = 2;

// ── Reading what came back ───────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One finding, as far as this seat reads it; anything else is not one. */
export function isPlanCheckFinding(value: unknown): value is PlanCheckFinding {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.where === "string" &&
		typeof value.summary === "string" &&
		(PLAN_CHECK_SEVERITIES as readonly unknown[]).includes(value.severity) &&
		(value.direction === undefined || typeof value.direction === "string") &&
		(value.needsPerson === undefined ||
			typeof value.needsPerson === "boolean") &&
		(value.question === undefined || typeof value.question === "string")
	);
}

/**
 * The subagent's structured output as a result, or nothing.
 *
 * Strict about what it reads and silent about what it does not: a decision
 * taken over values this seat could not recognise is a decision about nothing,
 * and an output that does not fit is the reviewer being unreachable — which is
 * a case the caller already has an answer for.
 */
export function readPlanCheckResult(
	output: unknown,
): PlanCheckResult | undefined {
	if (!isRecord(output)) return undefined;
	if (!(PLAN_CHECK_VERDICTS as readonly unknown[]).includes(output.verdict))
		return undefined;
	if (!Array.isArray(output.findings)) return undefined;
	if (!output.findings.every(isPlanCheckFinding)) return undefined;
	return {
		verdict: output.verdict as PlanCheckVerdict,
		findings: output.findings as readonly PlanCheckFinding[],
		notes: typeof output.notes === "string" ? output.notes : "",
	};
}

// ── What the harness does with it ────────────────────────────────────────────

/** The blocking findings, and the ones that are merely worth knowing. */
export function partitionPlanCheck(findings: readonly PlanCheckFinding[]): {
	readonly blocking: readonly PlanCheckFinding[];
	readonly informational: readonly PlanCheckFinding[];
} {
	return {
		blocking: findings.filter((finding) => finding.severity === "blocking"),
		informational: findings.filter(
			(finding) => finding.severity !== "blocking",
		),
	};
}

/** How many of each severity, for the record and for the one-line summary. */
export function severityCounts(
	findings: readonly PlanCheckFinding[],
): Readonly<Record<PlanCheckSeverity, number>> {
	const counts: Record<PlanCheckSeverity, number> = {
		blocking: 0,
		major: 0,
		minor: 0,
	};
	for (const finding of findings) counts[finding.severity] += 1;
	return counts;
}

/** What the harness decided to do with one check result. */
export type PlanCheckDecision =
	/** Nothing blocking, or nothing left to do about what is: go on. */
	| { readonly kind: "accept" }
	/** Hand the findings back to the author and check again. */
	| { readonly kind: "revise"; readonly findings: readonly PlanCheckFinding[] }
	/** A person has to answer these, and only these. */
	| { readonly kind: "ask"; readonly findings: readonly PlanCheckFinding[] };

/**
 * The whole decision, as a pure function of the result and the round.
 *
 * Three rules and no others:
 *
 *   - Nothing blocking → `accept`. `major` and `minor` are read in the
 *     confirmation and never asked about; a check that opened a dialog per
 *     observation would teach a person to escape through all of them.
 *   - Anything blocking that the reviewer marked `needsPerson` → `ask`, and
 *     only those findings are asked. A rewrite cannot answer them, so spending
 *     a round pretending it can is spending somebody's time.
 *   - Otherwise a rewrite, until `MAX_PLAN_CHECK_REVISIONS` is spent; the round
 *     that spends it asks instead, because a blocking finding nothing more will
 *     be done about is one a person is owed.
 *
 * `round` is how many rewrites have already happened, so the first check is
 * round 0.
 */
export function planCheckDecision(
	result: PlanCheckResult,
	round: number,
): PlanCheckDecision {
	const { blocking } = partitionPlanCheck(result.findings);
	if (blocking.length === 0) return { kind: "accept" };
	const personal = blocking.filter((finding) => finding.needsPerson === true);
	if (personal.length > 0) return { kind: "ask", findings: personal };
	if (round >= MAX_PLAN_CHECK_REVISIONS)
		return { kind: "ask", findings: blocking };
	return { kind: "revise", findings: blocking };
}

// ── What it all reads like ───────────────────────────────────────────────────

/** Findings as a person reads them: severity, where, and what. */
export function renderPlanCheckFindings(
	findings: readonly PlanCheckFinding[],
	heading: string,
): string {
	return [
		heading,
		...findings.map(
			(finding) =>
				`  [${finding.severity}] ${finding.id} — ${finding.where}\n    ${finding.summary}` +
				(finding.direction ? `\n    direction: ${finding.direction}` : "") +
				(finding.question ? `\n    question: ${finding.question}` : ""),
		),
	].join("\n");
}

/**
 * The check, in the one line the confirmation carries.
 *
 * It says the verdict and the counts and stops. The findings themselves follow
 * on their own lines when there are any, because a count with nothing under it
 * is a number a person cannot act on.
 */
export function renderPlanCheckLine(
	result: PlanCheckResult | PlanCheckUnavailable,
): string {
	if (isPlanCheckUnavailable(result))
		return `Plan check: could not run — ${result.unavailable}.`;
	const counts = severityCounts(result.findings);
	if (result.findings.length === 0)
		return `Plan check: \`${result.verdict}\`, nothing found.`;
	return (
		`Plan check: \`${result.verdict}\` — ` +
		(PLAN_CHECK_SEVERITIES as readonly PlanCheckSeverity[])
			.filter((severity) => counts[severity] > 0)
			.map((severity) => `${counts[severity]} ${severity}`)
			.join(", ") +
		"."
	);
}

/**
 * The findings, as the author is asked to answer them.
 *
 * Verbatim and all of them — the blocking ones it has to answer and the rest it
 * may — because a steer that summarised the check would be this seat deciding
 * which findings the author gets to see, which is the one thing an independent
 * read exists to stop.
 */
export function renderPlanCheckSteer(
	result: PlanCheckResult,
	round: number,
): string {
	const { blocking } = partitionPlanCheck(result.findings);
	const left = Math.max(MAX_PLAN_CHECK_REVISIONS - round, 0);
	return [
		"The plan you wrote has been read in a fresh context — the document and" +
			" the description we agreed, without your reasoning — and it blocks:" +
			` ${blocking.length} blocking finding${blocking.length === 1 ? "" : "s"}.` +
			` ${left === 1 ? "One rewrite is left" : `${left} rewrites are left`} before a person is asked instead.`,
		"",
		renderPlanCheckFindings(result.findings, "Everything it found, verbatim:"),
		...(result.notes.trim()
			? ["", "The reviewer's notes, verbatim:", "", result.notes.trim()]
			: []),
		"",
		"Rewrite the plan so that every blocking finding is answered, and take the" +
			" major and minor ones wherever you agree with them. Where you think a" +
			" finding is wrong, say so in the plan — a task, a body, an edge that" +
			" makes the answer visible — rather than leaving the reviewer to find" +
			" the same thing again.",
		"",
		"Send the WHOLE document again: the same slug, everything the plan already" +
			" has, with your changes in it. A deliverable's `tasks` are the work and" +
			" its `reviews` are who reads that work; effort, gates and publication" +
			" are already decided and the schema has no field for them.",
		"",
		"Your whole answer is that one JSON object. Do not answer the findings in" +
			" prose: the same reader reads the plan again the moment it is stored," +
			" and the person is shown the result.",
	].join("\n");
}

// ── The reviewer's output schema ──────────────────────────────────────────────

/**
 * What the one-shot reviewer must return, as the structured-output schema its
 * launch pins.
 *
 * DERIVED FROM THE CONSTANTS ABOVE, not written out beside them: the severities
 * and the verdicts live in exactly one place, and a fourth severity added to the
 * union cannot fail to appear in the schema the reviewer is held to. The schema
 * is pinned on the request, so an output that does not fit it is the reviewer
 * being unreachable — `readPlanCheckResult` is the second check, on this side,
 * because a schema enforced only by the runtime is a schema this seat is
 * trusting a peer to have enforced.
 */
export const PlanCheckOutputSchema = Type.Object(
	{
		verdict: Type.Union(
			PLAN_CHECK_VERDICTS.map((verdict) => Type.Literal(verdict)),
		),
		findings: Type.Array(
			Type.Object(
				{
					id: Type.String({ minLength: 1 }),
					severity: Type.Union(
						PLAN_CHECK_SEVERITIES.map((severity) => Type.Literal(severity)),
					),
					where: Type.String({ minLength: 1 }),
					summary: Type.String({ minLength: 1 }),
					direction: Type.Optional(Type.String({ minLength: 1 })),
					needsPerson: Type.Optional(Type.Boolean()),
					question: Type.Optional(Type.String({ minLength: 1 })),
				},
				{ additionalProperties: false },
			),
		),
		notes: Type.String(),
	},
	{ additionalProperties: false },
);
