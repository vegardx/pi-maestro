/**
 * Manages overlay widgets positioned above the editor.
 *
 * Overlay slots: "maestro" (settings), "ask" (legacy questions slot) and
 * "agents" (the HUD). Tab cycles focus between mounted overlays and the
 * input — consumed only when the editor is empty or an overlay is already
 * focused, so editor Tab-autocomplete keeps working. Only one overlay is
 * expanded at a time; focusing the input collapses them.
 *
 * Render discipline: pi's `ui.setWidget` is NOT an update — it disposes the
 * existing component, deletes the key, re-appends it, and rebuilds the whole
 * widget container. Calling it per keystroke/focus change/rebuild is what made
 * the ask dialog flicker. So each overlay key is set ONCE with a stable
 * wrapper that delegates to the current component; everything after that —
 * component swaps, focus changes, input routing — only mutates state and asks
 * the TUI to re-render.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { uiTrace } from "@vegardx/pi-core";

export type OverlayId = "ask" | "agents" | "maestro";

export interface ManagedOverlay {
	readonly id: OverlayId;
	/** The component to render (must implement render + handleInput). */
	component: OverlayComponent;
	/** Whether this overlay is currently mounted (visible as a widget). */
	mounted: boolean;
	/** Stable delegating component handed to pi ONCE; survives swaps. */
	readonly wrapper: Component;
}

export interface OverlayComponent extends Component {
	focused: boolean;
	expanded: boolean;
	handleInput(data: string): void;
}

const KEY_TAB = "\t";
const KEY_ESC = "\u001b";

export class OverlayManager {
	private overlays = new Map<OverlayId, ManagedOverlay>();
	private focusOrder: OverlayId[] = ["maestro", "ask", "agents"];
	private focusedId: OverlayId | null = null;
	private inputBlocked = false;
	private removeInputListener: (() => void) | undefined;
	private ctx: ExtensionContext | undefined;
	private requestRender: (() => void) | undefined;

	/** Whether main-agent questions are blocking input. */
	get isInputBlocked(): boolean {
		return this.inputBlocked;
	}

	/** Attach to extension context. Registers the terminal input handler. */
	attach(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.removeInputListener?.();
		if (ctx.ui.onTerminalInput) {
			this.removeInputListener = ctx.ui.onTerminalInput((data) =>
				this.handleTerminalInput(data),
			);
		}
		// Recover overlays mounted before the context existed.
		for (const overlay of this.overlays.values()) {
			if (overlay.mounted) this.setWidget(overlay.id);
		}
	}

	/** Detach from context, remove listener. */
	detach(): void {
		this.removeInputListener?.();
		this.removeInputListener = undefined;
		this.ctx = undefined;
	}

	/**
	 * Register an overlay component. First mount sets the widget; a re-mount
	 * of the same id swaps the component into the existing wrapper WITHOUT
	 * touching the widget stack, preserving focus/expansion — a rebuild must
	 * not blink the dialog.
	 */
	mount(id: OverlayId, component: OverlayComponent): void {
		const existing = this.overlays.get(id);
		if (existing) {
			component.focused = existing.component.focused;
			component.expanded = existing.component.expanded;
			existing.component = component;
			existing.mounted = true;
			uiTrace("overlay.swap", id);
			this.refresh();
			return;
		}
		const overlay: ManagedOverlay = {
			id,
			component,
			mounted: true,
			wrapper: {
				render: (width: number) => {
					const current = this.overlays.get(id);
					return current ? current.component.render(width) : [];
				},
				invalidate: () => {
					this.overlays.get(id)?.component.invalidate?.();
				},
			},
		};
		this.overlays.set(id, overlay);
		component.focused = false;
		component.expanded = false;
		uiTrace("overlay.mount", id);
		this.setWidget(id);
	}

	/** Remove an overlay widget entirely. */
	unmount(id: OverlayId): void {
		if (this.focusedId === id) {
			this.focusedId = null;
		}
		this.overlays.delete(id);
		uiTrace("overlay.unmount", id);
		this.ctx?.ui.setWidget(widgetKey(id), undefined);
	}

	/** Expand + focus a specific overlay. Collapses others. */
	focusOverlay(id: OverlayId): void {
		const overlay = this.overlays.get(id);
		if (!overlay?.mounted) return;

		// Collapse the previously focused overlay
		if (this.focusedId && this.focusedId !== id) {
			const prev = this.overlays.get(this.focusedId);
			if (prev) {
				prev.component.focused = false;
				prev.component.expanded = false;
			}
		}

		this.focusedId = id;
		overlay.component.focused = true;
		overlay.component.expanded = true;
		uiTrace("overlay.focus", id);
		this.refresh();
	}

