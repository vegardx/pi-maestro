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
//   - **Escape is *Back to the conversation*, and it is listed FIRST.** The
//     most severe findings are the ones where doing nothing must not mean
//     proceeding — so the row the dialog highlights and the row escape takes
//     are the same row, which is the rule every option table here follows.
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

// ── The dialogs ──────────────────────────────────────────────────────────────

export const FINDING_ACCEPT = "Accept the suggestion";
export const FINDING_DISMISS = "Dismiss";
export const FINDING_BACK = "Back to the conversation";

/**
 * The full table, default first, for the test that checks every one of them.
 *
 * The live table is built per finding — *Accept the suggestion* is dropped once
 * a patch has failed to apply — but the ORDER and the default are this one's.
 */
export const FINDING_OPTIONS: readonly ExitOption<
	"back" | "accept" | "dismiss"
>[] = [
	{ value: "back", text: FINDING_BACK, fallback: true },
	{ value: "accept", text: FINDING_ACCEPT },
	{ value: "dismiss", text: FINDING_DISMISS },
];

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
 * Ask about every blocking finding, in order, until one sends the human back.
 *
 * Returns the plan as it stands — patched and saved where accepts happened,
 * untouched otherwise — so the caller can recompile from it.
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

	for (const [index, finding] of blocking.entries()) {
		// Cleared when an accept fails: the suggestion stays visible in the
		// title, but it is no longer offered as something that would work.
		let acceptable = finding.patch !== undefined;
		let settled = false;
		while (!settled) {
			const options = FINDING_OPTIONS.filter(
				(option) => option.value !== "accept" || acceptable,
			);
			const choice = await dialogs.choose(
				findingTitle(finding, index + 1, blocking.length),
				options,
			);
			if (choice === "back") return { kind: "back", plan, accepted };
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
