// The hand-off: leaving plan mode is how a conversation becomes a run.
//
// THE PLAN LIVES IN THE CONVERSATION. In plan mode the model writes it and
// revises it as an ordinary message — deliverables, work tasks, reviews,
// dependencies — the way anybody plans anything with anybody. Nothing about
// plan mode says how a plan is executed; the modes are permission dials and
// only that. `/mode auto` or `/mode hack` is the TRIGGER: it says the planning
// is over, and this file is everything that happens between that sentence and a
// run.
//
// It is one async controller, started from `/mode`, and it is one function you
// can read top to bottom:
//
//   1. **The effort dial.** The one question a repository cannot answer. The
//      gates take their default and publication is DERIVED from the repository.
//   2. **The description and the document**, requested directly from the model
//      through `authoring.ts` — an ordinary completion, outside the agent loop,
//      with the session's own history and no tools at all — and validated with
//      retries. The plan as written in the conversation becomes the v5 document.
//   3. **The plan check** (`plan-check.ts`): one fresh-context read of the
//      stored plan. THE HARNESS ACTS ON THE FINDINGS ITSELF — a blocking
//      finding goes back to the same mini-conversation and the document is
//      rewritten, silently, twice at most.
//   4. **One confirmation.** The description to agree, the plan summary, and
//      what the check said. `Start the run` is the default, and starting it is
//      the approval.
//
// ONE CONFIRMATION, AND AT MOST ONE OTHER DIALOG. The separate description
// dialog, the compiled-document dialog, the blind-review dialog, the findings
// walk and the revise dialogs are gone, and with them the compiled stage
// document this file used to mirror. The only dialog besides the effort dial
// and the confirmation is the one the check can raise: a finding the reviewer
// marked as needing a person, or a bound spent with something still blocking.
//
// THE MODE DOES NOT MOVE UNTIL SOMETHING IS SETTLED. The seat stays in plan
// mode for the whole hand-off; `setMode` is called on exactly three answers —
// the run started, *Just switch, keep the plan stored*, and the one case where
// this flow has nothing to offer at all (no plan in the conversation, so no
// document), which switches WITH THE REASON SHOWN rather than hanging.
//
// NOTHING IS ON DISK BETWEEN THE STEPS. There is no pending record, because
// there is nothing to join: the flow never yields to a model turn. A session
// that dies mid-hand-off simply has no hand-off — which is what a person would
// say happened.
//
// Two rules shape everything else here:
//
//   - **NOTHING IS ASKED TWICE AND NOTHING IS ASSUMED SILENTLY.** Each dialog
//     is asked once, and the answers are attached to the plan as its `policy` —
//     on the document, where a check and a receipt can both see them — rather
//     than in a dialog transcript nobody can check afterwards. The model never
//     writes them: the plan schema has no `policy` field. Every option table
//     names both of the two different jobs an option has: `recommended` is the
//     answer a person most likely wants and is the only row labelled
//     `(default)`; `escape` is what an unanswered dialog means, and it is
//     always the answer that commits to nothing.
//   - **THE CONVERSATION LEARNS THE OUTCOME AND NOTHING ELSE.** One custom
//     message per hand-off says what was stored and what happened to it. The
//     requests, the retries, the check's findings and the validators'
//     complaints are not steers and do not appear in the transcript; they are
//     on the record in `authoring.json`, beside the plan.
//
// IO is the injected `ExitFlowUi` port, structurally Pi's `ExtensionUIContext`,
// so a test drives every branch with a fake and this module never reaches for a
// terminal. Every dialog carries the abort signal, so a session replacement
// ends the flow rather than leaving a dialog open over a session that is gone.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@vegardx/pi-models";
import {
	type AuthoringAttempt,
	type AuthoringAttemptKind,
	type AuthoringComplete,
	type AuthoringMessage,
	authoringThinking,
	CONTEXT_LIMIT_PERCENT,
	DESCRIPTION_REQUEST,
	DESCRIPTION_SYSTEM_PROMPT,
	DOCUMENT_REQUEST,
	descriptionProblem,
	MAX_AUTHORING_ATTEMPTS,
	MAX_DESCRIPTION_LENGTH,
	PROVIDER_FAILURE_PROBLEM,
	parseDocument,
	renderDocumentSystemPrompt,
	responseDigest,
	writeAuthoringEvidence,
} from "./authoring.js";
import type { ExitMode, ModeName } from "./mode.js";
import {
	DEFAULT_GATES,
	gateStops,
	ID_RE,
	inspectPlan,
	isRefName,
	type Plan,
	type PlanPolicy,
	type PlanReport,
	type PublishMode,
	type Review,
	resolvePolicy,
	withExplicitDiverse,
} from "./plan.js";
import {
	isPlanCheckUnavailable,
	MAX_PLAN_CHECK_REVISIONS,
	type PlanCheck,
	type PlanCheckFinding,
	type PlanCheckResult,
	type PlanCheckUnavailable,
	planCheckDecision,
	renderPlanCheckFindings,
	renderPlanCheckLine,
	renderPlanCheckSteer,
	severityCounts,
	unavailablePlanCheck,
} from "./plan-check.js";
import { PLAN_WORKFLOW_REF } from "./plan-command.js";
import {
	authoredPlanProblems,
	planFrom,
	withoutEmptyOptionals,
} from "./plan-document.js";
import {
	DEFAULT_EFFORT,
	EFFORTS,
	type Effort,
	planDigest,
	toWorkflowInput,
} from "./plan-input.js";
import { ghOnPath } from "./publish.js";
import type { PlanStore } from "./store.js";
import { callWorkflow, type WorkflowReadClient } from "./workflow-provider.js";

/**
 * The dialog primitives the hand-off uses, structurally Pi's
 * `ExtensionUIContext`.
 */
export type ExitFlowUi = Pick<
	ExtensionUIContext,
	"select" | "input" | "confirm" | "editor" | "notify"
>;

/** What the `/mode` handler is told to do once the hook has run. */
export type ModeExitDecision =
	/** Switch and report it, the way `/mode` always has. */
	| "switch"
	/** Leave the posture alone; the hook has already said why. */
	| "stay"
	/** The hook switched the posture itself, in its own order. */
	| "settled";

/**
 * The `/mode` seam, straddling the posture change.
 *
 * Returning nothing means `switch`: a hook that says nothing does not
 * interfere, which is what the empty seam did before this module existed.
 */
export type ModeExitHook = (
	previous: ModeName,
	next: ModeName,
	ctx: ModeExitContext,
) => ModeExitAnswer | Promise<ModeExitAnswer>;

/** A decision, or nothing — which is `switch`. */
export type ModeExitAnswer = ModeExitDecision | undefined;

/** The seam this file replaced: no dialogs, no request, an ordinary switch. */
export const beginModeExit: ModeExitHook = () => "switch";

/**
 * Structurally an `ExtensionCommandContext`; only these are read.
 *
 * `model`, `modelRegistry` and `sessionManager` are what the harness asks the
 * model WITH, and `getContextUsage` is what says whether asking at all is
 * honest. Declared as one narrow port so a test hands over an object rather
 * than a session.
 */
