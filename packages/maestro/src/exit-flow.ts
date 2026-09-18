// The plan-mode exit: one flow, from `/mode auto` to a run.
//
// Leaving plan mode is where a conversation becomes a run. It used to be split
// across model turns, because the two things only the model can write — the
// agreed description and the plan document — arrived as tool calls, and a
// dialog sequence cannot survive a turn. It is not split any more. THE HARNESS
// ASKS THE MODEL DIRECTLY, through `authoring.ts`: an ordinary completion,
// outside the agent loop, with the session's own history and no tools at all.
// So the whole exit is one async controller, started from `/mode`, and it is
// one function you can read top to bottom:
//
//   1. **Two dialogs.** What to do with this conversation, and how much effort
//      the run may spend. Nothing else is asked: the gates take their default,
//      publication is DERIVED from the repository and announced, and the base
//      branch is whatever this branch tracks.
//   2. **The description**, requested, validated, and agreed in one dialog.
//   3. **The document**, requested, validated, stored.
//   4. **Readiness, the compiled graph, the blind review, the findings walk**,
//      and the one confirmation that turns all of it into a run.
//
// THE MODE DOES NOT MOVE UNTIL THE RUN STARTS. `/mode auto` from plan mode used
// to switch first and ask later, which left every path that ends without a run
// — and there are several — in a posture nobody chose for what they ended up
// doing. The seat stays in plan mode for the whole exit; `setMode` is called in
// exactly two places: *Just switch mode*, and immediately after the run starts.
//
// NOTHING IS ON DISK BETWEEN THE STEPS. There is no pending record any more,
// because there is nothing to join: the flow never yields to a model turn. A
// session that dies mid-exit simply has no exit — which is what a person would
// say happened.
//
// Four rules shape everything here:
//
//   - **NOTHING IS ASKED TWICE AND NOTHING IS ASSUMED SILENTLY.** Each dialog
//     is asked once, and the answers are attached to the plan as its `policy` —
//     on the document, where a reviewer and a receipt can both see them —
//     rather than in a dialog transcript nobody can check afterwards. The model
//     never writes them: the plan schema has no `policy` field.
//   - **WHAT IS FIRST AND WHAT ESCAPE TAKES ARE DIFFERENT QUESTIONS.** Every
//     option table names both, on the options themselves: `recommended` is the
//     answer a person most likely wants, it is first, and it is the only row
//     labelled `(default)`; `escape` is what an unanswered dialog means, and it
//     is always the answer that commits to nothing. They are the same row only
//     on the effort dial, where escaping commits to nothing either way. An
//     unrecognised answer takes the escape too. `test/exit-flow-*` finds every
//     exported table by shape and asserts all of it.
//   - **THE CONVERSATION LEARNS THE OUTCOME AND NOTHING ELSE.** One custom
//     message per exit says what was stored and what happened to it. The
//     requests, the retries and the validators' complaints are not steers and
//     do not appear in the transcript; they are on the record in
//     `authoring.json`, beside the plan.
//   - **THE HARNESS STARTS THE RUN, AND THE MODEL IS NEVER ASKED TO.** Both
//     runs this module starts go through the runtime's own allowlist: the
//     headless `plan-review`, and `plan-to-ship` itself once a person has
//     answered `Start the run?` with yes. NOTHING IS SENT TO THE MODEL — this
//     flow sends no user message at all, and the pi-maestro seat still refuses
//     the model's own `workflow_run` in plan mode by name. The only Bash is
//     repository creation at readiness, through the seat's audited tool, under
//     this mode's confirmation policy.
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
import {
	MAX_BLIND_REVIEWS,
	type PlanReview,
	partitionFindings,
	readPlanReview,
	renderFindings,
	renderReviseSteer,
	walkFindings,
} from "./findings.js";
import type { ExitMode, ModeName } from "./mode.js";
import {
	DEFAULT_GATES,
	ID_RE,
	inspectPlan,
	isRefName,
	type Plan,
	type PlanPolicy,
	type PlanReport,
	type PublishMode,
	resolvePolicy,
	withExplicitDiverse,
} from "./plan.js";
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
import {
	type AuditedBash,
	createRepository,
	creationCommands,
	ghOnPath,
	probeReadiness,
	type ReadinessDeps,
} from "./readiness.js";
import {
	type CompiledStageDocument,
	compileStageDocument,
	planWithStageDocument,
	renderStageDocument,
	StageDocumentError,
} from "./stage-document.js";
import type { PlanStore } from "./store.js";
import {
	callWorkflow,
	type WorkflowBudgetProjectionView,
	type WorkflowReadClient,
} from "./workflow-provider.js";

/**
 * The dialog primitives the exit uses, structurally Pi's `ExtensionUIContext`.
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
	/** Dialog-capable UI. A session without one cannot be asked two questions. */
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

// ── Step 1 ───────────────────────────────────────────────────────────────────

export const EXIT_COMPILE = "Compile it into a workflow run";
export const EXIT_SWITCH_ONLY = "Just switch mode";
export const EXIT_KEEP_PLANNING = "Keep planning";

