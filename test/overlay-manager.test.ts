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

function mockCtx() {
	let handler:
		| ((data: string) => { consume?: boolean } | undefined)
		| undefined;
	const ctx = {
		ui: {
			setWidget: vi.fn(),
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

	it("Tab cycles focus: input → ask → agents → input", () => {
		const mgr = new OverlayManager();
		const ctx = mockCtx();
		mgr.attach(ctx as any);
		const ask = mockComponent();
		const agents = mockComponent();
		mgr.mount("ask", ask);
		mgr.mount("agents", agents);

		// Initially input focused (no overlay focused)
		expect(ask.focused).toBe(false);
		expect(agents.focused).toBe(false);

		// Tab → focus ask
		const r1 = ctx.sendInput("\t");
		expect(r1?.consume).toBe(true);
		expect(ask.focused).toBe(true);
		expect(ask.expanded).toBe(true);
		expect(agents.focused).toBe(false);

		// Tab → focus agents
		ctx.sendInput("\t");
		expect(ask.focused).toBe(false);
		expect(ask.expanded).toBe(false);
		expect(agents.focused).toBe(true);
		expect(agents.expanded).toBe(true);

		// Tab → back to input
		ctx.sendInput("\t");
		expect(ask.focused).toBe(false);
		expect(agents.focused).toBe(false);
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
		const ask = mockComponent();
		const agents = mockComponent();
		mgr.mount("ask", ask);
		mgr.mount("agents", agents);

		mgr.blockInput();
		// ask is focused (auto-expanded by blockInput)
		expect(ask.focused).toBe(true);

		// Tab → agents
		ctx.sendInput("\t");
		expect(agents.focused).toBe(true);

		// Tab → back to ask (skips input because blocked)
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
		// Tab should not crash with no overlays
		const result = ctx.sendInput("\t");
		expect(result?.consume).toBe(true);
	});

	it("skips unmounted overlays in focus ring", () => {
		const mgr = new OverlayManager();
		const ctx = mockCtx();
		mgr.attach(ctx as any);
		const agents = mockComponent();
		mgr.mount("agents", agents);
		// Only agents mounted, no ask

		ctx.sendInput("\t"); // focus agents (skip ask)
		expect(agents.focused).toBe(true);

		ctx.sendInput("\t"); // back to input
		expect(agents.focused).toBe(false);
	});

	it("focusOverlay expands specific overlay directly", () => {
		const mgr = new OverlayManager();
		const ctx = mockCtx();
		mgr.attach(ctx as any);
		const ask = mockComponent();
		const agents = mockComponent();
		mgr.mount("ask", ask);
		mgr.mount("agents", agents);

		mgr.focusOverlay("agents");
		expect(agents.focused).toBe(true);
		expect(agents.expanded).toBe(true);
		expect(ask.focused).toBe(false);
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
			const ask = mockComponent();
			const agents = mockComponent();
			mgr.mount("ask", ask);
			mgr.mount("agents", agents);
			const before = ctx.ui.setWidget.mock.calls.length;

			ctx.sendInput("\t"); // focus ask
			ctx.sendInput("\u001b[A"); // arrow into the component
			ctx.sendInput("\u001b[B");
			ctx.sendInput("\t"); // focus agents
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
