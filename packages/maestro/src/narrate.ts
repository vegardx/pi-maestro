// Narration: the engine executes, and the session says what is happening.
//
// A run used to be silent. The harness started it, the mode switched, and the
// conversation heard nothing again until somebody typed `/workflow` — so the
// session that was supposed to be the control surface was the one place with no
// view of the work. The person watched a spinner and the model, which is the
// thing that could actually explain what a reviewer said, was never given the
// chance to.
//
// So pi-maestro OBSERVES THE RUNS IT STARTED and posts what it sees into the
// conversation, one custom message per observation batch. `watchShippedRuns` in
// `publish.ts` is the precedent and the shape: one `observe` subscription,
// nothing thrown into the session, and a set of runs this seat owns — an
// observation about a run nobody here started is not this seat's to narrate.
//
// THE DIFFERENCE BETWEEN A LINE AND A TURN IS THE WHOLE DESIGN. Most of what a
// run does is progress: a task implemented, a check passed, one review filed.
// Those are posted with `deliverAs: "nextTurn"` and NO turn — they are facts the
// next turn should have, not questions, and a turn per task would mean the model
// narrating its own silence forty times.
//
// Four things get a turn, because each of them is something only the model can
// turn into a sentence a person can act on:
//
//   - **a review synthesis** — several lenses read the same work and disagreed
//     about it, and what that means is a judgement;
//   - **a fix report** — something was wrong and something was done about it;
//   - **a failure**, of a task or of the run — nothing retries on its own;
//   - **the ship gate arriving** — a decision is waiting, and the person has to
//     be told that it is waiting and how it is made.
//
// And a run that ENDS WITHOUT A GATE gets a final summary with a turn, because a
// run that finished and asked for nothing is exactly the case a silent seat used
// to leave a person guessing about.
//
// ONE ADAPTER READS THE RUNTIME'S FIELD NAMES. `adaptObservation` is the single
// place `stageKey`, `deliverableId`, `kind`, `summary` and `cause` are read off
// an observation; everything below it works on the local `Narration` type. When
// pi-workflow renames one of those, exactly one function is wrong.

import {
	TERMINAL_RUN_STATUSES,
	type WorkflowReadClient,
	type WorkflowRunObservationView,
} from "./workflow-provider.js";

/** The custom message's type, in the one place it exists. */
export const PROGRESS_MESSAGE_TYPE = "maestro:progress";

/** What the conversation is handed. */
export interface ProgressMessage {
	readonly customType: typeof PROGRESS_MESSAGE_TYPE;
	readonly content: string;
	readonly display: true;
}

/**
 * How it is delivered.
 *
 * `deliverAs: "nextTurn"` always: this is never a steer and never a follow-up
 * question, it is something the next turn should know. `triggerTurn` is what
 * makes that next turn happen NOW rather than whenever the person types again.
 */
export interface ProgressDelivery {
	readonly deliverAs: "nextTurn";
	readonly triggerTurn?: true;
}

/** How a message reaches the session. Pi's `sendMessage`, narrowed. */
export type SendProgress = (
	message: ProgressMessage,
	options: ProgressDelivery,
) => void;

/**
 * What a completed task was, as far as narration cares.
 *
 * pi-workflow's own vocabulary, mirrored here for the same reason
 * `workflow-provider.ts` mirrors the client surface: nothing may be imported
 * from an optional peer. `other` is the honest answer for a kind this build does
 * not recognise — a task nobody can name still happened, and dropping it would
 * be the seat deciding a person does not need to know.
 */
export const NARRATION_KINDS = [
	"implement",
	"check",
	"review",
	"synthesis",
	"fix",
	"gate",
	"refine",
	"other",
] as const;

export type NarrationKind = (typeof NARRATION_KINDS)[number];

export function isNarrationKind(value: unknown): value is NarrationKind {
	return (NARRATION_KINDS as readonly unknown[]).includes(value);
}

/** One thing that happened in a run, in this module's own terms. */
export interface Narration {
	readonly kind: NarrationKind;
	/** The stage's key, as the definition names it. */
	readonly stage: string;
	readonly deliverable: string;
	readonly summary: string;
	/** Present exactly when the task failed. */
	readonly cause?: string;
}

