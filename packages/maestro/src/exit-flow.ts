// The plan-mode exit, both halves: the questions a plan cannot answer, and
// what happens to the plan once the model has written it.
//
// Leaving plan mode is where a conversation becomes a run, and the flow is
// split by exactly one model turn because it has to be: a dialog sequence
// cannot obtain a plan document from a conversation, and the `plan` tool is
// withheld while the session is still in plan mode. So phase 1 asks the human
// what only a human knows — how much effort, which gates, where it publishes,
// what it is for — switches the posture, records the answers, and asks the
// model for the document. The model's turn writes the plan. Phase 2
// (`runExitFlowPhase2`, at the bottom of this file) picks it up from the
// `tool_result` of that very call: readiness, the review lenses, the compiled
// stage document, the blind review, the findings walk, and the one confirmation
// that turns all of it into a run request the model makes in the open.
//
// Two rules shape everything here:
//
//   - **NOTHING IS ASKED TWICE AND NOTHING IS ASSUMED SILENTLY.** Each dialog
//     is asked once, escape takes the documented default, and the answers end
//     up in the plan's own `policy` block — on the document, where a reviewer
//     and a receipt can both see them — rather than in a dialog transcript
//     nobody can check afterwards.
//   - **THE FLOW COMMITS ONCE, AT THE END.** The posture change, the record and
//     the steer are one synchronous step after the last dialog. Anything that
//     interrupts the questions leaves the session exactly where it was: plan
//     mode, no record, no message to the model.
//
// IO is the injected `ExitFlowUi` port, structurally Pi's `ExtensionUIContext`,
// so a test drives every branch with a fake and this module never reaches for a
// terminal. Every dialog carries the abort signal, so a session replacement
// ends the flow rather than leaving a dialog open over a session that is gone.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	type PlanReview,
	partitionFindings,
	readPlanReview,
	renderFindings,
	walkFindings,
} from "./findings.js";
import type { ModeName } from "./mode.js";
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
	type Deliverable,
	defaultStagesFor,
	isRefName,
	PLAN_GATES,
	type Plan,
	type PlanGates,
	type PlanPolicy,
	type PlanReport,
	type PublishMode,
	REVIEW_TIERS,
	type ResolvedPolicy,
	type ReviewFanOutStage,
	type ReviewLens,
	type ReviewTier,
	resolvePolicy,
	type Stage,
} from "./plan.js";
import { PLAN_WORKFLOW_REF, renderHandoff } from "./plan-command.js";
import {
	canonicalJson,
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

/** A session entry as this module reads one; structurally Pi's `SessionEntry`. */
export interface SessionEntryLike {
	readonly type: string;
	readonly message?: {
		readonly role?: string;
		readonly content?: unknown;
	};
}

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

/** Structurally an `ExtensionCommandContext`; only these three are read. */
export interface ModeExitContext {
	readonly ui: ExitFlowUi;
	/** Dialog-capable UI. A session without one cannot be asked six questions. */
	readonly hasUI?: boolean;
	readonly sessionManager?: {
		getSessionId(): string;
		getBranch(fromId?: string): readonly SessionEntryLike[];
	};
}

// ── Step 1 ───────────────────────────────────────────────────────────────────

export const EXIT_COMPILE = "Compile it into a workflow run";
export const EXIT_SWITCH_ONLY = "Just switch mode";
export const EXIT_KEEP_PLANNING = "Keep planning";

/** Escape is not a fourth option: it is *Keep planning*, said with a key. */
export const EXIT_START_OPTIONS = [
	EXIT_COMPILE,
	EXIT_SWITCH_ONLY,
	EXIT_KEEP_PLANNING,
] as const;

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

export const EFFORT_OPTIONS: readonly ExitOption<Effort>[] = EFFORTS.map(
	(effort) =>
		effort === DEFAULT_EFFORT
			? { value: effort, text: effort, fallback: true as const }
			: { value: effort, text: effort },
);

export const EFFORT_TITLE = "How much effort should the run spend?";

/**
 * The gate vocabulary, in the plan's words on one side and the human's on the
 * other. Derived from `PLAN_GATES` so a new gate cannot be added to the schema
 * without this table failing to compile.
 */
const GATE_TEXT: Readonly<Record<PlanGates, string>> = {
	"approve-plan": "approve-plan only",
	"approve-plan+ship": "approve-plan + ship",
	"every-deliverable": "every deliverable",
};

export const GATE_OPTIONS: readonly ExitOption<PlanGates>[] = PLAN_GATES.map(
	(gates) =>
		gates === DEFAULT_GATES
			? { value: gates, text: GATE_TEXT[gates], fallback: true as const }
			: { value: gates, text: GATE_TEXT[gates] },
);

export const GATE_TITLE = "Where should the run stop for a human?";

/**
 * Publication, which the exit asks about and `policy.publish` records.
 *
 * `pr` reads "pull request" here and nowhere else: the stored vocabulary is the
 * plan's, and a dialog that says `pr` to a human is a dialog written for the
 * schema rather than for the person answering it.
 */
export const PUBLICATION_OPTIONS: readonly ExitOption<PublishMode>[] = [
	{ value: "none", text: "none" },
	{ value: "branch", text: "branch" },
	{ value: "pr", text: "pull request", fallback: true },
];

export const PUBLICATION_TITLE = "What happens to the work when it is shipped?";

// ── Steps 5-6 ────────────────────────────────────────────────────────────────

export const BASE_BRANCH_TITLE = "Base branch to publish onto";

/** When the repository cannot say what it tracks, and the human is told. */
export const FALLBACK_BASE_BRANCH = "main";

export const INTENT_TITLE = "One line: what is this plan for?";

/**
 * The repository's current upstream head, or `null`.
 *
 * Shaped exactly like `gitRepoProbe`: one `execFileSync`, every failure the
 * same answer, because a caller cannot act differently on "no upstream", "not a
 * repository" and "no git at all" — all three mean the dialog has to offer
 * something else. The tracked branch first, then whatever `origin` calls its
 * head, because a detached or unpushed branch still publishes onto the default.
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

/**
 * The first line of the last thing the human said, as the intent's default.
 *
 * Slash commands are skipped: `/mode auto` is the message that opened this
 * dialog, and offering it back as "what this plan is for" would be the flow
 * quoting itself. Empty when the conversation offers nothing usable, which is
 * a legitimate answer — the intent is one line a human writes, not a summary
 * this flow is entitled to invent.
 */
export function lastUserLine(entries: readonly SessionEntryLike[]): string {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message" || entry.message?.role !== "user") continue;
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter(
								(part): part is { type: string; text: string } =>
									typeof part === "object" &&
									part !== null &&
									(part as { type?: unknown }).type === "text" &&
									typeof (part as { text?: unknown }).text === "string",
							)
							.map((part) => part.text)
							.join("\n")
					: "";
		const line = text
			.split("\n")
			.map((part) => part.trim())
			.find((part) => part.length > 0);
		if (!line || line.startsWith("/")) continue;
		return line.slice(0, MAX_INTENT_LENGTH);
	}
	return "";
}

