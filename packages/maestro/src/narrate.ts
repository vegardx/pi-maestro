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
// place `observation.task.narration` is read; everything below it works on the
// local `Narration` type. When pi-workflow renames one of those fields, exactly
// one function is wrong.
//
// AND THE SUMMARY IS NOT ON THE OBSERVATION. An observation is a synchronous
// notice on a durable append that reads no file and must stay in sequence order;
// a task's summary is its committed result, which lives in an artifact. So the
// adapter decides the kind, the stage, the deliverable and whether a turn is due
// from the observation alone — everything a narrator branches on — and the batch
// then makes ONE `inspect(runId, {include: ["tasks", "output"]})` call to fill in
// what each settled task said. One call per batch, not per task: a fan-out that
// finished together is one reading of one run.

import {
	MAX_NARRATION_SUMMARY_LENGTH,
	NARRATED_TASK_KINDS,
	type NarratedTaskKind,
	TERMINAL_RUN_STATUSES,
	type WorkflowInspectedTaskView,
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
 * pi-workflow's own `NARRATED_TASK_KINDS`, mirrored in `workflow-provider.ts`
 * beside the rest of the runtime's view shapes and re-exported here because this
 * is the module that branches on it. `other` is the honest answer for a stage key
 * pi-workflow's convention does not name — a task nobody can name still happened,
 * and dropping it would be the seat deciding a person does not need to know.
 */
export { MAX_NARRATION_SUMMARY_LENGTH, NARRATED_TASK_KINDS };

export type NarrationKind = NarratedTaskKind;

export function isNarrationKind(value: unknown): value is NarrationKind {
	return (NARRATED_TASK_KINDS as readonly unknown[]).includes(value);
}

/** What the deliverable reads as when the stage key names none — a gate, say. */
export const WHOLE_RUN = "the run";

/** What a line says when the inspection had no summary for the task. */
export const NO_SUMMARY = "no summary";

/** One thing that happened in a run, in this module's own terms. */
export interface Narration {
	readonly kind: NarrationKind;
	/** The stage's key, as the definition names it: `${namespace}/${key}`. */
	readonly stage: string;
	readonly deliverable: string;
	/**
	 * The settled task, so the batch can ask the inspection what it said.
	 *
	 * Carried rather than resolved here BECAUSE THE SUMMARY IS ARTIFACT-BACKED:
	 * an observation cannot have it, and reading a file inside a synchronous
	 * listener would put the narration out of sequence order.
	 */
	readonly taskId: string;
	/** Filled in from one inspection per batch; absent until then. */
	readonly summary?: string;
	/** Present exactly when the task did not complete. */
	readonly cause?: string;
}

/**
 * An observation as a narration, or nothing.
 *
 * THE ONE PLACE pi-workflow's per-task field names are read. An append with no
 * `task` is not about a settled task — a status change, a lease, a journal entry
 * — and there is nothing to narrate about it; the run's own end is handled from
 * `status`, not from here.
 */
export function adaptObservation(
	observation: WorkflowRunObservationView,
): Narration | undefined {
	const task = observation.task;
	if (!task) return undefined;
	const narration = task.narration;
	const stage = narration?.stage;
	if (typeof stage !== "string" || stage.length === 0) return undefined;
	return {
		kind: isNarrationKind(narration.taskKind) ? narration.taskKind : "other",
		stage,
		deliverable:
			typeof narration.deliverable === "string" &&
			narration.deliverable.length > 0
				? narration.deliverable
				: WHOLE_RUN,
		taskId: task.taskId,
		...(typeof narration.cause === "string" && narration.cause.length > 0
			? { cause: narration.cause }
			: {}),
	};
}

/**
 * The `include` a narrator asks an inspection for.
 *
 * BOTH SECTIONS, because `narration.summary` is artifact-backed: `"tasks"` is
 * what carries a narration at all and `"output"` is what makes it carry the
 * summary. Asking for one without the other is a call that returns everything
 * except the thing it was made for.
 */
export const NARRATION_INSPECT_SECTIONS = {
	include: ["tasks", "output"],
} as const;

/** What an inspection said each settled task's summary was, by task id. */
export async function readSummaries(
	client: Pick<WorkflowReadClient, "inspect">,
	runId: string,
): Promise<ReadonlyMap<string, string>> {
	const summaries = new Map<string, string>();
	const inspection = (await client.inspect(
		runId,
		NARRATION_INSPECT_SECTIONS,
	)) as { readonly tasks?: readonly WorkflowInspectedTaskView[] } | undefined;
	for (const task of inspection?.tasks ?? []) {
		const summary = task.narration?.summary;
		if (typeof task.id !== "string" || typeof summary !== "string") continue;
		const line = summary.trim();
		if (line.length === 0) continue;
		// Bounded here as well as there: the runtime cuts a summary to its own
		// contract, and a line this seat posts into somebody's conversation is not
		// a place to find out that a peer stopped doing so.
		summaries.set(
			task.id,
			line.length <= MAX_NARRATION_SUMMARY_LENGTH
				? line
				: `${line.slice(0, MAX_NARRATION_SUMMARY_LENGTH - 1)}…`,
		);
	}
	return summaries;
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
	const head = `${slug} · ${narration.deliverable} · ${narration.kind} ${narration.stage} — ${narration.summary ?? NO_SUMMARY}`;
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
	readonly client: Pick<WorkflowReadClient, "observe" | "inspect">;
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
	/** Resolves once every batch posted so far has been sent. For tests. */
	settled(): Promise<void>;
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
	/**
	 * The last flush, so two batches cannot interleave.
	 *
	 * A flush awaits an inspection now, so without this a second batch scheduled
	 * while the first was reading could post ahead of it — and the order of these
	 * messages is the order the run did things in.
	 */
	let tail: Promise<void> = Promise.resolve();

	const post = async (
		narrations: readonly {
			runId: string;
			slug: string;
			narration: Narration;
		}[],
		ends: readonly { runId: string; slug: string; status: string }[],
	): Promise<void> => {
		// ONE INSPECTION PER RUN IN THE BATCH, because the summary is artifact-
		// backed and an observation cannot carry it. A batch that reads nothing
		// still posts: a line without a summary says less than one with it and far
		// more than silence.
		const summaries = new Map<string, ReadonlyMap<string, string>>();
		for (const runId of new Set(narrations.map((entry) => entry.runId))) {
			try {
				summaries.set(runId, await readSummaries(deps.client, runId));
			} catch (error) {
				deps.onError?.(error);
			}
		}
		const filled = narrations.map((entry) => {
			const summary = summaries.get(entry.runId)?.get(entry.narration.taskId);
			return summary === undefined
				? entry
				: { ...entry, narration: { ...entry.narration, summary } };
		});
		const lines = filled.map((entry) =>
			renderNarration(entry.slug, entry.narration),
		);
		for (const end of ends)
			lines.push(renderRunEnd(end.slug, end.runId, end.status));
		// The batch's tail is about the FIRST run in it, which is the run every
		// line in it belongs to in every case but a session running two plans at
		// once — and there the prefix in each line is what tells them apart.
		const runId = filled[0]?.runId ?? ends[0]?.runId ?? "";
		const sentence = batchTail(
			runId,
			filled.map((entry) => entry.narration),
		);
		const turn =
			ends.length > 0 || filled.some((entry) => needsTurn(entry.narration));
		deps.send(
			{
				customType: PROGRESS_MESSAGE_TYPE,
				content: [...lines, ...(sentence ? ["", sentence] : [])].join("\n"),
				display: true,
			},
			{
				deliverAs: "nextTurn",
				...(turn ? { triggerTurn: true as const } : {}),
			},
		);
	};

	const flush = (): void => {
		queued = false;
		const narrations = batch;
		const ends = endings;
		batch = [];
		endings = [];
		if (narrations.length === 0 && ends.length === 0) return;
		tail = tail.then(() =>
			post(narrations, ends).catch((error: unknown) => {
				deps.onError?.(error);
			}),
		);
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
		settled: async () => {
			await tail;
		},
	};
}
