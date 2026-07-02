import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AskEngine, createAskTool } from "@vegardx/pi-ask";
import type { Answers } from "@vegardx/pi-contracts";

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

describe("AskEngine.present", () => {
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
	it("returns answers as readable text plus a JSON block", async () => {
		const e = new AskEngine();
		e.setContext(
			fakeCtx([{ questionId: "tier", value: "heavy", custom: true }]),
		);
		const tool = createAskTool(e);
		const res = await tool.execute(
			"call-1",
			{ questions: Q },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const text = res.content[0];
		expect(text.type).toBe("text");
		if (text.type === "text") {
			expect(text.text).toContain("tier): heavy");
			expect(text.text).toContain("[free text]");
			expect(text.text).toContain('"questionId":"tier"');
		}
	});

	it("reports dismissal when there is no answer", async () => {
		const e = new AskEngine();
		e.setContext(fakeCtx(undefined));
		const tool = createAskTool(e);
		const res = await tool.execute(
			"call-2",
			{ questions: Q },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const text = res.content[0];
		if (text.type === "text") expect(text.text).toContain("dismissed");
	});
});
