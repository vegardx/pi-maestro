// Mode runtime composition root: constructs the shared RuntimeContext, wires
// plan tools, commands, event hooks, and capability registrations. All
// behavior lives in the sibling modules; this file only assembles them.

import { join } from "node:path";
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
import type { ReviewLedgerWire } from "@vegardx/pi-rpc";
import { isAgentMode } from "../agent-bridge.js";
import type { ModesAskQueue } from "../ask-queue.js";
import { createCarryForwardTool, harvestInventory } from "../carry-forward.js";
import type { PlanEngine } from "../engine.js";
import type { ReviewLedger } from "../exec/findings.js";
import { createResearchTools, type ResearchRunView } from "../research.js";
import { createReviewTool } from "../review-tool.js";
import type { SubAgentSpec } from "../schema.js";
import {
	EXECUTION_POLICY_SETTINGS,
	WORKTREE_SETTINGS,
} from "../setting-declarations.js";
import { readResearchWatchdogSettings } from "../settings.js";
import { resolveSpawnModelSafe } from "../spawn-model.js";
import { plansRoot } from "../storage.js";
import { createPlanTools } from "../tools.js";
import {
	clipReport,
	registerAgentCardRenderer,
	sendAgentEvent,
} from "./agent-cards.js";
import { registerBashRouter } from "./bash-router.js";
import { registerRuntimeCommands } from "./commands.js";
import {
	activeDeliverable,
	createRuntimeContext,
	type ModesRuntimeOptions,
} from "./context.js";
import { createGateTool } from "./gate-triage.js";
import { registerRuntimeHooks } from "./hooks.js";

export type { ModesRuntimeOptions } from "./context.js";

const PLAN_CONTAINER = "plan" as const;

export { PLAN_CONTAINER };

export interface ModesRuntime {
	readonly askQueue: ModesAskQueue;
	currentMode(): ModeName;
	currentEngine(): PlanEngine | undefined;
	setMode(mode: ModeName, ctx?: ExtensionContext): void;
	requestMode(mode: ModeName, ctx: ExtensionContext): Promise<boolean>;
	openPlan(titleOrSlug: string | undefined, ctx: ExtensionContext): PlanEngine;
	cycle(ctx: ExtensionContext): Promise<void>;
}

