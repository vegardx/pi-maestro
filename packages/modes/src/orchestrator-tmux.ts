import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { killPane, splitWindow } from "@vegardx/pi-tmux";
import type { TmuxAgentState, TmuxFanout } from "./execution-tmux.js";

// ─── Status Widget ──────────────────────────────────────────────────────────

export function formatAgentStatusLine(
	agents: ReadonlyMap<string, TmuxAgentState>,
): string | undefined {
	if (agents.size === 0) return undefined;
	let working = 0;
	let done = 0;
	let failed = 0;
	let blocked = 0;
	for (const s of agents.values()) {
		if (s.status === "working" || s.status === "spawning") working++;
		else if (s.status === "done") done++;
		else if (s.status === "failed") failed++;
		else blocked++;
	}
	const parts: string[] = [];
	if (working > 0) parts.push(`${working} working`);
	if (done > 0) parts.push(`${done} done`);
	if (failed > 0) parts.push(`${failed} failed`);
	if (blocked > 0) parts.push(`${blocked} blocked`);
	if (parts.length === 0) return `Agents: ${agents.size} total`;
	return `Agents: ${parts.join(", ")}`;
}

export function updateAgentWidget(
	ctx: { ui: { setWidget(key: string, content: string[] | undefined): void } },
	agents: ReadonlyMap<string, TmuxAgentState>,
): void {
	const line = formatAgentStatusLine(agents);
	ctx.ui.setWidget("maestro.agents", line ? [line] : undefined);
}

// ─── View Command ───────────────────────────────────────────────────────────

export interface ViewState {
	viewPaneId: string | undefined;
}

export async function handleViewCommand(
	args: string,
	ctx: ExtensionCommandContext,
	fanout: TmuxFanout,
	viewState: ViewState,
): Promise<void> {
	// /view with no args and a pane open: close it
	if (!args.trim() && viewState.viewPaneId) {
		try {
			await killPane(viewState.viewPaneId);
		} catch {
			// Already closed
		}
		viewState.viewPaneId = undefined;
		return;
	}

	const snap = fanout.snapshot();
	if (snap.agents.size === 0) {
		ctx.ui.notify("No agents active.", "info");
		return;
	}

	let targetName: string | undefined = args.trim() || undefined;

	if (!targetName) {
		const options: string[] = [];
		for (const state of snap.agents.values()) {
			const icon =
				state.status === "working"
					? "[*]"
					: state.status === "done"
						? "[v]"
						: state.status === "failed"
							? "[!]"
							: "[ ]";
			options.push(`${icon} ${state.agentName}`);
		}
		const choice = await ctx.ui.select("View agent", options);
		if (!choice) return;
		targetName = choice.replace(/^\[.\]\s*/, "");
	}

	const agent = fanout.agentByName(targetName);
	if (!agent) {
		ctx.ui.notify(`Unknown agent: ${targetName}`, "warning");
		return;
	}

	// Close existing view pane before opening a new one
	if (viewState.viewPaneId) {
		try {
			await killPane(viewState.viewPaneId);
		} catch {
			// Already closed
		}
		viewState.viewPaneId = undefined;
	}

	// Open split pane attached to agent's tmux session (read-only)
	const command = `env -u TMUX -u TMUX_PANE tmux attach-session -r -t ${agent.agentName}`;
	try {
		const paneId = await splitWindow({
			horizontal: true,
			percent: 40,
			detach: true,
			command,
		});
		viewState.viewPaneId = paneId;
	} catch (e) {
		ctx.ui.notify(
			`Failed to open view: ${e instanceof Error ? e.message : "unknown error"}`,
			"warning",
		);
	}
}

// ─── Steer Command ──────────────────────────────────────────────────────────

export function handleSteerCommand(
	args: string,
	ctx: ExtensionCommandContext,
	fanout: TmuxFanout,
): void {
	const spaceIdx = args.indexOf(" ");
	if (spaceIdx === -1 || !args.trim()) {
		ctx.ui.notify("Usage: /steer <agent-name> <guidance>", "warning");
		return;
	}
	const name = args.slice(0, spaceIdx).trim();
	const message = args.slice(spaceIdx + 1).trim();
	if (!name || !message) {
		ctx.ui.notify("Usage: /steer <agent-name> <guidance>", "warning");
		return;
	}

	const agent = fanout.agentByName(name);
	if (!agent) {
		ctx.ui.notify(`Unknown agent: ${name}`, "warning");
		return;
	}

	const sent = fanout.steer(agent.deliverableId, message);
	if (sent) {
		ctx.ui.notify(`Steered ${name}: "${message}"`, "info");
	} else {
		ctx.ui.notify(`${name} is not connected.`, "warning");
	}
}

// ─── Agents List Command ────────────────────────────────────────────────────

export function handleAgentsCommand(
	ctx: ExtensionCommandContext,
	fanout: TmuxFanout,
): void {
	const snap = fanout.snapshot();
	if (snap.agents.size === 0) {
		ctx.ui.notify("No agents active.", "info");
		return;
	}

	const lines: string[] = [];
	for (const state of snap.agents.values()) {
		const icon =
			state.status === "working"
				? "*"
				: state.status === "done"
					? "v"
					: state.status === "failed"
						? "!"
						: "-";
		const tokens =
			state.tokens.turns > 0
				? ` (${state.tokens.turns} turns, ${state.tokens.totalTokens} tok)`
				: "";
		lines.push(`[${icon}] ${state.agentName}  ${state.deliverableId}${tokens}`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}
