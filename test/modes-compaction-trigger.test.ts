import { describe, expect, it } from "vitest";
import {
	contextFillLadder,
	firePendingForcedDistill,
} from "../packages/modes/src/runtime/carry-commands.js";

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

	it("50% crossing ARMS the force; agent_end fires it (never mid-run)", () => {
		const { messages, notes, rt, ctx } = fakes(55, 30); // nudge already fired
		contextFillLadder(rt as never, ctx as never);
		// Mid-run (turn_end fires between tool loops): nothing starts yet.
		expect(rt.carryForward.get()).toBeFalsy();
		expect(messages).toHaveLength(0);
		expect(
			(rt as { pendingForcedDistill?: { fillPct: number } })
				.pendingForcedDistill,
		).toEqual({ fillPct: 55 });
		expect(notes.some(([m]) => m.includes("queued"))).toBe(true);
		// Arms once — no re-arm on the next turn_end.
		contextFillLadder(rt as never, ctx as never);
		expect(notes.filter(([m]) => m.includes("queued"))).toHaveLength(1);

		// The run settles: agent_end fires the armed distill.
		firePendingForcedDistill(rt as never, ctx as never);
		expect(rt.carryForward.get()).toBeTruthy();
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("FORCED distill");
		expect(messages[0]).toContain("divergence check");
		// Disarmed + episode running — later agent_ends are no-ops.
		firePendingForcedDistill(rt as never, ctx as never);
		expect(messages).toHaveLength(1);
	});

	it("an armed force is dropped when an episode started meanwhile", () => {
		const { messages, rt, ctx } = fakes(55, 30);
		contextFillLadder(rt as never, ctx as never);
		// e.g. the user ran /distill themselves before the run settled.
		rt.carryForward.begin({ kind: "distill" });
		firePendingForcedDistill(rt as never, ctx as never);
		expect(messages).toHaveLength(0);
		expect(
			(rt as { pendingForcedDistill?: unknown }).pendingForcedDistill,
		).toBeUndefined();
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