// ── The steer ────────────────────────────────────────────────────────────────

/**
 * What the model is asked for, once the posture has moved.
 *
 * The policy block is quoted rather than described. It is a set of decisions a
 * human has already made, it is digest-bound once it is on the document, and a
 * model that re-derives "what they probably meant by standard effort" produces
 * a plan whose policy nobody chose. So the instruction is to copy it.
 */
export function renderExitSteer(policy: PlanPolicy, intent: string): string {
	const lines = [
		"Plan mode is over and the `plan` tool is available now. The document is what I am asking for.",
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
		"Those are decisions I have already made in the dialogs I just answered." +
			" Copy the block exactly: do not change a field, do not drop one, and do" +
			" not add one.",
		"",
		"Give a deliverable its own `stages` array wherever this conversation" +
			" implied more than the default list (`implement` → `verify-and-fix` →" +
			" `review-fan-out`): a different number of fix rounds, the review lenses" +
			" we actually named, or a `gate` a human has to answer inside the run. A" +
			" deliverable the conversation treated as ordinary needs no `stages` at" +
			" all — it gets the default list, derived from the policy above.",
	];
	if (intent.length > 0)
		lines.push(
			"",
			`I recorded one line for what this is for: "${intent}". Make the plan answer it.`,
		);
	lines.push(
		"",
		"Then stop. This message asks for the stored document and nothing else:" +
			" do not start a run and do not decide anything on my behalf.",
	);
	return lines.join("\n");
}

