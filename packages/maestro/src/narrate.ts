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
//   - **normalize** — the reviewers of a deliverable have reported and their
//     findings are being clustered: how many reported, and which did not;
//   - **resume** — the implementer has answered the check and the review in
//     its own session, fixed, declined or out of scope;
//   - **a failure**, of a task or of the run — a dialog is opened about it;
//   - **the ship gate arriving** — a decision is waiting, and the person has to
//     be told that it is waiting.
//
// AT NORMALIZE AND RESUME THE LINE IS THE JOURNAL'S, NEVER A CHILD'S. The
// inspection's `narration.summary` for those tasks is a model's own words — a
// merge answer the harness may refuse, an implementer's account of itself — so
// the line is built from what the inspection's `tasks[]` proves instead: which
// review tasks of that deliverable completed and which did not. The clusters,
// the agreement and each disposition live in the `reviews-<d>` record, which a
// lease-free inspection exposes only as checkpoint inputs and run output; the
// ship decision and the receipt render them, and the line says so.
//
// And a run that ENDS WITHOUT A GATE gets a final summary with a turn, because a
// run that finished and asked for nothing is exactly the case a silent seat used
// to leave a person guessing about.
//
// NARRATION IS NOT THE DECISION SURFACE, AND IT OPENS ONE. Three of the things
// above are decisions, not news: a gate that arrived, a failure, and the
// completion of a run whose mode says publish. Narration says what happened and
// hands each of those to `decide.ts`, through three optional hooks, because
// observing a run and asking a person a question are different jobs and a
// watcher that opened dialogs itself would be a watcher a test could not read.
// A seat that wires no hooks still narrates everything it always did.
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
 * Never a steer: nothing here should interrupt the turn in flight. A line with
 * no turn is `nextTurn`, something the next turn should know. A line that needs
 * a turn is a `followUp` with `triggerTurn`, because Pi queues a `nextTurn`
 * message without ever starting a turn for it: `followUp` starts the run now
 * when the session is idle, and joins the end of the one in flight when not.
 */
export type ProgressDelivery =
	| { readonly deliverAs: "nextTurn"; readonly triggerTurn?: undefined }
	| { readonly deliverAs: "followUp"; readonly triggerTurn: true };

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

/** One projected task, in this module's terms: the journal's facts about it. */
export interface InspectedTask {
	readonly id: string;
	readonly status?: string;
	readonly kind?: NarrationKind;
	readonly stage?: string;
	readonly deliverable?: string;
}

/** What one inspection says: each task's summary, and every task's facts. */
export interface NarrationInspection {
	readonly summaries: ReadonlyMap<string, string>;
	readonly tasks: readonly InspectedTask[];
}

/**
 * One inspection, read: every settled task's summary by id, and every task's
 * id, status, kind, stage and deliverable.
 *
 * THE SECOND PLACE pi-workflow's per-task field names are read, beside
 * `adaptObservation`: that one reads an observation, this one an inspection,
 * and nothing below either touches a runtime field.
 */
export async function readInspection(
	client: Pick<WorkflowReadClient, "inspect">,
	runId: string,
): Promise<NarrationInspection> {
	const summaries = new Map<string, string>();
	const tasks: InspectedTask[] = [];
	const inspection = (await client.inspect(
		runId,
		NARRATION_INSPECT_SECTIONS,
	)) as { readonly tasks?: readonly WorkflowInspectedTaskView[] } | undefined;
	for (const task of inspection?.tasks ?? []) {
		if (typeof task.id !== "string") continue;
		const narration = task.narration;
		tasks.push({
			id: task.id,
			...(typeof task.status === "string" ? { status: task.status } : {}),
			...(isNarrationKind(narration?.taskKind)
				? { kind: narration.taskKind }
				: {}),
			...(typeof narration?.stage === "string"
				? { stage: narration.stage }
				: {}),
			...(typeof narration?.deliverable === "string"
				? { deliverable: narration.deliverable }
				: {}),
		});
	}
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
	return { summaries, tasks };
}

/** What an inspection said each settled task's summary was, by task id. */
export async function readSummaries(
	client: Pick<WorkflowReadClient, "inspect">,
	runId: string,
): Promise<ReadonlyMap<string, string>> {
	return (await readInspection(client, runId)).summaries;
}

/** A review task's reviewer: the fan-out member's own key, `correctness-2`. */
function reviewerName(task: InspectedTask): string {
	const stage = task.stage ?? task.id;
	return stage.slice(stage.indexOf("/") + 1);
}

/**
 * What the journal proves about a deliverable's review, at normalize or at
 * resume, or nothing for any other kind.
 *
 * Built from task statuses alone: which `review` tasks of the deliverable
 * completed and which did not. The record's clusters and dispositions are not
 * on a lease-free inspection while the run is working, so the sentence names
 * where they are rather than guessing at them.
 */