export interface ModeExitContext {
	readonly ui: ExitFlowUi;
	/** Dialog-capable UI. A session without one cannot be asked anything. */
	readonly hasUI?: boolean;
	readonly getContextUsage?: () => ContextUsageView | undefined;
	readonly thinkingLevel?: ThinkingLevel;
	readonly model?: { readonly id: string } | undefined;
}

/** `ContextUsage`, as this module reads one. */
export interface ContextUsageView {
	readonly tokens: number | null;
	readonly contextWindow: number;
	readonly percent: number | null;
}

// ── The option tables ────────────────────────────────────────────────────────

/**
 * One option of a `select`, and the two different jobs an option can have.
 *
 * THESE ARE NOT THE SAME QUESTION, and collapsing them into one `fallback` flag
 * was a real defect: it forced the most likely answer and the safe answer to be
 * the same row, so every table had to give one of them up. *Start the run* is
 * what the person who typed `/mode auto` after a planning conversation almost
 * always wants; starting a run because they pressed escape is a commitment
 * nobody made.
 *
 *   - `recommended` — the action the person most likely wants. Exactly one per
 *     table, it MUST be first, and it is the row that carries `(default)`. It
 *     is a suggestion about ordering and highlighting, and nothing else.
 *   - `escape` — what an unanswered dialog means. Exactly one per table, and
 *     it is always the safe way out: escaping never commits to anything. It
 *     may be the same entry as `recommended` only where escaping is harmless —
 *     the effort dial, where every answer is equally reversible.
 *
 * Both live on the option rather than beside the list, so the label a human
 * reads and the value an escape produces cannot drift apart.
 */
export interface ExitOption<T> {
	readonly value: T;
	readonly text: string;
	/** The likely answer: first in the list, and the one labelled `(default)`. */
	readonly recommended?: true;
	/** What escape means. Never a commitment. */
	readonly escape?: true;
}

export function optionLabel<T>(option: ExitOption<T>): string {
	return option.recommended ? `${option.text} (default)` : option.text;
}

export function optionLabels<T>(options: readonly ExitOption<T>[]): string[] {
	return options.map(optionLabel);
}

/**
 * The chosen value, or the table's ESCAPE when nothing was chosen.
 *
 * An unrecognised label takes the escape too, and for the same reason: a label
 * this table cannot resolve is not evidence that anybody picked anything, and
 * resolving it to the recommended row would turn a dialog nobody answered into
 * a decision somebody is held to.
 */
export function chosenOption<T>(
	options: readonly ExitOption<T>[],
	label: string | undefined,
): T {
	const hatch = options.find((option) => option.escape);
	if (!hatch)
		throw new Error("an exit-flow option table needs exactly one escape");
	if (label === undefined) return hatch.value;
	return (options.find((option) => optionLabel(option) === label) ?? hatch)
		.value;
}

/**
 * The three efforts, the recommended one first.
 *
 * Derived from `EFFORTS` rather than written out, so a fourth effort cannot be
 * added to the schema without appearing here. This is the one table whose
 * escape IS its recommendation: every answer here is a dial on the same run and
 * none of them commits to anything, so escaping to `standard` takes nothing
 * away that the confirmation does not still gate.
 */
export const EFFORT_OPTIONS: readonly ExitOption<Effort>[] = [
	{
		value: DEFAULT_EFFORT,
		text: DEFAULT_EFFORT,
		recommended: true as const,
		escape: true as const,
	},
	...EFFORTS.filter((effort) => effort !== DEFAULT_EFFORT).map((effort) => ({
		value: effort,
		text: effort,
	})),
];

export const EFFORT_TITLE = "How much effort should the run spend?";

// ── Publication, derived ─────────────────────────────────────────────────────

/** When the repository cannot say what it tracks, and the human is told. */
export const FALLBACK_BASE_BRANCH = "main";

/**
 * The repository's current upstream head, or `null`.
 *
 * One `execFileSync`, every failure the same answer, because a caller cannot
 * act differently on "no upstream", "not a repository" and "no git at all" —
 * all three mean the derivation has to fall back. The tracked branch first,
 * then whatever `origin` calls its head, because a detached or unpushed branch
 * still publishes onto the default.
 */
export function gitUpstreamHead(cwd: string): string | null {
	const git = (args: string[]): string | null => {
		try {
			return execFileSync("git", args, {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			return null;
		}
	};
	const strip = (ref: string | null): string | null => {
		if (!ref) return null;
		const short = ref.includes("/") ? ref.slice(ref.indexOf("/") + 1) : ref;
		return isRefName(short) ? short : null;
	};
	return (
		strip(git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])) ??
		strip(git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))
	);
}

/** Does this repository have an `origin` remote? Same shape, same reasons. */
export function gitOriginPresent(cwd: string): boolean {
	try {
		return execFileSync("git", ["remote"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		})
			.split("\n")
			.map((line) => line.trim())
			.includes("origin");
	} catch {
		return false;
	}
}

/** What the derivation reads. Injected so a test needs no repository. */
export interface PublicationProbe {
	readonly originPresent: () => boolean;
	readonly ghPresent: () => boolean;
	readonly upstreamHead: () => string | null;
}

export interface DerivedPublication {
	readonly mode: PublishMode;
	/** The upstream head, else `main`. Recorded only when something publishes. */
	readonly base: string;
	/** One sentence naming what was found and what follows from it. */
	readonly why: string;
}

/**
 * Where the work goes, read off the repository rather than asked.
 *
 * This used to be two dialogs, and both of them asked a human to repeat what
 * the machine already knew: `gh repo create` is not going to happen without
 * `gh`, and a push has nowhere to go without a remote. So the rule is the
 * machine's own: an `origin` remote and `gh` on PATH means a pull request, a
 * remote alone means a branch, neither means the work stays here. It is
 * ANNOUNCED rather than silent — the confirmation carries this sentence — and
 * `policy.publish` on the plan is where it can still be changed.
 *
 * PUBLICATION NEVER SITS INSIDE A CEILING. The mode's ceiling bounds what a
 * delegated attempt may do; pushing is pi-maestro's own act, under its own
 * audited Bash policy, authorized by a durable human decision.
 */
export function derivePublication(probe: PublicationProbe): DerivedPublication {
	const base = probe.upstreamHead() ?? FALLBACK_BASE_BRANCH;
	const origin = probe.originPresent();
	const gh = origin && probe.ghPresent();
	const mode: PublishMode = !origin ? "none" : gh ? "pr" : "branch";
	const why =
		mode === "pr"
			? `Publication: pull request onto \`${base}\` — this repository has an \`origin\` remote and \`gh\` is on PATH.`
			: mode === "branch"
				? `Publication: branch onto \`${base}\` — this repository has an \`origin\` remote, and \`gh\` is not on PATH to open a pull request with.`
				: "Publication: none — this repository has no `origin` remote, so what a run produces stays on this machine.";
	return { mode, base, why };
}

/** The `policy.publish` block a derivation becomes. */
export function publicationPolicy(
	derived: DerivedPublication,
): NonNullable<PlanPolicy["publish"]> {
	return derived.mode === "none"
		? { mode: "none" }
		: { mode: derived.mode, base: derived.base };
}

