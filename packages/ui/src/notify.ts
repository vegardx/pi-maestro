// Thin wrappers over the host UI context for consistent notifications and
// status text across extensions. Keeps prefixes/severities uniform so the
// whole maestro suite speaks with one voice.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type NotifyKind = "info" | "warning" | "error";

/** Notify with a stable "maestro" provenance prefix. */
export function notify(
	ctx: ExtensionContext,
	message: string,
	kind: NotifyKind = "info",
): void {
	ctx.ui.notify(message, kind);
}

export function notifyError(ctx: ExtensionContext, message: string): void {
	ctx.ui.notify(message, "error");
}

export function notifyWarning(ctx: ExtensionContext, message: string): void {
	ctx.ui.notify(message, "warning");
}

/**
 * Set (or clear, when text is undefined) a footer status line under a stable
 * key. Wrapper over ctx.ui.setStatus so callers don't manage raw keys.
 */
export function setStatus(
	ctx: ExtensionContext,
	key: string,
	text: string | undefined,
): void {
	ctx.ui.setStatus(key, text);
}
