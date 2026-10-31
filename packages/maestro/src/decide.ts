// The decisions a run asks for, asked in the session that started it.
//
// A run used to ask for two things and get neither here. The ship gate parked
// and the conversation was told to type `/workflow decide <prefix> ship
// {"ship":true}` — a command with a JSON literal in it, about a gate whose
// inputs were in another surface — and a failure mid-run was narrated and then
// left, because "nothing retries on its own" was the whole of the answer. Both
// were decisions, and a decision a person has to leave the conversation to make
// is a decision this seat pushed onto them.
//
// So THE DIALOG IS THE DECISION SURFACE, and there are three of them:
//
//   1. **The ship dialog** (mode `ask`). The `ship` gate arrives, the gate's own
//      inputs are rendered — per deliverable the implementation summary, the
//      review's counts and the implementer's dispositions, and the last check —
//      and one select asks: *Ship*, *Don't ship*, *Look first*. *Look first*
//      shows the Review section, every finding with who raised it and how the
//      implementer answered, and asks again. Ship records the decision and
//      publication follows. Nothing in the model's turn names a command,
//      because there is nothing to type.
//   2. **Auto publication** (mode `auto`). A `gates: "none"` run has no ship gate
//      to park at: it completes, and the seat publishes immediately — the
//      approval was given when the person answered `Start the run?` from auto —
//      and the pull request's link lands in the conversation. A publication that
//      fails offers *Retry publication* / *Leave it*.
//   3. **The failure dialog** (both). A task or a run that failed is offered as
//      *Retry the task*, *Stop the run*, *Re-plan* — the last of which switches
//      to plan mode with the run's state summary, so the conversation plans from
//      where the run got to rather than from nothing.
//
// EVERY ANSWER IS A CALL ON THE RUN, and none of them is a local substitute for
// one. pi-workflow's service-provider client carries `decide`, `resume` and
// `stop` at contract revision 22, and `inspect(runId, {include: [..., -
// "checkpoints"]})` carries the gate's own verified input values on
// `tasks[].checkpoint.inputs`. So:
//
//   - **Ship decides the run's own `ship` checkpoint** with `{ship: true}`, and
//     then gets out of the way. Publication follows the run's COMPLETION, down
//     exactly the path a decision made in pi-workflow's own widget takes: the run
//     un-parks, finishes, `watchShippedRuns` proves `{"ship": true}` from the
//     checkpoint and announces, and publication re-proves it. This module
//     publishes nothing itself for a gated run. It used to — while the read
//     client had no `decide`, Ship published around a checkpoint that stayed
//     parked forever — and a run left parked behind its own publication is a run
//     whose journal disagrees with the repository.
//   - **Don't ship decides `{ship: false, note}`**, which ends the run without a
//     receipt. The note is the one line a person typed, and it is on the durable
//     decision record rather than in a notice nobody can check afterwards.
//   - **Retry resumes one task** and **Stop cancels the run**, both by the same
//     client. Retry is offered only for a failure that NAMED a task, because
//     `resume` takes a task id and there is no such thing as resuming "the run".
//   - **The gate's inputs come from `checkpoint.inputs`**, asked for by name.
//
// `source: "service-provider"` on the decision record is pi-workflow's, not this
// caller's: it sets the field itself, so a decision that reached `decide` is
// recorded as having reached it from a host's own dialog. That is the whole of
// this seat's authority over the gate — evidence, not a licence — and publication
// downstream still proves the decided value rather than trusting the claim.

import type { ModeName } from "./mode.js";
import type { Plan, PlanGates } from "./plan.js";
import type { Publication } from "./publish.js";
import { SHIP_CHECKPOINT_KEY } from "./publish.js";
import {
	checkLine,
	dispositionCounts,
	type ReviewSectionInput,
	type ReviewTally,
	renderReviewSections,
	sectionsFromGateInputs,
	sectionsFromShipSummary,
	sumTallies,
	tallyLine,
	tallyReviews,
} from "./review-section.js";
import type { WorkflowReadClient } from "./workflow-provider.js";

// ── What each reader asks an inspection for ──────────────────────────────────

