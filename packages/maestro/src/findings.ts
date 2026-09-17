// The findings walk: what a human does with a blind review (spec 1.2, 15-17).
//
// `plan-review` returns `{verdict, findings, notes?}`, and a finding is
// `{id, severity, kind, where, what, patch?}` — the shared shape exported from
// `@vegardx/pi-workflow/components`, declared again here because nothing
// crosses the import boundary. The walk turns those findings into exactly as
// many decisions as a human actually has to make, and no more:
//
//   - **Only `blocking` findings are asked.** `major` and `minor` are one
//     `notify(…, "info")` and never a dialog. A review that opened a dialog per
//     observation would teach the human to escape through all of them, which is
//     the same as not reviewing.
//   - **Accept is mechanical.** `finding.patch` is applied to the stored plan,
//     the result goes through `inspectPlan`, and only then is it saved. A patch
//     that does not apply, or one that produces a plan that no longer
//     validates, is REPORTED AND RE-ASKED WITHOUT THE ACCEPT OPTION: the
//     suggestion is still dismissable, but it is no longer offered as something
//     that works. Nothing is ever re-prompted to a model.
//   - **A dismissal has a reason.** An empty reason is not a dismissal; the
//     finding is asked again. The reason is what a later reader has instead of
//     the dialog nobody recorded.
//   - **A finding without a patch goes back to the model.** *Revise with the
//     model* is what a reviewer's prose is actually for: the finding, and every
//     other one in the same review, is rendered into a steer, the model rewrites
//     the plan and stores it again, and the exit re-enters from readiness. It
//     ends the walk the moment it is chosen — one rewrite answers the whole
//     review, and asking the remaining findings first would collect decisions
//     about a document that is being replaced.
//   - **Escape is *Back to the conversation*.** The most severe findings are
//     the ones where doing nothing must not mean proceeding. The FIRST option
//     is a different question — it is what a person most likely wants, which is
//     to take the patch the reviewer brought, or to hand the review back to the
//     model when it brought none — and the two are deliberately not the same
//     row.
//
// The walk holds no UI of its own: dialogs arrive as the injected `ExitDialogs`
// port, which counts them, carries the abort signal, and defers while another
// extension's prompt is on screen.

import type { ExitDialogs, ExitOption } from "./exit-flow.js";
import { applyJsonPatch } from "./json-patch.js";
import { inspectPlan, type Plan, type PlanReport } from "./plan.js";

/** Most severe first. The order IS the severity ordering; nothing else ranks. */
export const FINDING_SEVERITIES = ["blocking", "major", "minor"] as const;

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_KINDS = [
	"gap",
	"graph",
	"budget",
	"risk",
	"ambiguity",
] as const;

export type FindingKind = (typeof FINDING_KINDS)[number];

/**
 * One thing a reviewer found, as pi-workflow's `FindingSchema` declares it.
 *
 * `where` is an RFC 6901 pointer into the plan and `patch` is RFC 6902-shaped,
 * which is what makes *accept* an apply rather than a conversation.
 */
export interface Finding {
	readonly id: string;
	readonly severity: FindingSeverity;
	readonly kind: FindingKind;
	readonly where: string;
	readonly what: string;
	readonly patch?: {
		readonly op: string;
		readonly path: string;
		readonly value?: unknown;
	};
}

/** What `plan-review` returns. `blocked` and `gaps` both carry findings. */
export const PLAN_REVIEW_VERDICTS = ["ready", "gaps", "blocked"] as const;

export type PlanReviewVerdict = (typeof PLAN_REVIEW_VERDICTS)[number];

export interface PlanReview {
	readonly verdict: PlanReviewVerdict;
	readonly findings: readonly Finding[];
	readonly notes?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One finding, as far as this seat reads it; anything else is not one. */
export function isFinding(value: unknown): value is Finding {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.where === "string" &&
		typeof value.what === "string" &&
		(FINDING_SEVERITIES as readonly unknown[]).includes(value.severity) &&
		(FINDING_KINDS as readonly unknown[]).includes(value.kind) &&
		(value.patch === undefined || isRecord(value.patch))
	);
}

/**
 * A run's output as a review, or nothing.
 *
 * Tolerant on purpose about what it does not read (`notes`, anything the
 * runtime adds) and strict about what it does: a findings walk over values it
 * could not recognise would ask a human about nothing. A malformed output is
 * the reviewer being unreachable, which is a fallback the caller already has.
 */
