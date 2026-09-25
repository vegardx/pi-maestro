// Narration, driven through a scripted observer and a scripted inspection.
//
// Two ports, because the runtime hands the two halves over separately: an
// observation says a task settled and what kind it was — everything a narrator
// branches on — and the SUMMARY is artifact-backed, so it comes from one
// `inspect(runId, {include: ["tasks", "output"]})` call per batch. A test that
// faked one port would be asserting that the fake was written correctly.
//
// The stage keys below are `plan-to-ship`'s documented ones — `implement-<d>`,
// `check-<d>-verify-<n>`, `review-<d>/<lens>`, `synthesis-<d>`, `fix-<d>`,
// `approve-<d>` and `ship` — because this seat's job is to read what that
// definition produces, not to invent a vocabulary for it.

import { describe, expect, it } from "vitest";
import {
	adaptObservation,
	createRunNarrator,
	FAILURE_SENTENCE,
	JUDGEMENT_SENTENCE,
	NARRATED_TASK_KINDS,
	NARRATION_INSPECT_SECTIONS,
	type Narration,
	NO_SUMMARY,
	needsTurn,
	PROGRESS_MESSAGE_TYPE,
	type ProgressDelivery,
	type ProgressMessage,
	readSummaries,
	renderNarration,
	runPrefix,
	shipGateSentence,
	WHOLE_RUN,
} from "../packages/maestro/src/narrate.js";
import {
	MAX_NARRATION_SUMMARY_LENGTH,
	type WorkflowObservedTaskView,
	type WorkflowRunObservationView,
	type WorkflowTaskNarrationView,
} from "../packages/maestro/src/workflow-provider.js";

const RUN = "wfr-plan-to-ship-0e1f2a3b";
const SLUG = "compose";

/** One append with no task on it: a status change, a lease, a journal entry. */
function append(
	over: Partial<WorkflowRunObservationView> = {},
): WorkflowRunObservationView {
	return { runId: RUN, status: "running", sequence: 1, ...over };
}

/** The append that settled one task, as pi-workflow shapes it. */
function settled(
	taskId: string,
	narration: WorkflowTaskNarrationView,
	over: Partial<WorkflowObservedTaskView> = {},
): WorkflowRunObservationView {
	return append({
		task: { taskId, status: "completed", narration, ...over },
	});
}

/**
 * A narrator over a fake `observe` and a fake `inspect`, with the flush under
 * the test's control.
 *
 * `schedule` is captured rather than run: "one message per observation batch" is
 * only a claim if a test can put several observations inside one batch, and a
 * real `queueMicrotask` would make the boundary a matter of timing.
 */
function narrator(
	options: {
		readonly follow?: boolean;
		/** Task id → summary, as the inspection would report it. */
		readonly summaries?: Readonly<Record<string, string>>;
		readonly inspectFails?: true;
	} = {},
) {
	let listener: ((o: WorkflowRunObservationView) => void) | undefined;
	let stopped = 0;
	const flushes: (() => void)[] = [];
	const sent: [ProgressMessage, ProgressDelivery][] = [];
	const errors: unknown[] = [];
	const inspected: [string, unknown][] = [];
	const subject = createRunNarrator({
		client: {
			observe: (handler) => {
				listener = handler;
				return () => {
					stopped += 1;
				};
			},
			inspect: async (runId: string, opts?: unknown) => {
				inspected.push([runId, opts]);
				if (options.inspectFails) throw new Error("the run store is locked");
				return {
					run: { runId },
					tasks: Object.entries(options.summaries ?? {}).map(
						([id, summary]) => ({
							id,
							narration: { stage: id, taskKind: "other", summary },
						}),
					),
				};
			},
		},
		send: (message, delivery) => sent.push([message, delivery]),
		schedule: (flush) => flushes.push(flush),
		onError: (error) => errors.push(error),
	});
	if (options.follow !== false) subject.follow(RUN, SLUG);
	return {
		subject,
		sent,
		errors,
		flushes,
		inspected,
		stopped: () => stopped,
		observe: (...appends: WorkflowRunObservationView[]) => {
			for (const one of appends) listener?.(one);
		},
		/** Run every scheduled flush and wait for the posts they produce. */
		flush: async (): Promise<void> => {
			for (const flush of flushes.splice(0)) flush();
			await subject.settled();
		},
		content: (): string => sent.at(-1)?.[0].content ?? "",
		delivery: (): ProgressDelivery | undefined => sent.at(-1)?.[1],
	};
}

