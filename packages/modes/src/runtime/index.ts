// Mode runtime composition root: constructs the shared RuntimeContext, wires
// plan tools, commands, event hooks, and capability registrations. All
// behavior lives in the sibling modules; this file only assembles them.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	CAPABILITIES,
	EVENTS,
	type ModeName,
	type ModesExecutionStatus,
} from "@vegardx/pi-contracts";
import type { MaestroContext } from "@vegardx/pi-core";
import type { ModesAskQueue } from "../ask-queue.js";
import type { PlanEngine } from "../engine.js";
import { createResearchTools, type ResearchRunView } from "../research.js";
import { resolveSpawnModelSafe } from "../spawn-model.js";
import { plansRoot } from "../storage.js";
import { createPlanTools } from "../tools.js";
import { registerAgentCardRenderer, sendAgentEvent } from "./agent-cards.js";
import { registerRuntimeCommands } from "./commands.js";
import {
	activeDeliverable,
	createRuntimeContext,
	type ModesRuntimeOptions,
} from "./context.js";
import { syncAgentWidget } from "./dashboard.js";
import { registerRuntimeHooks } from "./hooks.js";

export type { ModesRuntimeOptions } from "./context.js";

const PLAN_CONTAINER = "plan" as const;

export { PLAN_CONTAINER };

export interface ModesRuntime {
	readonly askQueue: ModesAskQueue;
	currentMode(): ModeName;
	currentEngine(): PlanEngine | undefined;
	setMode(mode: ModeName, ctx?: ExtensionContext): void;
	openPlan(titleOrSlug: string | undefined, ctx: ExtensionContext): PlanEngine;
	cycle(ctx: ExtensionContext): Promise<void>;
}

