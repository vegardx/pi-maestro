import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AskEngine, createAskTool } from "@vegardx/pi-ask";
import type { Answers, Questionnaire } from "@vegardx/pi-contracts";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import { registerCapability } from "@vegardx/pi-core";
import type { AnswerModeOptions, openAnswerMode } from "@vegardx/pi-ui";
import { afterEach, describe, expect, it } from "vitest";
import { PendingSet } from "../packages/ask/src/pending.js";

// A context whose ui.custom resolves to a fixed answer set — runQuestionnaire
// just returns whatever ui.custom yields, so we never touch a real terminal.
// editorText drives the "auto-enter answer mode only when empty" rule.
function fakeCtx(
	result: Answers | undefined,
	hasUI = true,
	editorText = "",
): ExtensionContext & { statuses: Map<string, string | undefined> } {
	const statuses = new Map<string, string | undefined>();
	return {
		hasUI,
		statuses,
		ui: {
			custom: async () => result,
			getEditorText: () => editorText,
			setStatus: (key: string, text: string | undefined) => {
				statuses.set(key, text);
			},
			notify: () => {},
		},
	} as unknown as ExtensionContext & {
		statuses: Map<string, string | undefined>;
	};
}

const Q = [
	{ id: "tier", question: "Pick a tier", options: [{ label: "fast" }] },
];

// A scriptable answer-mode presenter: captures each open() so tests drive
// commits/defers exactly as the editor takeover would.
function fakePresenter() {
	const sessions: Array<{
		opts: AnswerModeOptions;
		closed: boolean;
		close(): void;
	}> = [];
	const open: typeof openAnswerMode = (_ui, opts) => {
		const session = {
			opts,
			closed: false,
			close() {
				if (session.closed) return;
				session.closed = true;
				opts.onClose?.();
			},
		};
		sessions.push(session);
		return {
			get currentQuestionId() {
				return opts.questions[0]?.id;
			},
			close: () => session.close(),
		};
	};
	return {
		open,
		sessions,
		/** The most recent still-open session. */
		current: () => sessions.filter((s) => !s.closed).at(-1),
	};
}

function pendingEngine(editorText = "") {
	const presenter = fakePresenter();
	const dispose = registerCapability(CAPABILITIES.overlays, {} as never);
	const delivered: string[] = [];
	const engine = new AskEngine(presenter.open);
	const ctx = fakeCtx(undefined, true, editorText);
	engine.setContext(ctx);
	engine.setDeliver((text) => delivered.push(text));
	return { engine, presenter, ctx, delivered, dispose };
}

describe("PendingSet", () => {
	const q = (id: string) => ({ id, question: `q ${id}` });

	it("posts append and upsert by id", () => {
		const set = new PendingSet();
		set.post([q("a"), q("b")]);
		set.post([{ ...q("a"), question: "updated" }]);
		expect(set.size).toBe(2);
		expect(set.questionnaire().map((x) => x.id)).toEqual(["a", "b"]);
		expect(set.questionnaire()[0].question).toBe("updated");
	});

	it("raises to the front, or right after the anchor question", () => {
		const set = new PendingSet();
		set.post([q("a"), q("b")]);
		set.raise([q("x")]);
		expect(set.questionnaire().map((x) => x.id)).toEqual(["x", "a", "b"]);
		set.raise([q("y")], "a");
		expect(set.questionnaire().map((x) => x.id)).toEqual(["x", "a", "y", "b"]);
		expect(set.activeBlockingIds).toEqual(["x", "y"]);
	});

	it("settles matched answers only once", () => {
		const set = new PendingSet();
		set.post([q("a"), q("b")]);
		const first = set.settle([
			{ questionId: "a", value: "1" },
			{ questionId: "zz", value: "?" },
		]);
		expect(first.map((a) => a.questionId)).toEqual(["a"]);
		expect(set.settle([{ questionId: "a", value: "1" }])).toEqual([]);
		expect(set.size).toBe(1);
	});

	it("defer demotes blocking entries and marks them in the list", () => {
		const set = new PendingSet();
		set.post([q("a")]);
		set.raise([q("x")]);
		expect(set.defer()).toEqual(["x"]);
		expect(set.activeBlockingIds).toEqual([]);
		expect(set.deferredCount).toBe(1);
		expect(set.list().find((p) => p.id === "x")?.deferred).toBe(true);
		expect(set.defer()).toEqual([]);
	});
});

