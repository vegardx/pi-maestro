// Held subagent sessions: lifetime is ownership.
//
// The assertions here are about what SURVIVES. A follow-up must land on the
// session that answered the first question — one `start`, two `prompt`s — or
// the "held" claim is a fresh reader wearing an old id. And an empty answer
// must leave the session held: the blank is the reader failing to report, not
// the session dying, and tearing it down would punish the caller for asking.

import { describe, expect, it } from "vitest";
import {
	EmptyAnswer,
	MAX_DEPTH,
	type ReadOnlySession,
	type ReadOnlySpawn,
} from "../packages/maestro/src/spawn.js";
import { SubagentSessions } from "../packages/maestro/src/subagent-sessions.js";

/**
 * A factory whose sessions record their calls and answer per turn. With no
 * scripted answers, turn n answers `answer n` — enough to tell answers apart.
 */
function factory(answers?: readonly (string | null)[]) {
	const sessions: { calls: string[]; spawn: ReadOnlySpawn }[] = [];
	const open = async (spawn: ReadOnlySpawn) => {
		const record = { calls: [] as string[], spawn };
		sessions.push(record);
		let turn = -1;
		const impl: ReadOnlySession = {
			async start() {
				record.calls.push("start");
			},
			async prompt(p) {
				record.calls.push(`prompt:${p}`);
				turn += 1;
			},
			async getLastAssistantText() {
				return answers ? (answers[turn] ?? null) : `answer ${turn + 1}`;
			},
			async stop() {
				record.calls.push("stop");
			},
		};
		return impl;
	};
	return { sessions, open };
}

const spawn = (over: Partial<ReadOnlySpawn> = {}): ReadOnlySpawn => ({
	kind: "read-only",
	cwd: "/repo",
	brief: "Look for X.",
	prompt: "Review the diff.",
	parentDepth: 1,
	...over,
});

describe("a started subagent stays held", () => {
	it("answers a follow-up on the same session: one start, two prompts", async () => {
		const f = factory();
		const held = new SubagentSessions(f.open);

		const started = await held.start({
			persona: "code-review",
			spawn: spawn(),
		});
		expect(started.id).toBe("code-review-1");
		expect(started.answer).toBe("answer 1");

		expect(await held.askAgain(started.id, "What about the tests?")).toBe(
			"answer 2",
		);
		// The whole point of holding it: the reader still has everything it read
		// the first time. A second session here would be a fresh reader wearing
		// an old id.
		expect(f.sessions).toHaveLength(1);
		expect(f.sessions[0]?.calls).toEqual([
			"start",
			"prompt:Review the diff.",
			"prompt:What about the tests?",
		]);
	});

	it("gives ids out deterministically, per persona", async () => {
		const f = factory();
		const held = new SubagentSessions(f.open);
		await held.start({ persona: "code-review", spawn: spawn() });
		await held.start({ persona: "code-review", spawn: spawn() });
		await held.start({ persona: "explorer", spawn: spawn() });
		expect(held.list().map((h) => h.id)).toEqual([
			"code-review-1",
			"code-review-2",
			"explorer-1",
		]);
	});

	it("lists what it holds, straight off the live map", async () => {
		const f = factory();
		const held = new SubagentSessions(f.open);
		await held.start({
			persona: "code-review",
			spawn: spawn({ model: "m-opus" }),
			family: "Anthropic",
		});
		expect(held.list()).toEqual([
			{
				id: "code-review-1",
				persona: "code-review",
				modelId: "m-opus",
				family: "Anthropic",
				state: "idle",
				asked: 1,
			},
		]);

		await held.start({ persona: "explorer", spawn: spawn() });
		expect(held.list().map((h) => [h.id, h.persona, h.state])).toEqual([
			["code-review-1", "code-review", "idle"],
			["explorer-1", "explorer", "idle"],
		]);
	});
});

describe("the map is the permission", () => {
	it("answers an unknown id by naming the ids that are real", async () => {
		const f = factory();
		const held = new SubagentSessions(f.open);
		await held.start({ persona: "code-review", spawn: spawn() });
		await held.start({ persona: "explorer", spawn: spawn() });
		// A corrective miss, not a permission refusal: the error's job is to
		// name what the caller actually holds.
		await expect(held.askAgain("reviewer-9", "anything")).rejects.toThrow(
			/no subagent `reviewer-9` — yours are: code-review-1, explorer-1/,
		);
	});

	it("says so when nothing is held at all", async () => {
		const held = new SubagentSessions(factory().open);
		await expect(held.askAgain("code-review-1", "anything")).rejects.toThrow(
			/you hold none/,
		);
	});

	it("takes one question at a time — its caller is the only asker", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let turn = 0;
		const open = async (): Promise<ReadOnlySession> => ({
			async start() {},
			async prompt() {
				turn += 1;
				if (turn > 1) await gate;
			},
			async getLastAssistantText() {
				return "a slow answer";
			},
			async stop() {},
		});
		const held = new SubagentSessions(open);
		const { id } = await held.start({ persona: "explorer", spawn: spawn() });

		const slow = held.askAgain(id, "the slow one");
		expect(held.list()[0]?.state).toBe("answering");
		await expect(held.askAgain(id, "the impatient one")).rejects.toThrow(
			/still answering — one question at a time/,
		);

		release();
		expect(await slow).toBe("a slow answer");
		expect(held.list()[0]?.state).toBe("idle");
	});

	it("guards the spawn before holding anything", async () => {
		const held = new SubagentSessions(factory().open);
		await expect(
			held.start({
				persona: "explorer",
				spawn: spawn({ parentDepth: MAX_DEPTH }),
			}),
		).rejects.toThrow(/nesting limit/);
		expect(held.list()).toEqual([]);
	});
});