export function createModesRuntime(
	pi: ExtensionAPI,
	maestro: MaestroContext,
	opts: ModesRuntimeOptions = {},
): ModesRuntime {
	const rt = createRuntimeContext(pi, maestro, opts);
	registerBashRouter(rt);

	for (const tool of createPlanTools({
		engine: () => rt.engine,
		agents: () => maestro.capabilities.get(CAPABILITIES.agents),
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

	// The research loop is orchestration over ordinary agents.v1 assignments.
	for (const tool of createResearchTools({
		engine: () => rt.engine,
		agents: () => maestro.capabilities.get(CAPABILITIES.agents),
		ask: () => maestro.capabilities.get(CAPABILITIES.ask),
		ensurePlanDir: (ctx) => {
			rt.finalizeDraftPlan(ctx, { force: true });
			const engine = rt.engine;
			if (!engine) throw new Error("no plan active");
			return join(plansRoot(), engine.get().slug);
		},
		watchdog: (ctx) => readResearchWatchdogSettings(ctx.cwd),
		onRunStarted: (run, ctx) => {
			rt.researchRuns.set(run.id, run);
			sendAgentEvent(pi, {
				kind: "research-spawn",
				question: run.question,
				research: run.kind,
			});
			rt.hud?.refresh();
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
				// Clipped: the card shows the first paragraph, the full report is
				// on disk (reportPath) and expandable via dig(ref).
				report: report ? clipReport(report.text) : undefined,
			});
			rt.hud?.refresh();
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

	// Maestro-side ship-gate triage tool: when a gate blocks, the maestro is
	// the first responder — one send-back with guidance per deliverable, or
	// escalate to the human with a mandatory recommendation. No override
	// action exists; only the human's gate answer opens a gate.
	if (!isAgentMode()) {
		pi.registerTool(createGateTool(() => rt.gateTriage));

		// The carry-forward episode tool (/distill and /handoff). Registered
		// once, VISIBLE only while an episode is active (applyTools flag).
		pi.registerTool(
			createCarryForwardTool({
				controller: () => rt.carryForward,
				ask: () => maestro.capabilities.get(CAPABILITIES.ask),
				inventory: () => {
					const plan = rt.engine?.get();
					const snap = rt.execution?.snapshot();
					return harvestInventory({
						...(plan ? { plan } : {}),
						mode: rt.state.mode,
						workers: snap
							? [...snap.agents.entries()].map(([agent, a]) => ({
									agent,
									status: a.status,
								}))
							: [],
						blocked: snap
							? [...snap.deliverables.entries()].flatMap(([id, d]) =>
									d.blocked ? [{ id, reason: d.blocked }] : [],
								)
							: [],
						pendingAsks:
							maestro.capabilities.get(CAPABILITIES.ask)?.pending?.() ?? [],
						...(plan ? { planDir: join(plansRoot(), plan.slug) } : {}),
					});
				},
				planDir: () => {
					const plan = rt.engine?.get();
					return plan ? join(plansRoot(), plan.slug) : undefined;
				},
				planSlug: () => rt.engine?.get().slug,
			}),
		);
	}

	// Worker-side review tool — registered only in a worker (agent mode). It
	// runs the deliverable's persona panel ONCE over the subagents transport,
	// then scope-locked verification runs; each run reports its verdicts AND
	// the review ledger over panelVerdict so the executor's ship gate reads
	// "blocking ledger empty" (and persists the ledger on the plan). The
	// maestro never sees this tool (it has no single deliverable to review).
	if (isAgentMode()) {
		const deliverableId = () =>
			process.env.PI_MAESTRO_AGENT_ID?.split("/")[0] || undefined;
		let reviewRound = 0;
		pi.registerTool(
			createReviewTool({
				subagents: () => maestro.capabilities.get(CAPABILITIES.subagents),
				panelState: async () => {
					const bridge = rt.agentBridge;
					const id = deliverableId();
					if (!bridge || !id) return { panel: [] };
					const result = await bridge.panelRead(id);
					return {
						panel: result.panel as SubAgentSpec[],
						// Wire ledger and the canonical one are structurally
						// identical (see ReviewLedgerWire); clone out of readonly.
						...(result.ledger
							? {
									ledger: structuredClone(
										result.ledger,
									) as unknown as ReviewLedger,
								}
							: {}),
						...(result.waivedFindingIds
							? { waived: result.waivedFindingIds }
							: {}),
					};
				},
				cwd: () => process.cwd(),
				// Non-blocking rounds: the settled report is injected as a
				// follow-up user message (queued to turn end while streaming;
				// triggers a turn when idle) — the same channel maestro steers
				// arrive on (agent-bridge) — so the worker stays steerable and
				// interruptible while reviewers run.
				deliver: (text) => {
					void pi.sendUserMessage(text, { deliverAs: "followUp" });
				},
				resolveModel: async (ctx, spec) => {
					const resolved = await roleSelection(
						ctx,
						"reviewer",
						spec ? { model: spec.model, effort: spec.effort } : undefined,
					);
					return { model: resolved.model, effort: resolved.effort };
				},
				report: (roundKind, results, ledger) => {
					const bridge = rt.agentBridge;
					const id = deliverableId();
					if (!bridge || !id) return;
					// Round-started markers announce the round the NEXT settle will
					// report; only settled rounds consume a round number (the
					// executor never caches markers as verdicts).
					if (roundKind !== "round-started") reviewRound += 1;
					bridge.reportPanelVerdict(
						id,
						roundKind === "round-started" ? reviewRound + 1 : reviewRound,
						results
							.filter((r) => r.kind === "review")
							.map((r) => ({
								name: r.name,
								persona: r.persona,
								required: r.required,
								verdict: r.verdict,
								ok: r.ok,
								model: r.model,
								effort: r.effort,
								// The findings travel with the verdict so the maestro
								// can show the human WHAT holds the gate.
								report: clipReport(r.report),
							})),
						{
							roundKind,
							ledger: structuredClone(ledger) as ReviewLedgerWire,
						},
					);
				},
			}),
		);
	}

	// Generic accounting is deliberately independent of researchRuns. The
	// subagents owner emits one revisioned cumulative checkpoint per run.
	maestro.events.on(EVENTS.usageCheckpoint, (checkpoint) => {
		if (isAgentMode()) {
			rt.agentBridge?.sendUsageCheckpoint(checkpoint);
			return;
		}
		rt.usageLedger.recordCheckpoint(checkpoint);
		rt.invalidateFooter?.();
	});

	// Feed live research telemetry into tracked presentation rows only.
	maestro.events.on(EVENTS.runProgress, ({ runId, progress }) => {
		const run: ResearchRunView | undefined = rt.researchRuns.get(runId);
		if (!run) return;
		if (progress.text) run.activity = progress.text;
		// Token fields are per-turn deltas: accumulate for the table row and
		// fold into the session ledger so footer totals include research runs.
		if (
			progress.tokensIn !== undefined ||
			progress.tokensOut !== undefined ||
			progress.cacheRead !== undefined ||
			progress.cacheWrite !== undefined ||
			progress.cost !== undefined
		) {
			run.tokensIn = (run.tokensIn ?? 0) + (progress.tokensIn ?? 0);
			run.tokensOut = (run.tokensOut ?? 0) + (progress.tokensOut ?? 0);
			// First-turn prefix warmth is a diagnostic, not cumulative cache hit.
			if (
				run.prefixCacheHitRate === undefined &&
				progress.cacheRead !== undefined
			) {
				const denom = progress.cacheRead + (progress.tokensIn ?? 0);
				if (denom > 0) run.prefixCacheHitRate = progress.cacheRead / denom;
			}
		}
	});

	registerRuntimeCommands(rt);
	registerRuntimeHooks(rt);
	// Chat cards for agent lifecycle events (spawn/done/shipped/settled/…).
	registerAgentCardRenderer(pi);

	maestro.capabilities.register(CAPABILITIES.usage, rt.usageLedger);
	maestro.capabilities.register(CAPABILITIES.overlays, rt.overlayManager);

	// Declare non-model runtime knobs for /maestro Advanced settings. Direct
	// model and effort policy lives exclusively in profile role pools.
	const settings = maestro.capabilities.get(CAPABILITIES.settings);
	settings?.declare("modes", [
		...EXECUTION_POLICY_SETTINGS,
		// Distill threshold ladder — read by readDistillSettings under
		// extensionConfig.modes.distill. Fractions of context fill.
		{
			key: "distill.nudgeAt",
			label: "Distill: suggest at (fraction full)",
			type: "number",
			default: 0.3,
		},
		{
			key: "distill.forceAt",
			label: "Distill: auto-run at (fraction full, 0 = off)",
			type: "number",
			default: 0.5,
		},
		// Summariser deadline — read by readModesCompactionSettings; deadlines
		// createModesSummariser for distill compactions and ship-time
		// carry-forward summaries. Nothing auto-compacts on a timer anymore.
		{
			key: "compaction.timeoutMs",
			label: "Summariser timeout (ms) — distill/ship",
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
	// Preserve the established extensionConfig.maestro.worktree.* namespace.
	settings?.declare("maestro", [...WORKTREE_SETTINGS]);

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
		requestMode: rt.requestMode,
		openPlan: rt.openPlan,
		cycle: rt.cycle,
	};
}

/** "…/plans/<slug>/research/03-x.md" → "research/03-x.md" for display. */
function relativeReportPath(path: string): string {
	return path.split("/").slice(-2).join("/");
}