/**
 * An observation as a narration, or nothing.
 *
 * THE ONE PLACE pi-workflow's per-task field names are read. An append that
 * carries no `stageKey` is not about a task — a status change, a lease, a
 * journal entry — and there is nothing to narrate about it; the run's own end is
 * handled from `status`, not from here.
 */
export function adaptObservation(
	observation: WorkflowRunObservationView,
): Narration | undefined {
	const stage = observation.stageKey;
	if (typeof stage !== "string" || stage.length === 0) return undefined;
	return {
		kind: isNarrationKind(observation.kind) ? observation.kind : "other",
		stage,
		deliverable: observation.deliverableId ?? "the run",
		summary:
			typeof observation.summary === "string" && observation.summary.length > 0
				? observation.summary
				: "no summary",
		...(typeof observation.cause === "string" && observation.cause.length > 0
			? { cause: observation.cause }
			: {}),
	};
}

/** The kinds whose meaning is a judgement, so the model is given a turn. */
const TURN_KINDS: ReadonlySet<NarrationKind> = new Set<NarrationKind>([
	"synthesis",
	"fix",
	"gate",
]);

/**
 * Does this deserve a turn?
 *
 * A failure always does, whatever kind of task failed: nothing retries on its
 * own, and a failure nobody explained is a run a person will find out about from
 * a spinner that stopped.
 */
export function needsTurn(narration: Narration): boolean {
	return narration.cause !== undefined || TURN_KINDS.has(narration.kind);
}

/** The first eight characters of a run id, which is what `/workflow` takes. */
export function runPrefix(runId: string): string {
	return runId.slice(0, 8);
}

/** One narration, in the one line the conversation gets for it. */
export function renderNarration(slug: string, narration: Narration): string {
	const head = `${slug} · ${narration.deliverable} · ${narration.kind} ${narration.stage} — ${narration.summary}`;
	return narration.cause ? `${head}\n  cause: ${narration.cause}` : head;
}

/**
 * What the model is told to do about a gate, and how the decision is made.
 *
 * The command is here rather than in a doc because this message is the only
 * place a person will be standing when they need it: a gate that says a decision
 * is waiting, without saying how to make one, is a gate that sends somebody to
 * the source.
 */
export function shipGateSentence(runId: string): string {
	return (
		`A decision is waiting on that gate — nothing publishes until it is made.` +
		` Tell the person what the run produced and that they decide with` +
		` \`/workflow decide ${runPrefix(runId)} ship {"ship":true}\`, or through the gate's own widget in this session.`
	);
}

export const FAILURE_SENTENCE =
	"Tell the person what failed and what it means for the rest of the plan. Nothing retries on its own.";

export const JUDGEMENT_SENTENCE =
	"Tell the person what that means for the plan.";

/** A run that reached a terminal state, and whether a gate ever asked anything. */
export function renderRunEnd(
	slug: string,
	runId: string,
	status: string,
): string {
	return (
		`${slug} · run \`${runPrefix(runId)}\` ended \`${status}\` without stopping at a gate.` +
		" Tell the person where the work stands and what, if anything, is left to do by hand."
	);
}

/**
 * The tail a batch earns, or nothing.
 *
 * One sentence per batch, not per line: a batch with a failure and a gate in it
 * is one thing that happened, and two instruction paragraphs would be the seat
 * arguing with itself about which the model should talk about first.
 */
export function batchTail(
	runId: string,
	narrations: readonly Narration[],
): string | undefined {
	if (narrations.some((narration) => narration.kind === "gate"))
		return shipGateSentence(runId);
	if (narrations.some((narration) => narration.cause !== undefined))
		return FAILURE_SENTENCE;
	if (narrations.some((narration) => TURN_KINDS.has(narration.kind)))
		return JUDGEMENT_SENTENCE;
	return undefined;
}

// ── The watcher ──────────────────────────────────────────────────────────────

