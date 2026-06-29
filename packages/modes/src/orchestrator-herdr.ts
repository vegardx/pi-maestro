// Orchestrator UX adapter: commands and panel data sourced from HerdrFanout.
// This module provides the command handlers and panel update logic for the
// herdr-backed orchestration path. Imported by runtime.ts when herdr is active.

import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	agentFocus,
	agentSend,
	isHerdrAvailable,
	workspaceFocus,
} from "@vegardx/pi-herdr";
import { shortDeliverableName } from "./agent-names.js";
import {
	type AgentState,
	agentStateFromDeliverable,
	renderAgentWidget,
	renderAgentWidgetCollapsed,
} from "./agent-widget.js";
import type { PlanEngine } from "./engine.js";
import type { HerdrAgentState, HerdrFanout } from "./execution-herdr.js";
import { deliverables } from "./schema.js";

export { isHerdrAvailable };

// --- /view command ---

export interface ViewCommandDeps {
	readonly herdrFanout: HerdrFanout;
	readonly orchestratorWorkspaceId?: string;
}

export async function handleViewCommand(
	args: string,
	ctx: ExtensionCommandContext,
	deps: ViewCommandDeps,
): Promise<void> {
	const target = args.trim();

	if (!target) {
		// Return to orchestrator.
		if (deps.orchestratorWorkspaceId) {
			try {
				await workspaceFocus(deps.orchestratorWorkspaceId);
			} catch {
				ctx.ui.notify("Could not return to orchestrator.", "warning");
			}
		} else {
			ctx.ui.notify("Already in orchestrator.", "info");
		}
		return;
	}

	// Find agent by name.
	const agent = deps.herdrFanout.agentByName(target);
	if (!agent) {
		ctx.ui.notify(`Unknown agent: ${target}`, "warning");
		return;
	}

	try {
		await agentFocus(agent.agentName);
	} catch {
		ctx.ui.notify(`Could not focus agent ${target}.`, "warning");
	}
}

// --- /steer command ---

export async function handleSteerCommand(
	args: string,
	ctx: ExtensionCommandContext,
	herdrFanout: HerdrFanout,
): Promise<void> {
	const [name, ...rest] = args.trim().split(/\s+/);
	const guidance = rest.join(" ");

	if (!name || !guidance) {
		ctx.ui.notify("Usage: /steer <agent-name> <guidance>", "warning");
		return;
	}

	const agent = herdrFanout.agentByName(name);
	if (!agent) {
		ctx.ui.notify(`Unknown agent: ${name}`, "warning");
		return;
	}

	if (agent.status !== "working" && agent.status !== "blocked") {
		ctx.ui.notify(`${name} is not currently active.`, "warning");
		return;
	}

	try {
		await agentSend(agent.agentName, guidance);
		ctx.ui.notify(`Steered ${name}: "${guidance}"`, "info");
	} catch {
		ctx.ui.notify(`Could not steer ${name}.`, "warning");
	}
}

// --- /agents command ---

export function handleAgentsCommand(
	ctx: ExtensionCommandContext,
	herdrFanout: HerdrFanout,
	engine: PlanEngine,
): void {
	const snap = herdrFanout.snapshot();
	if (snap.agents.size === 0) {
		ctx.ui.notify("No agents active.", "info");
		return;
	}

	const plan = engine.get();
	const lines: string[] = [];
	for (const [dId, state] of snap.agents) {
		const d = deliverables(plan).find((x) => x.id === dId);
		const title = d ? shortDeliverableName(d.title ?? dId) : dId;
		const icon =
			state.status === "working" ? "●" : state.status === "blocked" ? "◐" : "✓";
		const tokenStr =
			state.tokens.totalTokens > 0
				? ` ↑${formatTokenCount(state.tokens.input + state.tokens.cacheRead)} ↓${formatTokenCount(state.tokens.output)}`
				: "";
		lines.push(`${icon} ${state.agentName}   ${title}${tokenStr}`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

// --- Agent panel ---

export interface PanelDeps {
	readonly herdrFanout: HerdrFanout;
	readonly engine: PlanEngine;
	readonly agentStartTimes: ReadonlyMap<string, number>;
	readonly panelCollapsed: boolean;
}

export function updateHerdrAgentPanel(
	ctx: ExtensionContext,
	deps: PanelDeps,
): void {
	const snap = deps.herdrFanout.snapshot();
	const plan = deps.engine.get();
	const states: AgentState[] = [];

	for (const [dId, agentState] of snap.agents) {
		const d = deliverables(plan).find((x) => x.id === dId);
		if (!d) continue;

		const status = mapHerdrStatusToPanel(agentState.status);
		const finishTime =
			agentState.status === "done" || agentState.status === "idle"
				? Date.now()
				: undefined;

		states.push(
			agentStateFromDeliverable(
				agentState.agentName,
				"worker",
				d,
				status,
				deps.agentStartTimes.get(dId) ?? Date.now(),
				finishTime,
				{
					in: agentState.tokens.input + agentState.tokens.cacheRead,
					out: agentState.tokens.output,
					cost: agentState.tokens.cost,
				},
			),
		);
	}

	if (states.length === 0) {
		ctx.ui.setWidget?.("maestro.agents", undefined);
		return;
	}

	const collapsed = deps.panelCollapsed;
	ctx.ui.setWidget?.("maestro.agents", () => ({
		render(width: number): string[] {
			return collapsed
				? renderAgentWidgetCollapsed(states)
				: renderAgentWidget(states, width);
		},
		invalidate() {},
	}));
}

// --- Helpers ---

function mapHerdrStatusToPanel(
	status: HerdrAgentState["status"],
): "active" | "done" {
	switch (status) {
		case "spawning":
		case "working":
		case "blocked":
			return "active";
		case "idle":
		case "done":
		case "failed":
			return "done";
	}
}

function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}
