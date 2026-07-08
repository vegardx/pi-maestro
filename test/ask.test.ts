import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AskEngine, createAskTool } from "@vegardx/pi-ask";
import type { Answers, Questionnaire } from "@vegardx/pi-contracts";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import { registerCapability } from "@vegardx/pi-core";
import type { CollapsibleQuestionnaireComponent } from "@vegardx/pi-ui";
import { afterEach, describe, expect, it } from "vitest";
import { PendingSet } from "../packages/ask/src/pending.js";

// A context whose ui.custom resolves to a fixed answer set — runQuestionnaire
// just returns whatever ui.custom yields, so we never touch a real terminal.
function fakeCtx(result: Answers | undefined, hasUI = true): ExtensionContext {
	return {
		hasUI,
		ui: { custom: async () => result },
	} as unknown as ExtensionContext;
}

const Q = [
	{ id: "tier", question: "Pick a tier", options: [{ label: "fast" }] },
];

const ESC = "";
const ENTER = "\r";

// A scriptable overlays capability: exposes the mounted ask component so
// tests drive it with raw key input, exactly as the overlay manager would.
function fakeOverlays() {
	const mounted = new Map<string, CollapsibleQuestionnaireComponent>();
	let blocked = false;
	const overlays = {
		mount: (id: string, c: unknown) => {
			mounted.set(id, c as CollapsibleQuestionnaireComponent);
		},
		unmount: (id: string) => {
			mounted.delete(id);
		},
		focusOverlay: (id: string) => {
			const c = mounted.get(id);
			if (c) {
				c.focused = true;
				c.expanded = true;
			}
		},
		focusInput: () => {
			for (const c of mounted.values()) {
				c.focused = false;
				c.expanded = false;
			}
		},
		blockInput: () => {
			blocked = true;
			const c = mounted.get("ask");
			if (c) {
				c.focused = true;
				c.expanded = true;
			}
		},
		unblockInput: () => {
			blocked = false;
		},
		get isInputBlocked() {
			return blocked;
		},
	};
	return {
		overlays,
		ask: () => mounted.get("ask"),
		get blocked() {
			return blocked;
		},
	};
}

function pendingEngine() {
	const fake = fakeOverlays();
	const dispose = registerCapability(
		CAPABILITIES.overlays,
		fake.overlays as never,
	);
	const delivered: string[] = [];
	const engine = new AskEngine();
	engine.setContext(fakeCtx(undefined));
	engine.setDeliver((text) => delivered.push(text));
	return { engine, fake, delivered, dispose };
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

describe("AskEngine pending set (overlays)", () => {
	let dispose: (() => void) | undefined;
	afterEach(() => {
		dispose?.();
		dispose = undefined;
	});

	it("post mounts a badge and delivers committed answers as follow-up", () => {
		const rig = pendingEngine();
		dispose = rig.dispose;
		rig.engine.post(Q);
		const comp = rig.fake.ask();
		expect(comp).toBeDefined();
		expect(comp?.expanded).toBe(false);
		expect(rig.fake.blocked).toBe(false);
		expect(rig.engine.pending().map((p) => p.id)).toEqual(["tier"]);

		// User tabs in and picks the first option.
		rig.fake.overlays.focusOverlay("ask");
		comp?.handleInput(ENTER);

		expect(rig.delivered).toHaveLength(1);
		expect(rig.delivered[0]).toContain("tier");
		expect(rig.delivered[0]).toContain("fast");
		expect(rig.engine.pending()).toEqual([]);
		expect(rig.fake.ask()).toBeUndefined();
	});

	it("present blocks input and resolves with the committed answer", async () => {
		const rig = pendingEngine();
		dispose = rig.dispose;
		const promise = rig.engine.present([
			{ ...Q[0], blocking: true, whyBlocking: "next step depends on it" },
		]);
		expect(rig.fake.blocked).toBe(true);
		const comp = rig.fake.ask();
		expect(comp?.expanded).toBe(true);

		comp?.handleInput(ENTER);
		const answers = await promise;
		expect(answers).toEqual([{ questionId: "tier", value: "fast" }]);
		expect(rig.fake.blocked).toBe(false);
		expect(rig.delivered).toEqual([]);
	});

	it("esc defers a blocking question: demoted, resolved, unblocked", async () => {
		const rig = pendingEngine();
		dispose = rig.dispose;
		const promise = rig.engine.present([
			{ ...Q[0], blocking: true, whyBlocking: "gate" },
		]);
		const comp = rig.fake.ask();
		comp?.handleInput(ESC);

		const answers = await promise;
		expect(answers).toEqual([
			{ questionId: "tier", value: "", deferred: true },
		]);
		expect(rig.fake.blocked).toBe(false);
		// Stays pending (deferred) and can still be answered later.
		expect(rig.engine.pending()).toEqual([
			{
				id: "tier",
				header: undefined,
				question: "Pick a tier",
				deferred: true,
			},
		]);
		const after = rig.fake.ask();
		rig.fake.overlays.focusOverlay("ask");
		after?.handleInput(ENTER);
		expect(rig.delivered).toHaveLength(1);
		expect(rig.delivered[0]).toContain("fast");
	});

	it("a blocking raise jumps ahead of posted questions", () => {
		const rig = pendingEngine();
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
