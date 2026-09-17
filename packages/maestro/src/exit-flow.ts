// The plan-mode exit, both halves: the two questions a plan cannot answer, the
// description the conversation has to agree on, and what happens to the plan
// once the model has written it.
//
// Leaving plan mode is where a conversation becomes a run, and the flow is
// split by model turns because it has to be: a dialog sequence cannot obtain
// anything from a conversation, and both the description and the plan come from
// the model. So:
//
//   1. **Phase 1 — two dialogs.** What to do with this conversation, and how
//      much effort the run may spend. Nothing else is asked: the gates take
//      their default, publication is DERIVED from the repository and announced,
//      and the base branch is whatever this branch tracks. The record is
//      written and the model is asked to describe the work.
//   2. **The agreed description.** The model writes two or three sentences and
//      submits them through `plan_intent`; one dialog shows them back. Agreeing
//      puts them on the record and opens the `plan` tool's window — they are
//      the yardstick the blind reviewer checks the plan against, so there is no
//      window before there is a yardstick.
//   3. **Phase 2** (`runExitFlowPhase2`, at the bottom of this file) picks the
//      plan up from the `tool_result` of the model's `plan` call: readiness,
//      the compiled stage document, the blind review, the findings walk, and
//      the one confirmation that turns all of it into a run.
//
// THE MODE DOES NOT MOVE UNTIL THE RUN STARTS. `/mode auto` from plan mode used
// to switch first and ask later, which left every path that ends without a run
// — and there are five — in a posture nobody chose for what they ended up
// doing. The seat stays in plan mode for the whole exit; `seat.setMode` is
// called in exactly one place, immediately before the hand-off.
//
// Three rules shape everything here:
//
//   - **NOTHING IS ASKED TWICE AND NOTHING IS ASSUMED SILENTLY.** Each dialog
//     is asked once, escape takes the documented default — which is always the
//     FIRST option, so the highlighted row and the escape key agree — and the
//     answers end up in the plan's own `policy` block, on the document, where a
//     reviewer and a receipt can both see them.
//   - **EVERY OPTION TABLE LISTS ITS DEFAULT FIRST.** `test/exit-flow-*` asserts
//     it for every exported table.
//   - **NOTHING BLOCKS A TOOL RESULT.** The dialogs that follow a `plan_intent`
//     or `plan` call are scheduled detached, so the model's tool call completes
//     while the human is still reading. A by-hand pass showed a `plan` call
//     shown as running for minutes because the whole of phase 2 ran inside the
//     hook's await.
//
// IO is the injected `ExitFlowUi` port, structurally Pi's `ExtensionUIContext`,
// so a test drives every branch with a fake and this module never reaches for a
// terminal. Every dialog carries the abort signal, so a session replacement
// ends the flow rather than leaving a dialog open over a session that is gone.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { PLAN_INTENT_TOOL } from "./authoring.js";
import {
	type PlanReview,
	partitionFindings,
	readPlanReview,
	renderFindings,
	walkFindings,
} from "./findings.js";
import type { ExitMode, ModeName } from "./mode.js";
import { workflowInputFile } from "./paths.js";
import {
	deletePendingExit,
	MAX_INTENT_LENGTH,
	PENDING_EXIT_SCHEMA_VERSION,
	type PendingExit,
	PendingExitError,
	readPendingExit,
	writePendingExit,
} from "./pending-exit.js";
import {
	DEFAULT_GATES,
	inspectPlan,
	isRefName,
	type Plan,
	type PlanPolicy,
	type PlanReport,
	type PublishMode,
	resolvePolicy,
	withExplicitDiverse,
} from "./plan.js";
import { PLAN_WORKFLOW_REF, renderHandoff } from "./plan-command.js";
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
 * The dialog primitives phase 1 uses, structurally Pi's `ExtensionUIContext`.
 *
 * `confirm` and `editor` are unused here and declared anyway: phase 2 asks
 * with both (the readiness confirmations, the compiled-document editor), and a
 * port that grows when the second half lands would make every fake in the tests
 * a separate shape from the real thing.
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
 * Phase 1, straddling the posture change.
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

/** The seam this file replaced: no dialogs, no record, an ordinary switch. */
export const beginModeExit: ModeExitHook = () => "switch";

/**
 * Structurally an `ExtensionCommandContext`; only these three are read.
 *
 * The conversation itself is NOT read here any more. Phase 1 used to mine the
 * last user message for a one-line intent, which is the model's reading to do
 * and is now the model's job: it writes the description and submits it through
 * `plan_intent`.
 */
export interface ModeExitContext {
	readonly ui: ExitFlowUi;
	/** Dialog-capable UI. A session without one cannot be asked two questions. */
	readonly hasUI?: boolean;
	readonly sessionManager?: { getSessionId(): string };
}

// ── Step 1 ───────────────────────────────────────────────────────────────────

export const EXIT_COMPILE = "Compile it into a workflow run";
export const EXIT_SWITCH_ONLY = "Just switch mode";
export const EXIT_KEEP_PLANNING = "Keep planning";

export type ExitStart = "compile" | "switch" | "keep";

/**
 * Escape is not a fourth option: it is *Keep planning*, said with a key — and
 * *Keep planning* is listed first, because that is what escape takes.
 */
export const EXIT_START_OPTIONS: readonly ExitOption<ExitStart>[] = [
	{ value: "keep", text: EXIT_KEEP_PLANNING, fallback: true },
	{ value: "compile", text: EXIT_COMPILE },
	{ value: "switch", text: EXIT_SWITCH_ONLY },
];

export const EXIT_START_TITLE =
	"There is a conversation but no plan. What now?";

// ── Steps 2-4 ────────────────────────────────────────────────────────────────

/**
 * One option of a `select`, and whether it is the one escape takes.
 *
 * The default lives on the option rather than beside the list, so the label a
 * human reads and the value an escape produces cannot drift apart — there is
 * one `fallback: true` per table and the `(default)` suffix is derived from it.
 */
export interface ExitOption<T> {
	readonly value: T;
	readonly text: string;
	readonly fallback?: true;
}

export function optionLabel<T>(option: ExitOption<T>): string {
	return option.fallback ? `${option.text} (default)` : option.text;
}