/**
 * The sections the ship dialog needs.
 *
 * `"checkpoints"` is what carries `tasks[].checkpoint.inputs` — the gate's own
 * verified input values, the same ones an artifact-backed view shows an approver.
 * It implies `"tasks"`, and asking for it reads the artifact store while still
 * taking no lease. Revision 22; before it, a lease-free inspection carried no
 * inputs at all and this dialog had to read task narrations instead.
 */
export const GATE_INSPECT_SECTIONS = {
	include: ["tasks", "checkpoints"],
} as const;

/**
 * The sections a `gates: "none"` run's account needs.
 *
 * `"output"` alone: `shipSummary` is on the run's committed output, and such a
 * run has no checkpoint to read inputs from.
 */
export const AUTO_INSPECT_SECTIONS = { include: ["run", "output"] } as const;

// ── The gate's inputs, as this module reads them ─────────────────────────────

/**
 * One deliverable, as the gate shows it: the implementer's latest summary, and
 * the Review section's two values — the `reviews-<d>` record and the last check.
 */
export interface GateDeliverable extends ReviewSectionInput {
	/** The implementer's own summary of what it did, latest first. */
	readonly summary?: string;
}

/**
 * Everything the ship dialog puts on screen.
 *
 * `taskKey` is what `decide` is called with, and it is read off the view rather
 * than assumed to be `ship`: a checkpoint inside a fan-out is
 * `<namespace>/<key>`, and pi-workflow refuses a key that names no awaiting
 * checkpoint rather than guessing which one was meant.
 */
