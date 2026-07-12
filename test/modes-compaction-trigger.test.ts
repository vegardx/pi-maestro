import { describe, expect, it, vi } from "vitest";
import { contextFillLadder } from "../packages/modes/src/runtime/carry-commands.js";
import {
	awaitCompaction,
	diagnoseResumeAfterCompaction,
	type ResumeAfterCompactionInput,
	shouldCompactMidDeliverable,
} from "../packages/modes/src/trigger.js";

describe("shouldCompactMidDeliverable", () => {
	const base = {
		mode: "auto" as const,
		compactionInFlight: false,
		hasActiveDeliverable: true,
		workingUsed: 200_000,
		workingTokens: 150_000,
	};

	it("fires when working budget crosses the threshold in auto mode", () => {
		expect(shouldCompactMidDeliverable(base)).toBe(true);
	});

	it("does not fire in plan or hack mode", () => {
		expect(shouldCompactMidDeliverable({ ...base, mode: "plan" })).toBe(false);
		expect(shouldCompactMidDeliverable({ ...base, mode: "hack" })).toBe(false);
	});

	it("does not fire while a compaction is in flight", () => {
		expect(
			shouldCompactMidDeliverable({ ...base, compactionInFlight: true }),
		).toBe(false);
	});

	it("does not fire without an active deliverable", () => {
		expect(
			shouldCompactMidDeliverable({ ...base, hasActiveDeliverable: false }),
		).toBe(false);
	});

	it("does not fire when total/working is unknown (null)", () => {
		expect(shouldCompactMidDeliverable({ ...base, workingUsed: null })).toBe(
			false,
		);
	});

	it("does not fire at or below the threshold (summary growth alone)", () => {
		// workingUsed excludes seed + rollingSummary, so a large summary that
		// keeps workingUsed under the limit must never trigger.
		expect(shouldCompactMidDeliverable({ ...base, workingUsed: 150_000 })).toBe(
			false,
		);
		expect(shouldCompactMidDeliverable({ ...base, workingUsed: 10_000 })).toBe(
			false,
		);
	});

	it("a fanout parent (idle, no active deliverable) never triggers", () => {
		// Cross-session isolation: the parent maestro session stays idle, so
		// even over-budget it must not own compaction or poke an agent session.
		expect(
			shouldCompactMidDeliverable({
				...base,
				hasActiveDeliverable: false,
				workingUsed: 999_999,
			}),
		).toBe(false);
	});
});

describe("awaitCompaction", () => {
	it("resolves when onComplete fires", async () => {
		await expect(
			awaitCompaction({
				start: ({ onComplete }) => onComplete(),
				timeoutMs: 1000,
			}),
		).resolves.toBeUndefined();
	});

	it("rejects when onError fires", async () => {
		await expect(
			awaitCompaction({
				start: ({ onError }) => onError(new Error("boom")),
				timeoutMs: 1000,
			}),
		).rejects.toThrow("boom");
	});

	it("rejects on timeout", async () => {
		vi.useFakeTimers();
		const p = awaitCompaction({ start: () => {}, timeoutMs: 50 });
		const assertion = expect(p).rejects.toThrow(/timed out after 50ms/);
		await vi.advanceTimersByTimeAsync(60);
		await assertion;
		vi.useRealTimers();
	});

	it("rejects immediately when the signal is already aborted", async () => {
		const ac = new AbortController();
		ac.abort();
		await expect(
			awaitCompaction({ start: () => {}, timeoutMs: 1000, signal: ac.signal }),
		).rejects.toThrow("aborted");
	});

	it("settles exactly once (onComplete after onError is ignored)", async () => {
		let complete = () => {};
		const p = awaitCompaction({
			start: ({ onComplete, onError }) => {
				onError(new Error("first"));
				complete = onComplete;
			},
			timeoutMs: 1000,
		});
		await expect(p).rejects.toThrow("first");
		// Late onComplete must not throw or change the settled result.
		expect(() => complete()).not.toThrow();
	});
});

