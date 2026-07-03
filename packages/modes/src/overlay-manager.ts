/**
 * Manages overlay widgets positioned above the editor.
 *
 * Two overlays: "ask" (questions) and "agents" (dashboard).
 * Tab cycles focus between them and the input.
 * Only one expanded at a time. When input is focused, both collapse.
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

export type OverlayId = "ask" | "agents";

export interface ManagedOverlay {
	readonly id: OverlayId;
	/** The component to render (must implement render + handleInput). */
	component: OverlayComponent;
	/** Whether this overlay is currently mounted (visible as a widget). */
	mounted: boolean;
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
	private focusOrder: OverlayId[] = ["ask", "agents"];
	private focusedId: OverlayId | null = null;
	private inputBlocked = false;
	private removeInputListener: (() => void) | undefined;
	private ctx: ExtensionContext | undefined;

	/** Whether main-agent questions are blocking input. */
	get isInputBlocked(): boolean {
		return this.inputBlocked;
	}

	/** Attach to extension context. Registers the terminal input handler. */
	attach(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.removeInputListener?.();
		this.removeInputListener = ctx.ui.onTerminalInput((data) =>
			this.handleTerminalInput(data),
		);
	}

	/** Detach from context, remove listener. */
	detach(): void {
		this.removeInputListener?.();
		this.removeInputListener = undefined;
		this.ctx = undefined;
	}

	/** Register an overlay component. Mounts it as a widget. */
	mount(id: OverlayId, component: OverlayComponent): void {
		const overlay: ManagedOverlay = { id, component, mounted: true };
		this.overlays.set(id, overlay);
		component.focused = false;
		component.expanded = false;
		this.syncWidget(id);
	}

	/** Remove an overlay widget entirely. */
	unmount(id: OverlayId): void {
		if (this.focusedId === id) {
			this.focusedId = null;
		}
		this.overlays.delete(id);
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
				this.syncWidget(this.focusedId);
			}
		}

		this.focusedId = id;
		overlay.component.focused = true;
		overlay.component.expanded = true;
		this.syncWidget(id);
	}

	/** Return focus to input. Collapse all overlays. */
	focusInput(): void {
		if (this.focusedId) {
			const prev = this.overlays.get(this.focusedId);
			if (prev) {
				prev.component.focused = false;
				prev.component.expanded = false;
				this.syncWidget(this.focusedId);
			}
		}
		this.focusedId = null;
	}

	/** Block input (for main-agent questions). Auto-expands ask overlay. */
	blockInput(): void {
		this.inputBlocked = true;
		// Auto-expand the ask overlay
		if (this.overlays.has("ask")) {
			this.focusOverlay("ask");
		}
	}

	/** Unblock input. Collapse overlays, return focus to input. */
	unblockInput(): void {
		this.inputBlocked = false;
		this.focusInput();
	}

	private handleTerminalInput(
		data: string,
	): { consume?: boolean; data?: string } | undefined {
		// Tab: cycle focus ring
		if (data === KEY_TAB) {
			this.cycleNext();
			return { consume: true };
		}

		// If an overlay is focused, route all input to it
		if (this.focusedId) {
			const overlay = this.overlays.get(this.focusedId);
			if (overlay) {
				// Esc: collapse and return to input
				if (data === KEY_ESC) {
					if (this.inputBlocked) {
						// Can't escape when blocked — stay in ask
						return { consume: true };
					}
					this.focusInput();
					return { consume: true };
				}
				overlay.component.handleInput(data);
				this.syncWidget(this.focusedId);
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

	private syncWidget(id: OverlayId): void {
		const overlay = this.overlays.get(id);
		if (!overlay || !this.ctx) return;
		// setWidget with a component factory
		this.ctx.ui.setWidget(
			widgetKey(id),
			(_tui: TUI, _theme: Theme) => overlay.component,
			{ placement: "aboveEditor" },
		);
	}
}

function widgetKey(id: OverlayId): string {
	return `maestro.overlay.${id}`;
}
