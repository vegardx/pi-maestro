// /view and /steer command handlers: read-only tmux splits onto agent
// sessions and targeted guidance routed through the execution seam.

import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SubagentsCapabilityV1 } from "@vegardx/pi-contracts";
import { killPane, splitWindow } from "@vegardx/pi-tmux";
import type { ExecutionHandle } from "../exec/index.js";
import {
	descendantsOf,
	listAgentTargets,
	renderTargetResolutionError,
	resolveAgentTarget,
} from "./agent-targets.js";

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
 * and no argument, close it (toggle). Takes the base ExtensionContext so the
 * HUD's Enter action (no command context) can reuse it.
 */
export async function handleViewCommand(
	args: string,
	ctx: ExtensionContext,
	execution: ExecutionHandle | undefined,
	viewState: ViewState,
	subagents?: SubagentsCapabilityV1,
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
		const keys = listAgentTargets({ execution, subagents })
			.filter((candidate) => candidate.capabilities.view)
			.map((candidate) => candidate.id);
		if (keys.length === 0) {
			ctx.ui.notify("No agents to view.", "info");
			return;
		}
		const choice = await ctx.ui.select("View agent", keys);
		if (!choice) return;
		target = choice;
	}

	const targets = listAgentTargets({ execution, subagents });
	const resolution = resolveAgentTarget(targets, target);
	if (!resolution.ok) {
		ctx.ui.notify(renderTargetResolutionError(resolution), "warning");
		return;
	}
	const sessionName = resolution.target.tmuxSession;
	if (!sessionName) {
		ctx.ui.notify(
			`Target ${resolution.target.id} has no tmux session.`,
			"warning",
		);
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

/** `/steer <target> <guidance>` — one resolver for workers and runs. */
export function handleSteerCommand(
	args: string,
	ctx: ExtensionCommandContext,
	execution: ExecutionHandle,
	subagents?: SubagentsCapabilityV1,
): void {
	const space = args.trim().indexOf(" ");
	if (space > 0) {
		const selector = args.trim().slice(0, space);
		const guidance = args
			.trim()
			.slice(space + 1)
			.trim();
		const resolution = resolveAgentTarget(
			listAgentTargets({ execution, subagents }),
			selector,
		);
		if (guidance && resolution.ok && resolution.target.kind === "run") {
			const runId = resolution.target.id.slice("run:".length) as never;
			const run = subagents?.list().find((candidate) => candidate.id === runId);
			if (run) {
				subagents?.steer(run.id, guidance);
				ctx.ui.notify(`Steered ${resolution.target.id}.`, "info");
				return;
			}
			if (execution.steerProjectedRun?.(runId, guidance)) {
				ctx.ui.notify(`Steered ${resolution.target.id}.`, "info");
				return;
			}
		}
		if (guidance && !resolution.ok && resolution.reason === "ambiguous") {
			ctx.ui.notify(renderTargetResolutionError(resolution), "warning");
			return;
		}
	}
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

export interface ParsedInterrupt {
	readonly selector?: string;
	readonly scope: "self" | "children" | "tree" | "all";
}

export function parseInterruptArgs(args: string): ParsedInterrupt {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let scope: ParsedInterrupt["scope"] = "self";
	const selector: string[] = [];
	for (const token of tokens) {
		if (token === "--children") scope = "children";
		else if (token === "--tree") scope = "tree";
		else if (token === "--all") scope = "all";
		else selector.push(token);
	}
	return {
		...(selector.length ? { selector: selector.join(" ") } : {}),
		scope,
	};
}

export async function handleInterruptCommand(
	args: string,
	ctx: ExtensionContext,
	execution: ExecutionHandle | undefined,
	subagents: SubagentsCapabilityV1 | undefined,
): Promise<void> {
	const parsed = parseInterruptArgs(args);
	const targets = listAgentTargets({ execution, subagents, host: ctx });
	let selected: typeof targets;
	if (parsed.scope === "all") {
		selected = targets.filter((target) => target.capabilities.interrupt);
	} else {
		const resolution = resolveAgentTarget(
			targets,
			parsed.selector ?? "host:current",
		);
		if (!resolution.ok) {
			ctx.ui.notify(renderTargetResolutionError(resolution), "warning");
			return;
		}
		selected =
			parsed.scope === "self"
				? [resolution.target]
				: descendantsOf(targets, resolution.target.id);
		if (parsed.scope === "tree") selected = [resolution.target, ...selected];
	}
	if (selected.length === 0) {
		ctx.ui.notify("No interruptible targets in that scope.", "info");
		return;
	}
	const results: string[] = [];
	for (const target of selected) {
		if (target.kind === "host") {
			if (ctx.isIdle()) results.push(`${target.id}: already-idle`);
			else {
				ctx.abort();
				results.push(`${target.id}: accepted (session preserved)`);
			}
		} else if (target.kind === "worker") {
			const key = target.id.slice("worker:".length);
			const [deliverable, name] = key.split("/");
			const result =
				deliverable && execution?.interrupt
					? await execution.interrupt(deliverable, name)
					: undefined;
			results.push(
				`${target.id}: ${result?.outcome ?? "disconnected"} (session preserved)`,
			);
		} else {
			const runId = target.id.slice("run:".length) as never;
			const run = subagents?.list().find((candidate) => candidate.id === runId);
			const result = run
				? await subagents?.interrupt?.(run.id, "user interrupt")
				: await execution?.interruptProjectedRun?.(runId, "user interrupt");
			results.push(
				`${target.id}: ${result?.outcome ?? "disconnected"} (run settles)`,
			);
		}
	}
	ctx.ui.notify(
		results.join("\n"),
		results.some((line) => line.includes("disconnected")) ? "warning" : "info",
	);
}