export function reviewFacts(
	narration: Narration,
	tasks: readonly InspectedTask[],
): string | undefined {
	if (narration.kind !== "normalize" && narration.kind !== "resume")
		return undefined;
	const reviewers = tasks.filter(
		(task) =>
			task.kind === "review" && task.deliverable === narration.deliverable,
	);
	const reported = reviewers.filter((task) => task.status === "completed");
	const missing = reviewers.filter((task) => task.status !== "completed");
	const record = `\`reviews-${narration.deliverable}\``;
	if (narration.kind === "normalize")
		return (
			`${reported.length} of ${reviewers.length} reviewer${reviewers.length === 1 ? "" : "s"} reported` +
			(missing.length > 0
				? `; ${missing.map(reviewerName).join(", ")} did not, and ${missing.length === 1 ? "is" : "are"} counted in no agreement`
				: "") +
			". The harness clustered their findings by place without judging them, and this call may only merge clusters that state the same problem;" +
			` the clusters and who agreed are recorded in ${record}.`
		);
	if (reviewers.length === 0)
		return (
			"The implementer was resumed in its own session to answer the check" +
			" report; nobody reviewed this deliverable, so there are no findings to" +
			" answer and no record."
		);
	return (
		"The implementer was resumed in its own session with the check report and" +
		` the findings of ${reported.length} reviewer${reported.length === 1 ? "" : "s"} — claims, places and evidence, no severity, reviewer or agreement —` +
		" to answer each one fixed, declined or out of scope. Its answers are recorded" +
		` in ${record} once the harness has checked they cover every finding exactly once; a decline never holds the run.`
	);
}

/** The kinds whose meaning is a judgement, so the model is given a turn. */
const TURN_KINDS: ReadonlySet<NarrationKind> = new Set<NarrationKind>([
	"normalize",
	"resume",
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
 * What the model is told to do about a gate.
 *
 * NO COMMAND IS NAMED, and that is the change. This sentence used to carry
 * `/workflow decide <prefix> ship {"ship":true}` — a command with a JSON literal
 * in it — because there was nowhere else for the decision to happen. There is
 * now: `decide.ts` opens the dialog with the gate's own inputs rendered in it, and
 * a model that told somebody to type a command would be sending them past the
 * thing already on their screen.
 */
export function shipGateSentence(runId: string): string {
	return (
		`A decision is waiting on that gate — nothing publishes until it is made.` +
		` Tell the person what run \`${runPrefix(runId)}\` produced and what you would do` +
		` about the findings that are left. The decision itself is a dialog in this` +
		` session, with the gate's inputs in it; there is no command to type.`
	);
}

export const FAILURE_SENTENCE =
	"Tell the person what failed and what it means for the rest of the plan. A dialog is open about it: retry that task, stop the run, or go back to planning.";

/** What the model is told at a normalize or a resume. */
export const REVIEW_SENTENCE =
	"Tell the person where the review of that deliverable stands. Every finding, who raised it, how many agreed and how the implementer answered it reach the ship decision, where Look first lists them.";

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
		return REVIEW_SENTENCE;
	return undefined;
}

// ── The watcher ──────────────────────────────────────────────────────────────

/**
 * The three decisions a run raises, handed on rather than answered here.
 *
 * Every one is optional and every one is fire-and-forget: a hook that throws or
 * hangs must not stop the next observation from being narrated, so the batch
 * calls it and moves on. `decide.ts` is the only implementation, and the seat is
 * what wires it.
 */
export interface NarrationHooks {
	/** The `ship` gate arrived on a run this seat started. */
	readonly onGate?: (runId: string, slug: string) => void;
	/** A task, or the run, did not complete. */
	readonly onFailure?: (
		runId: string,
		slug: string,
		narration: Narration,
	) => void;
	/**
	 * A run reached a terminal status without ever stopping at a gate.
	 *
	 * Which is exactly the `gates: "none"` case mode `auto` writes — and also a
	 * run that failed, which is why `status` travels: the hook decides whether
	 * this is a publication or nothing at all.
	 */
	readonly onEnd?: (runId: string, slug: string, status: string) => void;
}

export interface NarrateDeps extends NarrationHooks {
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
		const inspections = new Map<string, NarrationInspection>();
		for (const runId of new Set(narrations.map((entry) => entry.runId))) {
			try {
				inspections.set(runId, await readInspection(deps.client, runId));
			} catch (error) {
				deps.onError?.(error);
			}
		}
		const filled = narrations.map((entry) => {
			const inspection = inspections.get(entry.runId);
			// At normalize and resume the journal speaks, never the child: see
			// `reviewFacts`. Everywhere else the task's own summary is the line.
			const summary = inspection
				? (reviewFacts(entry.narration, inspection.tasks) ??
					inspection.summaries.get(entry.narration.taskId))
				: undefined;
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
			turn
				? { deliverAs: "followUp", triggerTurn: true }
				: { deliverAs: "nextTurn" },
		);
		// THE MESSAGE GOES FIRST, THEN THE DECISION. The dialog's title carries
		// the gate's own inputs and the conversation carries the narration, and a
		// person reading a dialog wants the line that explains it already in the
		// transcript behind it.
		for (const entry of filled) {
			try {
				if (entry.narration.cause !== undefined)
					deps.onFailure?.(entry.runId, entry.slug, entry.narration);
				else if (entry.narration.kind === "gate")
					deps.onGate?.(entry.runId, entry.slug);
			} catch (error) {
				deps.onError?.(error);
			}
		}
		for (const end of ends) {
			try {
				deps.onEnd?.(end.runId, end.slug, end.status);
			} catch (error) {
				deps.onError?.(error);
			}
		}
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