describe("diagnoseResumeAfterCompaction", () => {
	const ok: ResumeAfterCompactionInput = {
		compacted: true,
		stageAtEntry: "executing",
		modeAtEntry: "auto",
		deliverableAtEntry: "a",
		currentStage: "executing",
		currentMode: "auto",
		currentDeliverable: "a",
		remainingTaskCount: 2,
	};

	it("resumes when every gate holds", () => {
		expect(diagnoseResumeAfterCompaction(ok)).toEqual({ resume: true });
	});

	it("gates on compaction failure", () => {
		expect(diagnoseResumeAfterCompaction({ ...ok, compacted: false })).toEqual({
			resume: false,
			gate: "compact-failed",
			driftedToExecComplete: false,
		});
	});

	it("gates when not executing at entry", () => {
		expect(
			diagnoseResumeAfterCompaction({ ...ok, stageAtEntry: "idle" }),
		).toMatchObject({ resume: false, gate: "stage-at-entry-not-executing" });
	});

	it("flags exec-complete drift", () => {
		expect(
			diagnoseResumeAfterCompaction({ ...ok, currentStage: "exec-complete" }),
		).toEqual({
			resume: false,
			gate: "stage-drifted",
			driftedToExecComplete: true,
		});
	});

	it("gates on stage drift back to idle (not exec-complete)", () => {
		expect(
			diagnoseResumeAfterCompaction({ ...ok, currentStage: "idle" }),
		).toEqual({
			resume: false,
			gate: "stage-drifted",
			driftedToExecComplete: false,
		});
	});

	it("gates on mode drift", () => {
		expect(
			diagnoseResumeAfterCompaction({ ...ok, currentMode: "hack" }),
		).toMatchObject({ resume: false, gate: "mode-drifted" });
	});

	it("gates on deliverable drift", () => {
		expect(
			diagnoseResumeAfterCompaction({ ...ok, currentDeliverable: "b" }),
		).toMatchObject({ resume: false, gate: "deliverable-drifted" });
	});

	it("gates when no tasks remain", () => {
		expect(
			diagnoseResumeAfterCompaction({ ...ok, remainingTaskCount: 0 }),
		).toMatchObject({ resume: false, gate: "no-remaining-tasks" });
	});
});

describe("contextFillLadder (nudge → force → warnings)", () => {
	function fakes(percent: number | null, warnedAt = 0) {
		const notes: Array<[string, string]> = [];
		const messages: string[] = [];
		const asked: string[] = [];
		let episode: unknown;
		const rt = {
			contextWarnedAt: warnedAt,
			engine: undefined,
			pendingCompaction: undefined,
			carryForward: {
				get: () => episode,
				begin: (e: unknown) => {
					if (episode) return false;
					episode = e;
					return true;
				},
				end: () => {
					episode = undefined;
				},
			},
			pi: {
				sendUserMessage: (text: string) => {
					messages.push(text);
				},
			},
			maestro: {
				capabilities: {
					get: () => ({
						ask: async (qs: Array<{ question: string }>) => {
							asked.push(qs[0].question);
							return [];
						},
					}),
				},
			},
		};
		const ctx = {
			// No cwd → the ladder falls back to default thresholds (30/50).
			getContextUsage: () => ({
				percent,
				tokens: percent === null ? null : percent * 2_000,
				contextWindow: 200_000,
			}),
			ui: {
				notify: (msg: string, level: string) => {
					notes.push([msg, level]);
				},
			},
		};
		return { notes, messages, asked, rt, ctx };
	}

	it("fires once at 70% as warning, escalates once at 90% as error", () => {
		const { notes, rt, ctx } = fakes(72, 50); // nudge+force already fired
		contextFillLadder(rt as never, ctx as never);
		contextFillLadder(rt as never, ctx as never); // no repeat
		expect(notes).toHaveLength(1);
		expect(notes[0][0]).toContain("72% full");
		expect(notes[0][0]).toContain("144k/200k");
		expect(notes[0][1]).toBe("warning");

		(ctx as { getContextUsage: unknown }).getContextUsage = () => ({
			percent: 91,
			tokens: 182_000,
			contextWindow: 200_000,
		});
		contextFillLadder(rt as never, ctx as never);
		expect(notes).toHaveLength(2);
		expect(notes[1][1]).toBe("error");
	});

	it("nudges a distill question once at 30%", () => {
		const { asked, messages, rt, ctx } = fakes(35);
		contextFillLadder(rt as never, ctx as never);
		contextFillLadder(rt as never, ctx as never); // no repeat
		expect(asked).toHaveLength(1);
		expect(asked[0]).toContain("distill now");
		expect(messages).toHaveLength(0); // nudge asks; it never forces
		expect(rt.contextWarnedAt).toBe(30);
	});

	it("forces a self-curated distill episode at 50%", () => {
		const { messages, rt, ctx } = fakes(55, 30); // nudge already fired
		contextFillLadder(rt as never, ctx as never);
		expect(rt.carryForward.get()).toBeTruthy();
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("FORCED distill");
		expect(messages[0]).toContain("divergence check");
		// Fires once — the running episode is never restarted.
		contextFillLadder(rt as never, ctx as never);
		expect(messages).toHaveLength(1);
	});

	it("re-arms after usage drops (a distill does that)", () => {
		const { notes, rt, ctx } = fakes(20, 90);
		contextFillLadder(rt as never, ctx as never);
		expect(rt.contextWarnedAt).toBe(0);
		expect(notes).toHaveLength(0);
	});

	it("does nothing when usage is unknown (right after compaction)", () => {
		const { notes, rt, ctx } = fakes(null);
		contextFillLadder(rt as never, ctx as never);
		expect(notes).toHaveLength(0);
	});
});