export function readPlanReview(output: unknown): PlanReview | undefined {
	if (!isRecord(output)) return undefined;
	if (!(PLAN_REVIEW_VERDICTS as readonly unknown[]).includes(output.verdict))
		return undefined;
	if (!Array.isArray(output.findings)) return undefined;
	if (!output.findings.every(isFinding)) return undefined;
	return {
		verdict: output.verdict as PlanReviewVerdict,
		findings: output.findings as readonly Finding[],
		...(typeof output.notes === "string" ? { notes: output.notes } : {}),
	};
}

/** The findings that stop a run, and the ones that are worth knowing. */
export function partitionFindings(findings: readonly Finding[]): {
	readonly blocking: readonly Finding[];
	readonly informational: readonly Finding[];
} {
	return {
		blocking: findings.filter((finding) => finding.severity === "blocking"),
		informational: findings.filter(
			(finding) => finding.severity !== "blocking",
		),
	};
}

/** Findings as a human reads them: severity, where, and what. */
export function renderFindings(
	findings: readonly Finding[],
	heading: string,
): string {
	return [
		heading,
		...findings.map(
			(finding) =>
				`  [${finding.severity}/${finding.kind}] ${finding.id} at ${finding.where}\n    ${finding.what}${
					finding.patch
						? `\n    suggests: ${finding.patch.op} ${finding.patch.path}`
						: ""
				}`,
		),
	].join("\n");
}

/**
 * How many blind reviews one exit record is worth.
 *
 * The loop between the model and the reviewer is bounded or it is not a loop
 * anybody approved: three reads of the same plan is where a fourth stops being
 * a check and starts being the flow arguing with itself. Accepts and revises
 * count against the SAME bound, because both of them buy a re-review.
 */
export const MAX_BLIND_REVIEWS = 3;

/**
 * The whole review, as the model is asked to answer it.
 *
 * Verbatim, and all of it: the blocking findings it has to answer, the major
 * and minor ones it may, and the reviewer's own notes. A steer that summarised
 * the review would be this seat deciding which findings the model gets to see,
 * which is the one thing a blind review exists to stop.
 *
 * `round` is how many reviews have run, including the one being handed over, so
 * the model is told what is left rather than being asked to guess.
 */
export function renderReviseSteer(
	findings: readonly Finding[],
	notes: string | undefined,
	round: number,
): string {
	const { blocking } = partitionFindings(findings);
	const left = Math.max(MAX_BLIND_REVIEWS - round, 0);
	return [
		"The plan you stored has been read by a blind reviewer — the compiled" +
			" graph, against the description we agreed, without your reasoning — and" +
			` it blocks: ${blocking.length} blocking finding${blocking.length === 1 ? "" : "s"}.` +
			` This was review ${round} of ${MAX_BLIND_REVIEWS}; ${
				left === 1 ? "one more is left" : `${left} are left`
			}.`,
		"",
		renderFindings(findings, "Everything it found, verbatim:"),
		...(notes?.trim()
			? ["", "The reviewer's notes, verbatim:", "", notes.trim()]
			: []),
		"",
		"Rewrite the plan so that every blocking finding is answered, and take the" +
			" major and minor ones wherever you agree with them. Where you think a" +
			" finding is wrong, say so in the plan — a task, a body, an edge that" +
			" makes the answer visible — rather than leaving the reviewer to find" +
			" the same thing again.",
		"",
		"Then call `plan` once with the WHOLE document: the same slug, everything" +
			" the plan already has, with your changes in it. The `policy` block does" +
			" not move — it is the effort, the gates and the publication already" +
			" decided, and nothing in this review touches them.",
		"",
		"Stop after the `plan` call. Do not answer the review in prose, do not" +
			" start a run, and do not ask a workflow to check your rewrite: the same" +
			" blind reviewer reads the plan again the moment you store it, and I am" +
			" shown both.",
	].join("\n");
}

// ── The dialogs ──────────────────────────────────────────────────────────────

export const FINDING_ACCEPT = "Accept the suggestion";
export const FINDING_REVISE = "Revise with the model";
export const FINDING_DISMISS = "Dismiss";
export const FINDING_BACK = "Back to the conversation";

export type FindingChoice = "accept" | "revise" | "dismiss" | "back";