	/** Return focus to input. Collapse all overlays. */
	focusInput(): void {
		if (this.focusedId) {
			const prev = this.overlays.get(this.focusedId);
			if (prev) {
				prev.component.focused = false;
				prev.component.expanded = false;
			}
			uiTrace("overlay.focus", "input");
			this.refresh();
		}
		this.focusedId = null;
	}

	/** Block input (for main-agent questions). Auto-expands ask overlay. */
	blockInput(): void {
		this.inputBlocked = true;
		uiTrace("overlay.blockInput");
		// Auto-expand the ask overlay
		if (this.overlays.has("ask")) {
			this.focusOverlay("ask");
		}
	}

	/** Unblock input. Collapse overlays, return focus to input. */
	unblockInput(): void {
		this.inputBlocked = false;
		uiTrace("overlay.unblockInput");
		this.focusInput();
	}

	private handleTerminalInput(
		data: string,
	): { consume?: boolean; data?: string } | undefined {
		// Tab: cycle focus ring — but ONLY when the ring can meaningfully take
		// it. Consuming Tab unconditionally killed the editor's Tab-autocomplete
		// in every maestro session (even with nothing mounted). New rule: Tab is
		// ours when an overlay is already focused, or when the editor is empty
		// and there is at least one mounted overlay to cycle into. A non-empty
		// editor with input focus keeps Tab for autocomplete.
		if (data === KEY_TAB) {
			const anyMounted = this.focusOrder.some(
				(id) => this.overlays.get(id)?.mounted,
			);
			const editorText = this.ctx?.ui.getEditorText?.() ?? "";
			if (this.focusedId !== null || (anyMounted && editorText === "")) {
				this.cycleNext();
				return { consume: true };
			}
			return undefined;
		}

		// If an overlay is focused, route all input to it
		if (this.focusedId) {
			const overlay = this.overlays.get(this.focusedId);
			if (overlay) {
				// Esc: collapse and return to input
				if (data === KEY_ESC) {
					if (this.inputBlocked) {
						// Blocked: hand esc to the ask component so it can
						// defer the blocking question (it unblocks us back).
						if (this.focusedId === "ask") {
							overlay.component.handleInput(data);
							this.refresh();
						}
						return { consume: true };
					}
					this.focusInput();
					return { consume: true };
				}
				overlay.component.handleInput(data);
				this.refresh();
				return { consume: true };
			}
		}

		// If input is blocked and no overlay focused, consume input
		if (this.inputBlocked) {
			return { consume: true };
		}

		// Let input through normally
		return undefined;
	}

	private cycleNext(): void {
		const mounted = this.focusOrder.filter(
			(id) => this.overlays.get(id)?.mounted,
		);
		if (mounted.length === 0) return;

		if (this.focusedId === null) {
			// Input focused → first mounted overlay
			this.focusOverlay(mounted[0]);
		} else {
			const idx = mounted.indexOf(this.focusedId);
			const next = idx + 1;
			if (next >= mounted.length) {
				// Past last overlay → back to input (unless blocked)
				if (this.inputBlocked) {
					// Cycle back to first overlay
					this.focusOverlay(mounted[0]);
				} else {
					this.focusInput();
				}
			} else {
				this.focusOverlay(mounted[next]);
			}
		}
	}

	/** Re-render without touching the widget stack (state already mutated). */
	private refresh(): void {
		this.requestRender?.();
	}

	/**
	 * Public re-render request for overlay content that changed outside the
	 * input path (timers, execution events, plan updates). No widget re-set.
	 */
	invalidate(): void {
		this.requestRender?.();
	}

	/** Hand the stable wrapper to pi. The ONLY place a widget key is (re)set. */
	private setWidget(id: OverlayId): void {
		const overlay = this.overlays.get(id);
		if (!overlay || !this.ctx) return;
		this.ctx.ui.setWidget(
			widgetKey(id),
			(tui: TUI, _theme: Theme) => {
				this.requestRender = () =>
					(tui as unknown as { requestRender?: () => void })?.requestRender?.();
				return overlay.wrapper;
			},
			{ placement: "aboveEditor" },
		);
	}
}

function widgetKey(id: OverlayId): string {
	return `maestro.overlay.${id}`;
}