/** The real world's derivation, for a caller that injected none. */
const DEFAULT_PUBLICATION = (): DerivedPublication =>
	derivePublication({
		originPresent: () => gitOriginPresent(process.cwd()),
		ghPresent: ghOnPath,
		upstreamHead: () => gitUpstreamHead(process.cwd()),
	});

// ── The context guard ────────────────────────────────────────────────────────

/** What a person is told when the session has no room left to plan in. */
export function contextGuardNotice(
	usage: ContextUsageView,
	wanted: ExitMode,
): string {
	const percent = usage.percent ?? 0;
	return (
		`This session is using ${Math.round(percent)}% of the model's ${usage.contextWindow.toLocaleString("en-US")}-token context window, past the ${CONTEXT_LIMIT_PERCENT}% this hand-off will ask for a plan at.` +
		" Asking now would spend a request on a document that would be truncated." +
		` Run \`/compact\`, then \`/mode ${wanted}\` again. Nothing changed and you are still in plan mode.`
	);
}

/** Is the session too full to be asked for a plan? */
export function contextExhausted(usage: ContextUsageView | undefined): boolean {
	return usage?.percent !== undefined && usage.percent !== null
		? usage.percent > CONTEXT_LIMIT_PERCENT
		: false;
}

// ── The dialog port ──────────────────────────────────────────────────────────

/**
 * A prompt opened by Pi or another extension, and the deferral it forces.
 *
 * Pi's dialogs have no queue: opening one over another replaces it and the
 * replaced promise never resolves. `parked-observer.ts` in `@vegardx/pi-workflow`
 * solves this by counting `ui_prompt_start`/`ui_prompt_end` and deferring; the
 * hand-off does the same, through this gate, so one of its dialogs never lands
 * on top of somebody else's.
 */
export interface DialogGate {
	/** A foreign prompt opened. */
	promptStart(): void;
	/** A foreign prompt closed. */
	promptEnd(): void;
	/** How many foreign prompts are outstanding. */
	open(): number;
	/** Resolves once nothing foreign is on screen, or once `signal` aborts. */
	quiet(signal?: AbortSignal): Promise<void>;
}

export function createDialogGate(): DialogGate {
	let open = 0;
	let waiting: (() => void)[] = [];
	const release = (): void => {
		const waiters = waiting;
		waiting = [];
		for (const resolve of waiters) resolve();
	};
	return {
		open: () => open,
		promptStart: () => {
			open += 1;
		},
		promptEnd: () => {
			if (open > 0) open -= 1;
			if (open === 0) release();
		},
		quiet: async (signal) => {
			while (open > 0 && !signal?.aborted) {
				await new Promise<void>((resolve) => {
					waiting.push(resolve);
					// An abort has to release the waiter too, or a replaced session
					// would leave this flow parked behind a prompt nobody will close.
					signal?.addEventListener("abort", () => resolve(), { once: true });
				});
			}
		},
	};
}

/** Internal control flow for "the session went away while a dialog was open". */
class ExitAborted extends Error {}

/**
 * Every dialog the hand-off opens, through one door.
 *
 * The door is what makes the discipline rules true everywhere instead of at
 * each call site: the abort signal is carried (and believed over an
 * escape-shaped resolution), foreign prompts defer, and the dialogs are
 * counted — which is how "the hand-off asks exactly two dialogs" is a test
 * rather than a claim.
 */