export interface NarrateDeps {
	readonly client: Pick<WorkflowReadClient, "observe">;
	readonly send: SendProgress;
	/**
	 * When a batch is flushed. Defaults to `queueMicrotask`.
	 *
	 * `observe` delivers appends synchronously and a run appends several at once,
	 * so a message per observation would be a message per task in a fan-out that
	 * finished together. Deferring to the end of the tick is what makes
	 * "one message per observation batch" true, and injecting it is what makes it
	 * testable without a timer.
	 */
	readonly schedule?: (flush: () => void) => void;
	/** Reported, never thrown: a watcher that throws takes the session with it. */
	readonly onError?: (error: unknown) => void;
}

export interface RunNarrator {
	/**
	 * Narrate this run, which this seat started.
	 *
	 * Runs are followed by id BECAUSE THE SEAT STARTED THEM. `observe` delivers
	 * every owned run's appends, and narrating a run somebody else started into
	 * this conversation would be this session claiming work it has no plan for.
	 */
	follow(runId: string, slug: string): void;
	/** Which runs are being narrated, for a caller that wants to know. */
	following(): readonly string[];
	/** Stop observing. Idempotent. */
	stop(): void;
}

export function createRunNarrator(deps: NarrateDeps): RunNarrator {
	const slugs = new Map<string, string>();
	/** Runs that have already stopped at a gate; their end is not a surprise. */
	const gated = new Set<string>();
	/** Runs whose end has been posted, so a second terminal append is silent. */
	const ended = new Set<string>();
	const schedule = deps.schedule ?? queueMicrotask;
	let batch: { runId: string; slug: string; narration: Narration }[] = [];
	let endings: { runId: string; slug: string; status: string }[] = [];
	let queued = false;

	const flush = (): void => {
		queued = false;
		const narrations = batch;
		const ends = endings;
		batch = [];
		endings = [];
		if (narrations.length === 0 && ends.length === 0) return;
		const lines = narrations.map((entry) =>
			renderNarration(entry.slug, entry.narration),
		);
		for (const end of ends)
			lines.push(renderRunEnd(end.slug, end.runId, end.status));
		// The tail is about the FIRST run in the batch, which is the run every
		// line in it belongs to in every case but a session running two plans at
		// once — and there the prefix in each line is what tells them apart.
		const runId = narrations[0]?.runId ?? ends[0]?.runId ?? "";
		const tail = batchTail(
			runId,
			narrations.map((entry) => entry.narration),
		);
		const turn =
			ends.length > 0 || narrations.some((entry) => needsTurn(entry.narration));
		try {
			deps.send(
				{
					customType: PROGRESS_MESSAGE_TYPE,
					content: [...lines, ...(tail ? ["", tail] : [])].join("\n"),
					display: true,
				},
				{
					deliverAs: "nextTurn",
					...(turn ? { triggerTurn: true as const } : {}),
				},
			);
		} catch (error) {
			deps.onError?.(error);
		}
	};

	const queue = (): void => {
		if (queued) return;
		queued = true;
		schedule(flush);
	};

	const unobserve = deps.client.observe(
		(observation: WorkflowRunObservationView) => {
			try {
				const slug = slugs.get(observation.runId);
				if (slug === undefined) return;
				const narration = adaptObservation(observation);
				if (narration) {
					if (narration.kind === "gate") gated.add(observation.runId);
					batch.push({ runId: observation.runId, slug, narration });
					queue();
				}
				// A run that ended having stopped at a gate has already said the one
				// thing that mattered, and publication takes it from there.
				if (
					TERMINAL_RUN_STATUSES.has(observation.status) &&
					!gated.has(observation.runId) &&
					!ended.has(observation.runId)
				) {
					ended.add(observation.runId);
					endings.push({
						runId: observation.runId,
						slug,
						status: observation.status,
					});
					queue();
				}
			} catch (error) {
				deps.onError?.(error);
			}
		},
	);

	return {
		follow: (runId, slug) => {
			slugs.set(runId, slug);
		},
		following: () => [...slugs.keys()],
		stop: () => {
			slugs.clear();
			unobserve();
		},
	};
}
