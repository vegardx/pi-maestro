import { describe, expect, it, vi } from "vitest";
import {
	type OverlayComponent,
	OverlayManager,
} from "../packages/modes/src/overlay-manager.js";

function mockComponent(): OverlayComponent {
	return {
		focused: false,
		expanded: false,
		handleInput: vi.fn(),
		invalidate() {},
		render: () => ["line"],
	};
}

function mockCtx(editorText = "") {
	let handler:
		| ((data: string) => { consume?: boolean } | undefined)
		| undefined;
	const ctx = {
		editorText,
		ui: {
			setWidget: vi.fn(),
			getEditorText: () => ctx.editorText,
			onTerminalInput: (
				fn: (data: string) => { consume?: boolean } | undefined,
			) => {
				handler = fn;
				return () => {
					handler = undefined;
				};
			},
		},
		sendInput: (data: string) => handler?.(data),
	};
	return ctx;
}

describe("OverlayManager", () => {
	it("mounts overlays as widgets", () => {
		const mgr = new OverlayManager();
		const ctx = mockCtx();
		mgr.attach(ctx as any);
		const comp = mockComponent();
		mgr.mount("ask", comp);
		expect(ctx.ui.setWidget).toHaveBeenCalledWith(
			"maestro.overlay.ask",
			expect.any(Function),
			{ placement: "aboveEditor" },
		);
	});

	it("Tab cycles focus: input → maestro → ask → input", () => {
		const mgr = new OverlayManager();
		const ctx = mockCtx();
		mgr.attach(ctx as any);
		const maestro = mockComponent();
		const ask = mockComponent();
		mgr.mount("maestro", maestro);
		mgr.mount("ask", ask);

		// Initially input focused (no overlay focused)
		expect(maestro.focused).toBe(false);
		expect(ask.focused).toBe(false);

		// Tab → focus maestro
		const r1 = ctx.sendInput("\t");
		expect(r1?.consume).toBe(true);
		expect(maestro.focused).toBe(true);
		expect(maestro.expanded).toBe(true);
		expect(ask.focused).toBe(false);

		// Tab → focus ask
		ctx.sendInput("\t");
		expect(maestro.focused).toBe(false);
		expect(maestro.expanded).toBe(false);
		expect(ask.focused).toBe(true);
		expect(ask.expanded).toBe(true);

		// Tab → back to input
		ctx.sendInput("\t");
		expect(maestro.focused).toBe(false);
		expect(ask.focused).toBe(false);
	});

	// The HUD left the manager: its slot no longer exists, so a session with
	// no dialog open (the normal state — "maestro" is mounted only while the
	// /maestro dialog is open) must let plain Tab through to the focused
	// editor component (MaestroEditor's ring grammar).
	it("has no agents slot — Tab reaches the editor in a bare session", () => {
		const mgr = new OverlayManager();
		const ctx = mockCtx("");
		mgr.attach(ctx as any);
		expect(ctx.sendInput("\t")).toBeUndefined();
		// @ts-expect-error "agents" is no longer an OverlayId
		mgr.mount("agents", mockComponent());
	});

	it("/maestro dialog stays focusable: Tab is consumed only while mounted", () => {
		const mgr = new OverlayManager();
		const ctx = mockCtx("");
		mgr.attach(ctx as any);
		const dialog = mockComponent();
		mgr.mount("maestro", dialog);
		const result = ctx.sendInput("\t");
		expect(result?.consume).toBe(true);
		expect(dialog.focused).toBe(true);
		mgr.unmount("maestro");
		expect(ctx.sendInput("\t")).toBeUndefined();
	});

	// Tab consumption rule: the ring takes Tab only when it can meaningfully
	// use it — an overlay is focused, or the editor is empty with something
	// mounted. Everything else keeps Tab for editor autocomplete.
	describe("Tab consumption rule", () => {
		it("passes Tab through when nothing is mounted", () => {
			const mgr = new OverlayManager();
			const ctx = mockCtx();
			mgr.attach(ctx as any);
			expect(ctx.sendInput("\t")).toBeUndefined();
		});

		it("passes Tab through when the editor has a draft", () => {
			const mgr = new OverlayManager();
			const ctx = mockCtx("half-typed prom");
			mgr.attach(ctx as any);
			const ask = mockComponent();
			mgr.mount("ask", ask);
			expect(ctx.sendInput("\t")).toBeUndefined();
			expect(ask.focused).toBe(false);
		});

		it("consumes Tab with a draft once an overlay is focused", () => {
			const mgr = new OverlayManager();
			const ctx = mockCtx();
			mgr.attach(ctx as any);
			const ask = mockComponent();
			mgr.mount("ask", ask);
			ctx.sendInput("\t"); // empty editor → focus ask
			expect(ask.focused).toBe(true);
			ctx.editorText = "draft written while overlay focused";
			// Focused ring keeps cycling regardless of the draft.
			const result = ctx.sendInput("\t");
			expect(result?.consume).toBe(true);
			expect(ask.focused).toBe(false); // cycled back to input
		});

		it("consumes Tab on an empty editor with an overlay mounted", () => {
			const mgr = new OverlayManager();
			const ctx = mockCtx("");
			mgr.attach(ctx as any);
			const ask = mockComponent();
			mgr.mount("ask", ask);
			const result = ctx.sendInput("\t");
			expect(result?.consume).toBe(true);
			expect(ask.focused).toBe(true);
		});
	});

	it("Esc returns focus to input", () => {
		const mgr = new OverlayManager();
		const ctx = mockCtx();
		mgr.attach(ctx as any);
		const ask = mockComponent();
		mgr.mount("ask", ask);

		ctx.sendInput("\t"); // focus ask
		expect(ask.expanded).toBe(true);

		ctx.sendInput("\u001b"); // Esc
		expect(ask.expanded).toBe(false);
		expect(ask.focused).toBe(false);
	});

	it("routes input to focused overlay", () => {
		const mgr = new OverlayManager();
		const ctx = mockCtx();
		mgr.attach(ctx as any);
		const ask = mockComponent();
		mgr.mount("ask", ask);

		ctx.sendInput("\t"); // focus ask
		ctx.sendInput("\u001b[A"); // up arrow

		expect(ask.handleInput).toHaveBeenCalledWith("\u001b[A");
	});

	it("does not consume input when no overlay focused", () => {
		const mgr = new OverlayManager();
		const ctx = mockCtx();
		mgr.attach(ctx as any);
		const ask = mockComponent();
		mgr.mount("ask", ask);

		// Type something with input focused
		const result = ctx.sendInput("a");
		expect(result).toBeUndefined();
	});

	it("blockInput locks editor and auto-expands ask", () => {
		const mgr = new OverlayManager();
		const ctx = mockCtx();
		mgr.attach(ctx as any);
		const ask = mockComponent();
		mgr.mount("ask", ask);

		mgr.blockInput();
		expect(mgr.isInputBlocked).toBe(true);
		expect(ask.focused).toBe(true);
		expect(ask.expanded).toBe(true);

		// Regular input is consumed
		const result = ctx.sendInput("a");
		// Input goes to the focused ask component
		expect(result?.consume).toBe(true);
	});

	it("blockInput prevents Esc from returning to input", () => {
		const mgr = new OverlayManager();
		const ctx = mockCtx();
		mgr.attach(ctx as any);
		const ask = mockComponent();
		mgr.mount("ask", ask);

		mgr.blockInput();
		ctx.sendInput("\u001b"); // Try to escape
		// Still focused on ask (can't escape when blocked)
		expect(ask.focused).toBe(true);
		expect(ask.expanded).toBe(true);
	});

	it("Tab cycles within overlays when blocked (never reaches input)", () => {
		const mgr = new OverlayManager();
		const ctx = mockCtx();
		mgr.attach(ctx as any);
		const maestro = mockComponent();
		const ask = mockComponent();
		mgr.mount("maestro", maestro);
		mgr.mount("ask", ask);

		mgr.blockInput();
		// ask is focused (auto-expanded by blockInput)
		expect(ask.focused).toBe(true);

		// Tab → wraps to maestro (skips input because blocked)
		ctx.sendInput("\t");
		expect(maestro.focused).toBe(true);

		// Tab → back to ask
		ctx.sendInput("\t");
		expect(ask.focused).toBe(true);
	});

	it("unblockInput restores normal behavior", () => {
		const mgr = new OverlayManager();
		const ctx = mockCtx();
		mgr.attach(ctx as any);
		const ask = mockComponent();
		mgr.mount("ask", ask);

		mgr.blockInput();
		mgr.unblockInput();
		expect(mgr.isInputBlocked).toBe(false);
		expect(ask.focused).toBe(false);
		expect(ask.expanded).toBe(false);

		// Input goes through normally
		const result = ctx.sendInput("a");
		expect(result).toBeUndefined();
	});

	it("unmount removes widget and clears focus", () => {
		const mgr = new OverlayManager();
		const ctx = mockCtx();
		mgr.attach(ctx as any);
		const ask = mockComponent();
		mgr.mount("ask", ask);

		ctx.sendInput("\t"); // focus ask
		mgr.unmount("ask");

		expect(ctx.ui.setWidget).toHaveBeenCalledWith(
			"maestro.overlay.ask",
			undefined,
		);
		// With nothing mounted, Tab passes through to the editor (autocomplete).
		const result = ctx.sendInput("\t");
		expect(result).toBeUndefined();
	});

	it("skips unmounted overlays in focus ring", () => {
		const mgr = new OverlayManager();
		const ctx = mockCtx();
		mgr.attach(ctx as any);
		const ask = mockComponent();
		mgr.mount("ask", ask);
		// Only ask mounted, no maestro

		ctx.sendInput("\t"); // focus ask (skip maestro)
		expect(ask.focused).toBe(true);

		ctx.sendInput("\t"); // back to input
		expect(ask.focused).toBe(false);
	});

	it("focusOverlay expands specific overlay directly", () => {
		const mgr = new OverlayManager();
		const ctx = mockCtx();
		mgr.attach(ctx as any);
		const maestro = mockComponent();
		const ask = mockComponent();
		mgr.mount("maestro", maestro);
		mgr.mount("ask", ask);

		mgr.focusOverlay("ask");
		expect(ask.focused).toBe(true);
		expect(ask.expanded).toBe(true);
		expect(maestro.focused).toBe(false);
	});

	// pi's setWidget disposes + deletes + re-appends the key and rebuilds the
	// whole widget container — repeated calls are the flicker mechanism. The
	// manager must set each key ONCE and drive everything else through state
	// mutation + re-render.
	describe("render discipline (flicker guard)", () => {
		function setWidgetCallsFor(ctx: ReturnType<typeof mockCtx>, key: string) {
			return ctx.ui.setWidget.mock.calls.filter((c) => c[0] === key);
		}

		it("re-mounting the same id swaps the component without a second setWidget", () => {
			const mgr = new OverlayManager();
			const ctx = mockCtx();
			mgr.attach(ctx as any);
			const first = mockComponent();
			mgr.mount("ask", first);
			mgr.focusOverlay("ask");
			expect(first.expanded).toBe(true);

			const second = mockComponent();
			second.render = () => ["second"];
			mgr.mount("ask", second);

			// Only the initial mount touched the widget stack.
			expect(setWidgetCallsFor(ctx, "maestro.overlay.ask")).toHaveLength(1);
			// Expansion/focus survive the rebuild — no collapsed blink frame.
			expect(second.expanded).toBe(true);
			expect(second.focused).toBe(true);
			// The stable wrapper delegates to the CURRENT component.
			const factory = setWidgetCallsFor(ctx, "maestro.overlay.ask")[0][1];
			const wrapper = factory({ requestRender: () => {} });
			expect(wrapper.render(80)).toEqual(["second"]);
		});

		it("keystrokes and focus changes never re-set the widget", () => {
			const mgr = new OverlayManager();
			const ctx = mockCtx();
			mgr.attach(ctx as any);
			const maestro = mockComponent();
			const ask = mockComponent();
			mgr.mount("maestro", maestro);
			mgr.mount("ask", ask);
			const before = ctx.ui.setWidget.mock.calls.length;

			ctx.sendInput("\t"); // focus maestro
			ctx.sendInput("\u001b[A"); // arrow into the component
			ctx.sendInput("\u001b[B");
			ctx.sendInput("\t"); // focus ask
			ctx.sendInput("\u001b"); // esc back to input
			mgr.blockInput();
			mgr.unblockInput();

			expect(ctx.ui.setWidget.mock.calls.length).toBe(before);
		});

		it("unmount then mount re-sets the widget (real removal, real return)", () => {
			const mgr = new OverlayManager();
			const ctx = mockCtx();
			mgr.attach(ctx as any);
			mgr.mount("ask", mockComponent());
			mgr.unmount("ask");
			mgr.mount("ask", mockComponent());

			const calls = setWidgetCallsFor(ctx, "maestro.overlay.ask");
			expect(calls).toHaveLength(3);
			expect(calls[1][1]).toBeUndefined();
			expect(calls[2][1]).toEqual(expect.any(Function));
		});
	});
});