describe("an empty answer is the reader failing, not the session dying", () => {
	it("throws EmptyAnswer on a blank follow-up and KEEPS the session", async () => {
		const f = factory(["a first answer", "   ", "a better answer"]);
		const held = new SubagentSessions(f.open);
		const { id } = await held.start({ persona: "explorer", spawn: spawn() });

		await expect(held.askAgain(id, "again")).rejects.toThrow(EmptyAnswer);

		// Held and re-askable: the caller may well want to ask differently, and
		// tearing the session down here would punish exactly that.
		expect(held.list()[0]?.state).toBe("idle");
		expect(await held.askAgain(id, "once more, concretely")).toBe(
			"a better answer",
		);
		expect(f.sessions).toHaveLength(1);
		expect(f.sessions[0]?.calls).not.toContain("stop");
	});
});

describe("every change is reported as the whole map", () => {
	// The hook the maestro's subtree listing hangs off: a worker forwards each
	// snapshot up its socket. Snapshots, never deltas — a listener that misses
	// one is fully caught up by the next, so there is no resync to get wrong.
	const snapshotsOf = (held: SubagentSessions) => {
		const seen: string[][] = [];
		held.onChange((snapshot) =>
			seen.push(snapshot.map((h) => `${h.id}:${h.state}:${h.asked}`)),
		);
		return seen;
	};

	it("fires through a start: held-and-answering, then the turn, then idle", async () => {
		const held = new SubagentSessions(factory().open);
		const seen = snapshotsOf(held);
		await held.start({ persona: "code-review", spawn: spawn() });
		// The entry is visible BEFORE the first answer arrives — a subagent that
		// exists is a subagent someone is waiting on — and every later state it
		// passes through is reported as the full map.
		expect(seen).toEqual([
			["code-review-1:answering:0"],
			["code-review-1:answering:1"],
			["code-review-1:idle:1"],
		]);
	});

	it("fires on both boundaries of a follow-up", async () => {
		const held = new SubagentSessions(factory().open);
		const { id } = await held.start({ persona: "explorer", spawn: spawn() });
		const seen = snapshotsOf(held);
		await held.askAgain(id, "and the tests?");
		expect(seen).toEqual([["explorer-1:answering:2"], ["explorer-1:idle:2"]]);
	});

	it("reports the empty map on stopAll", async () => {
		const held = new SubagentSessions(factory().open);
		await held.start({ persona: "explorer", spawn: spawn() });
		const seen = snapshotsOf(held);
		await held.stopAll();
		expect(seen).toEqual([[]]);
	});

	it("reports the removal of a session that never came up", async () => {
		const held = new SubagentSessions(async () => ({
			async start() {
				throw new Error("pi exploded on launch");
			},
			async prompt() {},
			async getLastAssistantText() {
				return null;
			},
			async stop() {},
		}));
		const seen = snapshotsOf(held);
		await expect(
			held.start({ persona: "explorer", spawn: spawn() }),
		).rejects.toThrow(/exploded/);
		// Added, then taken back: a listener that only saw the first snapshot
		// would report a reader that does not exist.
		expect(seen).toEqual([["explorer-1:answering:0"], []]);
	});
});

describe("teardown is hygiene, not the mechanism", () => {
	it("stops every held session", async () => {
		const f = factory();
		const held = new SubagentSessions(f.open);
		await held.start({ persona: "code-review", spawn: spawn() });
		await held.start({ persona: "explorer", spawn: spawn() });

		await held.stopAll();
		expect(f.sessions).toHaveLength(2);
		for (const s of f.sessions) expect(s.calls).toContain("stop");
		expect(held.list()).toEqual([]);
	});

	it("tolerates a session that will not stop — the process tree reaps it", async () => {
		let opened = 0;
		const stopped: number[] = [];
		const open = async (): Promise<ReadOnlySession> => {
			opened += 1;
			const n = opened;
			return {
				async start() {},
				async prompt() {},
				async getLastAssistantText() {
					return "fine";
				},
				async stop() {
					if (n === 1) throw new Error("already gone");
					stopped.push(n);
				},
			};
		};
		const held = new SubagentSessions(open);
		await held.start({ persona: "a", spawn: spawn() });
		await held.start({ persona: "b", spawn: spawn() });

		await held.stopAll();
		expect(stopped).toEqual([2]);
		expect(held.list()).toEqual([]);
	});

	it("does not hold a session that never came up", async () => {
		const held = new SubagentSessions(async () => ({
			async start() {
				throw new Error("pi exploded on launch");
			},
			async prompt() {},
			async getLastAssistantText() {
				return null;
			},
			async stop() {},
		}));
		await expect(
			held.start({ persona: "explorer", spawn: spawn() }),
		).rejects.toThrow(/exploded on launch/);
		// There is no conversation to come back to, so nothing is held.
		expect(held.list()).toEqual([]);
	});
});