export type ExitStart = "compile" | "switch" | "keep";

/**
 * Compiling is what somebody who typed `/mode auto` after a planning
 * conversation almost always wants, so it is first. Escape is *Keep planning*,
 * which is the one answer that changes nothing.
 */
export const EXIT_START_OPTIONS: readonly ExitOption<ExitStart>[] = [
	{ value: "compile", text: EXIT_COMPILE, recommended: true },
	{ value: "switch", text: EXIT_SWITCH_ONLY },
	{ value: "keep", text: EXIT_KEEP_PLANNING, escape: true },
];

export const EXIT_START_TITLE =
	"There is a conversation but no plan. What now?";

// ── Steps 2-4 ────────────────────────────────────────────────────────────────

/**
 * One option of a `select`, and the two different jobs an option can have.
 *
 * THESE ARE NOT THE SAME QUESTION, and collapsing them into one `fallback` flag
 * was a real defect: it forced the most likely answer and the safe answer to be
 * the same row, so every table had to give one of them up. *Agree* is what the
 * person usually wants when they are shown a description they asked the model
 * to write; agreeing because they pressed escape is a commitment nobody made.
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
 * away that the later dialogs do not still gate.
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
 * Shaped exactly like `gitRepoProbe`: one `execFileSync`, every failure the
 * same answer, because a caller cannot act differently on "no upstream", "not a
 * repository" and "no git at all" — all three mean the derivation has to fall
 * back. The tracked branch first, then whatever `origin` calls its head,
 * because a detached or unpushed branch still publishes onto the default.
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
 * ANNOUNCED rather than silent, because a derived decision nobody was told
 * about is exactly as unaccountable as one nobody chose — and `policy.publish`
 * on the plan is where it can still be changed.
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

// ── The agreed description ───────────────────────────────────────────────────

export const INTENT_TITLE = "Is this what we are doing?";
export const INTENT_AGREE = "Agree";
export const INTENT_EDIT = "Edit";
export const INTENT_BACK = "Back to the conversation";
export const INTENT_EDITOR_TITLE = "What we are doing, and why";

/**
 * Agree, edit, or stop.
 *
 * *Agree* is first because it is what usually happens: the sentences were
 * written from this conversation and are shown in full. It is NOT what escape
 * takes. Agreement is the one thing in this flow that a human supplies and
 * nothing else can — it becomes the blind reviewer's yardstick — and an
 * agreement obtained by not answering is not one.
 */
export const INTENT_OPTIONS: readonly ExitOption<"agree" | "edit" | "back">[] =
	[
		{ value: "agree", text: INTENT_AGREE, recommended: true },
		{ value: "edit", text: INTENT_EDIT },
		{ value: "back", text: INTENT_BACK, escape: true },
	];

/**
 * The dialog's title, which is the description itself.
 *
 * Pi's `select` carries no body, and the thing being agreed to has to be on
 * screen at the moment of agreeing — the same reason a blocking finding is its
 * own title in `findings.ts`.
 */
export function intentDialogTitle(summary: string): string {
	return `${INTENT_TITLE}\n\n${summary}`;
}

// ── The context guard ────────────────────────────────────────────────────────

