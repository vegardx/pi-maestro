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
});