/**
 * What to do with one blocking finding, when a patch came with it.
 *
 * *Accept the suggestion* is first: the reviewer brought a patch, the patch is
 * applied mechanically and re-validated, and taking it is what usually happens.
 * *Revise with the model* is second because it is the bigger move — the whole
 * review goes back and the plan is rewritten — and a patch that applies is the
 * cheaper way to the same place. Escape is *Back to the conversation*:
 * accepting a patch, handing the review to the model, and waving a blocking
 * finding away are all commitments, and a dialog nobody answered is not where
 * any of them belongs.
 */
export const FINDING_OPTIONS: readonly ExitOption<FindingChoice>[] = [
	{ value: "accept", text: FINDING_ACCEPT, recommended: true },
	{ value: "revise", text: FINDING_REVISE },
	{ value: "dismiss", text: FINDING_DISMISS },
	{ value: "back", text: FINDING_BACK, escape: true },
];

/**
 * The same table with no patch to take — or one shown not to work.
 *
 * *Revise with the model* moves up rather than the list simply losing a row:
 * the recommended option is a claim about what to do NOW, and a blocking
 * finding whose reviewer brought only prose is a finding a human cannot apply.
 * The model can, so the honest recommendation is to hand it back.
 */
export const FINDING_OPTIONS_UNPATCHABLE: readonly ExitOption<FindingChoice>[] =
	[
		{ value: "revise", text: FINDING_REVISE, recommended: true },
		{ value: "dismiss", text: FINDING_DISMISS },
		{ value: "back", text: FINDING_BACK, escape: true },
	];

/**
 * The table once the review budget is spent: no revise, because no review.
 *
 * `MAX_BLIND_REVIEWS` reviews have run and nothing would read a rewrite, so
 * offering *Revise with the model* would promise a check that cannot happen.
 * Accepting a patch still writes it into the stored plan, which is worth
 * keeping — it is the reading of this review that ends here, not the plan.
 */
export const FINDING_OPTIONS_FINAL: readonly ExitOption<FindingChoice>[] = [
	{ value: "accept", text: FINDING_ACCEPT, recommended: true },
	{ value: "dismiss", text: FINDING_DISMISS },
	{ value: "back", text: FINDING_BACK, escape: true },
];

/** Both doors shut: no patch to apply and no review left to earn. */
export const FINDING_OPTIONS_FINAL_UNPATCHABLE: readonly ExitOption<FindingChoice>[] =
	[
		{ value: "dismiss", text: FINDING_DISMISS, recommended: true },
		{ value: "back", text: FINDING_BACK, escape: true },
	];

/** The one table this finding is worth, from the two facts that decide it. */
export function findingOptions(state: {
	/** A patch came with the finding and has not failed to apply. */
	readonly acceptable: boolean;
	/** A further blind review is still inside `MAX_BLIND_REVIEWS`. */
	readonly revisable: boolean;
}): readonly ExitOption<FindingChoice>[] {
	if (state.revisable)
		return state.acceptable ? FINDING_OPTIONS : FINDING_OPTIONS_UNPATCHABLE;
	return state.acceptable
		? FINDING_OPTIONS_FINAL
		: FINDING_OPTIONS_FINAL_UNPATCHABLE;
}

export const DISMISS_REASON_TITLE = "Why is this not a problem?";

/** The title of one finding's dialog, which is the finding itself. */
export function findingTitle(
	finding: Finding,
	ordinal: number,
	total: number,
): string {
	return `Blocking finding ${ordinal} of ${total} — ${finding.what} (${finding.where})`;
}

/** What the walk did, and the plan as it stands afterwards. */
export type FindingsWalkOutcome =
	| {
			readonly kind: "settled";
			readonly plan: Plan;
			readonly accepted: number;
			readonly dismissed: readonly {
				readonly id: string;
				readonly reason: string;
			}[];
	  }
	/**
	 * *Revise with the model*, which ends the walk where it stands.
	 *
	 * The remaining findings are NOT asked: they go back to the model with the
	 * rest of the review, and a decision collected about a document that is
	 * being rewritten is a decision about nothing.
	 */
	| {
			readonly kind: "revise";
			readonly plan: Plan;
			readonly accepted: number;
	  }
	| {
			readonly kind: "back";
			readonly plan: Plan;
			readonly accepted: number;
	  };

export interface FindingsWalkDeps {
	readonly dialogs: ExitDialogs;
	readonly findings: readonly Finding[];
	/** The stored plan an accepted patch is applied to. */
	readonly plan: Plan;
	/** Persist an accepted plan. The store's `savePlan`, which refuses invalid. */
	readonly save: (plan: Plan) => void;
	/** Validation for the patched plan. Injected so a test needs no repository. */
	readonly inspect?: (plan: Plan) => PlanReport;
	/**
	 * Whether a further blind review is still inside `MAX_BLIND_REVIEWS`.
	 *
	 * Defaults to false, so a caller that has not thought about the bound does
	 * not offer a rewrite nothing would read. The exit flow passes its own
	 * count.
	 */
	readonly revisable?: boolean;
}