describe("AskEngine pending set (HUD presentation)", () => {
	let dispose: (() => void) | undefined;
	afterEach(() => {
		dispose?.();
		dispose = undefined;
	});

	it("post pends without any takeover and delivers committed answers", () => {
		const rig = pendingEngine();
		dispose = rig.dispose;
		const changes: Array<{ pending: number; blocking: number }> = [];
		rig.engine.setOnChanged((c) => changes.push(c));
		rig.engine.post(Q);
		// No answer-mode session, no input capture — just the pending set.
		expect(rig.presenter.sessions).toHaveLength(0);
		expect(rig.engine.pending().map((p) => p.id)).toEqual(["tier"]);
		expect(changes.at(-1)).toEqual({ pending: 1, blocking: 0 });

		// HUD Enter → answer mode for that question; option commit delivers.
		rig.engine.openAnswers("tier");
		const session = rig.presenter.current();
		expect(session?.opts.blocking).toBe(false);
		session?.opts.onDone([{ questionId: "tier", value: "fast" }]);
		session?.close();

		expect(rig.delivered).toHaveLength(1);
		expect(rig.delivered[0]).toContain("tier");
		expect(rig.delivered[0]).toContain("fast");
		expect(rig.engine.pending()).toEqual([]);
	});

	it("blocking present with an empty editor auto-enters answer mode", async () => {
		const rig = pendingEngine();
		dispose = rig.dispose;
		const promise = rig.engine.present([
			{ ...Q[0], blocking: true, whyBlocking: "next step depends on it" },
		]);
		// Footer badge on, answer mode open, but input never captured.
		expect(rig.ctx.statuses.get("maestro.ask")).toBe("maestro waiting on you");
		const session = rig.presenter.current();
		expect(session?.opts.blocking).toBe(true);
		expect(session?.opts.title).toBe("maestro");

		session?.opts.onDone([{ questionId: "tier", value: "fast" }]);
		const answers = await promise;
		expect(answers).toEqual([{ questionId: "tier", value: "fast" }]);
		expect(rig.ctx.statuses.get("maestro.ask")).toBeUndefined();
		expect(rig.delivered).toEqual([]);
	});

	it("blocking present with a user draft badges only — input is never stolen", () => {
		const rig = pendingEngine("half-typed prompt");
		dispose = rig.dispose;
		void rig.engine.present([{ ...Q[0], blocking: true, whyBlocking: "gate" }]);
		expect(rig.presenter.sessions).toHaveLength(0);
		expect(rig.ctx.statuses.get("maestro.ask")).toBe("maestro waiting on you");
		expect(rig.engine.pending()).toEqual([
			{
				id: "tier",
				header: undefined,
				question: "Pick a tier",
				blocking: true,
			},
		]);
		expect(rig.engine.blockingCount).toBe(1);
	});

	it("esc defers a blocking question: demoted, waiter resolves deferred", async () => {
		const rig = pendingEngine();
		dispose = rig.dispose;
		const promise = rig.engine.present([
			{ ...Q[0], blocking: true, whyBlocking: "gate" },
		]);
		const session = rig.presenter.current();
		session?.opts.onDefer?.();
		session?.close();

		const answers = await promise;
		expect(answers).toEqual([
			{ questionId: "tier", value: "", deferred: true },
		]);
		expect(rig.ctx.statuses.get("maestro.ask")).toBeUndefined();
		// Stays pending (deferred) and can still be answered later.
		expect(rig.engine.pending()).toEqual([
			{
				id: "tier",
				header: undefined,
				question: "Pick a tier",
				deferred: true,
			},
		]);
		rig.engine.openAnswers("tier");
		const again = rig.presenter.current();
		again?.opts.onDone([{ questionId: "tier", value: "fast" }]);
		again?.close();
		expect(rig.delivered).toHaveLength(1);
		expect(rig.delivered[0]).toContain("fast");
	});

	it("a blocking raise jumps ahead of posted questions", () => {
		const rig = pendingEngine("draft keeps answer mode shut");
		dispose = rig.dispose;
		rig.engine.post([
			{ id: "a", question: "posted a" },
			{ id: "b", question: "posted b" },
		]);
		void rig.engine.present([
			{ id: "x", question: "urgent", blocking: true, whyBlocking: "gate" },
		]);
		expect(rig.engine.pending().map((p) => p.id)).toEqual(["x", "a", "b"]);
	});

	it("shorthand still settles the pending set and delivers at once", () => {
		const rig = pendingEngine();
		dispose = rig.dispose;
		rig.engine.post(Q);
		expect(rig.engine.applyShorthand("1")).toBe(true);
		expect(rig.engine.pending()).toEqual([]);
		expect(rig.delivered).toHaveLength(1);
		expect(rig.delivered[0]).toContain("fast");
		// Non-matching text is left alone.
		expect(rig.engine.applyShorthand("just some prompt")).toBe(false);
	});
});

