// Dashboard glue: the custom footer installation and the /agents overview
// rendering. Presentation only — state lives on the RuntimeContext.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
			const agents = rt.execution.snapshot().agents;
			// Total = all non-terminal deliverables in the plan
			const plan = rt.engine.get();
			const activeGroups = plan.groups.filter(
				(g) => g.status !== "shipped" && g.status !== "abandoned",
			);
			const total = activeGroups.length;
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

/** Render the /agents overview: groups, task progress, and agent specs. */
export function renderAgentsOverview(plan: Plan): string {
	const lines: string[] = [`Plan: ${plan.title} (${plan.slug})`, ""];
	for (const g of plan.groups) {
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
		for (const a of g.agents) {
			lines.push(
				`  └─ ${a.name} (${a.mode}, ${a.slot}, after: ${a.after.join(",")})`,
			);
		}
	}
	return lines.join("\n");
}