export function optionLabels<T>(options: readonly ExitOption<T>[]): string[] {
	return options.map(optionLabel);
}

/** The chosen value, or the table's default when the dialog was escaped. */
export function chosenOption<T>(
	options: readonly ExitOption<T>[],
	label: string | undefined,
): T {
	const fallback = options.find((option) => option.fallback);
	if (!fallback)
		throw new Error("an exit-flow option table needs exactly one default");
	if (label === undefined) return fallback.value;
	return (options.find((option) => optionLabel(option) === label) ?? fallback)
		.value;
}

/**
 * The three efforts, with the default first.
 *
 * Derived from `EFFORTS` rather than written out, so a fourth effort cannot be
 * added to the schema without appearing here — and reordered so that the row a
 * `select` highlights is the row escape would take.
 */
export const EFFORT_OPTIONS: readonly ExitOption<Effort>[] = [
	{ value: DEFAULT_EFFORT, text: DEFAULT_EFFORT, fallback: true as const },
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

// ── The two steers ───────────────────────────────────────────────────────────

/**
 * What the model is asked for first: the description, not the plan.
 *
 * The description is the yardstick — it is what the blind reviewer is told the
 * plan is FOR, and a reviewer given the plan as its own justification can only
 * check the plan against itself. It comes from the model rather than from a
 * human typing one line into a dialog, because the conversation already
 * contains it and a human retyping their own intent is the flow asking them to
 * do the model's reading for it. It comes back through a TOOL because a
 * sentence in a transcript is a sentence somebody has to parse out again.
 */
export function renderIntentSteer(): string {
	return [
		"Before the plan: say what we are doing, and why.",
		"",
		"Write two or three sentences, from this conversation, that a reader who" +
			" has not seen it would understand: what we are setting out to do, and" +
			" why it is worth doing. Not a title, not the plan, not a list of steps" +
			" — the thing the plan will be judged against.",
		"",
		"Submit them with `plan_intent { summary }` and stop there. I will be" +
			" shown exactly what you write and I will agree to it, edit it, or send" +
			" us back to the conversation; the `plan` tool opens once I have agreed.",
		"",
		"Do not ask me to write it for you, and do not start a run.",
	].join("\n");
}

/**
 * What the model is asked for once the description is agreed.
 *
 * The policy block is quoted rather than described. It is a set of decisions
 * that have already been made — one in a dialog, one by default, one derived
 * from this repository — it is digest-bound once it is on the document, and a
 * model that re-derives "what they probably meant by standard effort" produces
 * a plan whose policy nobody chose. So the instruction is to copy it.
 *
 * `gates` is the one field with a licence to move, and it is written as a
 * narrow one: `every-deliverable` stops the run for a human after every single
 * deliverable, which is right when the conversation asked for exactly that and
 * is otherwise a run that never finishes without a babysitter.
 */
export function renderExitSteer(policy: PlanPolicy): string {
	return [
		"The description is agreed and the `plan` tool is available now. The document is what I am asking for.",
		"",
		"Call `plan` once with the whole plan from the conversation we just had:" +
			" every repository, every deliverable, its `after` and `reads` edges, its" +
			" implementation tasks and its review tasks. Write it from the" +
			" conversation — do not ask me to restate it, and do not narrow it to the" +
			" part that is easy to write down.",
		"",
		"Include this `policy` block verbatim, as `policy` at the top level of the document:",
		"",
		"```json",
		JSON.stringify(policy, null, 2),
		"```",
		"",
		"Those are decisions already made: the effort I chose in the dialog, the" +
			" gates this seat defaults to, and the publication derived from this" +
			" repository. Copy the block exactly: do not change a field, do not drop" +
			" one, and do not add one.",
		"",
		`One exception, and only one: raise \`gates\` to \`every-deliverable\` if — and` +
			" only if — this conversation asked for a check after every deliverable." +
			" Nothing else in the block moves.",
		"",
		"Give a deliverable its own `stages` array wherever this conversation" +
			" implied more than the default list (`implement` → `verify-and-fix` →" +
			" `review-fan-out`): a different number of fix rounds, the review lenses" +
			" we actually named, or a `gate` a human has to answer inside the run. A" +
			" deliverable the conversation treated as ordinary needs no `stages` at" +
			" all — it gets the default list, derived from the policy above.",
		"",
		"Then stop. This message asks for the stored document and nothing else:" +
			" do not start a run and do not decide anything on my behalf.",
	].join("\n");
}

// ── The flow ─────────────────────────────────────────────────────────────────

export interface ExitFlowDeps {
	readonly ui: ExitFlowUi;
	readonly sessionId: string;
	/** The posture the human asked for, and will be given when the run starts. */
	readonly wanted: ExitMode;
	/** The seat's own switch. Phase 1 calls it ONLY for *Just switch mode*. */
	readonly setMode: (name: ModeName) => void;
	/**
	 * How the model is asked for the description. Optional: a host with no
	 * steering channel keeps the record and gets the instruction printed, so
	 * the exit still completes whenever the description is eventually written.
	 */
	readonly sendUserMessage?: (
		content: string,
		options?: { readonly deliverAs?: "steer" | "followUp" },
	) => void;
	/** Where the work goes. Injected so the tests do not need a repository. */
	readonly publication?: () => DerivedPublication;
	readonly agentDir?: string;
	/** Aborts every open dialog; a session replacement ends the flow. */
	readonly signal?: AbortSignal;
	readonly now?: () => string;
}

export type ExitFlowOutcome =
	/** *Keep planning*, or escape at step 1. Nothing moved. */
	| { readonly kind: "keep-planning" }
	/** *Just switch mode*: the posture changes, no record, no steer. */
	| { readonly kind: "switch-only" }
	/**
	 * The two answers on disk, the posture still `plan`, and the model asked to
	 * describe the work.
	 */
	| {
			readonly kind: "compiled";
			readonly record: PendingExit;
			readonly steer: string;
			readonly path: string;
			/** Exactly how many dialogs were opened. Two, always. */
			readonly asked: number;
	  }
	/** A session replacement mid-flow. The posture is untouched. */
	| { readonly kind: "aborted" }
	/** A record this build cannot believe; the human is told to remove it. */
	| { readonly kind: "refused"; readonly problem: string };

/** Internal control flow for "the session went away while a dialog was open". */
class ExitAborted extends Error {}

export async function runExitFlowPhase1(
	deps: ExitFlowDeps,
): Promise<ExitFlowOutcome> {
	const { ui, sessionId, signal } = deps;
	const now = deps.now ?? (() => new Date().toISOString());
	let asked = 0;

	// A record from an exit that never finished is read before anything is
	// asked: it is the thing that keeps the exit's tools open in plan mode, so a
	// record nobody can parse has to stop the flow loudly rather than be
	// overwritten by a fresh one that hides it.
	try {
		readPendingExit(sessionId, deps.agentDir);
	} catch (error) {
		const problem =
			error instanceof PendingExitError
				? error.message
				: `pending-exit record for this session could not be read: ${String(error)}`;
		ui.notify(problem, "error");
		return { kind: "refused", problem };
	}

	/** Every dialog goes through here, so every dialog carries the signal. */
	const ask = async <T>(open: () => Promise<T>): Promise<T> => {
		if (signal?.aborted) throw new ExitAborted();
		asked++;
		const answer = await open();
		// An aborted dialog resolves like an escaped one, and the two mean
		// opposite things, so the signal is what is believed.
		if (signal?.aborted) throw new ExitAborted();
		return answer;
	};
	const opts = signal ? { signal } : undefined;
	const select = <T>(
		title: string,
		options: readonly ExitOption<T>[],
	): Promise<T> =>
		ask(() => ui.select(title, optionLabels(options), opts)).then((label) =>
			chosenOption(options, label),
		);

	try {
		// 1 — the only step that can end the flow without changing anything.
		const start = await select(EXIT_START_TITLE, EXIT_START_OPTIONS);
		if (start === "keep") {
			// No exit is in progress, so no record may claim there is one.
			deletePendingExit(sessionId, deps.agentDir);
			return { kind: "keep-planning" };
		}
		if (start === "switch") {
			deletePendingExit(sessionId, deps.agentDir);
			deps.setMode(deps.wanted);
			return { kind: "switch-only" };
		}

		// 2 — the one dial a repository cannot answer.
		const effort = await select(EFFORT_TITLE, EFFORT_OPTIONS);

		// Not a dialog: read off the repository and said out loud. `policy` is
		// still where it can be changed, and the plan carries it.
		const publication = (deps.publication ?? DEFAULT_PUBLICATION)();
		ui.notify(publication.why, "info");
		const publish = publicationPolicy(publication);
		if (publish.base !== undefined && !isRefName(publish.base)) {
			// Caught here rather than by `inspectPlan` three steps later. A base
			// branch this seat derived and Git would refuse is a bug in the
			// derivation, and the human is owed the name it arrived at.
			const problem = `\`${publish.base}\` is not a valid branch name, so nothing was recorded and the posture is unchanged.`;
			ui.notify(problem, "error");
			return { kind: "refused", problem };
		}

		// The commit: one synchronous step, in this order. THE POSTURE DOES NOT
		// MOVE. The record is what opens `plan_intent` in plan mode, and it is
		// written before the model is asked so that the description's own
		// `tool_result` can find it however fast the answer comes back.
		if (signal?.aborted) throw new ExitAborted();
		const policy: PlanPolicy = { effort, gates: DEFAULT_GATES, publish };
		const record: PendingExit = {
			schemaVersion: PENDING_EXIT_SCHEMA_VERSION,
			sessionId,
			policy,
			wanted: deps.wanted,
			createdAt: now(),
		};
		const path = writePendingExit(record, deps.agentDir);
		const steer = renderIntentSteer();
		if (deps.sendUserMessage) {
			deps.sendUserMessage(steer, { deliverAs: "followUp" });
			ui.notify(
				`Effort ${effort}, gates ${DEFAULT_GATES}, publication ${publish.mode}${
					publish.base ? ` onto \`${publish.base}\`` : ""
				}. You are still in plan mode — \`/mode ${deps.wanted}\` happens when the run starts. The model has been asked to say what we are doing; the exit is recorded at ${path}.`,
				"info",
			);
		} else {
			// R1: no steering channel. The record stays, so the exit completes
			// whenever the description is written; the instruction is printed so it
			// can be handed over by hand rather than lost.
			ui.notify(
				`Recorded at ${path}, and the posture is unchanged. This host cannot steer the session, so ask for the description yourself.\n\n${steer}`,
				"warning",
			);
		}
		return { kind: "compiled", record, steer, path, asked };
	} catch (error) {
		if (!(error instanceof ExitAborted)) throw error;
		// The session was replaced under an open dialog. Nothing was committed,
		// and any record left by an earlier exit is dropped: an aborted flow is
		// not an exit in progress, and a record that says otherwise would keep
		// the exit's tools open in plan mode forever.
		deletePendingExit(sessionId, deps.agentDir);
		return { kind: "aborted" };
	}
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
 * *Agree* is first and is what escape takes: the sentences were written from
 * this conversation and shown in full, so the cheap answer is the likely one,
 * and the two expensive answers — rewriting it, and throwing the exit away —
 * are both deliberate keystrokes.
 */
export const INTENT_OPTIONS: readonly ExitOption<"agree" | "edit" | "back">[] =
	[
		{ value: "agree", text: INTENT_AGREE, fallback: true },
		{ value: "edit", text: INTENT_EDIT },
		{ value: "back", text: INTENT_BACK },
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

export interface IntentAgreementDeps {
	readonly record: PendingExit;
	/** What `plan_intent` submitted, already validated by the tool. */
	readonly summary: string;
	readonly ui: ExitFlowUi;
	readonly agentDir?: string;
	readonly signal?: AbortSignal;
	readonly gate?: DialogGate;
	readonly sendUserMessage?: ExitFlowDeps["sendUserMessage"];
}

export type IntentAgreementOutcome =
	/** Agreed: the record carries it, and the `plan` tool's window is open. */
	| {
			readonly kind: "agreed";
			readonly record: PendingExit;
			readonly steer: string;
			readonly asked: number;
	  }
	/** *Back to the conversation*: the record is gone, the posture is plan. */
	| { readonly kind: "back"; readonly asked: number }
	| { readonly kind: "aborted" }
	| { readonly kind: "refused"; readonly problem: string };

/**
 * One dialog over the description the model submitted.
 *
 * It is the gate on the `plan` tool, so every path out of it settles the
 * record: agreeing writes the description onto it, going back deletes it, and
 * an abort deletes it — there is no state in which a window is open and nobody
 * is answering for it.
 */
export async function runIntentAgreement(
	deps: IntentAgreementDeps,
): Promise<IntentAgreementOutcome> {
	const { ui, record } = deps;
	const dialogs = createExitDialogs(ui, {
		...(deps.signal ? { signal: deps.signal } : {}),
		...(deps.gate ? { gate: deps.gate } : {}),
	});
	let summary = deps.summary.trim();
	try {
		for (;;) {
			const choice = await dialogs.choose(
				intentDialogTitle(summary),
				INTENT_OPTIONS,
			);
			if (choice === "back") {
				deletePendingExit(record.sessionId, deps.agentDir);
				ui.notify(
					`Nothing was recorded and you are still in plan mode — the conversation continues here. Run \`/mode ${record.wanted}\` again when the description is one we agree on.`,
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
				if (next.length > MAX_INTENT_LENGTH) {
					ui.notify(
						`That description is ${next.length} characters, past the ${MAX_INTENT_LENGTH} the record holds. Nothing changed.`,
						"warning",
					);
					continue;
				}
				summary = next;
				continue;
			}
			const agreed: PendingExit = { ...record, intent: summary };
			try {
				writePendingExit(agreed, deps.agentDir);
			} catch (error) {
				const problem = `The agreed description was not recorded: ${
					error instanceof Error ? error.message : String(error)
				}`;
				ui.notify(problem, "error");
				deletePendingExit(record.sessionId, deps.agentDir);
				return { kind: "refused", problem };
			}
			const steer = renderExitSteer(agreed.policy);
			if (deps.sendUserMessage) {
				deps.sendUserMessage(steer, { deliverAs: "followUp" });
				ui.notify(
					"Agreed. The model has been asked for the plan; the posture is still plan until the run starts.",
					"info",
				);
			} else {
				ui.notify(
					`Agreed. This host cannot steer the session, so ask for the plan yourself.\n\n${steer}`,
					"warning",
				);
			}
			return { kind: "agreed", record: agreed, steer, asked: dialogs.asked() };
		}
	} catch (error) {
		if (error instanceof ExitAborted) {
			deletePendingExit(record.sessionId, deps.agentDir);
			return { kind: "aborted" };
		}
		const problem = `The plan-mode exit stopped: ${
			error instanceof Error ? error.message : String(error)
		}`;
		ui.notify(problem, "error");
		deletePendingExit(record.sessionId, deps.agentDir);
		return { kind: "refused", problem };
	}
}

// ── The `/mode` hook ─────────────────────────────────────────────────────────

export interface ModeExitControllerDeps {
	/** The seat's switch. Called at the hand-off, and by *Just switch mode*. */
	readonly setMode: (name: ModeName) => void;
	readonly sendUserMessage?: ExitFlowDeps["sendUserMessage"];
	readonly agentDir?: string;
	/** Where publication is derived. Defaults to `process.cwd()`. */
	readonly cwd?: string;
	readonly upstreamHead?: () => string | null;
	readonly originPresent?: () => boolean;
	readonly ghPresent?: () => boolean;
	readonly now?: () => string;
	/**
	 * Reconcile the live tool set.
	 *
	 * The exit no longer changes the mode when it starts, and the mode change
	 * is what used to make the seat re-derive which tools it holds. So every
	 * point where the pending record appears, gains its description, or goes
	 * has to say so — otherwise `plan_intent` and `plan` are declared available
	 * and never handed to the host.
	 */
	readonly retools?: () => void;
	/** Phase 2's plan store. A getter: the seat builds lazily. */
	readonly store?: () => ExitPlanStore;
	/** Phase 2's audited Bash, built per flow from the session's own context. */
	readonly bash?: (ctx: ToolResultContext) => AuditedBash | undefined;
	/** Phase 2's workflow runtime, acquired per flow. */
	readonly workflow?: (
		ctx: ToolResultContext,
		notify: ExitFlowUi["notify"],
	) => Promise<WorkflowReadClient | undefined>;
	/** Phase 2 itself. Overridable so a test can watch the trigger fire. */
	readonly phase2?: ExitFlowPhase2Hook;
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
}

/** A `tool_result` context, as the phase-2 trigger reads one. */
export interface ToolResultContext {
	readonly ui: ExitFlowUi;
	readonly hasUI?: boolean;
	readonly sessionManager?: { getSessionId(): string };
}

export interface ModeExitController {
	/** The `/mode` hook: phase 1 when leaving plan mode, nothing otherwise. */
	readonly hook: ModeExitHook;
	/**
	 * The `tool_result` hook.
	 *
	 * RETURNS BEFORE ANY DIALOG IS ANSWERED. Both triggers — the description
	 * and the plan — open dialogs, and a dialog awaited here is a tool call the
	 * model and the human both watch spin. The work is scheduled detached and
	 * reports its own failures through `notify`.
	 */
	readonly onToolResult: (
		event: ToolResultLike,
		ctx: ToolResultContext,
	) => Promise<void>;
	/** Resolves once the detached work, if any, has finished. For tests. */
	settled(): Promise<void>;
	/** A session replacement: abort the open dialog and drop the record. */
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
	let detachedController: AbortController | undefined;
	let inFlight: Promise<void> | undefined;
	let last: ExitFlowOutcome | undefined;
	const gate = deps.gate ?? createDialogGate();
	const cwd = deps.cwd ?? process.cwd();
	const retools = (): void => deps.retools?.();

	const hook: ModeExitHook = async (previous, next, ctx) => {
		// Only the way out of plan mode, and only where dialogs exist: a session
		// that cannot be asked two questions gets the switch it asked for rather
		// than a silent set of defaults nobody chose.
		if (previous !== "plan" || next === "plan") return "switch";
		const sessionId = ctx.sessionManager?.getSessionId();
		if (!ctx.hasUI || !sessionId) return "switch";

		controller = new AbortController();
		try {
			const outcome = await runExitFlowPhase1({
				ui: ctx.ui,
				sessionId,
				wanted: next,
				setMode: deps.setMode,
				signal: controller.signal,
				...(deps.sendUserMessage
					? { sendUserMessage: deps.sendUserMessage }
					: {}),
				publication: () =>
					derivePublication({
						originPresent: deps.originPresent ?? (() => gitOriginPresent(cwd)),
						ghPresent: deps.ghPresent ?? ghOnPath,
						upstreamHead: deps.upstreamHead ?? (() => gitUpstreamHead(cwd)),
					}),
				...(deps.agentDir ? { agentDir: deps.agentDir } : {}),
				...(deps.now ? { now: deps.now } : {}),
			});
			last = outcome;
			switch (outcome.kind) {
				case "switch-only":
					// The one branch that moved the posture, in its own order.
					return "settled";
				default:
					// Everything else leaves the seat in plan mode — including the
					// compiled one, which is the whole point of the redesign: the
					// mode moves when the run starts, and not before.
					return "stay";
			}
		} finally {
			controller = undefined;
			// The record either appeared or went; either way the tool set moved.
			retools();
		}
	};

	/**
	 * Run dialogs off the tool-result hook's stack.
	 *
	 * `void`, deliberately: the hook returns immediately and this reports its
	 * own failures, because a rejection nobody is awaiting is an unhandled one
	 * and a dialog sequence awaited inside a `tool_result` hook is a tool call
	 * shown as running until the human answers it.
	 */
	const detach = (
		ctx: ToolResultContext,
		work: (signal: AbortSignal) => Promise<void>,
	): void => {
		const own = new AbortController();
		detachedController = own;
		const running = (async () => {
			try {
				await work(own.signal);
			} catch (error) {
				try {
					ctx.ui.notify(
						`The plan-mode exit stopped: ${
							error instanceof Error ? error.message : String(error)
						}`,
						"error",
					);
				} catch {
					// The session that would be told is gone. The record has already
					// been settled by the flow itself; there is nothing else to do.
				}
			} finally {
				// Both are set together by this call, so both are cleared together
				// — and only by the call that set them, never by a newer one.
				if (detachedController === own) {
					detachedController = undefined;
					inFlight = undefined;
				}
				retools();
			}
		})();
		inFlight = running;
	};

	/**
	 * The two triggers, and the one rule they share.
	 *
	 * The session id is read from THIS hook's own context, never from the id
	 * the `/mode` handler happened to learn earlier: a call arriving in a
	 * session that replaced the one that answered phase 1 must not be read as
	 * the continuation of that exit. `readPendingExit` refuses a record naming
	 * another session by name, and this is the other half of that guarantee.
	 */
	const onToolResult = async (
		event: ToolResultLike,
		ctx: ToolResultContext,
	): Promise<void> => {
		const summary = submittedIntent(event);
		const slug = summary === undefined ? storedSlug(event) : undefined;
		if (summary === undefined && slug === undefined) return;
		// One flow at a time. A second call while a dialog is open is not a
		// second exit; the record it would read is the one in play.
		if (inFlight) return;
		let sessionId: string | undefined;
		try {
			sessionId = ctx.sessionManager?.getSessionId();
		} catch {
			// A replaced session throws from its own context: there is nothing
			// left to continue, and nothing to record.
			return;
		}
		if (!sessionId) return;
		let record: PendingExit | null;
		try {
			record = readPendingExit(sessionId, deps.agentDir);
		} catch (error) {
			// Refused by name, exactly as phase 1 refuses it: a record nobody can
			// parse must not be read as "no exit in progress".
			ctx.ui.notify(
				error instanceof PendingExitError ? error.message : String(error),
				"error",
			);
			return;
		}
		if (!record) return;
		const pending = record;

		if (summary !== undefined) {
			if (!ctx.hasUI) {
				// The description cannot be agreed here, and an unagreed record is a
				// window that would never open. It goes, said out loud.
				deletePendingExit(sessionId, deps.agentDir);
				ctx.ui.notify(
					"This session has no dialogs, so the description cannot be agreed and the exit was dropped. Nothing changed and you are still in plan mode.",
					"info",
				);
				retools();
				return;
			}
			detach(ctx, async (signal) => {
				await runIntentAgreement({
					record: pending,
					summary,
					ui: ctx.ui,
					gate,
					signal,
					...(deps.agentDir ? { agentDir: deps.agentDir } : {}),
					...(deps.sendUserMessage
						? { sendUserMessage: deps.sendUserMessage }
						: {}),
				});
			});
			return;
		}

		if (slug === undefined) return;
		if (pending.intent === undefined) {
			// The `plan` tool is withheld until the description is agreed, so a
			// stored plan here means a host kept a stale tool set. The record
			// stays: the description is still the next step.
			ctx.ui.notify(
				`\`${slug}\` was stored before we agreed what we are doing, so the exit did not continue. Submit the two or three sentences with \`plan_intent\` and answer the dialog.`,
				"warning",
			);
			return;
		}
		if (!ctx.hasUI) {
			// The dialogs cannot be asked here, and the record is what holds the
			// `plan` tool open. It goes, with the fallback said out loud.
			deletePendingExit(sessionId, deps.agentDir);
			ctx.ui.notify(
				storedWithoutRunning(
					slug,
					pending.wanted,
					"This session has no dialogs.",
				),
				"info",
			);
			retools();
			return;
		}
		const acquire = deps.workflow;
		const bash = deps.bash?.(ctx);
		const notify: ExitFlowUi["notify"] = (message, type) =>
			ctx.ui.notify(message, type);
		detach(ctx, async (signal) => {
			const run = deps.phase2 ?? continueModeExit;
			await run({
				record: pending,
				slug,
				ui: ctx.ui,
				gate,
				signal,
				setMode: deps.setMode,
				...(deps.agentDir ? { agentDir: deps.agentDir } : {}),
				...(deps.store ? { store: deps.store() } : {}),
				...(bash ? { bash } : {}),
				...(acquire ? { workflow: () => acquire(ctx, notify) } : {}),
				...(deps.sendUserMessage
					? { sendUserMessage: deps.sendUserMessage }
					: {}),
				...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
			});
		});
	};

	return {
		hook,
		onToolResult,
		settled: async () => {
			// A flow can schedule nothing more than itself, so one await is enough.
			await inFlight;
		},
		abort: () => {
			controller?.abort();
			detachedController?.abort();
		},
		notePromptStart: gate.promptStart,
		notePromptEnd: gate.promptEnd,
		last: () => last,
	};
}

// ── Phase 2 ──────────────────────────────────────────────────────────────────
//
// The other half of the exit, and the half that has a plan. It starts from the
// `tool_result` of the model's own `plan` call — `toolName === "plan"`, the
// result says it stored, and a pending record with an AGREED description exists
// for that session — and it ends with either a run the model requests in the
// open, or a plan that is stored and nothing else.
//
// Four rules run through all of it:
//
//   - **NOTHING THE PLAN ALREADY ANSWERS IS ASKED.** Readiness asks nothing
//     when the machine is ready. The review lenses are not asked about at all:
//     the plan and `policy.reviewDefault` decide them, heavy implies diverse,
//     and the compiled-document dialog is where a reviewer is changed. Three
//     dialogs per deliverable to re-state what the document already said were
//     three dialogs a human learned to escape through.
//   - **THE STORED PLAN IS NORMALISED ONCE, BEFORE ANYTHING READS IT.** Every
//     heavy lens gets `diverse` written down explicitly (`withExplicitDiverse`),
//     so this seat's compiler and pi-workflow's derive the same graph from the
//     same document.
//   - **EVERY TERMINAL PATH DELETES THE RECORD.** The record is what holds the
//     `plan` tool open in plan mode. Whether the exit ends in a run request, in
//     a stored plan, back in the conversation, in a refusal or in a session
//     replacement, it goes. The posture is still `plan` on every one of those
//     paths except the run, which is the only place `setMode` is called.
//   - **NOTHING HERE STARTS ANYTHING BUT THE BLIND REVIEW.** The only run this
//     module starts is the headless `plan-review`, through the runtime's own
//     allowlist. `plan-to-ship` stays the model's `workflow_run` call, in the
//     transcript. The only Bash is repository creation at 7a, through the
//     seat's audited tool, under this mode's confirmation policy.

/** The one workflow this seat may start itself. The runtime owns the allowlist. */
export const PLAN_REVIEW_REF = "plan-review";

/** How long the blind review may take before the flow stops waiting for it. */
export const DEFAULT_REVIEW_TIMEOUT_MS = 300_000;

// ── The dialog port ──────────────────────────────────────────────────────────

/**
 * A prompt opened by Pi or another extension, and the deferral it forces.
 *
 * Pi's dialogs have no queue: opening one over another replaces it and the
 * replaced promise never resolves. `parked-observer.ts` in `@vegardx/pi-workflow`
 * solves this by counting `ui_prompt_start`/`ui_prompt_end` and deferring; the
 * exit flow does the same, through this gate, so a phase-2 dialog never lands
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

/**
 * Every dialog phase 2 opens, through one door.
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

// ── Step 7: readiness ────────────────────────────────────────────────────────

export const DIRTY_CONTINUE = "Continue";
export const DIRTY_BACK = "Back to the conversation";

/**
 * A dirty tree is a warning, never a refusal — `probeReadiness` says so and so
 * does the plan store. Continuing is therefore the default: nothing has run
 * yet, every later dialog still gates the run, and the last of them is a
 * confirmation. What the human is owed is the sentence about HEAD, which the
 * problem's own message carries.
 */
export const DIRTY_OPTIONS: readonly ExitOption<"continue" | "back">[] = [
	{ value: "continue", text: DIRTY_CONTINUE, fallback: true },
	{ value: "back", text: DIRTY_BACK },
];

export function creationTitle(path: string): string {
	return `Create \`${path}\`?`;
}

// ── Step 12-13: the compiled document ────────────────────────────────────────

export const COMPILED_TITLE = "The run this compiles to — check it how?";
export const COMPILED_REVIEW = "Review it blind";
export const COMPILED_APPROVE = "Approve as is";
export const COMPILED_EDIT = "Edit";
export const EDITOR_TITLE = "The compiled stage document";

export const COMPILED_OPTIONS: readonly ExitOption<
	"review" | "approve" | "edit"
>[] = [
	{ value: "review", text: COMPILED_REVIEW, fallback: true },
	{ value: "approve", text: COMPILED_APPROVE },
	{ value: "edit", text: COMPILED_EDIT },
];

/** The same table without the reviewer, for a seat that cannot reach one. */
export const COMPILED_OPTIONS_UNREVIEWED: readonly ExitOption<
	"review" | "approve" | "edit"
>[] = [
	{ value: "approve", text: COMPILED_APPROVE, fallback: true },
	{ value: "edit", text: COMPILED_EDIT },
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

// ── Step 18-19: the run ──────────────────────────────────────────────────────

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

// ── The flow ─────────────────────────────────────────────────────────────────

/** The plan store, narrowed to what phase 2 reads and writes. */
export type ExitPlanStore = Pick<PlanStore, "loadPlan" | "savePlan">;

/**
 * What phase 2 is handed when the model's `plan` call stores a document.
 *
 * `record`, `slug`, `ui` are the hand-over from phase 1; everything else is
 * the world, injected so the whole flow is drivable from a test with a fake
 * UI, a fake provider and a fake Bash. An absent dependency is not an error:
 * a seat with no workflow runtime takes the documented fallback and ends with
 * the plan stored.
 */
export interface ExitFlowPhase2 {
	readonly record: PendingExit;
	/** The slug the `plan` tool reported storing. */
	readonly slug: string;
	readonly ui: ExitFlowUi;
	/**
	 * The seat's switch, called exactly once and only at the hand-off. Absent
	 * on a seat that cannot switch, which then ends with the plan stored in
	 * whatever posture it was already in.
	 */
	readonly setMode?: (name: ModeName) => void;
	readonly agentDir?: string;
	readonly signal?: AbortSignal;
	/** Where the stored plan is read from and accepted patches are written. */
	readonly store?: ExitPlanStore;
	/** The workflow runtime, acquired lazily; `undefined` once it has warned. */
	readonly workflow?: () => Promise<WorkflowReadClient | undefined>;
	/** The seat's audited Bash tool, for repository creation at 7a and nothing else. */
	readonly bash?: AuditedBash;
	/** Readiness's own view of the world; defaults to the real one. */
	readonly readiness?: ReadinessDeps;
	/** Validation for a patched plan; defaults to `inspectPlan`. */
	readonly inspect?: (plan: Plan) => PlanReport;
	readonly sendUserMessage?: (
		content: string,
		options?: { readonly deliverAs?: "steer" | "followUp" },
	) => void;
	/** Where the exported run input goes; defaults to `workflowInputFile`. */
	readonly inputPath?: (slug: string) => string;
	/** How the run input is exported. Injected so a test writes nowhere. */
	readonly writeInput?: (path: string, json: string) => void;
	readonly timeoutMs?: number;
	readonly gate?: DialogGate;
}

export type ExitFlowPhase2Hook = (
	phase2: ExitFlowPhase2,
) => void | Promise<void>;

export type ExitFlowPhase2Outcome =
	/** 19: the record is gone and the model has the run request. */
	| {
			readonly kind: "handed-off";
			readonly slug: string;
			readonly steer: string;
			readonly asked: number;
	  }
	/** 18 answered no, or a fallback: the plan is stored and nothing runs. */
	| {
			readonly kind: "stored";
			readonly slug: string;
			readonly why: string;
			readonly asked: number;
	  }
	/** 7b or 15 sent the human back, or a second review still blocked. */
	| {
			readonly kind: "back";
			readonly slug: string;
			readonly asked: number;
	  }
	/** A session replacement mid-flow. */
	| { readonly kind: "aborted" }
	/** Something this flow cannot proceed past, named. */
	| { readonly kind: "refused"; readonly problem: string };

export async function runExitFlowPhase2(
	deps: ExitFlowPhase2,
): Promise<ExitFlowPhase2Outcome> {
	const { ui, slug, record } = deps;
	const dialogs = createExitDialogs(ui, {
		...(deps.signal ? { signal: deps.signal } : {}),
		...(deps.gate ? { gate: deps.gate } : {}),
	});
	/** Every terminal path goes through here, so every one drops the record. */
	const settle = (outcome: ExitFlowPhase2Outcome): ExitFlowPhase2Outcome => {
		deletePendingExit(record.sessionId, deps.agentDir);
		return outcome;
	};
	const refuse = (problem: string): ExitFlowPhase2Outcome => {
		ui.notify(problem, "error");
		return settle({ kind: "refused", problem });
	};
	const stored = (why: string): ExitFlowPhase2Outcome => {
		ui.notify(storedWithoutRunning(slug, record.wanted, why), "info");
		return settle({ kind: "stored", slug, why, asked: dialogs.asked() });
	};
	const back = (message: string): ExitFlowPhase2Outcome => {
		ui.notify(backToConversation(slug, record.wanted, message), "info");
		return settle({ kind: "back", slug, asked: dialogs.asked() });
	};

	try {
		if (!deps.store)
			return refuse(
				`The stored plan \`${slug}\` cannot be read back, so the exit stops here.`,
			);
		let plan = deps.store.loadPlan(slug);
		if (!plan)
			return refuse(
				`\`${slug}\` was reported stored and is not in the plan store, so the exit stops here.`,
			);
		const policy = resolvePolicy(plan.policy);

		// ── 7 — readiness, and the two questions it can raise ────────────────
		let readiness = probeReadiness(plan.repos, plan.policy, deps.readiness);
		const missing = readiness.problems.filter(
			(problem) => problem.kind === "missing-path",
		);
		for (const problem of missing) {
			const commands = creationCommands(problem.repo.path, policy.publish.mode);
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
				publish: { mode: policy.publish.mode },
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

		// ── Normalisation — heavy implies diverse, written down ─────────────
		//
		// Before anything compiles this document, and before a human is shown a
		// graph derived from it. A heavy lens whose `diverse` is undefined is a
		// question two compilers answered differently; writing the answer into
		// the stored plan is what makes this seat's compiled document and
		// pi-workflow's agree, and it is the document the digest covers.
		const explicit = withExplicitDiverse(plan);
		if (explicit) {
			const report = (deps.inspect ?? inspectPlan)(explicit);
			if (report.errors.length > 0)
				return refuse(
					`Writing \`diverse\` onto this plan's heavy reviewers produced a plan that no longer validates, which is a bug in this seat:\n${report.errors
						.map((error) => `  - ${error}`)
						.join("\n")}`,
				);
			const saved = savePlanOrReport(deps, explicit, dialogs);
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

		// ── 11 through 17 — compile, show, review, walk the findings ─────────
		const client = await deps.workflow?.();
		if (!client)
			// The warning naming `/plan run` has already been shown by the
			// provider seam; this is the flow ending cleanly behind it.
			return stored("This seat has no workflow runtime to compile against.");

		const effort: Effort = resolvePolicy(plan.policy).effort;
		// The agreed description, which is what the blind reviewer is told the
		// plan is FOR. `record.intent` is present by construction — the `plan`
		// tool's window does not open without it — and the title is the honest
		// fallback for a record that somehow reached here without one.
		const intent = record.intent?.trim() || plan.title;
		let reviewable = true;
		let reviewsRun = 0;
		let straightToReview = false;
		let verdict: PlanReview | undefined;

		for (;;) {
			let document: CompiledStageDocument;
			try {
				document = compileStageDocument(plan);
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

			// What dialog 12 is about, all of it on screen before it is asked:
			// what we agreed we are doing, who is going to read the work, the
			// graph, and what it costs.
			ui.notify(
				[
					`Agreed: ${intent}`,
					renderReviewers(document),
					"",
					renderStageDocument(document),
					renderProjection(projection),
				].join("\n"),
				"info",
			);

			// 12 — asked once per time round this loop, and the loop only comes
			// back here on an edit or an unreachable reviewer.
			let action: "review" | "approve" | "edit";
			if (straightToReview) {
				straightToReview = false;
				action = "review";
			} else {
				action = await dialogs.choose(
					COMPILED_TITLE,
					reviewable ? COMPILED_OPTIONS : COMPILED_OPTIONS_UNREVIEWED,
				);
			}

			// 13 — the document as JSON, escape ≡ discard.
			if (action === "edit") {
				const edited = await dialogs.editor(
					EDITOR_TITLE,
					JSON.stringify(document, null, 2),
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
				const saved = savePlanOrReport(deps, rewritten.plan, dialogs);
				if (!saved) continue;
				plan = saved;
				continue;
			}

			if (action === "approve") break;

			// 14 — the blind review. No dialog, and no model turn: a review
			// reached through the model would have read the conversation.
			ui.notify("Reviewing the plan…", "info");
			const review = await runBlindReview(client, ui.notify, {
				plan,
				intent,
				compiled: document,
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
			if (reviewsRun >= 2)
				// 16 — the loop is over. Two blind reviews that both block is a
				// plan the conversation has to answer, not one more dialog.
				return back(
					renderFindings(
						review.findings,
						`The second blind review still blocks (\`${review.verdict}\`):`,
					),
				);
			const walk = await walkFindings({
				dialogs,
				findings: review.findings,
				plan,
				save: (next) => deps.store?.savePlan(next),
				...(deps.inspect ? { inspect: deps.inspect } : {}),
			});
			plan = walk.plan;
			if (walk.kind === "back")
				return back(
					renderFindings(
						review.findings,
						`The blind review says \`${review.verdict}\`:`,
					),
				);
			// Everything blocking was dismissed, with a reason for each: the
			// human has answered the review and the run is theirs to start.
			if (walk.accepted === 0) break;
			// 16 — recompile and re-review once, without asking 12 again.
			straightToReview = true;
		}

		// ── 18 — the last question, and the only one that starts anything ────
		const input = toWorkflowInput(plan, effort);
		const start = await dialogs.confirm(
			START_RUN_TITLE,
			[
				`\`${plan.slug}\` — ${plan.deliverables.length} deliverable${plan.deliverables.length === 1 ? "" : "s"}, effort ${effort}, gates ${policy.gates}.`,
				verdict ? `The blind review says \`${verdict.verdict}\`.` : undefined,
				`The run parks at its \`approve-plan\` checkpoint, so approving it is still a separate decision.`,
			]
				.filter((line): line is string => line !== undefined)
				.join("\n"),
		);
		if (!start) return stored("Nothing was started.");

		// ── 19 — the hand-off, made by the model, in the open ────────────────
		const path = (
			deps.inputPath ?? ((s: string) => workflowInputFile(s, deps.agentDir))
		)(plan.slug);
		const json = JSON.stringify(input, null, 2);
		try {
			(deps.writeInput ?? writeWorkflowInput)(path, json);
		} catch (error) {
			// The export is a convenience; the call itself travels in the steer.
			ui.notify(
				`The run input could not be written to ${path}: ${error instanceof Error ? error.message : String(error)}.`,
				"warning",
			);
		}
		const steer = renderHandoff(input, path, json);
		// THE ONE PLACE THE POSTURE MOVES, and it moves first: the run about to
		// be requested writes to worktrees and the session that requested it
		// should be the posture the human asked for at `/mode auto`, not plan.
		// Then the record goes — before the model is asked — because the next
		// `plan` call is a new document, not a continuation of this exit.
		deps.setMode?.(record.wanted);
		deletePendingExit(record.sessionId, deps.agentDir);
		if (deps.sendUserMessage) {
			deps.sendUserMessage(steer, { deliverAs: "followUp" });
			ui.notify(
				`Mode ${record.wanted}, and \`${plan.slug}\` is handed to the model as \`workflow_run { ref: "${PLAN_WORKFLOW_REF}" }\` at effort ${effort}. Approval is the run's \`approve-plan\` checkpoint, not this flow.`,
				"info",
			);
		} else {
			ui.notify(
				`This host cannot steer the session, so make the call yourself.\n\n${steer}`,
				"warning",
			);
		}
		return {
			kind: "handed-off",
			slug: plan.slug,
			steer,
			asked: dialogs.asked(),
		};
	} catch (error) {
		if (error instanceof ExitAborted) {
			// The session was replaced under an open dialog. The record goes with
			// it: an exit nobody is answering is not an exit in progress.
			deletePendingExit(record.sessionId, deps.agentDir);
			return { kind: "aborted" };
		}
		// Nothing in this flow throws into the session. A failure here is a
		// plan that is stored and an exit that ended, said out loud.
		return refuse(
			`The plan-mode exit stopped: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** `savePlan`, with the store's own refusal reported rather than thrown. */
function savePlanOrReport(
	deps: ExitFlowPhase2,
	plan: Plan,
	dialogs: ExitDialogs,
): Plan | undefined {
	try {
		deps.store?.savePlan(plan);
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

// ── The `tool_result` trigger ────────────────────────────────────────────────

/** A `tool_result` as this module reads one; structurally Pi's. */
export interface ToolResultLike {
	readonly toolName: string;
	readonly isError?: boolean;
	readonly details?: unknown;
}

/**
 * The slug a `plan` call stored, or nothing.
 *
 * Exactly the trigger spec 1.2 names: the `plan` tool, no error, and a result
 * that says it stored. Everything else — including a `plan` call that returned
 * validation errors — is not the end of a model turn this flow is waiting for.
 */
export function storedSlug(event: ToolResultLike): string | undefined {
	if (event.toolName !== "plan" || event.isError) return undefined;
	const details = event.details as
		| { stored?: unknown; slug?: unknown }
		| undefined;
	if (details?.stored !== true || typeof details.slug !== "string")
		return undefined;
	return details.slug;
}

/**
 * The description a `plan_intent` call submitted, or nothing.
 *
 * The same shape of trigger as `storedSlug`: the right tool, no error, and a
 * result that says it submitted. A refused submission — too long, not two or
 * three sentences — is the model's to send again, not a dialog to open.
 */
export function submittedIntent(event: ToolResultLike): string | undefined {
	if (event.toolName !== PLAN_INTENT_TOOL || event.isError) return undefined;
	const details = event.details as
		| { submitted?: unknown; summary?: unknown }
		| undefined;
	if (details?.submitted !== true || typeof details.summary !== "string")
		return undefined;
	const summary = details.summary.trim();
	return summary.length > 0 ? summary : undefined;
}

/** Phase 2, as the `tool_result` handler calls it. */
export const continueModeExit: ExitFlowPhase2Hook = async (phase2) => {
	await runExitFlowPhase2(phase2);
};