// ── The flow ─────────────────────────────────────────────────────────────────

export interface ExitFlowDeps {
	readonly ui: ExitFlowUi;
	readonly sessionId: string;
	/** The posture the human asked for. */
	readonly wanted: ModeName;
	/** The seat's own switch, called once, before the record is written. */
	readonly setMode: (name: ModeName) => void;
	/**
	 * How the model is asked for the document. Optional: a host with no
	 * steering channel keeps the record and gets the instruction printed, so
	 * the exit still completes whenever the plan is eventually written.
	 */
	readonly sendUserMessage?: (
		content: string,
		options?: { readonly deliverAs?: "steer" | "followUp" },
	) => void;
	/** The conversation, for the intent default. Absent means "cannot read it". */
	readonly entries?: () => readonly SessionEntryLike[];
	/** The base-branch default. Injected so the tests do not need a repository. */
	readonly upstreamHead?: () => string | null;
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
	/** The six answers, on disk and on their way to the model. */
	| {
			readonly kind: "compiled";
			readonly record: PendingExit;
			readonly steer: string;
			readonly path: string;
			/** Exactly how many dialogs were opened; 5 when nothing publishes. */
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
	// asked: it is the thing that keeps the `plan` tool open in plan mode, so a
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
		const start = await ask(() =>
			ui.select(EXIT_START_TITLE, [...EXIT_START_OPTIONS], opts),
		);
		if (start === undefined || start === EXIT_KEEP_PLANNING) {
			// No exit is in progress, so no record may claim there is one.
			deletePendingExit(sessionId, deps.agentDir);
			return { kind: "keep-planning" };
		}
		if (start === EXIT_SWITCH_ONLY) {
			deletePendingExit(sessionId, deps.agentDir);
			deps.setMode(deps.wanted);
			return { kind: "switch-only" };
		}

		// 2, 3, 4 — the dials, each asked once, escape taking the default.
		const effort = await select(EFFORT_TITLE, EFFORT_OPTIONS);
		const gates = await select(GATE_TITLE, GATE_OPTIONS);
		const publish = await select(PUBLICATION_TITLE, PUBLICATION_OPTIONS);

		// 5 — only when there is something to publish onto.
		let base: string | undefined;
		if (publish !== "none") {
			const probed = (deps.upstreamHead ?? (() => null))();
			const suggested = probed ?? FALLBACK_BASE_BRANCH;
			if (!probed)
				ui.notify(
					`This repository does not say what it tracks, so the base branch starts at \`${FALLBACK_BASE_BRANCH}\`. Change it in the next dialog if that is wrong.`,
					"warning",
				);
			const answered = await ask(() =>
				ui.input(BASE_BRANCH_TITLE, suggested, opts),
			);
			const chosen = (answered ?? "").trim();
			base = chosen.length > 0 ? chosen : suggested;
			if (!isRefName(base)) {
				// Caught here rather than by `inspectPlan` three steps later: the
				// human is still in front of the dialog that produced it.
				const problem = `\`${base}\` is not a valid branch name, so nothing was recorded and the posture is unchanged.`;
				ui.notify(problem, "error");
				return { kind: "refused", problem };
			}
		}

		// 6 — one line, defaulting to the last thing the human said.
		const conversation = deps.entries?.();
		if (!conversation)
			ui.notify(
				"This session cannot be read back, so the intent starts empty rather than guessed.",
				"warning",
			);
		const suggestedIntent = conversation ? lastUserLine(conversation) : "";
		const answeredIntent = await ask(() =>
			ui.input(INTENT_TITLE, suggestedIntent, opts),
		);
		const intent = ((answeredIntent ?? "").trim() || suggestedIntent).slice(
			0,
			MAX_INTENT_LENGTH,
		);

		// The commit: one synchronous step, in this order. The posture moves
		// first because it is what makes the `plan` tool available, and the
		// record is written before the model is asked so that phase 2 can find
		// it however fast the answer comes back.
		if (signal?.aborted) throw new ExitAborted();
		const policy: PlanPolicy = {
			effort,
			gates,
			publish: base === undefined ? { mode: publish } : { mode: publish, base },
		};
		const record: PendingExit = {
			schemaVersion: PENDING_EXIT_SCHEMA_VERSION,
			sessionId,
			policy,
			intent,
			createdAt: now(),
		};
		deps.setMode(deps.wanted);
		const path = writePendingExit(record, deps.agentDir);
		const steer = renderExitSteer(policy, intent);
		if (deps.sendUserMessage) {
			deps.sendUserMessage(steer, { deliverAs: "followUp" });
			ui.notify(
				`Mode ${deps.wanted}, and the model has been asked for the plan — effort ${effort}, gates ${gates}, publication ${publish}${base ? ` onto \`${base}\`` : ""}. The exit is recorded at ${path}.`,
				"info",
			);
		} else {
			// R1: no steering channel. The record stays, so the exit completes
			// whenever the plan is written; the instruction is printed so it can
			// be handed over by hand rather than lost.
			ui.notify(
				`Mode ${deps.wanted}. This host cannot steer the session, so ask for the plan yourself — the exit is recorded at ${path}.\n\n${steer}`,
				"warning",
			);
		}
		return { kind: "compiled", record, steer, path, asked };
	} catch (error) {
		if (!(error instanceof ExitAborted)) throw error;
		// The session was replaced under an open dialog. Nothing was committed,
		// and any record left by an earlier exit is dropped: an aborted flow is
		// not an exit in progress, and a record that says otherwise would keep
		// the `plan` tool open in plan mode forever.
		deletePendingExit(sessionId, deps.agentDir);
		return { kind: "aborted" };
	}
}

// ── The `/mode` hook ─────────────────────────────────────────────────────────

export interface ModeExitControllerDeps {
	/** The seat's switch. */
	readonly setMode: (name: ModeName) => void;
	readonly sendUserMessage?: ExitFlowDeps["sendUserMessage"];
	readonly agentDir?: string;
	/** Where the base-branch default is probed. Defaults to `process.cwd()`. */
	readonly cwd?: string;
	readonly upstreamHead?: () => string | null;
	readonly now?: () => string;
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
	/** The `tool_result` hook: phase 2 when the model's `plan` call stored one. */
	readonly onToolResult: (
		event: ToolResultLike,
		ctx: ToolResultContext,
	) => Promise<void>;
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
	let phase2Controller: AbortController | undefined;
	let phase2InFlight = false;
	let last: ExitFlowOutcome | undefined;
	const gate = deps.gate ?? createDialogGate();

	const hook: ModeExitHook = async (previous, next, ctx) => {
		// Only the way out of plan mode, and only where dialogs exist: a session
		// that cannot be asked the six questions gets the switch it asked for
		// rather than a silent set of defaults nobody chose.
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
				...(ctx.sessionManager
					? { entries: () => ctx.sessionManager?.getBranch() ?? [] }
					: {}),
				upstreamHead:
					deps.upstreamHead ??
					(() => gitUpstreamHead(deps.cwd ?? process.cwd())),
				...(deps.agentDir ? { agentDir: deps.agentDir } : {}),
				...(deps.now ? { now: deps.now } : {}),
			});
			last = outcome;
			switch (outcome.kind) {
				case "keep-planning":
				case "aborted":
				case "refused":
					return "stay";
				default:
					// Both `switch-only` and `compiled` moved the posture already,
					// in the order the flow needed.
					return "settled";
			}
		} finally {
			controller = undefined;
		}
	};

	/**
	 * The phase-2 trigger.
	 *
	 * The session id is read from THIS hook's own context, never from the id
	 * the `/mode` handler happened to learn earlier: a `plan` call arriving in
	 * a session that replaced the one that answered phase 1 must not be read as
	 * the continuation of that exit. `readPendingExit` refuses a record naming
	 * another session by name, and this is the other half of that guarantee.
	 */
	const onToolResult = async (
		event: ToolResultLike,
		ctx: ToolResultContext,
	): Promise<void> => {
		const slug = storedSlug(event);
		if (slug === undefined) return;
		// One flow at a time. A second `plan` call while phase 2 is mid-dialog
		// is not a second exit; the record it would read is the one in play.
		if (phase2InFlight) return;
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
		if (!ctx.hasUI) {
			// Six dialogs cannot be asked here, and the record is what holds the
			// `plan` tool open. It goes, with the fallback said out loud.
			deletePendingExit(sessionId, deps.agentDir);
			ctx.ui.notify(
				storedWithoutRunning(slug, "This session has no dialogs."),
				"info",
			);
			return;
		}
		phase2Controller = new AbortController();
		phase2InFlight = true;
		const acquire = deps.workflow;
		const bash = deps.bash?.(ctx);
		const notify: ExitFlowUi["notify"] = (message, type) =>
			ctx.ui.notify(message, type);
		try {
			const run = deps.phase2 ?? continueModeExit;
			await run({
				record,
				slug,
				ui: ctx.ui,
				gate,
				signal: phase2Controller.signal,
				...(deps.agentDir ? { agentDir: deps.agentDir } : {}),
				...(deps.store ? { store: deps.store() } : {}),
				...(bash ? { bash } : {}),
				...(acquire ? { workflow: () => acquire(ctx, notify) } : {}),
				...(deps.sendUserMessage
					? { sendUserMessage: deps.sendUserMessage }
					: {}),
				...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
			});
		} finally {
			phase2InFlight = false;
			phase2Controller = undefined;
		}
	};

	return {
		hook,
		onToolResult,
		abort: () => {
			controller?.abort();
			phase2Controller?.abort();
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
// result says it stored, and a pending record exists FOR THAT SESSION — and it
// ends with either a run request the model makes in the open, or a plan that is
// stored and nothing else.
//
// Three rules run through all of it:
//
//   - **NOTHING THE PLAN ALREADY ANSWERS IS ASKED.** Readiness asks nothing
//     when the machine is ready; a lens the plan tiered is not tiered again; a
//     cross-family reviewer is offered only where a heavy lens made it a real
//     question. The dialog count is a property of the plan, not of the flow.
//   - **EVERY TERMINAL PATH DELETES THE RECORD.** The record is what holds the
//     `plan` tool open in plan mode. Whether the exit ends in a run request, in
//     a stored plan, back in the conversation, in a refusal or in a session
//     replacement, it goes.
//   - **NOTHING HERE STARTS ANYTHING BUT THE BLIND REVIEW.** The only run this
//     module starts is the headless `plan-review`, through the runtime's own
//     allowlist. `plan-to-ship` stays the model's `workflow_run` call, in the
//     transcript. The only Bash is repository creation at 7a, through the
//     seat's audited tool, under this mode's confirmation policy.

/** The one workflow this seat may start itself. The runtime owns the allowlist. */
export const PLAN_REVIEW_REF = "plan-review";

/** How long the blind review may take before the flow stops waiting for it. */
export const DEFAULT_REVIEW_TIMEOUT_MS = 300_000;

/**
 * Lenses offered to a deliverable whose plan named no reviewer at all.
 *
 * Only then: a deliverable whose `tasks[].by` (or whose authored
 * `review-fan-out`) already names its reviewers has ANSWERED this question,
 * and the dialog over it exists so one can be dropped, not so three more can be
 * proposed. A plan that named nothing would otherwise compile to a run with no
 * independent reader at all, which is the one case worth offering a list for.
 */
export const STANDARD_LENSES = ["contracts", "tests", "risk"] as const;

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

// ── Step 8-10: the review lenses ─────────────────────────────────────────────

export const LENS_INCLUDE = "Include";
export const LENS_SKIP = "Skip";

export function lensTitle(deliverable: string, lens: string): string {
	return `Review \`${deliverable}\` through the \`${lens}\` lens?`;
}

export function tierTitle(deliverable: string, lens: string): string {
	return `How much reviewer is \`${lens}\` worth on \`${deliverable}\`?`;
}

export function crossFamilyTitle(deliverable: string): string {
	return `A cross-family reviewer on \`${deliverable}\`?`;
}

/** The tier table, with the plan's own default marked as the escape. */
export function tierOptions(
	fallback: ReviewTier,
): readonly ExitOption<ReviewTier>[] {
	return REVIEW_TIERS.map((tier) =>
		tier === fallback
			? { value: tier, text: tier, fallback: true as const }
			: { value: tier, text: tier },
	);
}

/** One lens a deliverable could be reviewed through, and where it came from. */
interface LensCandidate {
	readonly lens: ReviewLens;
	/** In the plan already: escape keeps it, and its tier is not re-asked. */
	readonly seeded: boolean;
	/** The plan pinned neither a tier nor a model, so step 9 has a question. */
	readonly untiered: boolean;
}

/** The review stage of a deliverable's authored stages, if it declared one. */
function authoredReviewStage(
	deliverable: Deliverable,
): ReviewFanOutStage | undefined {
	return deliverable.stages?.find(
		(stage): stage is ReviewFanOutStage => stage.use === "review-fan-out",
	);
}

/**
 * What step 8 asks about, for one deliverable.
 *
 * Seeded from the deliverable's own review intent — its authored
 * `review-fan-out` lenses when it has stages, otherwise the lenses
 * `defaultStagesFor` derives from `tasks[].by` — so escaping every dialog
 * leaves exactly the plan that was stored. The standard lenses are offered
 * only when that seed is empty; see `STANDARD_LENSES`.
 */
export function lensCandidates(
	deliverable: Deliverable,
	policy: ResolvedPolicy,
): readonly LensCandidate[] {
	const authored = authoredReviewStage(deliverable);
	if (authored)
		return authored.lenses.map((lens) => ({
			lens,
			seeded: true,
			untiered: lens.tier === undefined && lens.model === undefined,
		}));
	if (!deliverable.stages) {
		const seeded = defaultStagesFor(deliverable, policy).find(
			(stage): stage is ReviewFanOutStage => stage.use === "review-fan-out",
		);
		if (seeded)
			return seeded.lenses.map((lens, index) => {
				const by = deliverable.tasks.filter((task) => task.by)[index]?.by;
				return {
					lens,
					seeded: true,
					untiered: by?.tier === undefined && by?.model === undefined,
				};
			});
	}
	return STANDARD_LENSES.map((id) => ({
		lens: { id },
		seeded: false,
		untiered: true,
	}));
}

/**
 * The deliverable's stage list with its review lenses replaced.
 *
 * Returns `undefined` when nothing changed, which is what keeps escape honest:
 * a plan nobody edited is not rewritten, its digest does not move, and the
 * document a receipt is checked against is the one the model stored.
 */
export function deliverableWithLenses(
	deliverable: Deliverable,
	policy: ResolvedPolicy,
	lenses: readonly ReviewLens[],
): Deliverable | undefined {
	const current = deliverable.stages ?? defaultStagesFor(deliverable, policy);
	const existing = current.find(
		(stage): stage is ReviewFanOutStage => stage.use === "review-fan-out",
	);
	let next: Stage[];
	if (existing) {
		next =
			lenses.length === 0
				? current.filter((stage) => stage !== existing)
				: current.map((stage) =>
						stage === existing ? { ...existing, lenses } : stage,
					);
	} else if (lenses.length === 0) {
		next = [...current];
	} else {
		// A review stage the plan did not have. It goes after the work and
		// before any gate, because a gate is last by rule and a decision shown
		// review results has to come after them.
		const taken = new Set(current.map((stage) => stage.id));
		let id = "review";
		for (let n = 2; taken.has(id); n += 1) id = `review-${n}`;
		const review: Stage = {
			use: "review-fan-out",
			id,
			lenses,
			synthesis: "optional",
		};
		const gateAt = current.findIndex((stage) => stage.use === "gate");
		next = [...current];
		next.splice(gateAt === -1 ? next.length : gateAt, 0, review);
	}
	const before = deliverable.stages ?? defaultStagesFor(deliverable, policy);
	if (canonicalJson(before) === canonicalJson(next)) {
		// Identical to what the plan compiles to today. When the plan declared
		// no stages it keeps declaring none: materialising the default list
		// would change the document (and its digest) without changing the run.
		return deliverable.stages ? deliverable : undefined;
	}
	return { ...deliverable, stages: next };
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

/** What a human is told when the exit ends without a run. */
export function storedWithoutRunning(slug: string, why: string): string {
	return `${why} The plan is stored — start it whenever you like with \`/plan run ${slug}\`.`;
}

/** Back to the conversation, from a flow that already moved the posture. */
export function backToConversation(findings: string): string {
	return (
		`${findings}\n\n` +
		"Nothing is running. The plan is stored and the posture has already" +
		" changed, so `/mode plan` takes you back to the conversation to work" +
		" through these."
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
		ui.notify(storedWithoutRunning(slug, why), "info");
		return settle({ kind: "stored", slug, why, asked: dialogs.asked() });
	};
	const back = (message: string): ExitFlowPhase2Outcome => {
		ui.notify(backToConversation(message), "info");
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

		// ── 8, 9, 10 — the review lenses, per deliverable ────────────────────
		const deliverables: Deliverable[] = [];
		let lensesChanged = false;
		for (const deliverable of plan.deliverables) {
			const chosen: ReviewLens[] = [];
			for (const candidate of lensCandidates(deliverable, policy)) {
				const include = await dialogs.choose(
					lensTitle(deliverable.id, candidate.lens.id),
					[
						{
							value: true,
							text: LENS_INCLUDE,
							...(candidate.seeded ? { fallback: true as const } : {}),
						},
						{
							value: false,
							text: LENS_SKIP,
							...(candidate.seeded ? {} : { fallback: true as const }),
						},
					],
				);
				if (!include) continue;
				// 9 — only where the plan pinned neither a tier nor a model.
				if (!candidate.untiered) {
					chosen.push(candidate.lens);
					continue;
				}
				const tier = await dialogs.choose(
					tierTitle(deliverable.id, candidate.lens.id),
					tierOptions(policy.reviewDefault.tier),
				);
				chosen.push({ ...candidate.lens, tier });
			}
			// 10 — a real question only where a heavy reviewer made it one.
			let lenses: readonly ReviewLens[] = chosen;
			if (chosen.some((lens) => lens.tier === "heavy")) {
				const cross = await dialogs.confirm(
					crossFamilyTitle(deliverable.id),
					"A heavy lens here reads the same work as the implementer. A reviewer from another model family fails differently, which is the point of a second opinion.",
				);
				if (cross)
					lenses = chosen.map((lens) =>
						lens.tier === "heavy" ? { ...lens, diverse: true } : lens,
					);
			}
			const next = deliverableWithLenses(deliverable, policy, lenses);
			if (next) {
				lensesChanged = true;
				deliverables.push(next);
			} else deliverables.push(deliverable);
		}
		if (lensesChanged) {
			const edited: Plan = { ...plan, deliverables };
			const saved = savePlanOrReport(deps, edited, dialogs);
			if (!saved)
				return refuse(
					"The review lenses chosen here produce a plan that no longer validates, so nothing was written.",
				);
			plan = saved;
		}

		// ── 11 through 17 — compile, show, review, walk the findings ─────────
		const client = await deps.workflow?.();
		if (!client)
			// The warning naming `/plan run` has already been shown by the
			// provider seam; this is the flow ending cleanly behind it.
			return stored("This seat has no workflow runtime to compile against.");

		const effort: Effort = resolvePolicy(plan.policy).effort;
		const intent = record.intent.trim() || plan.title;
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

			ui.notify(
				`${renderStageDocument(document)}\n${renderProjection(projection)}`,
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
		// The record goes BEFORE the model is asked: the next `plan` call is a
		// new document, not a continuation of this exit.
		deletePendingExit(record.sessionId, deps.agentDir);
		if (deps.sendUserMessage) {
			deps.sendUserMessage(steer, { deliverAs: "followUp" });
			ui.notify(
				`Handed \`${plan.slug}\` to the model as \`workflow_run { ref: "${PLAN_WORKFLOW_REF}" }\` at effort ${effort}. Approval is the run's \`approve-plan\` checkpoint, not this flow.`,
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

/** Phase 2, as the `tool_result` handler calls it. */
export const continueModeExit: ExitFlowPhase2Hook = async (phase2) => {
	await runExitFlowPhase2(phase2);
};