export interface ExitDialogs {
	/** A `select` over an option table, returning the table's escape on escape. */
	choose<T>(title: string, options: readonly ExitOption<T>[]): Promise<T>;
	input(title: string, placeholder: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	/** Pi's `editor` takes no dialog options, so the signal is checked around it. */
	editor(title: string, prefill: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	/** How many dialogs have been opened. */
	asked(): number;
}

export interface ExitDialogOptions {
	readonly signal?: AbortSignal;
	readonly gate?: DialogGate;
}

export function createExitDialogs(
	ui: ExitFlowUi,
	options: ExitDialogOptions = {},
): ExitDialogs {
	const { signal, gate } = options;
	let asked = 0;
	const opts = signal ? { signal } : undefined;
	const around = async <T>(open: () => Promise<T>): Promise<T> => {
		if (signal?.aborted) throw new ExitAborted();
		await gate?.quiet(signal);
		if (signal?.aborted) throw new ExitAborted();
		asked += 1;
		const answer = await open();
		// An aborted dialog resolves exactly like an escaped one, and the two
		// mean opposite things, so the signal is what is believed.
		if (signal?.aborted) throw new ExitAborted();
		return answer;
	};
	return {
		asked: () => asked,
		notify: (message, type) => ui.notify(message, type),
		choose: <T>(title: string, table: readonly ExitOption<T>[]): Promise<T> =>
			around(() => ui.select(title, optionLabels(table), opts)).then((label) =>
				chosenOption(table, label),
			),
		input: (title, placeholder) =>
			around(() => ui.input(title, placeholder, opts)),
		confirm: (title, message) => around(() => ui.confirm(title, message, opts)),
		editor: (title, prefill) => around(() => ui.editor(title, prefill)),
	};
}

// ── The one dialog the check can raise ───────────────────────────────────────

export const CHECK_PROCEED = "Proceed anyway";
export const CHECK_KEEP_PLANNING = "Keep planning";

export type CheckAnswer = "proceed" | "keep";

/**
 * What to do about findings a rewrite will not answer.
 *
 * *Proceed anyway* is first because it is what usually follows: the plan is
 * stored, the finding is on screen in full, and the run stops at its gates
 * anyway. Escape is *Keep planning*, which is the answer that commits to
 * nothing — the whole reason this dialog exists is that the finding needs a
 * decision, and a decision nobody made is not one.
 */
export const CHECK_OPTIONS: readonly ExitOption<CheckAnswer>[] = [
	{ value: "proceed", text: CHECK_PROCEED, recommended: true },
	{ value: "keep", text: CHECK_KEEP_PLANNING, escape: true },
];

/**
 * The dialog's title, which is the findings themselves.
 *
 * Pi's `select` carries no body, and what is being decided has to be on screen
 * at the moment of deciding.
 */
export function checkDialogTitle(
	findings: readonly PlanCheckFinding[],
	exhausted: boolean,
): string {
	const rewrites: number = MAX_PLAN_CHECK_REVISIONS;
	const heading = exhausted
		? `The plan check still blocks after ${rewrites} rewrite${rewrites === 1 ? "" : "s"}, and that is the last one this hand-off is worth:`
		: "The plan check found something only you can answer:";
	return renderPlanCheckFindings(findings, heading);
}

// ── The one confirmation ─────────────────────────────────────────────────────

export const START_RUN = "Start the run";
export const START_EDIT = "Edit the description";
export const START_SWITCH = "Just switch, keep the plan stored";
export const START_KEEP_PLANNING = "Keep planning";
export const DESCRIPTION_EDITOR_TITLE = "What we are doing, and why";

export type StartAnswer = "start" | "edit" | "switch" | "keep";

/**
 * The only question that starts anything.
 *
 * *Start the run* is first: the document came out of this conversation, the
 * check has read it, and starting it is what somebody who typed `/mode auto`
 * after planning almost always wants. It is NOT what escape takes. Starting a
 * run IS the approval — there is no `approve-plan` checkpoint behind it — and
 * an approval obtained by not answering is not one, so escape is *Keep
 * planning*, the one answer that changes nothing at all.
 *
 * *Edit the description* returns to this same confirmation rather than going
 * anywhere: the description is the yardstick, it is on screen, and changing it
 * is a change to what is being agreed, not a way out of agreeing.
 */
export const START_OPTIONS: readonly ExitOption<StartAnswer>[] = [
	{ value: "start", text: START_RUN, recommended: true },
	{ value: "edit", text: START_EDIT },
	{ value: "switch", text: START_SWITCH },
	{ value: "keep", text: START_KEEP_PLANNING, escape: true },
];

export const START_TITLE = "Start the run?";

/** One review, as the confirmation names who is going to read the work. */
function renderReview(review: Review): string {
	const parts = [review.lens];
	if (review.tier) parts.push(`tier ${review.tier}`);
	if (review.diverse) parts.push("diverse");
	if (review.skill) parts.push(`skill ${review.skill}`);
	if (review.model) parts.push(`model ${review.model}`);
	if (!review.tier && !review.model && !review.diverse)
		parts.push("effort dial decides");
	return `${parts[0]} (${parts.slice(1).join(", ")})`;
}

/**
 * The plan, as the person about to start it reads it.
 *
 * The work and who reads it, and nothing derived: the stages a deliverable
 * compiles to are pi-workflow's to decide from these tasks, these reviews and
 * these dials, and a graph rendered here would be this seat's second opinion
 * about a compilation it does not perform.
 */
export function renderPlanSummary(
	plan: Plan,
	effort: Effort,
	publication: DerivedPublication,
): string {
	const resolved = resolvePolicy(plan.policy);
	const lines = [
		`\`${plan.slug}\` — ${plan.deliverables.length} deliverable${plan.deliverables.length === 1 ? "" : "s"}, effort ${effort}, gates ${resolved.gates}.`,
	];
	for (const deliverable of plan.deliverables) {
		lines.push(
			`  ${deliverable.id} — ${deliverable.title}` +
				(deliverable.after && deliverable.after.length > 0
					? `, after ${deliverable.after.join(", ")}`
					: ""),
		);
		for (const task of deliverable.tasks)
			lines.push(`      ${task.id}: ${task.title}`);
		for (const review of deliverable.reviews ?? [])
			lines.push(`      read by ${renderReview(review)}`);
	}
	lines.push("", publication.why);
	return lines.join("\n");
}

/**
 * The whole confirmation, in one string, because Pi's `select` has no body.
 *
 * Everything that is being agreed to is here and nothing else is: what we
 * agreed we are doing, the plan, where the work goes, what the check said, and
 * where the run will stop.
 */
export function confirmationTitle(view: {
	readonly plan: Plan;
	readonly description: string;
	readonly effort: Effort;
	readonly publication: DerivedPublication;
	readonly check: PlanCheckResult | PlanCheckUnavailable;
}): string {
	const resolved = resolvePolicy(view.plan.policy);
	const findings =
		!isPlanCheckUnavailable(view.check) && view.check.findings.length > 0
			? [renderPlanCheckFindings(view.check.findings, "")]
			: [];
	return [
		START_TITLE,
		"",
		view.description,
		"",
		renderPlanSummary(view.plan, view.effort, view.publication),
		renderPlanCheckLine(view.check),
		...findings,
		"",
		`Starting it is the approval, and ${gateStops(resolved.gates)}.`,
	]
		.join("\n")
		.replace(/\n{3,}/g, "\n\n");
}

// ── What a human is told when nothing runs ───────────────────────────────────

/**
 * The plan is stored, the posture is the one asked for, and nothing runs.
 *
 * It names the way on — `/plan run <slug>` — because a plan stored without a
 * run is a plan somebody meant to start later.
 */
export function storedWithoutRunning(
	slug: string,
	wanted: ExitMode,
	why: string,
): string {
	return (
		`${why} Mode ${wanted}, and \`${slug}\` is stored without running:` +
		` start it whenever you like with \`/plan run ${slug}\`.`
	);
}

/** Back to the conversation, from a flow that never left plan mode. */
export function backToConversation(
	slug: string | undefined,
	wanted: ExitMode,
	why: string,
): string {
	return (
		`${why}\n\n` +
		"Nothing is running. You are still in plan mode, so the conversation" +
		" continues right here." +
		(slug ? ` The plan is stored — \`/plan run ${slug}\` starts it, and` : "") +
		`${slug ? "" : " Run"} \`/mode ${wanted}\` ${slug ? "switches" : "again"} when you are ready.`
	);
}

/**
 * The posture moves and there is no plan, with the reason said out loud.
 *
 * THIS IS NEVER A HANG. Leaving plan mode with nothing planned is an ordinary
 * thing to do — the model is still asked, because the harness cannot know what
 * is in the conversation until it does — and when the answer is empty or
 * refused, the person gets the posture they typed and one sentence saying why
 * there is no plan behind it.
 */
export function switchedWithoutPlan(wanted: ExitMode, why: string): string {
	return (
		`${why} Mode ${wanted}, with no plan stored:` +
		` there was nothing in this conversation to write one from, and \`/mode plan\` goes back to planning.`
	);
}

// ── What the conversation is told ────────────────────────────────────────────

/** The custom message's type, in the one place it exists. */
export const PLAN_MESSAGE_TYPE = "maestro:plan";

/** What the conversation learns; everything else the harness did stays out. */
export interface PlanAnnouncement {
	readonly customType: typeof PLAN_MESSAGE_TYPE;
	readonly content: string;
	readonly display: true;
}

/** How the announcement reaches the session. */
export type Announce = (message: PlanAnnouncement) => void;

/**
 * What happened to the plan, as the one message says it.
 *
 * `started` carries the run id because the harness started the run and knows
 * it: a message that said a run had been requested, without naming it, would be
 * the transcript's only trace of something it could not then look up.
 */
export type PlanMessageOutcome =
	| { readonly kind: "stored" }
	| { readonly kind: "started"; readonly runId: string }
	| { readonly kind: "back" };

/**
 * One message per event, naming the plan and what happened to it.
 *
 * The slug and the digest are both here because they answer different
 * questions: which plan, and which bytes of it. Nothing about how the document
 * was obtained appears — the requests, the retries, the check and the
 * validators' complaints are on the record in `authoring.json`, not in the
 * transcript.
 */
export function renderPlanMessage(
	plan: Plan,
	outcome: PlanMessageOutcome,
): PlanAnnouncement {
	const head =
		`Plan \`${plan.slug}\` (digest ${planDigest(plan)}) — ${plan.deliverables.length} deliverable` +
		`${plan.deliverables.length === 1 ? "" : "s"}.`;
	const tail =
		outcome.kind === "stored"
			? " Written by the harness on the way out of plan mode, from this conversation, and stored."
			: outcome.kind === "started"
				? ` Run started \`${outcome.runId}\` — started by the harness, not by this conversation, and ${gateStops(resolvePolicy(plan.policy).gates)}.`
				: " The hand-off ended without a run and the session is still in plan mode.";
	return {
		customType: PLAN_MESSAGE_TYPE,
		content: `${head}${tail}`,
		display: true,
	};
}

// ── The flow ─────────────────────────────────────────────────────────────────

/** The plan store, narrowed to what the hand-off reads and writes. */
export type ExitPlanStore = Pick<
	PlanStore,
	"loadPlan" | "savePlan" | "planDir" | "workflowInputFile"
>;

export interface ExitFlowDeps {
	readonly ui: ExitFlowUi;
	/** The posture the human asked for, and will be given when this settles. */
	readonly wanted: ExitMode;
	/** The seat's own switch. Called on the three answers that settle. */
	readonly setMode: (name: ModeName) => void;
	/** How the model is asked. The whole mechanism, in one injected function. */
	readonly complete: AuthoringComplete;
	/** The session's own room to think in, before anything is asked of it. */
	readonly contextUsage?: () => ContextUsageView | undefined;
	/** The session's thinking level, which the request never goes below. */
	readonly thinkingLevel?: ThinkingLevel;
	/** What the evidence calls the model. */
	readonly modelId?: string;
	/** Where the plan is read from and written to. */
	readonly store?: ExitPlanStore;
	/** Validation for a stored plan; defaults to `inspectPlan`. */
	readonly inspect?: (plan: Plan) => PlanReport;
	/** The workflow runtime, acquired lazily; `undefined` once it has warned. */
	readonly workflow?: () => Promise<WorkflowReadClient | undefined>;
	/**
	 * The plan check. @see PlanCheck
	 *
	 * Defaults to {@link unavailablePlanCheck}: a seat that cannot reach a
	 * reviewer is a seat whose confirmation says the check could not run, never
	 * one that refuses to hand off.
	 */
	readonly planCheck?: PlanCheck;
	/** Where the work goes. Injected so the tests do not need a repository. */
	readonly publication?: () => DerivedPublication;
	/** The one custom message per event. Absent on a host that has none. */
	readonly announce?: Announce;
	/** The repository the plan defaults its `repos` to. */
	readonly cwd?: string;
	/**
	 * Where the exported run input goes; defaults to the store's own
	 * `workflowInputFile`, which is the only thing that knows where this
	 * project's plans are. A default computed from `agentDir` here would have to
	 * guess the project key and would export into a directory nothing reads.
	 */
	readonly inputPath?: (slug: string) => string;
	/** How the run input is exported. Injected so a test writes nowhere. */
	readonly writeInput?: (path: string, json: string) => void;
	/** Aborts every open dialog and request; a session replacement ends the flow. */
	readonly signal?: AbortSignal;
	readonly gate?: DialogGate;
	readonly now?: () => Date;
}

export type ExitFlowOutcome =
	/** *Keep planning*, or escape. Nothing moved. */
	| { readonly kind: "keep-planning" }
	/** There was no plan to write: the posture changes and the reason is shown. */
	| { readonly kind: "switch-only"; readonly why: string }
	/** The run is running and the posture is the one asked for. */
	| {
			readonly kind: "started";
			readonly slug: string;
			readonly runId: string;
			readonly asked: number;
	  }
	/** The plan is stored, nothing runs, and the posture is the one asked for. */
	| {
			readonly kind: "stored";
			readonly slug: string;
			readonly why: string;
			readonly asked: number;
	  }
	/** Still in plan mode, with the plan stored when there is one. */
	| {
			readonly kind: "back";
			readonly slug?: string;
			readonly asked: number;
	  }
	/** A session replacement mid-flow. The posture is untouched. */
	| { readonly kind: "aborted" }
	/** Something this flow cannot proceed past, named. */
	| { readonly kind: "refused"; readonly problem: string };

export async function runExitFlow(
	deps: ExitFlowDeps,
): Promise<ExitFlowOutcome> {
	const { ui } = deps;
	const now = deps.now ?? (() => new Date());
	const dialogs = createExitDialogs(ui, {
		...(deps.signal ? { signal: deps.signal } : {}),
		...(deps.gate ? { gate: deps.gate } : {}),
	});
	const inspect = deps.inspect ?? ((plan: Plan) => inspectPlan(plan));
	const planCheck = deps.planCheck ?? unavailablePlanCheck;

	// ── The record of what was asked, and where it goes ──────────────────────
	//
	// Buffered rather than appended: the file lives beside the plan, and until
	// a document names a slug there is no directory to put it in. Every attempt
	// after that flushes the whole array, so the file on disk is always the
	// whole story so far.
	const attempts: AuthoringAttempt[] = [];
	let evidenceDir: string | undefined;
	const flushEvidence = (): void => {
		if (!evidenceDir || attempts.length === 0) return;
		try {
			writeAuthoringEvidence(evidenceDir, attempts);
		} catch {
			// The evidence is a record, not a gate: a hand-off that cannot write it
			// is still a hand-off, and the person is about to be told the outcome
			// either way.
		}
	};
	const noteEvidenceDir = (slug: string): void => {
		if (evidenceDir || !deps.store || !ID_RE.test(slug)) return;
		// The store's own helper: it is the only thing that knows where this
		// project's plans live, and the evidence belongs beside the plan.
		evidenceDir = deps.store.planDir(slug);
	};

	let thinking: ThinkingLevel = authoringThinking(
		DEFAULT_EFFORT,
		deps.thinkingLevel,
	);
	const modelId = deps.modelId ?? "unknown";

	// ONE REQUEST IS TWO STEPS. `request` sends it and holds what came back;
	// `judge` writes the attempt down once the caller has decided whether the
	// answer was any good. Two steps so that "what came back" and "what was
	// wrong with it" are one record rather than two.
	let pending:
		| { kind: AuthoringAttemptKind; startedAt: Date; text: string }
		| undefined;
	const request = async (
		kind: AuthoringAttemptKind,
		systemPrompt: string,
		messages: readonly AuthoringMessage[],
	): Promise<string | undefined> => {
		if (deps.signal?.aborted) throw new ExitAborted();
		const startedAt = now();
		const answer = await deps.complete({
			systemPrompt,
			// A copy: the caller goes on appending to the mini-conversation, and a
			// port handed the live array would see turns it was never sent.
			messages: [...messages],
			...(deps.signal ? { signal: deps.signal } : {}),
		});
		if (deps.signal?.aborted) throw new ExitAborted();
		if (!answer.ok) {
			attempts.push({
				kind,
				startedAt: startedAt.toISOString(),
				durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
				model: modelId,
				thinking,
				ok: false,
				problems: [PROVIDER_FAILURE_PROBLEM],
				responseDigest: responseDigest(""),
			});
			flushEvidence();
			return undefined;
		}
		pending = { kind, startedAt, text: answer.text };
		return answer.text;
	};
	/** What was wrong with the last answer, or nothing. Writes the attempt. */
	const judge = (problems: readonly string[]): void => {
		if (!pending) return;
		attempts.push({
			kind: pending.kind,
			startedAt: pending.startedAt.toISOString(),
			durationMs: Math.max(0, now().getTime() - pending.startedAt.getTime()),
			model: modelId,
			thinking,
			ok: problems.length === 0,
			problems: [...problems],
			responseDigest: responseDigest(pending.text),
		});
		pending = undefined;
		flushEvidence();
	};

	const reportProblems = (what: string, problems: readonly string[]): string =>
		[
			`${what} after ${MAX_AUTHORING_ATTEMPTS} attempts. What was wrong with the last one:`,
			...problems.map((problem) => `  - ${problem}`),
		].join("\n");

	try {
		// ── 1 — the one dial a repository cannot answer ────────────────────────
		const effort = await dialogs.choose(EFFORT_TITLE, EFFORT_OPTIONS);
		thinking = authoringThinking(effort, deps.thinkingLevel);

		// Not a dialog: read off the repository and carried into the confirmation.
		// `policy` is still where it can be changed, and the plan carries it.
		const publication = (deps.publication ?? DEFAULT_PUBLICATION)();
		const publish = publicationPolicy(publication);
		if (publish.base !== undefined && !isRefName(publish.base)) {
			// Caught here rather than by `inspectPlan` two steps later. A base
			// branch this seat derived and Git would refuse is a bug in the
			// derivation, and the human is owed the name it arrived at.
			const problem = `\`${publish.base}\` is not a valid branch name, so nothing was written and the posture is unchanged.`;
			ui.notify(problem, "error");
			return { kind: "refused", problem };
		}
		const policy: PlanPolicy = { effort, gates: DEFAULT_GATES, publish };

		// ── 2 — is there room to ask at all? ──────────────────────────────────
		const usage = deps.contextUsage?.();
		if (contextExhausted(usage) && usage) {
			ui.notify(contextGuardNotice(usage, deps.wanted), "warning");
			return { kind: "back", asked: dialogs.asked() };
		}

		/** The posture moves, no plan, and the reason is on screen. */
		const switchOnly = (why: string): ExitFlowOutcome => {
			deps.setMode(deps.wanted);
			ui.notify(switchedWithoutPlan(deps.wanted, why), "warning");
			return { kind: "switch-only", why };
		};

		// ── 3 — the description ───────────────────────────────────────────────
		const conversation: AuthoringMessage[] = [
			{ role: "user", text: DESCRIPTION_REQUEST },
		];
		let described: string | undefined;
		let lastProblems: string[] = [];
		for (let attempt = 0; attempt < MAX_AUTHORING_ATTEMPTS; attempt++) {
			const answer = await request(
				"intent",
				DESCRIPTION_SYSTEM_PROMPT,
				conversation,
			);
			if (answer === undefined) {
				lastProblems = [PROVIDER_FAILURE_PROBLEM];
				continue;
			}
			const problem = descriptionProblem(answer);
			judge(problem ? [problem] : []);
			if (!problem) {
				described = answer.trim();
				break;
			}
			lastProblems = [problem];
			conversation.push(
				{ role: "assistant", text: answer },
				{
					role: "user",
					text: `That is not the description: ${problem}. Write it again, whole.`,
				},
			);
		}
		if (described === undefined)
			// NEVER A HANG. The model was asked and had nothing usable to say, which
			// is exactly what leaving plan mode with no plan in the conversation
			// looks like from here.
			return switchOnly(
				reportProblems(
					"The model did not write a usable description",
					lastProblems,
				),
			);

		// ── 4 — the document ──────────────────────────────────────────────────
		if (!deps.store) {
			const problem =
				"This seat has no plan store to write the plan into, so the hand-off stops here.";
			ui.notify(problem, "error");
			return { kind: "refused", problem };
		}
		const store = deps.store;
		const documentPrompt = renderDocumentSystemPrompt(policy, described);
		const document: AuthoringMessage[] = [
			{ role: "user", text: DOCUMENT_REQUEST },
		];

		/**
		 * One round of "ask, validate, store".
		 *
		 * The whole reason `plan-document.ts` is separate from anything that
		 * registers a tool: `authoredPlanProblems` → `withoutEmptyOptionals` →
		 * `planFrom` → `inspectPlan` → `savePlan` is the document's own path,
		 * and nothing about it needs a tool to exist.
		 */
		const writeDocument = async (
			kind: AuthoringAttemptKind,
		): Promise<Plan | undefined> => {
			for (let attempt = 0; attempt < MAX_AUTHORING_ATTEMPTS; attempt++) {
				const answer = await request(kind, documentPrompt, document);
				if (answer === undefined) {
					lastProblems = [PROVIDER_FAILURE_PROBLEM];
					continue;
				}
				const problems = documentProblems(answer, store, {
					cwd: deps.cwd ?? process.cwd(),
					policy,
					inspect,
					noteSlug: noteEvidenceDir,
				});
				judge(problems.problems);
				if (problems.plan) {
					// The accepted document STAYS in the mini-conversation: a rewrite
					// appends the check to it, and findings about a document the model
					// cannot see are findings about nothing.
					document.push({ role: "assistant", text: answer });
					return problems.plan;
				}
				lastProblems = problems.problems;
				document.push(
					{ role: "assistant", text: answer },
					{
						role: "user",
						text: [
							"That document was not stored. Fix these and send the whole document again:",
							"",
							...problems.problems.map((problem) => `- ${problem}`),
						].join("\n"),
					},
				);
			}
			return undefined;
		};

		const first = await writeDocument("plan");
		if (!first)
			return switchOnly(
				reportProblems("The model did not write a usable plan", lastProblems),
			);
		let plan: Plan = first;
		deps.announce?.(renderPlanMessage(plan, { kind: "stored" }));

		const stored = (why: string): ExitFlowOutcome => {
			deps.setMode(deps.wanted);
			ui.notify(storedWithoutRunning(plan.slug, deps.wanted, why), "info");
			return { kind: "stored", slug: plan.slug, why, asked: dialogs.asked() };
		};
		const back = (why: string): ExitFlowOutcome => {
			ui.notify(backToConversation(plan.slug, deps.wanted, why), "info");
			deps.announce?.(renderPlanMessage(plan, { kind: "back" }));
			return { kind: "back", slug: plan.slug, asked: dialogs.asked() };
		};
		const refuse = (problem: string): ExitFlowOutcome => {
			ui.notify(problem, "error");
			return { kind: "refused", problem };
		};

		// Normalisation — heavy implies diverse, written down.
		//
		// Before anything reads this document. A heavy lens whose `diverse` is
		// undefined is a question two compilers answered differently; writing the
		// answer into the STORED plan settles it in the one place a receipt can be
		// checked against, and it is the document the digest covers.
		const explicit = withExplicitDiverse(plan);
		if (explicit) {
			const report = inspect(explicit);
			if (report.errors.length > 0)
				return refuse(
					`Writing \`diverse\` onto this plan's heavy reviewers produced a plan that no longer validates, which is a bug in this seat:\n${report.errors
						.map((error) => `  - ${error}`)
						.join("\n")}`,
				);
			const saved = savePlanOrReport(store, explicit, dialogs);
			if (!saved)
				return refuse(
					"This plan's heavy reviewers could not be written down, so the hand-off stops here rather than offering a plan the run would not reproduce.",
				);
			plan = saved;
		}

		// ── 5 — the plan check, and the harness acting on it ──────────────────
		//
		// THE PERSON IS NOT WALKED THROUGH THE FINDINGS. A blocking finding goes
		// straight back to the same mini-conversation, the document is rewritten
		// and the check runs again — silently. The one dialog below fires only
		// for a finding the reviewer said needs a person, or for a bound spent
		// with something still blocking.
		let check: PlanCheckResult | PlanCheckUnavailable = {
			unavailable: "it was not run",
		};
		for (let round = 0; ; round++) {
			const startedAt = now();
			check = await planCheck(plan, described, deps.signal);
			if (deps.signal?.aborted) throw new ExitAborted();
			attempts.push({
				kind: "check",
				startedAt: startedAt.toISOString(),
				durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
				model: modelId,
				thinking,
				ok: !isPlanCheckUnavailable(check),
				problems: isPlanCheckUnavailable(check) ? [check.unavailable] : [],
				responseDigest: responseDigest(JSON.stringify(check)),
				...(isPlanCheckUnavailable(check)
					? {}
					: {
							verdict: check.verdict,
							counts: severityCounts(check.findings),
						}),
			});
			flushEvidence();
			// Unreachable is never a refusal: the confirmation says so, and the
			// person decides with what they have.
			if (isPlanCheckUnavailable(check)) break;

			const decision = planCheckDecision(check, round);
			if (decision.kind === "accept") break;
			if (decision.kind === "ask") {
				const answer = await dialogs.choose(
					checkDialogTitle(
						decision.findings,
						decision.findings.every((finding) => finding.needsPerson !== true),
					),
					CHECK_OPTIONS,
				);
				if (answer === "keep")
					return back("The plan check found something you chose to answer.");
				break;
			}
			// The rewrite, in the same mini-conversation: the findings go in as a
			// user message and the next document comes straight back. No steer, no
			// model turn, no second hand-off.
			document.push({ role: "user", text: renderPlanCheckSteer(check, round) });
			const revised = await writeDocument("revise");
			if (!revised)
				return back(
					reportProblems("The model did not rewrite the plan", lastProblems),
				);
			plan = revised;
			deps.announce?.(renderPlanMessage(plan, { kind: "stored" }));
		}

		// ── 6 — the one confirmation ──────────────────────────────────────────
		const client = await deps.workflow?.();
		if (!client)
			// The warning naming `/plan run` has already been shown by the provider
			// seam; this is the flow ending cleanly behind it.
			return stored("This seat has no workflow runtime to start the run with.");

		let description = described;
		for (;;) {
			const answer = await dialogs.choose(
				confirmationTitle({ plan, description, effort, publication, check }),
				START_OPTIONS,
			);
			if (answer === "keep")
				return back("Nothing was started and nothing was changed.");
			if (answer === "switch") return stored("Nothing was started.");
			if (answer === "edit") {
				const edited = await dialogs.editor(
					DESCRIPTION_EDITOR_TITLE,
					description,
				);
				// Escape discards the edit and asks again: the confirmation is the
				// thing being answered, and an editor that went nowhere has not
				// answered it.
				const next = (edited ?? "").trim();
				if (next.length === 0) continue;
				if (next.length > MAX_DESCRIPTION_LENGTH) {
					ui.notify(
						`That description is ${next.length} characters, past the ${MAX_DESCRIPTION_LENGTH} bound. Nothing changed.`,
						"warning",
					);
					continue;
				}
				description = next;
				continue;
			}

			// ── 7 — the run, started here ─────────────────────────────────────
			//
			// The exported input is written FIRST and kept whatever happens next:
			// it is what `/plan run <slug>` and a person reading the plan directory
			// both want, and a run that failed to start is exactly when it is
			// wanted most.
			const input = toWorkflowInput(plan, effort);
			const path = (
				deps.inputPath ?? ((slug: string) => store.workflowInputFile(slug))
			)(plan.slug);
			try {
				(deps.writeInput ?? writeWorkflowInput)(
					path,
					JSON.stringify(input, null, 2),
				);
			} catch (error) {
				// The export is a record beside the plan, not the call: the run below
				// is started from `input` in memory either way.
				ui.notify(
					`The run input could not be written to ${path}: ${error instanceof Error ? error.message : String(error)}.`,
					"warning",
				);
			}
			// THE HARNESS STARTS IT. The runtime allowlists `plan-to-ship` for this
			// call, validates the input the way `workflow_run` would, and journals
			// the run with origin `"service-provider"` — so nothing here or
			// afterwards pretends the conversation started it.
			const receipt = await callWorkflow(
				() => client.startBuiltin(PLAN_WORKFLOW_REF, { input, effort }),
				ui.notify,
			);
			if (!receipt)
				// The refusal itself was printed by `callWorkflow`, sanitized and
				// naming `/plan run`. The plan is stored, so this ends where *Just
				// switch* ends: the posture asked for, and one sentence.
				return stored(
					`The workflow runtime did not start \`${plan.slug}\`, so nothing is running.`,
				);
			// THE POSTURE MOVES ONCE THE RUN EXISTS: the run writes to worktrees,
			// and the session watching it should be in the posture the human asked
			// for at `/mode auto`, not plan.
			deps.setMode(deps.wanted);
			deps.announce?.(
				renderPlanMessage(plan, { kind: "started", runId: receipt.runId }),
			);
			ui.notify(
				`Mode ${deps.wanted}, and \`${plan.slug}\` is running as \`${receipt.runId}\` at effort ${effort}. Starting it was the approval, and ${gateStops(resolvePolicy(plan.policy).gates)}.`,
				"info",
			);
			return {
				kind: "started",
				slug: plan.slug,
				runId: receipt.runId,
				asked: dialogs.asked(),
			};
		}
	} catch (error) {
		if (error instanceof ExitAborted) {
			// The session was replaced under an open dialog or an open request.
			// Nothing was committed and the posture is untouched.
			return { kind: "aborted" };
		}
		// Nothing in this flow throws into the session. A failure here is a
		// hand-off that ended, said out loud.
		const problem = `The plan-mode hand-off stopped: ${error instanceof Error ? error.message : String(error)}`;
		ui.notify(problem, "error");
		return { kind: "refused", problem };
	} finally {
		flushEvidence();
	}
}

/** The one place a document answer becomes a stored plan, or a list of faults. */
function documentProblems(
	answer: string,
	store: ExitPlanStore,
	surroundings: {
		readonly cwd: string;
		readonly policy: PlanPolicy;
		readonly inspect: (plan: Plan) => PlanReport;
		readonly noteSlug: (slug: string) => void;
	},
): { readonly plan?: Plan; readonly problems: string[] } {
	const parsed = parseDocument(answer);
	if ("problems" in parsed) return { problems: parsed.problems };
	const schema = authoredPlanProblems(parsed.value);
	if (schema.length > 0) {
		const slug = (parsed.value as { slug?: unknown }).slug;
		if (typeof slug === "string") surroundings.noteSlug(slug);
		return { problems: schema };
	}
	const authored = withoutEmptyOptionals(
		parsed.value as Parameters<typeof withoutEmptyOptionals>[0],
	);
	const plan = planFrom(authored, {
		cwd: surroundings.cwd,
		policy: surroundings.policy,
	});
	surroundings.noteSlug(plan.slug);
	const report = surroundings.inspect(plan);
	if (report.errors.length > 0) return { problems: report.errors };
	try {
		store.savePlan(plan);
	} catch (error) {
		return {
			problems: [
				`the plan store refused this document: ${error instanceof Error ? error.message : String(error)}`,
			],
		};
	}
	return { plan, problems: [] };
}

/** `savePlan`, with the store's own refusal reported rather than thrown. */
function savePlanOrReport(
	store: ExitPlanStore,
	plan: Plan,
	dialogs: ExitDialogs,
): Plan | undefined {
	try {
		store.savePlan(plan);
		return plan;
	} catch (error) {
		dialogs.notify(
			`The plan was not written: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
		return undefined;
	}
}

function writeWorkflowInput(path: string, json: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${json}\n`, "utf8");
}

// ── The `/mode` hook ─────────────────────────────────────────────────────────

export interface ModeExitControllerDeps {
	/** The seat's switch. Called on the three answers that settle. */
	readonly setMode: (name: ModeName) => void;
	/**
	 * How the model is asked, built from the `/mode` context.
	 *
	 * `undefined` for a session with no model: the hand-off exists to obtain two
	 * things from one, and there is nothing to ask.
	 */
	readonly complete?: (ctx: ModeExitContext) => AuthoringComplete | undefined;
	readonly announce?: Announce;
	/** Where publication is derived, and the plan's default repository. */
	readonly cwd?: string;
	readonly upstreamHead?: () => string | null;
	readonly originPresent?: () => boolean;
	readonly ghPresent?: () => boolean;
	readonly now?: () => Date;
	/** The seat's plan store. A getter: the seat builds lazily. */
	readonly store?: () => ExitPlanStore;
	/** The workflow runtime, acquired per flow. */
	readonly workflow?: (
		ctx: ModeExitContext,
		notify: ExitFlowUi["notify"],
	) => Promise<WorkflowReadClient | undefined>;
	/** The plan check, built per flow from the session's own context. */
	readonly planCheck?: (ctx: ModeExitContext) => PlanCheck | undefined;
	/**
	 * How the flow validates a plan — the stored document and every rewrite of
	 * it.
	 *
	 * Passed from the extension so the host a pinned review model or skill is
	 * checked against is the SAME one the store uses. A default `inspectPlan`
	 * here would have no host, and would then refuse a document the store had
	 * just accepted.
	 */
	readonly inspect?: (plan: Plan) => PlanReport;
	/**
	 * The seat's one dialog gate.
	 *
	 * Injected rather than owned so that everything on the seat that opens a
	 * dialog — this flow, and publication — defers behind the SAME count of
	 * outstanding foreign prompts. Two gates would be two owners of one screen,
	 * and only one of them would ever hear `ui_prompt_start`. A controller built
	 * without one makes its own, which is the right answer for a caller that
	 * opens no other dialogs.
	 */
	readonly gate?: DialogGate;
	/** The whole flow. Overridable so a test can watch the trigger fire. */
	readonly flow?: (deps: ExitFlowDeps) => Promise<ExitFlowOutcome>;
}

export interface ModeExitController {
	/** The `/mode` hook: the hand-off when leaving plan mode, nothing otherwise. */
	readonly hook: ModeExitHook;
	/** Resolves once the flow, if any, has finished. For tests. */
	settled(): Promise<void>;
	/** A session replacement: abort the open dialog or request. */
	abort(): void;
	/** A prompt opened by Pi or another extension; our dialogs defer. */
	notePromptStart(): void;
	notePromptEnd(): void;
	/** The last outcome, for a caller that wants to see what happened. */
	last(): ExitFlowOutcome | undefined;
}

export function createModeExitController(
	deps: ModeExitControllerDeps,
): ModeExitController {
	let controller: AbortController | undefined;
	let inFlight: Promise<unknown> | undefined;
	let last: ExitFlowOutcome | undefined;
	const gate = deps.gate ?? createDialogGate();
	const cwd = deps.cwd ?? process.cwd();

	const hook: ModeExitHook = async (previous, next, ctx) => {
		// Only the way out of plan mode, and only where dialogs exist: a session
		// that cannot be asked anything gets the switch it asked for rather than
		// a silent set of defaults nobody chose.
		if (previous !== "plan" || next === "plan") return "switch";
		if (!ctx.hasUI) return "switch";

		const own = new AbortController();
		controller = own;
		const complete = deps.complete?.(ctx);
		if (!complete) {
			// No way to ask the model is not a silent fallback: the hand-off exists
			// to obtain two things from it, and a seat that cannot would otherwise
			// switch posture and say nothing about the plan that never happened.
			ctx.ui.notify(
				"This session has no model to write the plan with, so the plan-mode hand-off did not run. Nothing changed.",
				"warning",
			);
			controller = undefined;
			return "switch";
		}
		const notify: ExitFlowUi["notify"] = (message, type) =>
			ctx.ui.notify(message, type);
		const run = deps.flow ?? runExitFlow;
		const check = deps.planCheck?.(ctx);
		const running = run({
			ui: ctx.ui,
			wanted: next,
			setMode: deps.setMode,
			complete,
			cwd,
			signal: own.signal,
			gate,
			publication: () =>
				derivePublication({
					originPresent: deps.originPresent ?? (() => gitOriginPresent(cwd)),
					ghPresent: deps.ghPresent ?? ghOnPath,
					upstreamHead: deps.upstreamHead ?? (() => gitUpstreamHead(cwd)),
				}),
			...(ctx.getContextUsage
				? { contextUsage: () => ctx.getContextUsage?.() }
				: {}),
			...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
			...(ctx.model?.id ? { modelId: ctx.model.id } : {}),
			...(deps.store ? { store: deps.store() } : {}),
			...(deps.inspect ? { inspect: deps.inspect } : {}),
			...(check ? { planCheck: check } : {}),
			...(deps.workflow
				? { workflow: () => deps.workflow?.(ctx, notify) as never }
				: {}),
			...(deps.announce ? { announce: deps.announce } : {}),
			...(deps.now ? { now: deps.now } : {}),
		});
		inFlight = running;
		try {
			const outcome = await running;
			last = outcome;
			switch (outcome.kind) {
				case "switch-only":
				case "stored":
				case "started":
					// The three branches that moved the posture, in their own order.
					return "settled";
				default:
					// Everything else leaves the seat in plan mode, which is the whole
					// point of the redesign: the mode moves when something is settled,
					// and not before.
					return "stay";
			}
		} finally {
			if (controller === own) controller = undefined;
			inFlight = undefined;
		}
	};

	return {
		hook,
		settled: async () => {
			await inFlight;
		},
		abort: () => controller?.abort(),
		notePromptStart: gate.promptStart,
		notePromptEnd: gate.promptEnd,
		last: () => last,
	};
}
