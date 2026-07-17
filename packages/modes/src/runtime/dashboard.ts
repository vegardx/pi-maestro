// Dashboard glue: the custom footer installation and the /agents overview
// rendering (headless fallback — the HUD is the interactive surface).
// Presentation only — state lives on the RuntimeContext.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExecutionAgentSnapshot, ExecutionHandle } from "../exec/index.js";
import { installFooter } from "../install-footer.js";
import type { Plan } from "../schema.js";
import type { RuntimeContext } from "./context.js";
import { hudElapsed } from "./hud.js";

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
		if (g.prUrl) {
			lines.push(`  PR: ${g.prUrl}`);
		}
		const workerLive = liveSuffix(
			snap?.agents.get(`${g.id}/worker`),
			Date.now(),
		);
		if (workerLive) {
			lines.push(`  └─ worker (${g.worker.mode})${workerLive}`);
		}
		for (const a of g.agents) {
			const live = liveSuffix(
				snap?.agents.get(`${g.id}/${a.name}`),
				Date.now(),
			);
			lines.push(
				`  └─ ${a.name} (${a.mode}${a.after.length ? `, after: ${a.after.join(", ")}` : ""})${live}`,
			);
		}
	}
	return lines.join("\n");
}

/** " — status · elapsed · Nin/Nout · N turns · cache NN%" or "". */
function liveSuffix(
	agent: ExecutionAgentSnapshot | undefined,
	now: number,
): string {
	if (!agent) return "";
	const t = agent.tokens;
	const prompt =
		t.promptTokens ?? t.input + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0);
	const cache =
		(t.cacheRead ?? 0) > 0 && prompt > 0
			? ` · cache ${Math.round(((t.cacheRead ?? 0) / prompt) * 100)}%`
			: "";
	const elapsed = hudElapsed((agent.completedAt ?? now) - agent.startedAt);
	return ` — ${agent.status} · ${elapsed} · ${prompt}in/${t.output}out · ${t.turns} turns${cache}`;
}