/** What a person is told when the session has no room left to plan in. */
export function contextGuardNotice(
	usage: ContextUsageView,
	wanted: ExitMode,
): string {
	const percent = usage.percent ?? 0;
	return (
		`This session is using ${Math.round(percent)}% of the model's ${usage.contextWindow.toLocaleString("en-US")}-token context window, past the ${CONTEXT_LIMIT_PERCENT}% this exit will ask for a plan at.` +
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
 * exit flow does the same, through this gate, so one of its dialogs never lands
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
 * Every dialog the exit opens, through one door.
 *
 * The door is what makes the three discipline rules true everywhere instead of
 * at each call site: the abort signal is carried (and believed over an
 * escape-shaped resolution), foreign prompts defer, and the dialogs are
 * counted — which is how "a three-deliverable tiered plan asks exactly eleven
 * dialogs" is a test rather than a claim.
 */
export interface ExitDialogs {
	/** A `select` over an option table, returning the table's default on escape. */
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

// ── Readiness ────────────────────────────────────────────────────────────────

export const DIRTY_CONTINUE = "Continue";
export const DIRTY_BACK = "Back to the conversation";

/**
 * A dirty tree is a warning, never a refusal — `probeReadiness` says so and so
 * does the plan store. Continuing is therefore what is recommended: nothing has
 * run yet, every later dialog still gates the run, and the last of them is a
 * confirmation. What the human is owed is the sentence about HEAD, which the
 * problem's own message carries. Escape still stops, because a dialog about the
 * state of somebody's working tree is not one to answer on their behalf.
 */
export const DIRTY_OPTIONS: readonly ExitOption<"continue" | "back">[] = [
	{ value: "continue", text: DIRTY_CONTINUE, recommended: true },
	{ value: "back", text: DIRTY_BACK, escape: true },
];

export function creationTitle(path: string): string {
	return `Create \`${path}\`?`;
}

// ── The compiled document ────────────────────────────────────────────────────

export const COMPILED_TITLE = "The run this compiles to — check it how?";
export const COMPILED_REVIEW = "Review it blind";
export const COMPILED_APPROVE = "Approve as is";
export const COMPILED_EDIT = "Edit";
export const COMPILED_BACK = "Back to the conversation";
export const EDITOR_TITLE = "The compiled stage document";

export type CompiledAction = "review" | "approve" | "edit" | "back";

/**
 * What to do with the graph this plan compiles to.
 *
 * *Review it blind* is first: an independent read of the graph costs one
 * headless run and is what a person opening this dialog usually wants. Escape
 * is *Back to the conversation*, because everything else here starts something
 * — a reviewer, an editor, or the run — and none of those should happen
 * because a dialog went unanswered.
 */
export const COMPILED_OPTIONS: readonly ExitOption<CompiledAction>[] = [
	{ value: "review", text: COMPILED_REVIEW, recommended: true },
	{ value: "approve", text: COMPILED_APPROVE },
	{ value: "edit", text: COMPILED_EDIT },
	{ value: "back", text: COMPILED_BACK, escape: true },
];

/** The same table without the reviewer, for a seat that cannot reach one. */
export const COMPILED_OPTIONS_UNREVIEWED: readonly ExitOption<CompiledAction>[] =
	[
		{ value: "approve", text: COMPILED_APPROVE, recommended: true },
		{ value: "edit", text: COMPILED_EDIT },
		{ value: "back", text: COMPILED_BACK, escape: true },
	];

/**
 * Who will read this work, in one line.
 *
 * The reviewers used to be settled by three dialogs per deliverable; now the
 * plan settles them and this is where they are SHOWN — beside the agreed
 * description, before the dialog that can change them. A compiled document
 * whose reviewer list nobody read is a reviewer list nobody chose.
 */
export function renderReviewers(document: CompiledStageDocument): string {
	const seen = new Map<string, number>();
	for (const deliverable of document.deliverables)
		for (const stage of deliverable.stages) {
			if (stage.use !== "review-fan-out") continue;
			for (const lens of stage.lenses) {
				const label = `${lens.id}${lens.tier ? `/${lens.tier}` : ""}${
					lens.diverse ? "/diverse" : ""
				}`;
				seen.set(label, (seen.get(label) ?? 0) + 1);
			}
		}
	if (seen.size === 0)
		return "Reviewers: none — nothing in this plan is read by an independent lens.";
	return `Reviewers: ${[...seen]
		.map(([label, count]) => (count === 1 ? label : `${label} ×${count}`))
		.join(", ")}`;
}

/** The projected budget, in the three numbers a human decides on. */
export function renderProjection(
	projection: WorkflowBudgetProjectionView,
): string {
	return (
		`Projected: ${projection.tasks} task${projection.tasks === 1 ? "" : "s"}, ` +
		`${projection.totalTokens.toLocaleString("en-US")} tokens, ` +
		`cost ${projection.cost}, ${Math.round(projection.childRuntimeMs / 1000)}s of child runtime — ` +
		(projection.fits
			? "inside the workflow's budget."
			: "OVER the workflow's budget, which the run will refuse at admission.")
	);
}

// ── The run ──────────────────────────────────────────────────────────────────

export const START_RUN_TITLE = "Start the run?";

/**
 * What a human is told when the exit ends without a run.
 *
 * It names BOTH ways on: the plan, and the posture they asked for and have not
 * been given. `/mode plan` is never offered — the seat never left plan mode, so
 * offering it would be the flow apologising for something that did not happen.
 */
export function storedWithoutRunning(
	slug: string,
	wanted: ExitMode,
	why: string,
): string {
	return (
		`${why} The plan is stored and you are still in plan mode:` +
		` start the run whenever you like with \`/plan run ${slug}\`,` +
		` or take the posture you asked for with \`/mode ${wanted}\`.`
	);
}

/** Back to the conversation, from a flow that never left plan mode. */
export function backToConversation(
	slug: string,
	wanted: ExitMode,
	findings: string,
): string {
	return (
		`${findings}\n\n` +
		"Nothing is running. You are still in plan mode, so the conversation" +
		` continues right here. The plan is stored — \`/plan run ${slug}\` starts` +
		` it, and \`/mode ${wanted}\` switches when you are ready.`
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
 * was obtained appears — the requests, the retries and the validators'
 * complaints are on the record in `authoring.json`, not in the transcript.
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
				? ` Run started \`${outcome.runId}\` — started by the harness, not by this conversation, and it parks at its \`approve-plan\` checkpoint.`
				: " The exit ended without a run and the session is still in plan mode.";
	return {
		customType: PLAN_MESSAGE_TYPE,
		content: `${head}${tail}`,
		display: true,
	};
}

// ── The flow ─────────────────────────────────────────────────────────────────

/** The plan store, narrowed to what the exit reads and writes. */
export type ExitPlanStore = Pick<
	PlanStore,
	"loadPlan" | "savePlan" | "planDir" | "workflowInputFile"
>;

export interface ExitFlowDeps {
	readonly ui: ExitFlowUi;
	/** The posture the human asked for, and will be given when the run starts. */
	readonly wanted: ExitMode;
	/** The seat's own switch. Called for *Just switch mode* and a started run. */
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
	/** Validation for a stored or patched plan; defaults to `inspectPlan`. */
	readonly inspect?: (plan: Plan) => PlanReport;
	/** The workflow runtime, acquired lazily; `undefined` once it has warned. */
	readonly workflow?: () => Promise<WorkflowReadClient | undefined>;
	/** The seat's audited Bash, for repository creation and nothing else. */
	readonly bash?: AuditedBash;
	/** Readiness's own view of the world; defaults to the real one. */
	readonly readiness?: ReadinessDeps;
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
	/** How long the blind review may take. */
	readonly timeoutMs?: number;
	/** Aborts every open dialog and request; a session replacement ends the flow. */
	readonly signal?: AbortSignal;
	readonly gate?: DialogGate;
	readonly now?: () => Date;
}

export type ExitFlowOutcome =
	/** *Keep planning*, or escape at step 1. Nothing moved. */
	| { readonly kind: "keep-planning" }
	/** *Just switch mode*: the posture changes, no plan, no request. */
	| { readonly kind: "switch-only" }
	/** The run is running and the posture is the one asked for. */
	| {
			readonly kind: "started";
			readonly slug: string;
			readonly runId: string;
			readonly asked: number;
	  }
	/** The plan is stored and nothing runs. */
	| {
			readonly kind: "stored";
			readonly slug: string;
			readonly why: string;
			readonly asked: number;
	  }
	/** The human went back, or the last review still blocked. */
	| {
			readonly kind: "back";
			readonly slug?: string;
			readonly asked: number;
	  }
	/** A session replacement mid-flow. The posture is untouched. */
	| { readonly kind: "aborted" }
	/** Something this flow cannot proceed past, named. */
	| { readonly kind: "refused"; readonly problem: string };

/** The headless reviewer this seat starts. The runtime owns the allowlist. */
export const PLAN_REVIEW_REF = "plan-review";

/** How long the blind review may take before the flow stops waiting for it. */
export const DEFAULT_REVIEW_TIMEOUT_MS = 300_000;

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
			// The evidence is a record, not a gate: an exit that cannot write it
			// is still an exit, and the person is about to be told the outcome
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

	const reportProblems = (what: string, problems: readonly string[]): void => {
		ui.notify(
			[
				`${what} after ${MAX_AUTHORING_ATTEMPTS} attempts. What was wrong with the last one:`,
				...problems.map((problem) => `  - ${problem}`),
				"",
				`Nothing changed and you are still in plan mode. Say what you want differently and run \`/mode ${deps.wanted}\` again.`,
			].join("\n"),
			"error",
		);
	};

	try {
		// ── 1 — the only step that can end the flow without changing anything ──
		const start = await dialogs.choose(EXIT_START_TITLE, EXIT_START_OPTIONS);
		if (start === "keep") return { kind: "keep-planning" };
		if (start === "switch") {
			deps.setMode(deps.wanted);
			return { kind: "switch-only" };
		}

		// ── 2 — the one dial a repository cannot answer ────────────────────────
		const effort = await dialogs.choose(EFFORT_TITLE, EFFORT_OPTIONS);
		thinking = authoringThinking(effort, deps.thinkingLevel);

		// Not a dialog: read off the repository and said out loud. `policy` is
		// still where it can be changed, and the plan carries it.
		const publication = (deps.publication ?? DEFAULT_PUBLICATION)();
		ui.notify(publication.why, "info");
		const publish = publicationPolicy(publication);
		if (publish.base !== undefined && !isRefName(publish.base)) {
			// Caught here rather than by `inspectPlan` three steps later. A base
			// branch this seat derived and Git would refuse is a bug in the
			// derivation, and the human is owed the name it arrived at.
			const problem = `\`${publish.base}\` is not a valid branch name, so nothing was written and the posture is unchanged.`;
			ui.notify(problem, "error");
			return { kind: "refused", problem };
		}
		const policy: PlanPolicy = { effort, gates: DEFAULT_GATES, publish };

		// ── 3 — is there room to ask at all? ───────────────────────────────────
		const usage = deps.contextUsage?.();
		if (contextExhausted(usage) && usage) {
			ui.notify(contextGuardNotice(usage, deps.wanted), "warning");
			return { kind: "back", asked: dialogs.asked() };
		}

		// ── 4 — the description, requested and agreed ─────────────────────────
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
		if (described === undefined) {
			reportProblems(
				"The model did not write a usable description",
				lastProblems,
			);
			return { kind: "back", asked: dialogs.asked() };
		}

		let summary = described;
		for (;;) {
			const choice = await dialogs.choose(
				intentDialogTitle(summary),
				INTENT_OPTIONS,
			);
			if (choice === "back") {
				ui.notify(
					`Nothing was written and you are still in plan mode — the conversation continues here. Run \`/mode ${deps.wanted}\` again when the description is one we agree on.`,
					"info",
				);
				return { kind: "back", asked: dialogs.asked() };
			}
			if (choice === "edit") {
				const edited = await dialogs.editor(INTENT_EDITOR_TITLE, summary);
				// Escape discards the edit and asks again, which is the same rule
				// the compiled document's editor follows.
				const next = (edited ?? "").trim();
				if (next.length === 0) continue;
				if (next.length > MAX_DESCRIPTION_LENGTH) {
					ui.notify(
						`That description is ${next.length} characters, past the ${MAX_DESCRIPTION_LENGTH} bound. Nothing changed.`,
						"warning",
					);
					continue;
				}
				summary = next;
				continue;
			}
			break;
		}

		// ── 5 — the document ──────────────────────────────────────────────────
		if (!deps.store) {
			const problem =
				"This seat has no plan store to write the plan into, so the exit stops here.";
			ui.notify(problem, "error");
			return { kind: "refused", problem };
		}
		const store = deps.store;
		const documentPrompt = renderDocumentSystemPrompt(policy, summary);
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
					// The accepted document STAYS in the mini-conversation: a revise
					// appends the review to it, and a reviewer's findings about a
					// document the model cannot see are findings about nothing.
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
		if (!first) {
			reportProblems("The model did not write a usable plan", lastProblems);
			return { kind: "back", asked: dialogs.asked() };
		}
		let plan: Plan = first;
		deps.announce?.(renderPlanMessage(plan, { kind: "stored" }));

		// ── 6 — readiness, the graph, the review, the run ─────────────────────
		const resolved = resolvePolicy(plan.policy);
		const stored = (why: string): ExitFlowOutcome => {
			ui.notify(storedWithoutRunning(plan.slug, deps.wanted, why), "info");
			return { kind: "stored", slug: plan.slug, why, asked: dialogs.asked() };
		};
		const back = (message: string): ExitFlowOutcome => {
			ui.notify(backToConversation(plan.slug, deps.wanted, message), "info");
			deps.announce?.(renderPlanMessage(plan, { kind: "back" }));
			return { kind: "back", slug: plan.slug, asked: dialogs.asked() };
		};
		const refuse = (problem: string): ExitFlowOutcome => {
			ui.notify(problem, "error");
			return { kind: "refused", problem };
		};

		// Readiness, and the two questions it can raise.
		let readiness = probeReadiness(plan.repos, plan.policy, deps.readiness);
		const missing = readiness.problems.filter(
			(problem) => problem.kind === "missing-path",
		);
		for (const problem of missing) {
			const commands = creationCommands(
				problem.repo.path,
				resolved.publish.mode,
			);
			const create = await dialogs.confirm(
				creationTitle(problem.repo.path),
				[
					problem.message,
					"",
					"These commands run through the seat's audited Bash, under this mode's own confirmation policy:",
					...commands.map((command) => `  ${command}`),
				].join("\n"),
			);
			if (!create)
				return back(
					`Nothing was created, so \`${problem.repo.key}\` still has no repository at \`${problem.repo.path}\`.`,
				);
			if (!deps.bash)
				return refuse(
					`\`${problem.repo.path}\` cannot be created: this session has no audited Bash to run \`git init\` through.`,
				);
			const creation = await createRepository(problem, {
				bash: deps.bash,
				confirmed: true,
				publish: { mode: resolved.publish.mode },
			});
			if (!creation.ok) return refuse(creation.reason);
			ui.notify(
				`Created \`${problem.repo.path}\`:\n${creation.commands.map((command) => `  ${command}`).join("\n")}`,
				"info",
			);
		}
		// Re-probed rather than patched in memory: a repository that was just
		// created is clean, has a HEAD, and may or may not have the base branch,
		// and the machine is the only honest answer to which.
		if (missing.length > 0)
			readiness = probeReadiness(plan.repos, plan.policy, deps.readiness);

		for (const problem of readiness.problems) {
			if (problem.kind !== "dirty") continue;
			const choice = await dialogs.choose(problem.message, DIRTY_OPTIONS);
			if (choice === "back")
				return back(
					`\`${problem.repo.path}\` has uncommitted changes that no worktree would see.`,
				);
		}
		const rest = readiness.problems.filter(
			(problem) => problem.kind !== "dirty" && problem.kind !== "missing-path",
		);
		if (rest.length > 0)
			// Reported whole and not asked about: none of them stops a plan from
			// being stored or a run from being requested, and every one of them
			// is a fact about this host that publication will meet again.
			ui.notify(
				`Readiness found ${rest.length} thing${rest.length === 1 ? "" : "s"} worth knowing about this machine:\n${rest
					.map((problem) => `  - ${problem.message}`)
					.join("\n")}`,
				"warning",
			);

		// Normalisation — heavy implies diverse, written down.
		//
		// Before anything compiles this document, and before a human is shown a
		// graph derived from it. A heavy lens whose `diverse` is undefined is a
		// question two compilers answered differently; writing the answer into
		// the stored plan is what makes this seat's compiled document and
		// pi-workflow's agree, and it is the document the digest covers.
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
					"This plan's heavy reviewers could not be written down, so the exit stops here rather than compiling a graph the run would not reproduce.",
				);
			plan = saved;
			ui.notify(
				"Every heavy reviewer on this plan now says `diverse: true` explicitly, so the run compiles the reviewers you are about to see.",
				"info",
			);
		}

		const client = await deps.workflow?.();
		if (!client)
			// The warning naming `/plan run` has already been shown by the
			// provider seam; this is the flow ending cleanly behind it.
			return stored("This seat has no workflow runtime to compile against.");

		let reviewable = true;
		let reviewsRun = 0;
		let straightToReview = false;
		let verdict: PlanReview | undefined;

		for (;;) {
			let compiled: CompiledStageDocument;
			try {
				compiled = compileStageDocument(plan);
			} catch (error) {
				if (error instanceof StageDocumentError) return refuse(error.message);
				throw error;
			}
			const input = toWorkflowInput(plan, effort);
			const validation = await callWorkflow(
				() => client.validate(PLAN_WORKFLOW_REF, input),
				ui.notify,
				"run",
			);
			if (!validation)
				return stored("The runtime could not validate this plan's run input.");
			const projection = await callWorkflow(
				() => client.project(PLAN_WORKFLOW_REF, input),
				ui.notify,
				"run",
			);
			if (!projection)
				return stored("The runtime could not project this run's budget.");

			// What the compiled dialog is about, all of it on screen before it is
			// asked: what we agreed we are doing, who is going to read the work,
			// the graph, and what it costs.
			ui.notify(
				[
					`Agreed: ${summary}`,
					renderReviewers(compiled),
					"",
					renderStageDocument(compiled),
					renderProjection(projection),
				].join("\n"),
				"info",
			);

			let action: CompiledAction;
			if (straightToReview) {
				straightToReview = false;
				action = "review";
			} else {
				action = await dialogs.choose(
					COMPILED_TITLE,
					reviewable ? COMPILED_OPTIONS : COMPILED_OPTIONS_UNREVIEWED,
				);
			}

			// The document as JSON, escape ≡ discard.
			if (action === "edit") {
				const edited = await dialogs.editor(
					EDITOR_TITLE,
					JSON.stringify(compiled, null, 2),
				);
				if (edited === undefined) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(edited);
				} catch (error) {
					ui.notify(
						`The edited document was not read: ${error instanceof Error ? error.message : String(error)}. Nothing changed.`,
						"warning",
					);
					continue;
				}
				const rewritten = planWithStageDocument(plan, parsed);
				if (!rewritten.plan) {
					ui.notify(
						`The edited document was not applied:\n${rewritten.problems.map((problem) => `  - ${problem}`).join("\n")}`,
						"warning",
					);
					continue;
				}
				const saved = savePlanOrReport(store, rewritten.plan, dialogs);
				if (!saved) continue;
				plan = saved;
				continue;
			}

			if (action === "back")
				// Escape, or the option that says so. The plan stays stored and the
				// exit ends exactly where the other *Back to the conversation*
				// answers end it: plan mode, one notice.
				return back("Nothing was reviewed and nothing was started.");

			if (action === "approve") break;

			// The blind review. No dialog, and no model turn: a review reached
			// through the seat's model would have read the conversation.
			ui.notify("Reviewing the plan…", "info");
			const review = await runBlindReview(client, ui.notify, {
				plan,
				intent: summary,
				compiled,
				projection,
				effort,
				timeoutMs: deps.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
			});
			if (!review) {
				// Only the reviewer is out of reach; the compiled plan is in hand.
				reviewable = false;
				continue;
			}
			reviewsRun += 1;
			verdict = review;
			const { blocking } = partitionFindings(review.findings);
			if (blocking.length === 0) {
				ui.notify(
					`The blind review says \`${review.verdict}\`.${review.notes ? `\n${review.notes}` : ""}`,
					"info",
				);
				if (review.findings.length > 0)
					ui.notify(
						renderFindings(review.findings, "Nothing blocking:"),
						"info",
					);
				break;
			}
			// The budget is spent when this was the last review the exit is worth:
			// nothing would read a rewrite, so the walk is asked without *Revise
			// with the model* and this reading of the plan ends in the
			// conversation however it is answered. An accepted patch still lands
			// on the stored plan on the way out.
			const revisable = reviewsRun < MAX_BLIND_REVIEWS;
			const walk = await walkFindings({
				dialogs,
				findings: review.findings,
				plan,
				save: (next) => store.savePlan(next),
				revisable,
				inspect,
			});
			plan = walk.plan;
			if (walk.kind === "back")
				return back(
					renderFindings(
						review.findings,
						`The blind review says \`${review.verdict}\`:`,
					),
				);
			if (walk.kind === "revise") {
				// THE REVISE LOOP, and it is the same mini-conversation: the review
				// goes in as a user message and the next document comes straight
				// back. No steer, no model turn, no second exit.
				document.push({
					role: "user",
					text: renderReviseSteer(review.findings, review.notes, reviewsRun),
				});
				ui.notify(
					`The whole review went back to the model — ${review.findings.length} finding${
						review.findings.length === 1 ? "" : "s"
					}, verbatim. ${MAX_BLIND_REVIEWS - reviewsRun} of ${MAX_BLIND_REVIEWS} blind reviews are left.`,
					"info",
				);
				const revised = await writeDocument("revise");
				if (!revised) {
					reportProblems("The model did not rewrite the plan", lastProblems);
					return back(
						"The review was not answered with a document this seat could store.",
					);
				}
				plan = revised;
				deps.announce?.(renderPlanMessage(plan, { kind: "stored" }));
				straightToReview = true;
				continue;
			}
			if (!revisable)
				// The loop is over. `MAX_BLIND_REVIEWS` reads of the same plan that
				// still block is a plan the conversation has to answer, not one
				// more dialog and not one more reviewer.
				return back(
					renderFindings(
						review.findings,
						`Blind review ${reviewsRun} of ${MAX_BLIND_REVIEWS} still blocks (\`${review.verdict}\`), and that is the last one this exit is worth:`,
					),
				);
			// Everything blocking was dismissed, with a reason for each: the human
			// has answered the review and the run is theirs to start.
			if (walk.accepted === 0) break;
			// Recompile and re-review once, without asking the compiled dialog
			// again.
			straightToReview = true;
		}

		// ── 7 — the last question, and the only one that starts anything ──────
		const input = toWorkflowInput(plan, effort);
		const start2 = await dialogs.confirm(
			START_RUN_TITLE,
			[
				`\`${plan.slug}\` — ${plan.deliverables.length} deliverable${plan.deliverables.length === 1 ? "" : "s"}, effort ${effort}, gates ${resolved.gates}.`,
				verdict ? `The blind review says \`${verdict.verdict}\`.` : undefined,
				"The run parks at its `approve-plan` checkpoint, so approving it is still a separate decision.",
			]
				.filter((line): line is string => line !== undefined)
				.join("\n"),
		);
		if (!start2) return stored("Nothing was started.");

		// ── 8 — the run, started here ─────────────────────────────────────────
		//
		// The exported input is written FIRST and kept whatever happens next: it
		// is what `/plan run <slug>` and a person reading the plan directory both
		// want, and a run that failed to start is exactly when it is wanted most.
		const path = (
			deps.inputPath ?? ((s: string) => store.workflowInputFile(s))
		)(plan.slug);
		const json = JSON.stringify(input, null, 2);
		try {
			(deps.writeInput ?? writeWorkflowInput)(path, json);
		} catch (error) {
			// The export is a record beside the plan, not the call: the run below
			// is started from `input` in memory either way.
			ui.notify(
				`The run input could not be written to ${path}: ${error instanceof Error ? error.message : String(error)}.`,
				"warning",
			);
		}
		// THE HARNESS STARTS IT. The runtime allowlists `plan-to-ship` for this
		// call, validates the input the way `workflow_run` would, and journals the
		// run with origin `"service-provider"` — so nothing here or afterwards
		// pretends the conversation started it.
		const receipt = await callWorkflow(
			() => client.startBuiltin(PLAN_WORKFLOW_REF, { input, effort }),
			ui.notify,
			"run",
		);
		if (!receipt)
			// The refusal itself was printed by `callWorkflow`, sanitized and
			// naming `/plan run`. The posture has not moved and the plan is stored,
			// so this ends exactly the way going back does.
			return back(
				`The workflow runtime did not start \`${plan.slug}\`, so nothing is running.`,
			);
		// THE ONE PLACE THE POSTURE MOVES ON THE WAY TO A RUN, and it moves only
		// once the run exists: the run writes to worktrees, and the session
		// watching it should be in the posture the human asked for at
		// `/mode auto`, not plan.
		deps.setMode(deps.wanted);
		deps.announce?.(
			renderPlanMessage(plan, { kind: "started", runId: receipt.runId }),
		);
		ui.notify(
			`Mode ${deps.wanted}, and \`${plan.slug}\` is running as \`${receipt.runId}\` at effort ${effort}. Approval is the run's \`approve-plan\` checkpoint, not this flow.`,
			"info",
		);
		return {
			kind: "started",
			slug: plan.slug,
			runId: receipt.runId,
			asked: dialogs.asked(),
		};
	} catch (error) {
		if (error instanceof ExitAborted) {
			// The session was replaced under an open dialog or an open request.
			// Nothing was committed and the posture is untouched.
			return { kind: "aborted" };
		}
		// Nothing in this flow throws into the session. A failure here is an exit
		// that ended, said out loud.
		const problem = `The plan-mode exit stopped: ${error instanceof Error ? error.message : String(error)}`;
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

interface BlindReviewRequest {
	readonly plan: Plan;
	readonly intent: string;
	readonly compiled: CompiledStageDocument;
	readonly projection: WorkflowBudgetProjectionView;
	readonly effort: Effort;
	readonly timeoutMs: number;
}

/**
 * Start the headless `plan-review` and wait for it.
 *
 * `undefined` means the reviewer is unreachable, for any reason — no runtime
 * method, a refusal, a timeout, or an output this seat cannot read. Every one
 * of them is the same thing to the caller: the compiled plan is in hand and
 * `Approve as is` is what continues.
 */
async function runBlindReview(
	client: WorkflowReadClient,
	notify: ExitFlowUi["notify"],
	request: BlindReviewRequest,
): Promise<PlanReview | undefined> {
	const receipt = await callWorkflow(
		() =>
			client.runBuiltin(PLAN_REVIEW_REF, {
				plan: request.plan,
				planDigest: planDigest(request.plan),
				intent: request.intent,
				compiled: request.compiled,
				// Passed through exactly as the runtime returned it: the
				// reviewer's schema reads fields this seat does not.
				projection: request.projection,
				effort: request.effort,
			}),
		notify,
		"reviewer",
	);
	if (!receipt) return undefined;
	const view = await callWorkflow(
		() => client.awaitRun(receipt.runId, { timeoutMs: request.timeoutMs }),
		notify,
		"reviewer",
	);
	if (!view) return undefined;
	if (view.timedOut) {
		notify(
			`The blind review did not finish within ${Math.round(request.timeoutMs / 1000)}s. ${UNREVIEWED_HINT}`,
			"warning",
		);
		return undefined;
	}
	const review = readPlanReview(view.output);
	if (!review) {
		notify(
			`The blind review ended \`${view.status}\` without a verdict this seat can read. ${UNREVIEWED_HINT}`,
			"warning",
		);
		return undefined;
	}
	return review;
}

const UNREVIEWED_HINT =
	"Choose `Approve as is` to continue without it, or `Edit` to change the graph.";

// ── The `/mode` hook ─────────────────────────────────────────────────────────

export interface ModeExitControllerDeps {
	/** The seat's switch. Called once a run starts, and by *Just switch mode*. */
	readonly setMode: (name: ModeName) => void;
	/**
	 * How the model is asked, built from the `/mode` context.
	 *
	 * `undefined` for a session with no model: the exit exists to obtain two
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
	/** The audited Bash, built per flow from the session's own context. */
	readonly bash?: (ctx: ModeExitContext) => AuditedBash | undefined;
	/** The workflow runtime, acquired per flow. */
	readonly workflow?: (
		ctx: ModeExitContext,
		notify: ExitFlowUi["notify"],
	) => Promise<WorkflowReadClient | undefined>;
	/**
	 * How the flow validates a plan — the stored document, normalisation, and
	 * every accepted patch.
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
	/** How long the blind review may take. */
	readonly timeoutMs?: number;
	/** The whole flow. Overridable so a test can watch the trigger fire. */
	readonly flow?: (deps: ExitFlowDeps) => Promise<ExitFlowOutcome>;
}

export interface ModeExitController {
	/** The `/mode` hook: the exit when leaving plan mode, nothing otherwise. */
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
		// that cannot be asked two questions gets the switch it asked for rather
		// than a silent set of defaults nobody chose.
		if (previous !== "plan" || next === "plan") return "switch";
		if (!ctx.hasUI) return "switch";

		const own = new AbortController();
		controller = own;
		const complete = deps.complete?.(ctx);
		if (!complete) {
			// No way to ask the model is not a silent fallback: the exit exists to
			// obtain two things from it, and a seat that cannot would otherwise
			// switch posture and say nothing about the plan that never happened.
			ctx.ui.notify(
				"This session has no model to write the plan with, so the plan-mode exit did not run. Nothing changed.",
				"warning",
			);
			controller = undefined;
			return "switch";
		}
		const notify: ExitFlowUi["notify"] = (message, type) =>
			ctx.ui.notify(message, type);
		const run = deps.flow ?? runExitFlow;
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
			...(deps.bash ? { bash: deps.bash(ctx) } : {}),
			...(deps.workflow
				? { workflow: () => deps.workflow?.(ctx, notify) as never }
				: {}),
			...(deps.announce ? { announce: deps.announce } : {}),
			...(deps.now ? { now: deps.now } : {}),
			...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
		});
		inFlight = running;
		try {
			const outcome = await running;
			last = outcome;
			switch (outcome.kind) {
				case "switch-only":
				case "started":
					// The two branches that moved the posture, in their own order.
					return "settled";
				default:
					// Everything else leaves the seat in plan mode, which is the whole
					// point of the redesign: the mode moves when the run starts, and
					// not before.
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