export interface ShipGateView {
	readonly runId: string;
	readonly slug: string;
	/** `${namespace}/${key}` when the view names it; `ship` otherwise. */
	readonly taskKey: string;
	readonly deliverables: readonly GateDeliverable[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function at(value: unknown, ...path: readonly string[]): unknown {
	let current: unknown = value;
	for (const key of path) {
		if (!isRecord(current)) return undefined;
		current = current[key];
	}
	return current;
}

function array(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

/** The `ship` checkpoint task of an inspection, if it declared one. */
function shipTask(inspection: unknown): unknown {
	const tasks = at(inspection, "tasks") ?? at(inspection, "run", "tasks");
	return array(tasks).find(
		(task) =>
			at(task, "kind") === "checkpoint" &&
			text(at(task, "key")) === SHIP_CHECKPOINT_KEY,
	);
}

/**
 * The gate, from the verified input values `include: ["checkpoints"]` carries.
 *
 * ONE SOURCE. `tasks[].checkpoint.inputs` is the gate's own values — the same
 * ones the artifact-backed views show an approver: `summary-<d>`, `reviews-<d>`
 * and `check-<d>` per deliverable. The Review section's reader takes the last
 * two; the summary is the implementer's own sentence. It used to fall back to
 * each producing task's `narration.summary`; revision 22 carries the inputs, and
 * a fallback that stayed would be a second answer to "what did the gate show"
 * that nothing would ever exercise.
 *
 * `undefined` for a run that declares no `ship` checkpoint, which is every
 * `gates: "none"` run — those are read from `output.shipSummary` instead.
 */
export function readShipGate(
	inspection: unknown,
	runId: string,
	slug: string,
): ShipGateView | undefined {
	const task = shipTask(inspection);
	if (!task) return undefined;
	const taskKey =
		text(at(task, "taskKey")) ?? text(at(task, "key")) ?? SHIP_CHECKPOINT_KEY;
	const inputs = at(task, "checkpoint", "inputs");
	const source = isRecord(inputs) ? inputs : {};
	return {
		runId,
		slug,
		taskKey,
		deliverables: sectionsFromGateInputs(source).map((section) => {
			const summary = text(at(source, `summary-${section.id}`, "summary"));
			return { ...section, ...(summary ? { summary } : {}) };
		}),
	};
}

/**
 * What a `gates: "none"` run committed, read from `output.shipSummary`.
 *
 * pi-workflow puts exactly what the ship gate would have shown there — the
 * refined plan, and per deliverable the implementation summary, the review
 * record and the last check — so that a host which publishes without a gate can
 * still say what it published. Read into the SAME shape the gate is, so it
 * renders through the same functions.
 */
export function readShipSummary(
	inspection: unknown,
	runId: string,
	slug: string,
): ShipGateView | undefined {
	const summary =
		at(inspection, "run", "output", "shipSummary") ??
		at(inspection, "output", "shipSummary") ??
		at(inspection, "shipSummary");
	const entries = array(at(summary, "deliverables"));
	const sections = sectionsFromShipSummary(summary);
	if (sections.length === 0) return undefined;
	const deliverables = sections.map((section) => {
		const entry = entries.find(
			(candidate) => at(candidate, "id") === section.id,
		);
		const said = text(at(entry, "summary", "summary"));
		return { ...section, ...(said ? { summary: said } : {}) };
	});
	return { runId, slug, taskKey: SHIP_CHECKPOINT_KEY, deliverables };
}

/** Every deliverable's tally, summed: the counts the dialog's first line says. */
function totals(view: ShipGateView): ReviewTally {
	return sumTallies(
		view.deliverables.flatMap((deliverable) =>
			deliverable.reviews ? [tallyReviews(deliverable.reviews)] : [],
		),
	);
}

/**
 * The gate, as the person deciding it reads it.
 *
 * Pi's `select` carries no body, so what is being decided has to be in the
 * title — the same constraint `confirmationTitle` works under. So the title is
 * SHORT: per deliverable the implementer's summary, the review's counts and the
 * last check, and on top the dispositions across the run. Every finding, with
 * who raised it and how it was answered, is the Review section *Look first*
 * shows — the same section the pull request carries.
 */
export function renderShipGate(view: ShipGateView): string {
	const tally = totals(view);
	const lines = [
		`Ship \`${view.slug}\`?`,
		"",
		`Run \`${view.runId}\` is parked at its \`${view.taskKey}\` decision with ${view.deliverables.length} deliverable${view.deliverables.length === 1 ? "" : "s"}; ` +
			`${tally.clusters} review finding${tally.clusters === 1 ? "" : "s"}: ${dispositionCounts(tally)}.`,
	];
	for (const deliverable of view.deliverables) {
		lines.push("", `  ${deliverable.id}`);
		lines.push(`    ${deliverable.summary ?? "no implementation summary"}`);
		lines.push(
			deliverable.reviews
				? `    review: ${tallyLine(tallyReviews(deliverable.reviews))}`
				: "    review: no reviewers were asked",
		);
		lines.push(`    ${checkLine(deliverable.check)}`);
	}
	lines.push(
		"",
		tally.declined > 0
			? `${tally.declined === 1 ? "1 declined finding ships as it is" : `${tally.declined} declined findings ship as they are`}; Look first lists every finding with the implementer's reasoning.`
			: "Look first lists every finding, who raised it and how it was answered.",
	);
	return lines.join("\n");
}

/** The Review section of a gate or a ship summary: the shared rendering. */
export function renderGateReview(view: ShipGateView): string {
	return renderReviewSections(view.deliverables);
}

// ── Who answered ─────────────────────────────────────────────────────────────

/**
 * What the decision record names as the approver.
 *
 * `human:<via>` is pi-workflow's own convention and `via` names what asked, so a
 * journal read a month later says the ship dialog of a pi-maestro seat decided —
 * a different fact from `/workflow decide` typed at a prompt, and one worth being
 * able to tell apart. The runtime sets `source: "service-provider"` itself; this
 * is the part a caller is allowed to say.
 */
export const SHIP_DIALOG_APPROVER = "human:maestro-ship-dialog";

// ── The dialogs ──────────────────────────────────────────────────────────────

/**
 * One option of a `select`, and the two different jobs an option can have.
 *
 * The same shape `exit-flow.ts`'s `ExitOption` is, restated here rather than
 * imported because these tables are not part of that flow's counted sequence and
 * this module has no other reason to depend on it. The two jobs are `recommended`
 * — the answer a person most likely wants, first in the list and the only row
 * labelled `(default)` — and `escape`, which is what an unanswered dialog means
 * and is always the answer that commits to nothing.
 */
export interface DecideOption<T> {
	readonly value: T;
	readonly text: string;
	readonly recommended?: true;
	readonly escape?: true;
}

export const SHIP_YES = "Ship";
export const SHIP_NO = "Don't ship";
export const SHIP_LOOK = "Look first";

export type ShipAnswer = "ship" | "no" | "look";

/**
 * *Ship* is first because it is what usually follows a run that got this far: the
 * work is done, the findings are on screen and the residuals are named. Escape is
 * *Look first*, which loops — so escaping forever is a dialog nobody answered,
 * never a publication nobody asked for.
 */
export const SHIP_OPTIONS: readonly DecideOption<ShipAnswer>[] = [
	{ value: "ship", text: SHIP_YES, recommended: true },
	{ value: "no", text: SHIP_NO },
	{ value: "look", text: SHIP_LOOK, escape: true },
];

export const RETRY_TASK = "Retry the task";
export const STOP_RUN = "Stop the run";
export const REPLAN = "Re-plan";

export type FailureAnswer = "retry" | "stop" | "replan";

export const FAILURE_OPTIONS: readonly DecideOption<FailureAnswer>[] = [
	{ value: "retry", text: RETRY_TASK, recommended: true },
	{ value: "stop", text: STOP_RUN },
	{ value: "replan", text: REPLAN, escape: true },
];

export const PUBLISH_RETRY = "Retry publication";
export const PUBLISH_LEAVE = "Leave it";

export type PublishAnswer = "retry" | "leave";

export const PUBLISH_OPTIONS: readonly DecideOption<PublishAnswer>[] = [
	{ value: "retry", text: PUBLISH_RETRY, recommended: true },
	{ value: "leave", text: PUBLISH_LEAVE, escape: true },
];

/**
 * One `select` over an option table, and the table's escape on escape.
 *
 * The same discipline `exit-flow.ts`'s `ExitDialogs` keeps, taken as a port so
 * that these dialogs go through the seat's ONE dialog gate: Pi's dialogs have no
 * queue, and a ship dialog that lands on top of an open prompt is a promise that
 * never resolves.
 */
export interface DecideDialogs {
	choose<T>(title: string, options: readonly DecideOption<T>[]): Promise<T>;
	input(title: string, placeholder: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** The failure a dialog is offered about. */
export interface RunFailure {
	readonly runId: string;
	readonly slug: string;
	/** The task that failed, when one did; absent for a whole-run failure. */
	readonly taskId?: string;
	readonly stage?: string;
	readonly deliverable?: string;
	readonly cause: string;
}

/** The title of the failure dialog, which is the failure itself. */
export function renderFailure(failure: RunFailure): string {
	const what = failure.taskId
		? `${failure.stage ?? "a task"}${failure.deliverable ? ` of \`${failure.deliverable}\`` : ""}`
		: "the run";
	return [
		`\`${failure.slug}\` — ${what} failed. What now?`,
		"",
		failure.cause,
		"",
		`Run \`${failure.runId}\`. Retrying re-runs that one task; stopping cancels the run and leaves every handoff it already made; re-planning takes you back to plan mode with where this got to, so the conversation plans from here.`,
	].join("\n");
}

/** The state summary a re-plan carries into the conversation. */
export function replanMessage(failure: RunFailure): string {
	return [
		`Re-planning \`${failure.slug}\` after run \`${failure.runId}\` failed.`,
		"",
		failure.taskId
			? `What failed: ${failure.stage ?? "a task"}${failure.deliverable ? ` of deliverable \`${failure.deliverable}\`` : ""} (task \`${failure.taskId}\`).`
			: "The run itself failed, not one task of it.",
		`Cause: ${failure.cause}`,
		"",
		"The run is where it stopped and nothing was published. Plan from here:" +
			" say what to change about the plan, and leaving plan mode again forms and" +
			" starts the next run.",
	].join("\n");
}

/** What the model is told when a ship decision is waiting. */
export const SHIP_TURN_SENTENCE =
	"A decision is waiting in the dialog on screen — tell the person what the run" +
	" produced and what you would do about the findings that are left. There is no" +
	" command to type: they answer the dialog.";

/** What the conversation is told when a pull request was published. */
export function publishedMessage(
	slug: string,
	runId: string,
	publication: Publication,
	shipped?: ShipGateView,
): string {
	const where = publication.prUrl
		? `Pull request: ${publication.prUrl}`
		: `Branch \`${publication.branch}\` is pushed; no pull request was opened.`;
	return [
		`\`${slug}\` is published from run \`${runId}\`. ${where}`,
		// WHAT WAS PUBLISHED: the Review section, rendered exactly as *Look first*
		// renders it and as the pull request carries it. A run that shipped
		// without asking still owes a person the account a gate would have shown
		// them: a declined finding is the same finding whether or not anybody was
		// asked about it, and it reads differently after the fact only because
		// nothing can be changed about it now.
		...(shipped
			? [
					"",
					PUBLISHED_HEADING,
					"",
					...shipped.deliverables.map(
						(deliverable) =>
							`- \`${deliverable.id}\`: ${deliverable.summary ?? "no implementation summary"}`,
					),
					"",
					renderGateReview(shipped),
					"",
				]
			: [""]),
		"Tell the person what shipped and what is left to do, if anything.",
	].join("\n");
}

/** The heading the Review section gets when it is a receipt, not a question. */
export const PUBLISHED_HEADING = "What was published:";

/** Everything the decisions need and cannot build themselves. */
export interface DecideDeps {
	readonly dialogs: DecideDialogs;
	/**
	 * The acquired workflow client.
	 *
	 * Four methods, and every one of them carries an answer a person gave:
	 * `inspect` reads the gate, `decide` records the ship answer, `resume` retries
	 * one task and `stop` cancels the run. All four are in `CLIENT_METHODS`, so a
	 * runtime missing one is refused at discovery rather than found missing inside a
	 * dialog that has nothing else to offer.
	 */
	readonly client: Pick<
		WorkflowReadClient,
		"inspect" | "decide" | "resume" | "stop"
	>;
	/**
	 * Publish this plan's run. The seat's own `publish`, narrowed.
	 *
	 * ONLY `autoPublish` CALLS IT. A gated run publishes down the announcement path
	 * after the run completes, exactly as a widget decision does.
	 */
	readonly publish: (
		plan: Plan,
		runId: string,
	) => Promise<Publication | undefined>;
	/** The stored plan for a run, by slug. */
	readonly plan: (slug: string) => Plan | undefined;
	/** One custom message into the conversation, with a turn. */
	readonly say: (content: string) => void;
	/** Switch the session's posture; re-planning uses it. */
	readonly setMode?: (name: ModeName) => void;
	/** Where a person is sent to look at a run, when they ask to look first. */
	readonly inspector?: (runId: string) => void;
}

/**
 * What one ship dialog did.
 *
 * `decided` and not `published`: the dialog writes the checkpoint and the run
 * takes it from there. Publication follows the run's completion, down the
 * announcement path, which re-proves the decision from the journal — so the
 * dialog's job is over the moment the decision is durable.
 */
export type ShipOutcome =
	| { readonly kind: "decided" }
	| { readonly kind: "declined"; readonly reason: string }
	| { readonly kind: "refused"; readonly problem: string };

/**
 * *Look first*: the Review section, then where the rest of the run is.
 *
 * The section is the same text the pull request will carry — every finding,
 * who raised it, how many agreed and what the implementer answered, declines
 * named — so what a person reads before deciding is what reviewers of the pull
 * request read after. pi-workflow owns the inspector and this seat has no handle
 * on it, so the notice names the command that opens it, and the dialog comes
 * straight back so the decision is not lost.
 */
export function lookFirstNotice(view: ShipGateView): string {
	const review = renderGateReview(view);
	return [
		...(review.length > 0 ? [review, ""] : []),
		`Run \`${view.runId}\` is in \`/workflow ${view.runId.slice(0, 8)}\` — its tasks, its` +
			" journal and every artifact it wrote. The ship dialog is open again behind" +
			" this notice, so answer it when you have looked.",
	].join("\n");
}

/**
 * The ship dialog, and what each answer does.
 *
 * *Look first* loops rather than returning: the decision is not made by going to
 * look at the run, and a dialog that closed on the way to the inspector would be
 * a decision lost to an escape key.
 */
export async function askShip(
	deps: DecideDeps,
	view: ShipGateView,
): Promise<ShipOutcome> {
	/** `decide`, with the runtime's own refusal reported rather than thrown. */
	const record = async (
		decision: unknown,
		reason?: string,
	): Promise<string | undefined> => {
		try {
			await deps.client.decide(view.runId, view.taskKey, {
				decision,
				approver: SHIP_DIALOG_APPROVER,
				...(reason ? { reason } : {}),
			});
			return undefined;
		} catch (error) {
			// The runtime's own sentence, sanitized by it: a key that names no
			// awaiting checkpoint, a value its schema refuses, a run that moved on.
			// Better than one this seat could write, and the decision did not happen.
			return error instanceof Error ? error.message : String(error);
		}
	};

	for (;;) {
		const answer = await deps.dialogs.choose(
			renderShipGate(view),
			SHIP_OPTIONS,
		);
		if (answer === "look") {
			deps.dialogs.notify(lookFirstNotice(view), "info");
			deps.inspector?.(view.runId);
			continue;
		}
		if (answer === "no") {
			const typed = await deps.dialogs.input(
				`Why is \`${view.slug}\` not shipping?`,
				"one line, recorded with the decision",
			);
			const reason = (typed ?? "").trim() || "no reason given";
			const failed = await record({ ship: false, note: reason }, reason);
			if (failed) {
				const problem = `\`${view.slug}\` was not recorded as not shipping: ${failed} Nothing about the run changed, and the reason you typed was: ${reason}`;
				deps.dialogs.notify(problem, "warning");
				return { kind: "refused", problem };
			}
			deps.dialogs.notify(
				`\`${view.slug}\` is not shipping: ${reason}. The decision is on the run's record and nothing is published.`,
				"info",
			);
			return { kind: "declined", reason };
		}
		// Ship. THE DECISION IS THE WHOLE ACT. The checkpoint is written, the run
		// un-parks and finishes, and publication follows its completion down the
		// same path a decision made in pi-workflow's own widget takes — which
		// re-proves `{"ship": true}` from the journal rather than from this dialog.
		const failed = await record({ ship: true });
		if (failed) {
			const problem = `\`${view.slug}\` was not recorded as shipping: ${failed} Nothing is published and the gate is where it was — \`/workflow ${view.runId.slice(0, 8)}\` has it.`;
			deps.dialogs.notify(problem, "warning");
			return { kind: "refused", problem };
		}
		deps.dialogs.notify(
			`\`${view.slug}\` is shipping: the \`${view.taskKey}\` decision is on run \`${view.runId}\`'s record. The run finishes and this seat publishes from its receipt.`,
			"info",
		);
		return { kind: "decided" };
	}
}

/** What one auto publication did. */
export type AutoOutcome =
	| { readonly kind: "published"; readonly publication: Publication }
	| { readonly kind: "left"; readonly reason: string }
	| { readonly kind: "skipped"; readonly why: string };

/**
 * A `gates: "none"` run completed, so publish it.
 *
 * NO QUESTION IS ASKED FIRST. The approval was given when the person answered
 * `Start the run?` from auto, and the confirmation said in as many words that
 * this is what it meant. The only dialog here is the one a FAILED publication
 * earns, because a failure is new information and "retry" is a decision.
 */
export async function autoPublish(
	deps: DecideDeps,
	runId: string,
	slug: string,
	gates: PlanGates,
): Promise<AutoOutcome> {
	if (gates !== "none")
		return {
			kind: "skipped",
			why: `plan \`${slug}\` is gated \`${gates}\`, so its ship decision is asked rather than assumed`,
		};
	const plan = deps.plan(slug);
	if (!plan) {
		const why = `no stored plan \`${slug}\` in this project, so there is nothing to publish run \`${runId}\` against`;
		deps.dialogs.notify(
			`Run \`${runId}\` completed and ${why}. Its handoff refs are in \`/workflow ${runId.slice(0, 8)}\`.`,
			"warning",
		);
		return { kind: "skipped", why };
	}
	// READ BEFORE PUBLISHING, so a failed publication is not also a lost account:
	// `output.shipSummary` is on the terminal run and does not change, and a run
	// whose inspection cannot be read still publishes — it just says less.
	let shipped: ShipGateView | undefined;
	try {
		shipped = readShipSummary(
			await deps.client.inspect(runId, AUTO_INSPECT_SECTIONS),
			runId,
			slug,
		);
	} catch {
		// The account is a courtesy; the receipt publication reads is its own call.
		shipped = undefined;
	}
	for (;;) {
		const publication = await deps.publish(plan, runId);
		if (publication?.ok) {
			deps.say(publishedMessage(slug, runId, publication, shipped));
			return { kind: "published", publication };
		}
		const reason =
			publication?.reason ??
			`publication of \`${slug}\` could not be started from run \`${runId}\``;
		const answer = await deps.dialogs.choose(
			[
				`\`${slug}\` did not publish. Retry?`,
				"",
				reason,
				"",
				publication?.branch
					? `The branch \`${publication.branch}\` is in place in the working tree, so nothing is lost either way.`
					: "Nothing was pushed.",
			].join("\n"),
			PUBLISH_OPTIONS,
		);
		if (answer === "leave") {
			deps.dialogs.notify(
				`\`${slug}\` is not published. \`/plan ship ${slug}\` tries again whenever you like.`,
				"info",
			);
			return { kind: "left", reason };
		}
	}
}

/** What one failure dialog did. */
export type FailureOutcome =
	| { readonly kind: "retried" }
	| { readonly kind: "stopped" }
	| { readonly kind: "replanned" }
	| { readonly kind: "refused"; readonly problem: string };

/**
 * A task or a run failed, offered as three answers.
 *
 * *Re-plan* is the escape, and it is the one answer that always works: it needs
 * nothing of the runtime, because it is about this conversation. That is also why
 * it is the escape rather than *Stop*: an unanswered dialog must commit to
 * nothing, and cancelling somebody's run is a commitment.
 */
export async function askFailure(
	deps: DecideDeps,
	failure: RunFailure,
): Promise<FailureOutcome> {
	const answer = await deps.dialogs.choose(
		renderFailure(failure),
		FAILURE_OPTIONS,
	);
	if (answer === "retry") {
		// `resume` RE-ATTEMPTS ONE TASK, so there has to be one. A run-level failure
		// names none, and there is no such thing as resuming "the run" — refusing by
		// name beats resuming whatever task happened to be last.
		if (!failure.taskId) {
			const problem = `Run \`${failure.runId}\` failed as a whole rather than at one task, and a retry re-attempts one task. \`/workflow ${failure.runId.slice(0, 8)}\` shows which of its tasks can be re-attempted.`;
			deps.dialogs.notify(problem, "warning");
			return { kind: "refused", problem };
		}
		const taskId = failure.taskId;
		try {
			await deps.client.resume(failure.runId, { taskId });
		} catch (error) {
			// The runtime's own refusal, verbatim — `WORKFLOW_NOT_RESUMABLE` for a
			// task it cannot re-attempt. Its sentence, because it is the one that
			// knows why.
			const problem = `\`${taskId}\` was not retried: ${error instanceof Error ? error.message : String(error)}`;
			deps.dialogs.notify(problem, "warning");
			return { kind: "refused", problem };
		}
		deps.dialogs.notify(
			`Retrying \`${taskId}\` of run \`${failure.runId}\` on its existing subagent run; its dependents are untouched. This session goes on narrating it.`,
			"info",
		);
		return { kind: "retried" };
	}
	if (answer === "stop") {
		try {
			await deps.client.stop(failure.runId);
		} catch (error) {
			const problem = `Run \`${failure.runId}\` was not cancelled: ${error instanceof Error ? error.message : String(error)}`;
			deps.dialogs.notify(problem, "warning");
			return { kind: "refused", problem };
		}
		deps.dialogs.notify(
			`Run \`${failure.runId}\` is cancelled. Every handoff it already made is still in the repository's object store — the runtime never applies one — and \`/workflow ${failure.runId.slice(0, 8)}\` names them.`,
			"info",
		);
		return { kind: "stopped" };
	}
	// Re-plan: the posture goes back to plan and the conversation is handed where
	// the run got to, so the next plan is written from it rather than from memory.
	deps.setMode?.("plan");
	deps.say(replanMessage(failure));
	deps.dialogs.notify(
		`Mode plan. The conversation has where \`${failure.slug}\` got to; plan the next run from it and leave plan mode again when you are ready.`,
		"info",
	);
	return { kind: "replanned" };
}

// ── `plan_ship_dialog` ───────────────────────────────────────────────────────

export const SHIP_DIALOG_TOOL = "plan_ship_dialog";

/**
 * What the tool says when nothing is parked.
 *
 * REFUSED BY NAME rather than opening an empty dialog. The tool exists so that
 * "ship it" in the conversation reaches the same dialog the gate opens; a session
 * with no parked run has nothing to ship, and a dialog asking about nothing is
 * worse than a sentence saying so.
 */
export const NOTHING_PARKED =
	"No run of this session is parked at a ship decision, so there is no ship dialog to open." +
	" A run started from `/mode ask` opens this dialog itself when it reaches its gate;" +
	" a run started from `/mode auto` publishes without one; and `/plan ship <slug>` is" +
	" the manual fallback for a run that finished earlier.";

/** What the tool says when it opened the dialog. */
export function openedDialog(slug: string, runId: string): string {
	return (
		`The ship dialog for \`${slug}\` (run \`${runId}\`) is open on screen, with the gate's` +
		" inputs in it. The person answers it; you decide nothing here. Tell them what" +
		" the run produced while they read it."
	);
}

/**
 * The dialog primitives, taken as Pi's `select`/`input`/`notify` behind the
 * seat's ONE dialog gate.
 *
 * Built here rather than reused from `exit-flow.ts` because these dialogs are not
 * part of a counted sequence: the exit's `ExitDialogs` counts what it asked, so
 * that "the hand-off asks exactly one dialog" is a test. A ship dialog asks once
 * per gate and there is nothing to count.
 */
export function createDecideDialogs(
	ui: {
		select(
			title: string,
			options: string[],
			opts?: unknown,
		): Promise<string | undefined>;
		input(
			title: string,
			placeholder: string,
			opts?: unknown,
		): Promise<string | undefined>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	},
	gate?: { quiet(signal?: AbortSignal): Promise<void> },
): DecideDialogs {
	const label = (option: {
		readonly text: string;
		readonly recommended?: true;
	}): string => (option.recommended ? `${option.text} (default)` : option.text);
	return {
		notify: (message, type) => ui.notify(message, type),
		choose: async (title, options) => {
			await gate?.quiet();
			const chosen = await ui.select(title, options.map(label));
			const hatch = options.find((option) => option.escape);
			if (!hatch)
				throw new Error("a decide option table needs exactly one escape");
			if (chosen === undefined) return hatch.value;
			return (options.find((option) => label(option) === chosen) ?? hatch)
				.value;
		},
		input: async (title, placeholder) => {
			await gate?.quiet();
			return ui.input(title, placeholder);
		},
	};
}

/** The custom message's type, in the one place it exists. */
export const DECISION_MESSAGE_TYPE = "maestro:decision";

/**
 * `plan_ship_dialog`: what "ship it" in the conversation reaches.
 *
 * IT DECIDES NOTHING. The tool opens the same dialog the gate opens and returns;
 * the person answers it. That is the whole design: a model asked to ship
 * something must not be able to ship it, and the honest way to honour "ship it"
 * is to put the decision in front of the person who said it, with the gate's
 * inputs on screen.
 *
 * Its `available` predicate is the moving half of the same rule — a run of THIS
 * session parked at a ship decision — read at call time through
 * `ToolRegistry`'s own `available`, so the tool is simply not offered when there
 * is nothing to ship, and `NOTHING_PARKED` is what a model that called it anyway
 * is told.
 */
export interface ShipDialogTool {
	/** Is a run of this session parked at a ship decision right now? */
	readonly parked: () => boolean;
	/** Open the dialog for whatever is parked. The slug and run, or nothing. */
	readonly open: () => Promise<
		{ readonly slug: string; readonly runId: string } | undefined
	>;
}
