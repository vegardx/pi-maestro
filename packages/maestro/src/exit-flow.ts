// Phase 1 of the plan-mode exit: the six questions a plan cannot answer.
//
// Leaving plan mode is where a conversation becomes a run, and the flow is
// split by exactly one model turn because it has to be: a dialog sequence
// cannot obtain a plan document from a conversation, and the `plan` tool is
// withheld while the session is still in plan mode. So phase 1 asks the human
// what only a human knows — how much effort, which gates, where it publishes,
// what it is for — switches the posture, records the answers, and asks the
// model for the document. The model's turn writes the plan. Phase 2 (M3-EXIT2,
// `continueModeExit` below) picks it up from there.
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
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ModeName } from "./mode.js";
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
	isRefName,
	PLAN_GATES,
	type PlanGates,
	type PlanPolicy,
	type PublishMode,
} from "./plan.js";
import { DEFAULT_EFFORT, EFFORTS, type Effort } from "./plan-input.js";

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
}

export interface ModeExitController {
	/** The `/mode` hook: phase 1 when leaving plan mode, nothing otherwise. */
	readonly hook: ModeExitHook;
	/** A session replacement: abort the open dialog and drop the record. */
	abort(): void;
	/** The last outcome, for a caller that wants to see what happened. */
	last(): ExitFlowOutcome | undefined;
}

export function createModeExitController(
	deps: ModeExitControllerDeps,
): ModeExitController {
	let controller: AbortController | undefined;
	let last: ExitFlowOutcome | undefined;

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

	return {
		hook,
		abort: () => controller?.abort(),
		last: () => last,
	};
}

// ── The phase-2 seam ─────────────────────────────────────────────────────────

/**
 * What phase 2 is handed when the model's `plan` call stores a document.
 *
 * Deliberately not read here: the trigger (`toolName === "plan"`, `stored`,
 * a pending record for this session), readiness, the lens dialogs, the compile,
 * the blind review and the run request are M3-EXIT2's, and none of it exists
 * yet. The shape is declared now so the `tool_result` handler has exactly one
 * place to grow, and so the record this half writes already names what the
 * other half will need from it.
 */
export interface ExitFlowPhase2 {
	readonly record: PendingExit;
	/** The slug the `plan` tool reported storing. */
	readonly slug: string;
	readonly ui: ExitFlowUi;
	readonly agentDir?: string;
	readonly signal?: AbortSignal;
}

export type ExitFlowPhase2Hook = (
	phase2: ExitFlowPhase2,
) => void | Promise<void>;

/** The seam, empty until M3-EXIT2 fills it. Phase 1 ships without phase 2. */
export const continueModeExit: ExitFlowPhase2Hook = () => {};