export function createModesRuntime(
	pi: ExtensionAPI,
	maestro: MaestroContext,
	opts: ModesRuntimeOptions = {},
): ModesRuntime {
	const rt = createRuntimeContext(pi, maestro, opts);

	for (const tool of createPlanTools({
		engine: () => rt.engine,
		onPlanChanged: () => rt.emitPlanChanged(),
		mode: () => rt.state.mode,
		steerAgent: (deliverableId, guidance) => {
			rt.execution?.steer(deliverableId, guidance);
		},
		onTaskToggle: (deliverableId, taskId) => {
			rt.agentBridge?.onTaskComplete(deliverableId, taskId);
		},
		seedContent: () => rt.agentSeedContent,
		agentBridge: () => rt.agentBridge,
		agentDeliverableId: () =>
			process.env.PI_MAESTRO_AGENT_ID?.split("/")[0] || undefined,
	})) {
		pi.registerTool(tool);
	}

	// The research loop: fan-out research agents + the readiness phase gate.
	// Children spawn isolated (-ne) with the research-tools extension so their
	// tool namespace is deterministic (websearch/webfetch/context7 + builtins).
	const repoRoot = resolve(
		dirname(fileURLToPath(import.meta.url)),
		"../../../..",
	);
	for (const tool of createResearchTools({
		engine: () => rt.engine,
		subagents: () => maestro.capabilities.get(CAPABILITIES.subagents),
		ask: () => maestro.capabilities.get(CAPABILITIES.ask),
		ensurePlanDir: (ctx) => {
			rt.finalizeDraftPlan(ctx, { force: true });
			const engine = rt.engine;
			if (!engine) throw new Error("no plan active");
			return join(plansRoot(), engine.get().slug);
		},
		researchToolsPath: () =>
			join(repoRoot, "packages/research-tools/src/index.ts"),
		resolveAdvisorModel: async (ctx) =>
			(await resolveSpawnModelSafe(ctx, { slot: "alternate", effort: "high" }))
				?.modelId,
		onRunStarted: (run, ctx) => {
			rt.researchRuns.set(run.id, run);
			sendAgentEvent(pi, {
				kind: "research-spawn",
				question: run.question,
				research: run.kind,
			});
			syncAgentWidget(rt, ctx);
		},
		onRunSettled: (run, report, ctx) => {
			rt.researchRuns.delete(run.id);
			sendAgentEvent(pi, {
				kind: "research-done",
				question: run.question,
				research: run.kind,
				ok: run.status === "succeeded" && report !== undefined,
				durationMs: Date.now() - run.startedAt,
				reportPath: report ? relativeReportPath(report.path) : undefined,
				report: report?.text,
			});
			syncAgentWidget(rt, ctx);
		},
		onPhaseChanged: (ctx) => {
			rt.applyTools();
			rt.notifyMode(ctx);
		},
	})) {
		pi.registerTool(tool);
	}

	// Feed live research telemetry (current tool, token deltas) from the
	// bridged run-bus into the tracked views; the widget's 5s tick renders it.
	maestro.events.on(EVENTS.runProgress, ({ runId, progress }) => {
		const run: ResearchRunView | undefined = rt.researchRuns.get(runId);
		if (!run) return;
		if (progress.text) run.activity = progress.text;
		// Token fields are per-turn deltas: accumulate for the table row and
		// fold into the session ledger so footer totals include research runs.
		if (progress.tokensIn !== undefined || progress.tokensOut !== undefined) {
			run.tokensIn = (run.tokensIn ?? 0) + (progress.tokensIn ?? 0);
			run.tokensOut = (run.tokensOut ?? 0) + (progress.tokensOut ?? 0);
			rt.usageLedger.add(
				{ kind: "agent", id: runId },
				{
					input: progress.tokensIn,
					output: progress.tokensOut,
					cacheRead: progress.cacheRead,
					cacheWrite: progress.cacheWrite,
					cost:
						progress.cost !== undefined ? { total: progress.cost } : undefined,
				},
			);
			rt.invalidateFooter?.();
		}
	});

	registerRuntimeCommands(rt);
	registerRuntimeHooks(rt);
	// Chat cards for agent lifecycle events (spawn/done/shipped/settled/…).
	registerAgentCardRenderer(pi);

	maestro.capabilities.register(CAPABILITIES.usage, rt.usageLedger);
	maestro.capabilities.register(CAPABILITIES.overlays, rt.overlayManager);

	// Declare configurable settings for /maestro menu
	maestro.capabilities.get(CAPABILITIES.settings)?.declare("modes", [
		{ key: "maxAgents", label: "Max agents", type: "number", default: 4 },
		{
			key: "maxReviewCycles",
			label: "Max review cycles",
			type: "number",
			default: 2,
		},
		{ key: "models.agent.effort", label: "Agent effort", type: "thinking" },
		{ key: "models.agent.slot", label: "Agent slot", type: "slot" },
		{ key: "models.agent.model", label: "Agent model", type: "model" },
		{ key: "models.analyze.effort", label: "Analyze effort", type: "thinking" },
		{ key: "models.analyze.slot", label: "Analyze slot", type: "slot" },
		{ key: "models.analyze.model", label: "Analyze model", type: "model" },
		{
			key: "models.classifier.effort",
			label: "Classifier effort",
			type: "thinking",
		},
		{ key: "models.classifier.slot", label: "Classifier slot", type: "slot" },
	]);

	maestro.capabilities.register(CAPABILITIES.modes, {
		current: rt.currentMode,
		onChange(listener) {
			rt.listeners.add(listener);
			return () => rt.listeners.delete(listener);
		},
		execution: (): ModesExecutionStatus => ({
			mode: rt.state.mode,
			activePlanSlug: rt.state.activePlanSlug,
			activeDeliverableId:
				rt.state.execution.deliverableId ??
				(rt.engine ? activeDeliverable(rt.engine.get())?.id : undefined),
			executing: rt.state.execution.stage === "executing",
			compactionInFlight: rt.compactionInFlight,
		}),
	});

	return {
		askQueue: rt.askQueue,
		currentMode: rt.currentMode,
		currentEngine: rt.currentEngine,
		setMode: rt.setMode,
		openPlan: rt.openPlan,
		cycle: rt.cycle,
	};
}

/** "…/plans/<slug>/research/03-x.md" → "research/03-x.md" for display. */
function relativeReportPath(path: string): string {
	return path.split("/").slice(-2).join("/");
}