describe("AskEngine.present (legacy dialog path)", () => {
	it("short-circuits with no questions or no UI", async () => {
		const e = new AskEngine();
		expect(await e.present([])).toEqual([]);
		e.setContext(fakeCtx([{ questionId: "x", value: "y" }], false));
		expect(await e.present(Q)).toEqual([]);
	});

	it("resolves the answers from the dialog", async () => {
		const e = new AskEngine();
		e.setContext(fakeCtx([{ questionId: "tier", value: "fast" }]));
		expect(await e.present(Q)).toEqual([{ questionId: "tier", value: "fast" }]);
	});

	it("treats a cancelled dialog as no answer", async () => {
		const e = new AskEngine();
		e.setContext(fakeCtx(undefined));
		expect(await e.present(Q)).toEqual([]);
	});

	it("post without overlays runs the dialog and delivers the answers", async () => {
		const delivered: string[] = [];
		const e = new AskEngine();
		e.setContext(fakeCtx([{ questionId: "tier", value: "fast" }]));
		e.setDeliver((text) => delivered.push(text));
		e.post(Q);
		await new Promise((r) => setImmediate(r));
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toContain("fast");
	});
});

describe("AskEngine queue + flush", () => {
	it("accumulates then flushes once and clears", async () => {
		const e = new AskEngine();
		e.setContext(fakeCtx([{ questionId: "tier", value: "fast" }]));
		expect(e.hasQueued).toBe(false);
		e.queue(Q);
		e.queue([{ id: "set", question: "Which set" }]);
		expect(e.hasQueued).toBe(true);

		const answers = await e.flush();
		expect(answers).toEqual([{ questionId: "tier", value: "fast" }]);
		expect(e.hasQueued).toBe(false);
		expect(await e.flush()).toEqual([]);
	});

	it("ignores empty queue calls", () => {
		const e = new AskEngine();
		e.queue([]);
		expect(e.hasQueued).toBe(false);
	});
});

describe("ask tool", () => {
	async function run(
		engine: AskEngine,
		questions: Questionnaire,
	): Promise<string> {
		const tool = createAskTool(engine);
		const res = await tool.execute(
			"call-1",
			{ questions } as never,
			undefined as never,
			undefined as never,
			{} as ExtensionContext,
		);
		const text = res.content[0];
		return text.type === "text" ? text.text : "";
	}

	it("posts non-blocking questions and tells the model to continue", async () => {
		const e = new AskEngine();
		e.setContext(fakeCtx(undefined, false));
		const text = await run(e, Q);
		expect(text).toContain("Posted 1 question(s)");
		expect(text).toContain("Continue with independent work");
	});

	it("rejects blocking questions without whyBlocking", async () => {
		const e = new AskEngine();
		const text = await run(e, [{ ...Q[0], blocking: true }]);
		expect(text).toContain("whyBlocking");
		expect(text).toContain("tier");
	});

	it("blocking: returns answers as readable text plus a JSON block", async () => {
		const e = new AskEngine();
		e.setContext(
			fakeCtx([{ questionId: "tier", value: "heavy", custom: true }]),
		);
		const text = await run(e, [
			{ ...Q[0], blocking: true, whyBlocking: "cannot proceed" },
		]);
		expect(text).toContain("tier): heavy");
		expect(text).toContain("[free text]");
		expect(text).toContain('"questionId":"tier"');
	});

	it("blocking: renders a deferred answer as guidance to continue", async () => {
		const e = new AskEngine();
		e.setContext(fakeCtx([{ questionId: "tier", value: "", deferred: true }]));
		const text = await run(e, [
			{ ...Q[0], blocking: true, whyBlocking: "gate" },
		]);
		expect(text).toContain("deferred");
		expect(text).toContain("continue without blocking");
	});

	it("reports dismissal when there is no answer", async () => {
		const e = new AskEngine();
		e.setContext(fakeCtx(undefined));
		const text = await run(e, [
			{ ...Q[0], blocking: true, whyBlocking: "gate" },
		]);
		expect(text).toContain("dismissed");
	});
});
