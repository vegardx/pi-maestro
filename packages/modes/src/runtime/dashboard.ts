// Dashboard glue: the custom footer installation and the /agents overview
// rendering (headless fallback — the HUD is the interactive surface).
// Presentation only — state lives on the RuntimeContext.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ledgerSummary, openBlocking } from "../exec/findings.js";
import type { ExecutionAgentSnapshot, ExecutionHandle } from "../exec/index.js";
import { installFooter } from "../install-footer.js";
import type { Plan } from "../schema.js";
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
		if (deliverableState?.blocked) {
			lines.push(`  ⚠ Blocked: ${deliverableState.blocked}`);
		}
		// The review loop at a glance — mid-fix-cycle state is otherwise
		// invisible until the deliverable blocks ("why is it steering again?").
		if (g.reviewLedger) {
			const waived = new Set(
				(g.waivers ?? []).flatMap((w) => (w.findingId ? [w.findingId] : [])),
			);
			const open = openBlocking(g.reviewLedger, waived);
			if (open.length > 0 || g.reviewLedger.cycle > 0) {
				lines.push(
					`  Review: ${ledgerSummary(g.reviewLedger, g.maxFixRounds ?? 3, waived)}`,
				);
			}
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
				`  └─ ${a.name} (${a.mode}${a.after.length ? `, after: ${a.after.join(", ")}` : ""})${live}`,
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
		agent.prefixCacheHitRate !== undefined
			? ` · prefix ${Math.round(agent.prefixCacheHitRate * 100)}%`
			: "";
	return ` — ${agent.status} · ${t.input}in/${t.output}out · ${t.turns} turns${cache}`;
}
