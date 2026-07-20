// Dashboard glue: the custom footer installation and the /agents overview
// rendering (headless fallback — the HUD is the interactive surface).
// Presentation only — state lives on the RuntimeContext.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { planViewTasks, projectPlanView } from "@vegardx/pi-contracts";
import { activeResidency, readModelsConfig } from "@vegardx/pi-models";
import type { ExecutionAgentSnapshot, ExecutionHandle } from "../exec/index.js";
import { installFooter } from "../install-footer.js";
import type { PlanV2 } from "../plan/schema.js";
import type { RuntimeContext } from "./context.js";
import { hudElapsed } from "./hud.js";

/** Install the maestro footer and remember its invalidate handle. */
export function installMaestroFooter(
	rt: RuntimeContext,
	ctx: ExtensionContext,
): void {
	// Residency for the footer: settings reads are file I/O, and render runs
	// per keystroke — cache with a short TTL so toggles show up promptly
	// without hammering the disk.
	let residencyCache: { at: number; value: string | undefined } | undefined;
	const getResidency = (): string | undefined => {
		const now = Date.now();
		if (!residencyCache || now - residencyCache.at > 3000) {
			let value: string | undefined;
			try {
				const config = readModelsConfig(ctx.cwd);
				value = config?.residency ? activeResidency(config) : undefined;
			} catch {
				value = undefined;
			}
			residencyCache = { at: now, value };
		}
		return residencyCache.value;
	};
	rt.invalidateFooter = installFooter({
		pi: rt.pi,
		ctx,
		getMode: () => rt.state.mode,
		getLedger: () => rt.usageLedger,
		getPendingQuestions: () => {
			if (!rt.execution) return 0;
			return rt.execution.questionQueue?.all()?.length ?? 0;
		},
		getResidency,
	});
}

/**
 * Render the /agents overview: deliverables, task progress, and agent specs. With
 * an execution handle, includes live status/tokens/turns per agent plus the
 * deliverable's fix round and blocked reason.
 *
 * Renders from the shared PlanView projection (plan-schema spike PR-1): row
 * depth indents once the v2 tree lands; a flat v1 plan renders identically.
 */
export function renderAgentsOverview(
	plan: PlanV2,
	execution?: ExecutionHandle,
): string {
	const view = projectPlanView(plan);
	const snap = execution?.snapshot();
	const lines: string[] = [`Plan: ${plan.title} (${plan.slug})`, ""];
	for (const node of view?.nodes ?? []) {
		const indent = "  ".repeat(node.depth);
		const icon =
			node.status === "shipped"
				? "🚀"
				: node.status === "active"
					? "●"
					: node.status === "complete"
						? "✓"
						: "○";
		const deps = node.dependsOn.length
			? ` [after: ${node.dependsOn.join(", ")}]`
			: "";
		lines.push(`${indent}${icon} ${node.title} (${node.status})${deps}`);
		const tasks = planViewTasks(node);
		const done = tasks.filter((t) => t.done).length;
		if (tasks.length > 0) {
			lines.push(`${indent}  Tasks: ${done}/${tasks.length}`);
		}
		const deliverableState = snap?.deliverables.get(node.id);
		if (deliverableState?.blocked) {
			lines.push(`${indent}  ⚠ Blocked: ${deliverableState.blocked}`);
		}
		if (node.prUrl) {
			lines.push(`${indent}  PR: ${node.prUrl}`);
		}
		const workerLive = liveSuffix(snap?.agents.get(node.id), Date.now());
		if (workerLive) {
			lines.push(
				`${indent}  └─ worker (${node.workerMode ?? "full"})${workerLive}`,
			);
		}
		for (const agent of node.agents) {
			const live = liveSuffix(
				snap?.agents.get(`${node.id}/${agent.name}`),
				Date.now(),
			);
			lines.push(
				`${indent}  └─ ${agent.name} (${agent.mode ?? "read-only"}${agent.after.length ? `, after: ${agent.after.join(", ")}` : ""})${live}`,
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
