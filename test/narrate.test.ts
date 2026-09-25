// Narration, driven through a scripted observer.
//
// The observer is a port for the same reason the completion is one: the four
// things that earn a turn — a review synthesis, a fix report, a failure, the
// ship gate — and the many that do not are each one line here, and none of them
// needs a workflow runtime to be written down.

import { describe, expect, it } from "vitest";
import {
	adaptObservation,
	createRunNarrator,
	FAILURE_SENTENCE,
	JUDGEMENT_SENTENCE,
	NARRATION_KINDS,
	type Narration,
	needsTurn,
	PROGRESS_MESSAGE_TYPE,
	type ProgressDelivery,
	type ProgressMessage,
	renderNarration,
	runPrefix,
	shipGateSentence,
} from "../packages/maestro/src/narrate.js";
import type { WorkflowRunObservationView } from "../packages/maestro/src/workflow-provider.js";

const RUN = "wfr-plan-to-ship-0e1f2a3b";
const SLUG = "compose";

/** One append, with the run's own three fields filled in. */
function append(
	over: Partial<WorkflowRunObservationView> = {},
): WorkflowRunObservationView {
	return {
		runId: RUN,
		status: "running",
		sequence: 1,
		...over,
	};
}

/**
 * A narrator over a fake `observe`, with the flush under the test's control.
 *
 * `schedule` is captured rather than run: "one message per observation batch" is
 * only a claim if a test can put several observations inside one batch, and a
 * real `queueMicrotask` would make the boundary a matter of timing.
 */