// ── The adapter ──────────────────────────────────────────────────────────────

describe("the one place the runtime's field names are read", () => {
	it("reads a settled task's narration into the fields a narrator branches on", () => {
		expect(
			adaptObservation(
				settled("t-1", {
					stage: "check-d1-verify-1",
					taskKind: "check",
					deliverable: "d1",
				}),
			),
		).toEqual({
			kind: "check",
			stage: "check-d1-verify-1",
			deliverable: "d1",
			taskId: "t-1",
		});
	});

	it("carries no summary, because an observation cannot have one", () => {
		// `narration.summary` is artifact-backed and is never on an observation. The
		// adapter does not invent one and does not go and read one: a synchronous
		// listener that read a file would put the narration out of sequence order.
		const narration = adaptObservation(
			settled("t-1", { stage: "implement-d1", taskKind: "implement" }),
		);
		expect(narration).not.toHaveProperty("summary");
		expect(narration?.taskId).toBe("t-1");
	});

	it("carries a cause only when there is one, because that is journal-derived", () => {
		expect(
			adaptObservation(
				settled(
					"t-2",
					{
						stage: "implement-d2",
						taskKind: "implement",
						deliverable: "d2",
						cause: "the worktree could not be created",
					},
					{ status: "failed", outcome: "failed" },
				),
			),
		).toMatchObject({ cause: "the worktree could not be created" });
		expect(
			adaptObservation(
				settled("t-2", {
					stage: "implement-d2",
					taskKind: "implement",
					cause: "",
				}),
			),
		).not.toHaveProperty("cause");
	});

	it("is nothing at all for an append that settled no task", () => {
		// One notice per append, and most appends are not about a task settling. The
		// run's own end is read from `status` instead.
		expect(adaptObservation(append())).toBeUndefined();
		expect(adaptObservation(append({ status: "completed" }))).toBeUndefined();
		expect(
			adaptObservation(settled("t-1", { stage: "", taskKind: "implement" })),
		).toBeUndefined();
	});

	it("calls a kind it does not know `other`, and a missing deliverable the run", () => {
		expect(
			adaptObservation(
				settled("t-9", {
					stage: "teleport-d1",
					taskKind: "teleport" as never,
				}),
			),
		).toMatchObject({ kind: "other", deliverable: WHOLE_RUN });
		// A gate names no deliverable — `ship` is the whole run's decision.
		expect(
			adaptObservation(settled("g-1", { stage: "ship", taskKind: "gate" })),
		).toMatchObject({ kind: "gate", stage: "ship", deliverable: WHOLE_RUN });
	});

	it("knows the eight kinds pi-workflow derives", () => {
		expect([...NARRATED_TASK_KINDS]).toEqual([
			"implement",
			"check",
			"review",
			"synthesis",
			"fix",
			"gate",
			"refine",
			"other",
		]);
	});
});

// ── The summary, from the one call that has it ───────────────────────────────

describe("the summary an inspection carries", () => {
	it("asks for both sections, because only the pair carries a summary", () => {
		expect(NARRATION_INSPECT_SECTIONS).toEqual({
			include: ["tasks", "output"],
		});
	});

	it("reads each task's summary by id, and skips what it cannot use", async () => {
		const client = {
			inspect: async () => ({
				tasks: [
					{
						id: "t-1",
						narration: {
							stage: "a",
							taskKind: "check",
							summary: " the suite passes ",
						},
					},
					{ id: "t-2", narration: { stage: "b", taskKind: "check" } },
					{
						id: "t-3",
						narration: { stage: "c", taskKind: "check", summary: "   " },
					},
					{ id: "t-4" },
				],
			}),
		};
		const summaries = await readSummaries(client as never, RUN);
		expect([...summaries]).toEqual([["t-1", "the suite passes"]]);
	});

	it("bounds a summary the runtime stopped bounding", async () => {
		const client = {
			inspect: async () => ({
				tasks: [
					{
						id: "t-1",
						narration: {
							stage: "a",
							taskKind: "check",
							summary: "x".repeat(MAX_NARRATION_SUMMARY_LENGTH + 50),
						},
					},
				],
			}),
		};
		const summary =
			(await readSummaries(client as never, RUN)).get("t-1") ?? "";
		expect(summary.length).toBe(MAX_NARRATION_SUMMARY_LENGTH);
		expect(summary.endsWith("…")).toBe(true);
	});

	it("is an empty map for an inspection with no tasks at all", async () => {
		await expect(
			readSummaries({ inspect: async () => ({}) } as never, RUN),
		).resolves.toEqual(new Map());
	});
});

