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
	type Tier,
} from "@vegardx/pi-contracts";
import type { MaestroContext } from "@vegardx/pi-core";
import { isAgentMode } from "../agent-bridge.js";
import type { ModesAskQueue } from "../ask-queue.js";
import type { PlanEngine } from "../engine.js";
import { createResearchTools, type ResearchRunView } from "../research.js";
import { createReviewTool } from "../review-tool.js";
import type { SubAgentSpec } from "../schema.js";
import { readResearchWatchdogSettings } from "../settings.js";
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

/**
 * The pinned model id for a tier, or undefined when the tier tracks the session
 * model (⇒ let the subagent inherit the default, cache-warm). Used to wire the
 * research/advisor and reviewer spawns to their tiers.
 */
async function pinnedTierModel(
	ctx: ExtensionContext,
	tier: Tier,
): Promise<string | undefined> {
	const sessionId = ctx.model
		? `${ctx.model.provider}/${ctx.model.id}`
		: undefined;
	const resolved = await resolveSpawnModelSafe(ctx, { tier });
	return resolved && resolved.modelId !== sessionId
		? resolved.modelId
		: undefined;
}

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
		resolveTierModel: (ctx, tier) => pinnedTierModel(ctx, tier),
		watchdog: (ctx) => readResearchWatchdogSettings(ctx.cwd),
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
		// Non-blocking research: a settled round is delivered as a follow-up
		// user message (queued to turn end while streaming; triggers a turn
		// when idle) so the maestro stays responsive during research.
		deliver: (text) => {
			void pi.sendUserMessage(text, { deliverAs: "followUp" });
		},
	})) {
		pi.registerTool(tool);
	}

	// Worker-side review tool — registered only in a worker (agent mode). It
	// runs the deliverable's persona panel over the subagents transport,
	// fetching the panel live via panelRead and reporting each round's verdicts
	// back over panelVerdict so the executor's ship gate can read them. The
	// maestro never sees this tool (it has no single deliverable to review).
	if (isAgentMode()) {
		const deliverableId = () =>
			process.env.PI_MAESTRO_AGENT_ID?.split("/")[0] || undefined;
		let reviewRound = 0;
		pi.registerTool(
			createReviewTool({
				subagents: () => maestro.capabilities.get(CAPABILITIES.subagents),
				panel: async () => {
					const bridge = rt.agentBridge;
					const id = deliverableId();
					if (!bridge || !id) return [];
					return (await bridge.panelRead(id)).panel as SubAgentSpec[];
				},
				cwd: () => process.cwd(),
				// Reviewers run on the `review` tier: a pinned distinct model
				// (cross-model second opinion), or undefined to inherit the
				// session model when review tracks plan.
				resolveModel: (ctx) => pinnedTierModel(ctx, "review"),
				reportVerdicts: (results) => {
					const bridge = rt.agentBridge;
					const id = deliverableId();
					if (!bridge || !id) return;
					reviewRound += 1;
					bridge.reportPanelVerdict(
						id,
						reviewRound,
						results
							.filter((r) => r.kind === "review")
							.map((r) => ({
								name: r.name,
								persona: r.persona,
								required: r.required,
								verdict: r.verdict,
								ok: r.ok,
								// The findings travel with the verdict so the maestro
								// can show the human WHAT holds the gate.
								report: clipReport(r.report),
							})),
					);
				},
			}),
		);
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
			// First-turn cache-prefix hit ratio (frozen after the first delta
			// that carries cache data), matching the execution agents' metric.
			if (run.cacheRatio === undefined && progress.cacheRead !== undefined) {
				const denom = progress.cacheRead + (progress.tokensIn ?? 0);
				if (denom > 0) run.cacheRatio = progress.cacheRead / denom;
			}
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
		// Role → tier is hardcoded (worker→work, classifier→fast, …); tiers'
		// models live in the active profile. Only per-role effort is exposed as
		// an override (rarely needed).
		{ key: "models.agent.effort", label: "Agent effort", type: "thinking" },
		{
			key: "models.classifier.effort",
			label: "Classifier effort",
			type: "thinking",
		},
		// Compaction budgets — read by readModesCompactionSettings; declared here
		// so they're discoverable/editable in /maestro (were hidden before).
		{
			key: "compaction.workingTokens",
			label: "Compaction: working budget",
			type: "number",
			default: 150000,
		},
		{
			key: "compaction.summaryTokens",
			label: "Compaction: summary budget",
			type: "number",
			default: 100000,
		},
		{
			key: "compaction.timeoutMs",
			label: "Compaction: timeout (ms)",
			type: "number",
			default: 90000,
		},
		// Research watchdog — read by readResearchWatchdogSettings. Stall kills
		// wedged children fast; soft steers slow ones to wrap up; hard is the
		// unbounded-run backstop.
		{
			key: "research.stallMs",
			label: "Research: stall kill (ms of event silence)",
			type: "number",
			default: 120000,
		},
		{
			key: "research.softMs",
			label: "Research: wrap-up steer (ms)",
			type: "number",
			default: 240000,
		},
		{
			key: "research.hardMs",
			label: "Research: hard cap (ms)",
			type: "number",
			default: 600000,
		},
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

/** Clip a reviewer report for the panelVerdict wire message (RPC hygiene). */
const REPORT_CLIP_CHARS = 4000;
function clipReport(report: string): string | undefined {
	const trimmed = report.trim();
	if (!trimmed) return undefined;
	if (trimmed.length <= REPORT_CLIP_CHARS) return trimmed;
	return `${trimmed.slice(0, REPORT_CLIP_CHARS)}\n[…report clipped]`;
}
