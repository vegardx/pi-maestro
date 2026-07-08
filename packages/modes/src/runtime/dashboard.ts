// Dashboard glue: the custom footer installation, the live agent-table
// widget above the editor, and the /agents overview rendering. Presentation
// only — state lives on the RuntimeContext.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExecutionAgentSnapshot, ExecutionHandle } from "../exec/index.js";
import { installFooter } from "../install-footer.js";
import type { ResearchRunView } from "../research.js";
import type { Plan } from "../schema.js";
import {
	type AgentTableAgent,
	buildAgentTable,
	hasActiveAgents,
	styleAgentTable,
} from "./agent-widget.js";
import type { RuntimeContext } from "./context.js";

/** Install the maestro footer and remember its invalidate handle. */
export function installMaestroFooter(
	rt: RuntimeContext,
	ctx: ExtensionContext,
): void {
	rt.invalidateFooter = installFooter({
		pi: rt.pi,
		ctx,
		getMode: () => rt.state.mode,
		getLedger: () => rt.usageLedger,
		getAgentStatus: () => {
			if (!rt.execution || !rt.engine) return undefined;
			// Done and total must count the same population: agents.
			const agents = rt.execution.snapshot().agents;
			const total = agents.size;
			if (total === 0) return undefined;
			let done = 0;
			let failed = 0;
			for (const a of agents.values()) {
				if (a.status === "done") done++;
				else if (a.status === "failed") failed++;
			}
			return { done: done + failed, total, failed };
		},
		getPendingQuestions: () => {
			if (!rt.execution) return 0;
			return rt.execution.questionQueue?.all()?.length ?? 0;
		},
	});
}

// ─── Live agent widget ───────────────────────────────────────────────────────

const AGENT_WIDGET_KEY = "maestro-agents";
/** Re-render cadence while agents are active, so ELAPSED ticks. */
const AGENT_WIDGET_TICK_MS = 5_000;

/**
 * Map live research runs onto agent-table rows: DELIVERABLE "research", AGENT =
 * question slug, STATUS from the child's current tool (searching/reading/
 * working), TOKENS from run progress events.
 */
export function researchTableAgents(
	runs: ReadonlyMap<string, ResearchRunView>,
): Map<string, AgentTableAgent> {
	const rows = new Map<string, AgentTableAgent>();
	for (const run of runs.values()) {
		if (run.status !== "running") continue;
		let key = `research/${run.label}`;
		for (let n = 2; rows.has(key); n++) key = `research/${run.label}-${n}`;
		rows.set(key, {
			status: researchStatus(run),
			startedAt: run.startedAt,
			tokens: {
				input: run.tokensIn ?? 0,
				output: run.tokensOut ?? 0,
				turns: 0,
			},
			...(run.cacheRatio !== undefined ? { cacheRatio: run.cacheRatio } : {}),
			...(run.model ? { model: run.model } : {}),
			...(run.effort ? { effort: run.effort } : {}),
			...(run.adaptive !== undefined ? { adaptive: run.adaptive } : {}),
		});
	}
	return rows;
}

function researchStatus(run: ResearchRunView): string {
	if (run.activity === "websearch") return "searching";
	if (run.activity === "webfetch" || run.activity === "context7")
		return "reading";
	if (run.activity === "read" || run.activity === "grep") return "reading";
	return "working";
}

/**
 * Render the live agent table into the widget above the editor. Rows merge
 * two sources: execution agents (ExecutionHandle.snapshot()) and plan-mode
 * research runs (rt.researchRuns). Called on every state change; while any
 * row is active a 5s timer re-syncs so ELAPSED (and research tokens) tick.
 * When none are active the widget is cleared and the timer stopped.
 */
export function syncAgentWidget(
	rt: RuntimeContext,
	ctx: ExtensionContext,
): void {
	const snap = rt.execution?.snapshot();
	const agents = new Map([
		...(snap?.agents ?? []),
		...researchTableAgents(rt.researchRuns),
	]);
	if (!hasActiveAgents(agents)) {
		clearAgentWidget(rt, ctx);
		return;
	}
	const deliverables = snap?.deliverables;
	const now = Date.now();
	ctx.ui.setWidget?.(AGENT_WIDGET_KEY, (_tui, theme) => ({
		render: (width: number) =>
			styleAgentTable(
				buildAgentTable({ agents, deliverables, width, now }),
				theme,
			),
		invalidate: () => {},
	}));
	if (rt.agentWidgetTimer === undefined) {
		const timer = setInterval(
			() => syncAgentWidget(rt, ctx),
			AGENT_WIDGET_TICK_MS,
		);
		timer.unref?.();
		rt.agentWidgetTimer = timer;
	}
}

/** Clear the agent widget and stop its refresh timer. */
export function clearAgentWidget(
	rt: RuntimeContext,
	ctx?: ExtensionContext,
): void {
	if (rt.agentWidgetTimer !== undefined) {
		clearInterval(rt.agentWidgetTimer);
		rt.agentWidgetTimer = undefined;
	}
	ctx?.ui.setWidget?.(AGENT_WIDGET_KEY, undefined);
}

/**
 * Render the /agents overview: deliverables, task progress, and agent specs. With
 * an execution handle, includes live status/tokens/turns per agent plus the
 * deliverable's fix round and blocked reason.
 */
export function renderAgentsOverview(
	plan: Plan,
	execution?: ExecutionHandle,
): string {
	const snap = execution?.snapshot();
	const lines: string[] = [`Plan: ${plan.title} (${plan.slug})`, ""];
	for (const g of plan.deliverables) {
		const icon =
			g.status === "shipped"
				? "🚀"
				: g.status === "active"
					? "●"
					: g.status === "complete"
						? "✓"
						: "○";
		const deps = g.dependsOn?.length
			? ` [after: ${g.dependsOn.join(", ")}]`
			: "";
		lines.push(`${icon} ${g.title} (${g.status})${deps}`);
		const tasks = g.tasks.filter((t) => t.kind === "task");
		const done = tasks.filter((t) => t.done).length;
		if (tasks.length > 0) {
			lines.push(`  Tasks: ${done}/${tasks.length}`);
		}
		const deliverableState = snap?.deliverables.get(g.id);
		if (deliverableState && deliverableState.round > 0) {
			lines.push(`  Fix round: ${deliverableState.round}`);
		}
		if (deliverableState?.blocked) {
			lines.push(`  ⚠ Blocked: ${deliverableState.blocked}`);
		}
		if (g.prUrl) {
			lines.push(`  PR: ${g.prUrl}`);
		}
		const workerLive = liveSuffix(snap?.agents.get(`${g.id}/worker`));
		if (workerLive) {
			lines.push(`  └─ worker (${g.worker.mode})${workerLive}`);
		}
		for (const a of g.agents) {
			const live = liveSuffix(snap?.agents.get(`${g.id}/${a.name}`));
			lines.push(
				`  └─ ${a.name} (${a.mode}, ${a.slot}${a.after.length ? `, after: ${a.after.join(", ")}` : ""})${live}`,
			);
		}
	}
	return lines.join("\n");
}

/** " — status · Nin/Nout · N turns · cache NN%" for a live agent, or "". */
function liveSuffix(agent: ExecutionAgentSnapshot | undefined): string {
	if (!agent) return "";
	const t = agent.tokens;
	const cache =
		agent.cacheRatio !== undefined
			? ` · cache ${Math.round(agent.cacheRatio * 100)}%`
			: "";
	return ` — ${agent.status} · ${t.input}in/${t.output}out · ${t.turns} turns${cache}`;
}
