// /view and /steer command handlers: read-only tmux splits onto agent
// sessions and targeted guidance routed through the execution seam.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { killPane, splitWindow } from "@vegardx/pi-tmux";
import type { ExecutionHandle } from "../exec/index.js";

/** Tracks the single /view split pane so a second /view replaces it. */
export interface ViewState {
	viewPaneId: string | undefined;
}

/** Read-only attach that escapes the maestro's own tmux context. */
function readOnlyAttachCommand(sessionName: string): string {
	return `env -u TMUX -u TMUX_PANE tmux attach-session -r -t ${sessionName} 2>/dev/null || echo "[session ended: ${sessionName}]"`;
}

/**
 * `/view <agent-or-deliverable>` — open a read-only tmux split attached to that
 * agent's session. No argument: pick from active agents; with an open pane
 * and no argument, close it (toggle).
 */
export async function handleViewCommand(
	args: string,
	ctx: ExtensionCommandContext,
	execution: ExecutionHandle,
	viewState: ViewState,
): Promise<void> {
	let target = args.trim();

	if (viewState.viewPaneId) {
		await killPane(viewState.viewPaneId).catch(() => {});
		viewState.viewPaneId = undefined;
		if (!target) {
			ctx.ui.notify("View pane closed.", "info");
			return;
		}
	}

	if (!target) {
		const keys = [...execution.snapshot().agents.keys()];
		if (keys.length === 0) {
			ctx.ui.notify("No agents to view.", "info");
			return;
		}
		const choice = await ctx.ui.select("View agent", keys);
		if (!choice) return;
		target = choice;
	}

	const sessionName = execution.resolveSessionName(target);
	if (!sessionName) {
		ctx.ui.notify(`No agent session matches "${target}".`, "warning");
		return;
	}

	try {
		viewState.viewPaneId = await splitWindow({
			horizontal: true,
			percent: 40,
			command: readOnlyAttachCommand(sessionName),
		});
		ctx.ui.notify(
			`Viewing ${sessionName} (read-only). /view to close.`,
			"info",
		);
	} catch (err) {
		ctx.ui.notify(
			`Could not open view pane: ${err instanceof Error ? err.message : String(err)}`,
			"warning",
		);
	}
}

export interface SteerTarget {
	deliverableId: string;
	/** Optional `name:` prefix before the guidance; defaults to the worker. */
	agentName?: string;
	guidance: string;
}

/** Parse `/steer <deliverable> [agent:] <guidance>`. */
export function parseSteerArgs(args: string): SteerTarget | undefined {
	const trimmed = args.trim();
	const space = trimmed.indexOf(" ");
	if (space === -1) return undefined;
	const deliverableId = trimmed.slice(0, space);
	let rest = trimmed.slice(space + 1).trim();
	if (!deliverableId || !rest) return undefined;

	let agentName: string | undefined;
	const prefix = rest.match(/^([A-Za-z0-9._-]+):\s*(.*)$/s);
	if (prefix?.[2]) {
		agentName = prefix[1];
		rest = prefix[2];
	}
	return { deliverableId, ...(agentName ? { agentName } : {}), guidance: rest };
}

/** `/steer <deliverable> [agent:] <guidance>` — routed via ExecutionHandle.steer. */
export function handleSteerCommand(
	args: string,
	ctx: ExtensionCommandContext,
	execution: ExecutionHandle,
): void {
	const target = parseSteerArgs(args);
	if (!target) {
		ctx.ui.notify("Usage: /steer <deliverable> [agent:] <guidance>", "warning");
		return;
	}
	const agent = target.agentName ?? "worker";
	const sent = execution.steer(
		target.deliverableId,
		target.guidance,
		target.agentName,
	);
	ctx.ui.notify(
		sent
			? `Steered ${target.deliverableId}/${agent}.`
			: `${target.deliverableId}/${agent} is not connected.`,
		sent ? "info" : "warning",
	);
}