function narrator(options: { readonly follow?: boolean } = {}) {
	let listener: ((o: WorkflowRunObservationView) => void) | undefined;
	let stopped = 0;
	const flushes: (() => void)[] = [];
	const sent: [ProgressMessage, ProgressDelivery][] = [];
	const errors: unknown[] = [];
	const subject = createRunNarrator({
		client: {
			observe: (handler) => {
				listener = handler;
				return () => {
					stopped += 1;
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
		stopped: () => stopped,
		observe: (...appends: WorkflowRunObservationView[]) => {
			for (const one of appends) listener?.(one);
		},
		flush: () => {
			for (const flush of flushes.splice(0)) flush();
		},
		content: (): string => sent.at(-1)?.[0].content ?? "",
		delivery: (): ProgressDelivery | undefined => sent.at(-1)?.[1],
	};
}

// ── The adapter ──────────────────────────────────────────────────────────────

describe("the one place the runtime's field names are read", () => {
	it("reads a completed task into the five fields narration works on", () => {
		expect(
			adaptObservation(
				append({
					stageKey: "verify",
					deliverableId: "d1",
					kind: "check",
					summary: "the suite passes",
				}),
			),
		).toEqual({
			kind: "check",
			stage: "verify",
			deliverable: "d1",
			summary: "the suite passes",
		});
	});

	it("carries a cause only when there is one", () => {
		expect(
			adaptObservation(
				append({
					stageKey: "implement",
					deliverableId: "d2",
					kind: "implement",
					summary: "the attempt stopped",
					cause: "the worktree could not be created",
				}),
			),
		).toMatchObject({ cause: "the worktree could not be created" });
		expect(
			adaptObservation(
				append({ stageKey: "implement", kind: "implement", cause: "" }),
			),
		).not.toHaveProperty("cause");
	});

	it("is nothing at all for an append that is not about a task", () => {
		// A status change, a lease, a journal entry: real appends with nothing to
		// say about work, and the run's own end is read from `status` instead.
		expect(adaptObservation(append())).toBeUndefined();
		expect(adaptObservation(append({ stageKey: "" }))).toBeUndefined();
	});

	it("calls an unrecognised kind `other` rather than dropping it", () => {
		expect(
			adaptObservation(append({ stageKey: "s", kind: "teleport" })),
		).toMatchObject({ kind: "other" });
		expect(adaptObservation(append({ stageKey: "s" }))).toMatchObject({
			kind: "other",
			deliverable: "the run",
			summary: "no summary",
		});
	});

	it("knows the eight kinds pi-workflow names", () => {
		expect([...NARRATION_KINDS]).toEqual([
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

// ── What earns a turn ────────────────────────────────────────────────────────

describe("the line and the turn", () => {
	const of = (over: Partial<Narration>): Narration => ({
		kind: "implement",
		stage: "implement",
		deliverable: "d1",
		summary: "did the work",
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
		for (const kind of NARRATION_KINDS)
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
				stage: "review",
				deliverable: "d1",
				summary: "contracts filed two observations",
			}),
		).toBe("compose · d1 · review review — contracts filed two observations");
	});

	it("puts a cause on its own line", () => {
		expect(
			renderNarration(SLUG, {
				kind: "implement",
				stage: "implement",
				deliverable: "d1",
				summary: "the attempt stopped",
				cause: "tsc exited 2",
			}),
		).toBe(
			"compose · d1 · implement implement — the attempt stopped\n  cause: tsc exited 2",
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
	it("says nothing about a run it did not start", () => {
		const n = narrator({ follow: false });
		n.observe(append({ stageKey: "implement", kind: "implement" }));
		n.flush();
		expect(n.sent).toEqual([]);
		expect(n.subject.following()).toEqual([]);
	});

	it("posts a routine completion with no turn at all", () => {
		const n = narrator();
		n.observe(
			append({
				stageKey: "implement",
				deliverableId: "d1",
				kind: "implement",
				summary: "wrote the adapter",
			}),
		);
		n.flush();
		expect(n.sent.length).toBe(1);
		expect(n.sent[0]?.[0]).toEqual({
			customType: PROGRESS_MESSAGE_TYPE,
			content: "compose · d1 · implement implement — wrote the adapter",
			display: true,
		});
		// `nextTurn` and nothing else: a fact the next turn should have.
		expect(n.delivery()).toEqual({ deliverAs: "nextTurn" });
	});

	it("coalesces a batch of appends into one message", () => {
		const n = narrator();
		n.observe(
			append({
				stageKey: "review",
				deliverableId: "d1",
				kind: "review",
				summary: "contracts is content",
			}),
			append({
				stageKey: "review",
				deliverableId: "d1",
				kind: "review",
				summary: "security is content",
			}),
			append({
				stageKey: "verify",
				deliverableId: "d1",
				kind: "check",
				summary: "the suite passes",
			}),
		);
		// One flush scheduled for three appends, and one message out of it.
		expect(n.flushes.length).toBe(1);
		n.flush();
		expect(n.sent.length).toBe(1);
		expect(n.content().split("\n")).toEqual([
			"compose · d1 · review review — contracts is content",
			"compose · d1 · review review — security is content",
			"compose · d1 · check verify — the suite passes",
		]);
		expect(n.delivery()?.triggerTurn).toBeUndefined();
	});

	it("triggers a turn for a synthesis, and says what to do with it", () => {
		const n = narrator();
		n.observe(
			append({
				stageKey: "review",
				deliverableId: "d1",
				kind: "review",
				summary: "contracts is content",
			}),
			append({
				stageKey: "synthesis",
				deliverableId: "d1",
				kind: "synthesis",
				summary: "two lenses disagree about the seam",
			}),
		);
		n.flush();
		// ONE message for the batch, and the turn is the batch's, not the line's.
		expect(n.sent.length).toBe(1);
		expect(n.delivery()).toEqual({
			deliverAs: "nextTurn",
			triggerTurn: true,
		});
		expect(n.content()).toContain("two lenses disagree about the seam");
		expect(n.content().endsWith(JUDGEMENT_SENTENCE)).toBe(true);
	});

	it("triggers a turn for a fix report", () => {
		const n = narrator();
		n.observe(
			append({
				stageKey: "fix",
				deliverableId: "d2",
				kind: "fix",
				summary: "one round closed the contracts finding",
			}),
		);
		n.flush();
		expect(n.delivery()?.triggerTurn).toBe(true);
		expect(n.content()).toContain(JUDGEMENT_SENTENCE);
	});

	it("triggers a turn for a failure and says nothing retries", () => {
		const n = narrator();
		n.observe(
			append({
				stageKey: "implement",
				deliverableId: "d1",
				kind: "implement",
				summary: "the attempt stopped",
				cause: "tsc exited 2",
			}),
		);
		n.flush();
		expect(n.delivery()?.triggerTurn).toBe(true);
		expect(n.content()).toContain("cause: tsc exited 2");
		expect(n.content()).toContain(FAILURE_SENTENCE);
	});

	it("triggers a turn for the ship gate, and the gate wins the batch's tail", () => {
		const n = narrator();
		n.observe(
			append({
				stageKey: "fix",
				deliverableId: "d1",
				kind: "fix",
				summary: "one round closed it",
			}),
			append({
				stageKey: "ship",
				deliverableId: "d2",
				kind: "gate",
				summary: "the ship decision is waiting",
			}),
		);
		n.flush();
		expect(n.delivery()?.triggerTurn).toBe(true);
		// The gate outranks the fix: the batch is one thing that happened, and the
		// decision is the part a person has to act on.
		expect(n.content()).toContain(shipGateSentence(RUN));
		expect(n.content()).not.toContain(JUDGEMENT_SENTENCE);
	});

	it("posts a final summary with a turn when a run ends without a gate", () => {
		for (const status of ["completed", "failed", "cancelled", "expired"]) {
			const n = narrator();
			n.observe(
				append({
					stageKey: "verify",
					deliverableId: "d1",
					kind: "check",
					summary: "the suite passes",
				}),
				append({ status }),
			);
			n.flush();
			expect(n.sent.length).toBe(1);
			expect(n.delivery()?.triggerTurn).toBe(true);
			expect(n.content()).toContain(
				`compose · run \`wfr-plan\` ended \`${status}\` without stopping at a gate.`,
			);
			expect(n.content()).toContain("what, if anything, is left to do by hand");
		}
	});

	it("says nothing extra when a run that stopped at a gate then ends", () => {
		const n = narrator();
		n.observe(
			append({
				stageKey: "ship",
				deliverableId: "d1",
				kind: "gate",
				summary: "the ship decision is waiting",
			}),
		);
		n.flush();
		n.observe(append({ status: "completed" }));
		n.flush();
		// One message, the gate's. The gate already said the one thing that
		// mattered, and publication takes it from there.
		expect(n.sent.length).toBe(1);
		expect(n.content()).toContain("gate ship");
	});

	it("posts a run's end once, however many terminal appends arrive", () => {
		const n = narrator();
		n.observe(append({ status: "completed" }));
		n.flush();
		n.observe(append({ status: "completed" }), append({ status: "completed" }));
		n.flush();
		expect(n.sent.length).toBe(1);
	});

	it("never throws into the session, and reports instead", () => {
		let listener: ((o: WorkflowRunObservationView) => void) | undefined;
		const errors: unknown[] = [];
		const subject = createRunNarrator({
			client: {
				observe: (handler) => {
					listener = handler;
					return () => undefined;
				},
			},
			send: () => {
				throw new Error("the session went away");
			},
			schedule: (flush) => flush(),
			onError: (error) => errors.push(error),
		});
		subject.follow(RUN, SLUG);
		expect(() =>
			listener?.(append({ stageKey: "implement", kind: "implement" })),
		).not.toThrow();
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