// ── What earns a turn ────────────────────────────────────────────────────────

describe("the line and the turn", () => {
	const of = (over: Partial<Narration>): Narration => ({
		kind: "implement",
		stage: "implement-d1",
		deliverable: "d1",
		taskId: "t-1",
		...over,
	});

	it("gives no turn to routine progress", () => {
		for (const kind of [
			"implement",
			"check",
			"review",
			"refine",
			"other",
		] as const)
			expect([kind, needsTurn(of({ kind }))]).toEqual([kind, false]);
	});

	it("gives a turn to a synthesis, a fix report and the ship gate", () => {
		for (const kind of ["synthesis", "fix", "gate"] as const)
			expect([kind, needsTurn(of({ kind }))]).toEqual([kind, true]);
	});

	it("gives a turn to a failure, whatever kind of task failed", () => {
		for (const kind of NARRATED_TASK_KINDS)
			expect([kind, needsTurn(of({ kind, cause: "it exploded" }))]).toEqual([
				kind,
				true,
			]);
	});
});

describe("what a line says", () => {
	it("names the plan, the deliverable, the kind, the stage and the summary", () => {
		expect(
			renderNarration(SLUG, {
				kind: "review",
				stage: "review-d1/contracts",
				deliverable: "d1",
				taskId: "t-1",
				summary: "contracts filed two observations",
			}),
		).toBe(
			"compose · d1 · review review-d1/contracts — contracts filed two observations",
		);
	});

	it("says so when the inspection had no summary for the task", () => {
		expect(
			renderNarration(SLUG, {
				kind: "implement",
				stage: "implement-d1",
				deliverable: "d1",
				taskId: "t-1",
			}),
		).toBe(`compose · d1 · implement implement-d1 — ${NO_SUMMARY}`);
	});

	it("puts a cause on its own line", () => {
		expect(
			renderNarration(SLUG, {
				kind: "implement",
				stage: "implement-d1",
				deliverable: "d1",
				taskId: "t-1",
				summary: "the attempt stopped",
				cause: "tsc exited 2",
			}),
		).toBe(
			"compose · d1 · implement implement-d1 — the attempt stopped\n  cause: tsc exited 2",
		);
	});

	it("says how a ship decision is made, with the prefix `/workflow` takes", () => {
		const sentence = shipGateSentence(RUN);
		expect(runPrefix(RUN)).toBe("wfr-plan");
		expect(sentence).toContain('/workflow decide wfr-plan ship {"ship":true}');
		expect(sentence).toContain("widget");
		expect(sentence).toContain("nothing publishes until it is made");
	});
});

// ── The watcher ──────────────────────────────────────────────────────────────