/** A patched document that is not a plan at all, before validation sees it. */
function planShapeProblem(value: unknown): string | undefined {
	if (!isRecord(value)) return "the patched plan is not a JSON object";
	if (!Array.isArray(value.deliverables))
		return "the patched plan has no `deliverables` array";
	if (typeof value.slug !== "string") return "the patched plan has no `slug`";
	return undefined;
}

/**
 * Ask about every blocking finding, in order, until one ends the walk.
 *
 * Two answers end it early: *Back to the conversation*, and *Revise with the
 * model*. Returns the plan as it stands — patched and saved where accepts
 * happened, untouched otherwise — so the caller can recompile from it, or hand
 * it back to the model and wait for the next one.
 */
export async function walkFindings(
	deps: FindingsWalkDeps,
): Promise<FindingsWalkOutcome> {
	const { dialogs } = deps;
	const inspect = deps.inspect ?? ((plan: Plan) => inspectPlan(plan));
	const { blocking, informational } = partitionFindings(deps.findings);

	// Step 17: said once, never asked. A major finding is worth reading and is
	// not worth a decision — the run is not held up by one.
	if (informational.length > 0)
		dialogs.notify(
			renderFindings(
				informational,
				`${informational.length} finding${informational.length === 1 ? "" : "s"} worth knowing, none of them blocking:`,
			),
			"info",
		);

	let plan = deps.plan;
	let accepted = 0;
	const dismissed: { id: string; reason: string }[] = [];

	const revisable = deps.revisable === true;

	for (const [index, finding] of blocking.entries()) {
		// Cleared when an accept fails: the suggestion stays visible in the
		// title, but it is no longer offered as something that would work.
		let acceptable = finding.patch !== undefined;
		let settled = false;
		while (!settled) {
			const choice = await dialogs.choose(
				findingTitle(finding, index + 1, blocking.length),
				findingOptions({ acceptable, revisable }),
			);
			if (choice === "back") return { kind: "back", plan, accepted };
			// One rewrite answers the whole review, so the walk stops here and
			// the findings that were not asked travel in the steer with the rest.
			if (choice === "revise") return { kind: "revise", plan, accepted };
			if (choice === "dismiss") {
				const answer = await dialogs.input(DISMISS_REASON_TITLE, "");
				const reason = (answer ?? "").trim();
				if (reason.length === 0) {
					// Not a dismissal. A finding waved away without a reason is a
					// finding nobody can weigh later, so the question comes back.
					dialogs.notify(
						`\`${finding.id}\` was not dismissed: a dismissal needs a reason.`,
						"warning",
					);
					continue;
				}
				dismissed.push({ id: finding.id, reason });
				settled = true;
				continue;
			}
			const patched = applyJsonPatch(plan, finding.patch);
			if (!patched.ok) {
				dialogs.notify(
					`\`${finding.id}\` could not be applied: ${patched.reason}`,
					"warning",
				);
				acceptable = false;
				continue;
			}
			const shape = planShapeProblem(patched.document);
			if (shape) {
				dialogs.notify(
					`\`${finding.id}\` could not be applied: ${shape}`,
					"warning",
				);
				acceptable = false;
				continue;
			}
			const next = patched.document as Plan;
			const report = inspect(next);
			if (report.errors.length > 0) {
				dialogs.notify(
					`\`${finding.id}\` was not applied — the plan would stop validating:\n${report.errors
						.map((error) => `  - ${error}`)
						.join("\n")}`,
					"warning",
				);
				acceptable = false;
				continue;
			}
			try {
				deps.save(next);
			} catch (error) {
				dialogs.notify(
					`\`${finding.id}\` was not applied — the plan could not be stored: ${
						error instanceof Error ? error.message : String(error)
					}`,
					"warning",
				);
				acceptable = false;
				continue;
			}
			plan = next;
			accepted += 1;
			dialogs.notify(
				`Applied \`${finding.id}\` to the stored plan (${finding.patch?.op} ${finding.patch?.path}).`,
				"info",
			);
			settled = true;
		}
	}

	return { kind: "settled", plan, accepted, dismissed };
}
