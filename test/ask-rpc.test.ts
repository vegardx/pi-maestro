// The RPC rendering path of the ask engine: in rpc mode (no TUI overlays), a
// question must surface as an extension_ui_request dialog (ctx.ui.select /
// ctx.ui.input) rather than the invisible TUI pending set. This pins that
// behavior deterministically, without a real model or terminal.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AskEngine } from "@vegardx/pi-ask";
import { afterEach, describe, expect, it, vi } from "vitest";

interface RpcHooks {
	onSelect?: (title: string, options: string[]) => Promise<string | undefined>;
	onInput?: (title: string) => Promise<string | undefined>;
}

/** A fake rpc-mode ExtensionContext whose ui.select/input are scriptable. */
function rpcCtx(hooks: RpcHooks): ExtensionContext {
	return {
		mode: "rpc",
		hasUI: true,
		ui: {
			select: (title: string, options: string[]) =>
				(hooks.onSelect ?? (async () => options[0]))(title, options),
			input: (title: string) => (hooks.onInput ?? (async () => ""))(title),
			notify: () => {},
			setStatus: () => {},
			getEditorText: () => "",
		},
	} as unknown as ExtensionContext;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("ask engine over rpc", () => {
	afterEach(() => vi.restoreAllMocks());

	it("present() renders a choice question as ctx.ui.select and returns the answer", async () => {
		const engine = new AskEngine();
		const select = vi.fn(async (_title: string, _options: string[]) => "slow");
		engine.setContext(rpcCtx({ onSelect: select }));

		const answers = await engine.present([
			{
				id: "tier",
				question: "Pick a tier",
				options: [{ label: "fast" }, { label: "slow" }],
			},
		]);

		expect(select).toHaveBeenCalledOnce();
		expect(select.mock.calls[0][1]).toEqual(["fast", "slow"]);
		expect(answers).toEqual([
			{ questionId: "tier", value: "slow", custom: false, source: "human" },
		]);
	});

	it("maps the picked label back to the option's value", async () => {
		const engine = new AskEngine();
		engine.setContext(rpcCtx({ onSelect: async () => "Enter execution" }));

		const answers = await engine.present([
			{
				id: "gate",
				question: "Proceed?",
				options: [
					{ label: "Enter execution", value: "enter" },
					{ label: "Stay in plan", value: "stay" },
				],
			},
		]);

		expect(answers[0]).toMatchObject({ questionId: "gate", value: "enter" });
	});

	it("post() is non-blocking and delivers the answer as a follow-up", async () => {
		const engine = new AskEngine();
		const delivered: string[] = [];
		engine.setDeliver((t) => delivered.push(t));
		engine.setContext(rpcCtx({ onSelect: async () => "fast" }));

		engine.post([
			{ id: "tier", question: "Pick", options: [{ label: "fast" }] },
		]);
		await tick();

		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toContain("tier");
		expect(delivered[0]).toContain("fast");
	});

	it("a cancelled (parked) dialog defers and delivers nothing", async () => {
		const engine = new AskEngine();
		const delivered: string[] = [];
		engine.setDeliver((t) => delivered.push(t));
		engine.setContext(rpcCtx({ onSelect: async () => undefined }));

		engine.post([{ id: "q", question: "x", options: [{ label: "a" }] }]);
		await tick();

		expect(delivered).toHaveLength(0);
	});

	it("free-text questions render as ctx.ui.input", async () => {
		const engine = new AskEngine();
		const input = vi.fn(async () => "my answer");
		engine.setContext(rpcCtx({ onInput: input }));

		const answers = await engine.present([
			{ id: "note", question: "Any notes?", allowFreeText: true },
		]);

		expect(input).toHaveBeenCalledOnce();
		expect(answers[0]).toMatchObject({
			questionId: "note",
			value: "my answer",
			custom: true,
			source: "human",
		});
	});
});