describe("the runs this seat narrates", () => {
	it("says nothing about a run it did not start, and inspects nothing", async () => {
		const n = narrator({ follow: false });
		n.observe(settled("t-1", { stage: "implement-d1", taskKind: "implement" }));
		await n.flush();
		expect(n.sent).toEqual([]);
		expect(n.inspected).toEqual([]);
		expect(n.subject.following()).toEqual([]);
	});

	it("posts a routine completion with its summary and no turn at all", async () => {
		const n = narrator({ summaries: { "t-1": "wrote the adapter" } });
		n.observe(
			settled("t-1", {
				stage: "implement-d1",
				taskKind: "implement",
				deliverable: "d1",
			}),
		);
		await n.flush();
		expect(n.sent.length).toBe(1);
		expect(n.sent[0]?.[0]).toEqual({
			customType: PROGRESS_MESSAGE_TYPE,
			content: "compose · d1 · implement implement-d1 — wrote the adapter",
			display: true,
		});
		// `nextTurn` and nothing else: a fact the next turn should have.
		expect(n.delivery()).toEqual({ deliverAs: "nextTurn" });
		// ONE inspection, for the run, asking for both sections.
		expect(n.inspected).toEqual([[RUN, NARRATION_INSPECT_SECTIONS]]);
	});

	it("coalesces a batch into one message and one inspection", async () => {
		const n = narrator({
			summaries: {
				"r-1": "contracts is content",
				"r-2": "security is content",
				"v-1": "the suite passes",
			},
		});
		n.observe(
			settled("r-1", {
				stage: "review-d1/contracts",
				taskKind: "review",
				deliverable: "d1",
			}),
			settled("r-2", {
				stage: "review-d1/security",
				taskKind: "review",
				deliverable: "d1",
			}),
			settled("v-1", {
				stage: "check-d1-verify-1",
				taskKind: "check",
				deliverable: "d1",
			}),
		);
		// One flush scheduled for three appends, and one message out of it.
		expect(n.flushes.length).toBe(1);
		await n.flush();
		expect(n.sent.length).toBe(1);
		expect(n.content().split("\n")).toEqual([
			"compose · d1 · review review-d1/contracts — contracts is content",
			"compose · d1 · review review-d1/security — security is content",
			"compose · d1 · check check-d1-verify-1 — the suite passes",
		]);
		expect(n.delivery()?.triggerTurn).toBeUndefined();
		// THREE TASKS, ONE INSPECTION. A fan-out that finished together is one
		// reading of one run.
		expect(n.inspected.length).toBe(1);
	});

	it("posts the line anyway when the inspection cannot be read", async () => {
		const n = narrator({ inspectFails: true });
		n.observe(
			settled("t-1", {
				stage: "implement-d1",
				taskKind: "implement",
				deliverable: "d1",
			}),
		);
		await n.flush();
		// A line without a summary says less than one with it and far more than
		// silence, and the failure is reported rather than thrown.
		expect(n.sent.length).toBe(1);
		expect(n.content()).toBe(
			`compose · d1 · implement implement-d1 — ${NO_SUMMARY}`,
		);
		expect(n.errors.length).toBe(1);
	});

	it("triggers a turn for a synthesis, and says what to do with it", async () => {
		const n = narrator({
			summaries: {
				"r-1": "contracts is content",
				"s-1": "two lenses disagree about the seam",
			},
		});
		n.observe(
			settled("r-1", {
				stage: "review-d1/contracts",
				taskKind: "review",
				deliverable: "d1",
			}),
			settled("s-1", {
				stage: "synthesis-d1",
				taskKind: "synthesis",
				deliverable: "d1",
			}),
		);
		await n.flush();
		// ONE message for the batch, and the turn is the batch's, not the line's.
		expect(n.sent.length).toBe(1);
		expect(n.delivery()).toEqual({
			deliverAs: "nextTurn",
			triggerTurn: true,
		});
		expect(n.content()).toContain("two lenses disagree about the seam");
		expect(n.content().endsWith(JUDGEMENT_SENTENCE)).toBe(true);
	});

	it("triggers a turn for a fix report", async () => {
		const n = narrator({
			summaries: { "f-1": "one round closed the finding" },
		});
		n.observe(
			settled("f-1", { stage: "fix-d2", taskKind: "fix", deliverable: "d2" }),
		);
		await n.flush();
		expect(n.delivery()?.triggerTurn).toBe(true);
		expect(n.content()).toContain(JUDGEMENT_SENTENCE);
	});

	it("triggers a turn for a failure and says nothing retries", async () => {
		const n = narrator({ summaries: { "t-1": "the attempt stopped" } });
		n.observe(
			settled(
				"t-1",
				{
					stage: "implement-d1",
					taskKind: "implement",
					deliverable: "d1",
					cause: "tsc exited 2",
				},
				{ status: "failed" },
			),
		);
		await n.flush();
		expect(n.delivery()?.triggerTurn).toBe(true);
		expect(n.content()).toContain("cause: tsc exited 2");
		expect(n.content()).toContain(FAILURE_SENTENCE);
	});

	it("triggers a turn for the ship gate, and the gate wins the batch's tail", async () => {
		const n = narrator({
			summaries: { "f-1": "one round closed it", "g-1": "the ship decision" },
		});
		n.observe(
			settled("f-1", { stage: "fix-d1", taskKind: "fix", deliverable: "d1" }),
			settled("g-1", { stage: "ship", taskKind: "gate" }),
		);
		await n.flush();
		expect(n.delivery()?.triggerTurn).toBe(true);
		// The gate outranks the fix: the batch is one thing that happened, and the
		// decision is the part a person has to act on.
		expect(n.content()).toContain(shipGateSentence(RUN));
		expect(n.content()).not.toContain(JUDGEMENT_SENTENCE);
		expect(n.content()).toContain(`${WHOLE_RUN} · gate ship`);
	});

	it("narrates a per-deliverable gate as a gate too", async () => {
		const n = narrator({ summaries: { "a-1": "approve d1" } });
		n.observe(settled("a-1", { stage: "approve-d1", taskKind: "gate" }));
		await n.flush();
		expect(n.delivery()?.triggerTurn).toBe(true);
		expect(n.content()).toContain("gate approve-d1");
	});

	it("posts a final summary with a turn when a run ends without a gate", async () => {
		for (const status of ["completed", "failed", "cancelled", "expired"]) {
			const n = narrator({ summaries: { "v-1": "the suite passes" } });
			n.observe(
				settled("v-1", {
					stage: "check-d1-verify-1",
					taskKind: "check",
					deliverable: "d1",
				}),
				append({ status }),
			);
			await n.flush();
			expect(n.sent.length).toBe(1);
			expect(n.delivery()?.triggerTurn).toBe(true);
			expect(n.content()).toContain(
				`compose · run \`wfr-plan\` ended \`${status}\` without stopping at a gate.`,
			);
			expect(n.content()).toContain("what, if anything, is left to do by hand");
		}
	});

	it("says nothing extra when a run that stopped at a gate then ends", async () => {
		const n = narrator({
			summaries: { "g-1": "the ship decision is waiting" },
		});
		n.observe(settled("g-1", { stage: "ship", taskKind: "gate" }));
		await n.flush();
		n.observe(append({ status: "completed" }));
		await n.flush();
		// One message, the gate's. The gate already said the one thing that
		// mattered, and publication takes it from there.
		expect(n.sent.length).toBe(1);
		expect(n.content()).toContain("gate ship");
	});

	it("posts a run's end once, however many terminal appends arrive", async () => {
		const n = narrator();
		n.observe(append({ status: "completed" }));
		await n.flush();
		n.observe(append({ status: "completed" }), append({ status: "completed" }));
		await n.flush();
		expect(n.sent.length).toBe(1);
		// A batch of nothing but a run's end reads no tasks.
		expect(n.inspected).toEqual([]);
	});

	it("keeps two batches in the order the run did them in", async () => {
		// The flush awaits an inspection now, so a second batch scheduled while the
		// first is reading must not post ahead of it: the order of these messages
		// is the order the run did things in.
		const n = narrator({
			summaries: { "t-1": "first", "t-2": "second" },
		});
		n.observe(settled("t-1", { stage: "implement-d1", taskKind: "implement" }));
		for (const flush of n.flushes.splice(0)) flush();
		n.observe(settled("t-2", { stage: "implement-d2", taskKind: "implement" }));
		for (const flush of n.flushes.splice(0)) flush();
		await n.subject.settled();
		expect(n.sent.map(([message]) => message.content)).toEqual([
			`compose · ${WHOLE_RUN} · implement implement-d1 — first`,
			`compose · ${WHOLE_RUN} · implement implement-d2 — second`,
		]);
	});

	it("never throws into the session, and reports instead", async () => {
		let listener: ((o: WorkflowRunObservationView) => void) | undefined;
		const errors: unknown[] = [];
		const subject = createRunNarrator({
			client: {
				observe: (handler) => {
					listener = handler;
					return () => undefined;
				},
				inspect: async () => ({ tasks: [] }),
			},
			send: () => {
				throw new Error("the session went away");
			},
			schedule: (flush) => flush(),
			onError: (error) => errors.push(error),
		});
		subject.follow(RUN, SLUG);
		expect(() =>
			listener?.(
				settled("t-1", { stage: "implement-d1", taskKind: "implement" }),
			),
		).not.toThrow();
		await subject.settled();
		expect(errors.length).toBe(1);
	});

	it("unsubscribes and forgets its runs on stop", () => {
		const n = narrator();
		expect(n.subject.following()).toEqual([RUN]);
		n.subject.stop();
		expect(n.stopped()).toBe(1);
		expect(n.subject.following()).toEqual([]);
	});
});
