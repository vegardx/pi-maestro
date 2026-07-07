// pi.on event hooks for the mode runtime: preamble injection, session
// lifecycle, bash/tool gating, usage accounting, the mid-deliverable
// compaction trigger, and compaction ownership.

import { randomUUID } from "node:crypto";
import type {
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import { initAgentBridge, isAgentMode } from "../agent-bridge.js";
import { classifyBashFast, classifyBashIntent } from "../bash-classifier.js";
import {
	buildCompactionMarker,
	buildDeliverableSliceCompactionResult,
	createCrashSnapshot,
	decideCompactionOwnership,
	readModesCompactionDetails,
} from "../compaction.js";
import { toolBlockedInPlanMode } from "../policy.js";
import { gatingTasks } from "../schema.js";
import { hydrateModesState } from "../session.js";
import {
	getModeRoleModel,
	MAESTRO_ENV,
	readModesCompactionSettings,
} from "../settings.js";
import { createModesSummariser } from "../summarise.js";
import {
	awaitCompaction,
	diagnoseResumeAfterCompaction,
	shouldCompactMidDeliverable,
} from "../trigger.js";
import { activeDeliverable, type RuntimeContext } from "./context.js";
import { installMaestroFooter } from "./dashboard.js";
import {
	buildAgentCompactionGuidance,
	buildAgentWorkerPreamble,
	buildHackModePreamble,
	buildMaestroPreamble,
	buildPlanModePreamble,
} from "./preambles.js";

// ─── Agent tool classes ──────────────────────────────────────────────────────
// Exactly TWO tool sets exist across execution agents (the two prompt-cache
// classes). Any per-agent variation here would fragment the shared cache
// prefix, so the lists are fixed constants and the set arithmetic is a pure
// exported function (pinned by test/cache-invariants.test.ts).

/** Tools stripped from read-only agents (write/commit/ship/ask surface). */
export const READ_ONLY_STRIPPED_TOOLS = [
	"commit",
	"ship",
	"edit",
	"write",
	"ask",
] as const;

/** Tools ensured present for read-only agents (findings reporting). */
export const READ_ONLY_ENSURED_TOOLS = ["task", "plan"] as const;

/** Tools ensured present for full-mode agents (the decision loop). */
export const FULL_MODE_ENSURED_TOOLS = [
	"task",
	"ask",
	"review",
	"commit",
	"ship",
] as const;

/**
 * Compute the active tool set for an execution agent session. Pure function
 * of (mode, available, active) — agents of the same mode with the same
 * baseline always get the identical set; exactly two distinct sets exist
 * across the two modes.
 */
export function computeAgentSessionTools(
	agentMode: string | undefined,
	available: readonly string[],
	active: readonly string[],
): string[] {
	const availableSet = new Set(available);
	if (agentMode === "read-only") {
		const stripped = new Set<string>(READ_ONLY_STRIPPED_TOOLS);
		const kept = active.filter((t) => !stripped.has(t));
		const needed = READ_ONLY_ENSURED_TOOLS.filter(
			(t) => availableSet.has(t) && !kept.includes(t),
		);
		return [...kept, ...needed];
	}
	const missing = FULL_MODE_ENSURED_TOOLS.filter(
		(t) => availableSet.has(t) && !active.includes(t),
	);
	return [...active, ...missing];
}

export function registerRuntimeHooks(rt: RuntimeContext): void {
	const { pi, maestro } = rt;

	pi.on("before_agent_start", (event) => {
		if (rt.state.mode === "plan") {
			const preamble = buildPlanModePreamble(rt.engine);
			return { systemPrompt: `${event.systemPrompt}\n\n${preamble}` };
		}
		if (rt.state.mode === "hack" && rt.execution) {
			const preamble = buildHackModePreamble();
			return { systemPrompt: `${event.systemPrompt}\n\n${preamble}` };
		}
		if (rt.execution) {
			const preamble = buildMaestroPreamble(rt.engine, rt.execution);
			return { systemPrompt: `${event.systemPrompt}\n\n${preamble}` };
		}
		if (rt.agentBridge) {
			const preamble = buildAgentWorkerPreamble();
			return { systemPrompt: `${event.systemPrompt}\n\n${preamble}` };
		}
	});

	pi.on("session_start", (_event, ctx) => {
		if (isAgentMode()) {
			// Agents start in a special mode — agentBridge handles tool policy
			rt.state = {
				mode: "auto",
				execution: {
					stage: "executing",
					deliverableId: process.env.PI_MAESTRO_AGENT_ID ?? "",
				},
				updatedAt: new Date().toISOString(),
			};
		}
		const hydrated = hydrateModesState(ctx.sessionManager.getEntries());
		if (hydrated) rt.state = hydrated;
		// Extract seed content for agents (read-only plan context)
		if (rt.state.mode === "agent") {
			for (const entry of ctx.sessionManager.getEntries()) {
				const e = entry as unknown as Record<string, unknown>;
				if (
					(e.type === "custom" && e.customType === "maestro-execution-seed") ||
					(e.type === "custom_message" &&
						e.customType === "maestro.execution.seed")
				) {
					const data = e.data as Record<string, unknown> | undefined;
					const content = data?.content ?? e.content;
					if (typeof content === "string") rt.agentSeedContent = content;
				}
			}
		}
		rt.compactionInFlight = false;
		rt.pendingCompaction = undefined;
		rt.compactionCooldownUntil = 0;
		rt.summaryBudgetWarnFired = false;
		rt.seedSummaryBudgetWarnFired = false;
		rt.resetCalibration();
		if (rt.state.activePlanSlug)
			rt.engine = rt.loadEngine(rt.state.activePlanSlug);
		// Auto-open a draft plan when starting in plan mode with no active plan
		if (rt.state.mode === "plan" && !rt.engine) {
			rt.openPlan(undefined, ctx);
		}
		rt.applyTools();
		rt.overlayManager.attach(ctx);
		// Install custom footer (before notifyMode so invalidate handle exists)
		if (!rt.agentBridge && rt.state.mode !== "agent") {
			installMaestroFooter(rt, ctx);
		}
		rt.notifyMode(ctx);
		// Agent-side RPC bridge: connect to maestro if running as agent
		rt.agentBridge = initAgentBridge(pi);
		if (rt.agentBridge) {
			const bridge = rt.agentBridge;
			bridge.start(ctx);
			// Ensure agents have the tools they need (baseline strips `task`;
			// `ask`/`review`/`ship`/`commit` must be present for the decision loop).
			const available = pi.getAllTools().map((t) => t.name);
			const active = pi.getActiveTools();
			const agentModeEnv = process.env.PI_MAESTRO_AGENT_MODE;
			const next = computeAgentSessionTools(agentModeEnv, available, active);
			if (agentModeEnv === "read-only" || next.length !== active.length) {
				pi.setActiveTools(next);
			}

			// Route the ask tool to the maestro over RPC (G1 transport).
			maestro.capabilities.register(CAPABILITIES.askTransport, {
				present: (questions) => bridge.ask(questions),
			});
		}

		// Worker mode: strip TUI chrome so panes show only output
		if (rt.state.mode === "agent") {
			const empty = () => ({
				render: () => [],
				invalidate: () => {},
				dispose: () => {},
			});
			ctx.ui.setFooter(empty as any);
			ctx.ui.setHeader(empty);
			ctx.ui.setEditorComponent(() => ({
				render: () => [],
				invalidate: () => {},
				getText: () => "",
				setText: () => {},
				handleInput: () => {},
			}));
		}
	});

	pi.on("session_shutdown", async () => {
		rt.invalidateFooter = undefined;
		if (rt.workerPanes.isOpen()) {
			await rt.workerPanes.close();
		}
		if (rt.execution) {
			await rt.execution.destroy();
			rt.execution = undefined;
		}
		if (rt.agentBridge) {
			rt.agentBridge.destroy();
			rt.agentBridge = undefined;
		}
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
		if (
			rt.state.mode !== "plan" &&
			rt.state.mode !== "auto" &&
			rt.state.mode !== "agent"
		)
			return;
		if (event.toolName === "ask") return;
		if (event.toolName === "bash") {
			const command =
				typeof event.input.command === "string" ? event.input.command : "";
			// Fast path: regex classification
			const fast = classifyBashFast(command);
			if (fast !== null) {
				// Workers: only block on tool suggestions + rm outside worktree
				if (fast.suggestedTool) {
					return {
						block: true,
						reason: `Use the ${fast.suggestedTool} tool instead.`,
					};
				}
				if (!fast.allowed && rt.state.mode === "agent") {
					// Read-only agents: block ALL non-allowed bash commands
					if (process.env.PI_MAESTRO_AGENT_MODE === "read-only") {
						return {
							block: true,
							reason:
								"Read-only agent: only read commands allowed (ls, cat, grep, git log/status/diff, test/lint).",
						};
					}
					// Full agents can mutate, but block rm with absolute paths
					if (/\b(rm|rmdir)\s+.*\//.test(command)) {
						return { block: true, reason: fast.reason };
					}
					return;
				}
				if (!fast.allowed) {
					return { block: true, reason: fast.reason };
				}
				return;
			}
			// Workers: ambiguous commands are allowed (no LLM classifier)
			// EXCEPT read-only agents which block anything ambiguous
			if (rt.state.mode === "agent") {
				if (process.env.PI_MAESTRO_AGENT_MODE === "read-only") {
					return {
						block: true,
						reason:
							"Read-only agent: only read commands allowed (ls, cat, grep, git log/status/diff, test/lint).",
					};
				}
				return;
			}
			// Ambiguous: LLM classification (maestro only)
			const classifierModel = ctx
				? (await getModeRoleModel(ctx, "classifier"))?.modelId
				: MAESTRO_ENV.classifierModel;
			const intent = await classifyBashIntent(command, {
				model: classifierModel,
			});
			if (!intent.allowed) return { block: true, reason: intent.reason };
			if (intent.suggestedTool)
				return {
					block: true,
					reason: `Use the ${intent.suggestedTool} tool instead: ${intent.intent}`,
				};
			return;
		}
		// In auto mode, non-bash tools are gated by the active-tools filter
		// (+ bridge force-add for agents). Only block in plan mode.
		if (rt.state.mode === "plan") {
			const reason = toolBlockedInPlanMode(event.toolName);
			if (reason) return { block: true, reason };
		}
	});

	pi.on("turn_start", () => {
		rt.agentBridge?.onTurnStart();
	});

	// Accumulate real usage from assistant messages (tokens + cost). In agent
	// mode the bridge reports it over RPC; the maestro records its own
	// usage into the ledger (wired by the usage deliverable).
	pi.on("message_end", (event) => {
		const message = (
			event as {
				message?: { role?: string; usage?: unknown; content?: unknown };
			}
		).message;
		if (message?.role !== "assistant") return;
		if (rt.agentBridge) {
			rt.agentBridge.recordAssistantText(extractMessageText(message.content));
		}
		if (!message.usage) return;
		if (rt.agentBridge) rt.agentBridge.recordUsage(message.usage as never);
		else rt.recordMaestroUsage(message.usage);
	});

	pi.on("turn_end", async (_event, ctx) => {
		rt.agentBridge?.onTurnEnd();
		if (!rt.agentBridge) rt.incrementMaestroTurn();
		if (rt.state.mode === "plan") {
			rt.finalizeDraftPlan(ctx);
			rt.askQueue.flushTo(maestro.capabilities.get(CAPABILITIES.ask));
			return;
		}
		if (rt.state.mode !== "auto") return;

		const snapshot = rt.budgetSnapshot(ctx);
		if (!snapshot || !rt.engine) return;
		const { buckets, settings } = snapshot;

		// Soft warn (once per session) when the stable summary burden
		// (seed + rollingSummary) outgrows its budget. Not enforced — dropping
		// older summaries would lose the carry-forward signal that motivates them.
		if (
			!rt.summaryBudgetWarnFired &&
			buckets.summaryUsed > settings.summaryTokens
		) {
			rt.summaryBudgetWarnFired = true;
			ctx.ui.notify(
				`Maestro carry-forward summaries (${buckets.summaryUsed} tokens) exceed compaction.summaryTokens (${settings.summaryTokens}); consider lowering compaction.phaseTokens`,
				"warning",
			);
		}

		const active = activeDeliverable(rt.engine.get());
		const fire = shouldCompactMidDeliverable({
			mode: rt.state.mode,
			compactionInFlight: rt.compactionInFlight,
			hasActiveDeliverable: !!active,
			// Never trigger on stale data: when total is unknown `workingUsed`
			// collapses to `sys`, so gate it out explicitly.
			workingUsed: buckets.total === null ? null : buckets.workingUsed,
			workingTokens: settings.workingTokens,
		});
		if (!fire || !active) return;
		// A timed-out/aborted compaction may still be running in pi; don't stack a
		// second until the orphan should have settled.
		if (Date.now() < rt.compactionCooldownUntil) return;

		const nonce = randomUUID();
		const stageAtEntry = rt.state.execution.stage;
		const modeAtEntry = rt.state.mode;
		const deliverableAtEntry = active.id;
		rt.pendingCompaction = {
			nonce,
			deliverableId: active.id,
			reason: "modes-trigger",
			buckets: {
				sys: buckets.sys,
				seed: buckets.seed,
				rollingSummary: buckets.rollingSummary,
				hotTail: buckets.hotTail,
				workingUsed: buckets.workingUsed,
				summaryUsed: buckets.summaryUsed,
			},
		};
		rt.compactionInFlight = true;

		let compacted = false;
		try {
			await awaitCompaction({
				start: ({ onComplete, onError }) =>
					ctx.compact({
						customInstructions: buildCompactionMarker(nonce),
						onComplete,
						onError,
					}),
				timeoutMs: settings.timeoutMs,
			});
			compacted = true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(
				`Maestro mid-deliverable compaction skipped (${msg}).`,
				"warning",
			);
			if (msg === "aborted" || msg.includes("timed out")) {
				rt.compactionCooldownUntil = Date.now() + settings.timeoutMs;
			}
		} finally {
			rt.compactionInFlight = false;
			rt.pendingCompaction = undefined;
		}

		// Resume the auto loop exactly once when the gates still hold. The nonce
		// already guarantees exact-once ownership of THIS compaction; the gates
		// guard against mid-flight drift (Shift+Tab, deliverable switch, finish).
		const current = activeDeliverable(rt.engine.get());
		const remaining = current
			? gatingTasks(current).filter((t) => !t.done).length
			: 0;
		const decision = diagnoseResumeAfterCompaction({
			compacted,
			stageAtEntry,
			modeAtEntry,
			deliverableAtEntry,
			currentStage: rt.state.execution.stage,
			currentMode: rt.state.mode,
			currentDeliverable: current?.id,
			remainingTaskCount: remaining,
		});
		if (decision.resume) {
			pi.sendMessage(
				{
					customType: "maestro.compaction.resume",
					content:
						"[Maestro: context was compacted mid-deliverable. The rolling " +
						"summary above captures the work so far. Continue the active " +
						"deliverable's remaining tasks — do NOT restart from the beginning.]",
					display: false,
					details: {
						postCompactionResume: true,
						deliverableId: deliverableAtEntry,
					},
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} else if (
			compacted &&
			decision.gate !== "stage-at-entry-not-executing" &&
			decision.gate !== "mode-drifted"
		) {
			// Surface unexpected gate trips so a stalled auto run has an observable
			// reason. Skip the routine "user left auto" cases to avoid notify spam.
			ctx.ui.notify(
				`Maestro post-compaction resume skipped (gate: ${decision.gate}).`,
				"info",
			);
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		// Agent mode: inject plan-aware compaction guidance
		if (rt.state.mode === "agent" && rt.agentBridge) {
			const guidance = await buildAgentCompactionGuidance(rt.agentBridge);
			if (guidance) {
				return { additionalInstructions: guidance };
			}
			return undefined;
		}

		const decision = decideCompactionOwnership(
			event.customInstructions,
			rt.pendingCompaction,
		);
		// No modes marker → generic smart-compact or pi default owns it. Returning
		// undefined leaves the result slot untouched so an earlier handler wins.
		if (decision.kind === "decline") return undefined;

		// Marker present but no matching pending claim → never let the marker text
		// fall through into pi's default "Additional focus" prompt.
		if (decision.kind === "leak-guard" || !rt.engine) {
			rt.pendingCompaction = undefined;
			ctx.ui.notify(
				"Maestro could not own this compaction; cancelled to avoid a stale marker.",
				"warning",
			);
			return { cancel: true };
		}

		const pending = decision.pending;
		const settings = readModesCompactionSettings(ctx.cwd);
		const summarise = createModesSummariser(ctx, settings.timeoutMs);
		const { preparation } = event;
		const rawMessages = [
			...preparation.messagesToSummarize,
			...preparation.turnPrefixMessages,
		];
		try {
			const result = await buildDeliverableSliceCompactionResult({
				entries: ctx.sessionManager.getEntries(),
				plan: rt.engine.get(),
				deliverableId: pending.deliverableId,
				summarise,
				rawMessages,
				previousSummary: preparation.previousSummary,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				maxTokens: settings.phaseTokens,
				nonce: pending.nonce,
				reason: pending.reason,
				buckets: pending.buckets,
				signal: event.signal,
			});
			// Summariser soft-failed: cancel only the modes-triggered compaction
			// (never leak the marker) and let native/smart handle future overflow.
			if (!result) {
				ctx.ui.notify(
					"Maestro compaction summariser unavailable; skipping this compaction.",
					"warning",
				);
				return { cancel: true };
			}
			return { compaction: result };
		} finally {
			rt.pendingCompaction = undefined;
		}
	});

	pi.on("session_compact", (event, ctx) => {
		// Only announce compactions modes itself owned. Generic smart-compact and
		// pi-native compactions are also `fromExtension`/threshold; staying quiet
		// avoids mislabelling them as Maestro-owned.
		if (readModesCompactionDetails(event.compactionEntry)) {
			ctx.ui.notify("Maestro compacted execution context.", "info");
		}
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (!event.isError || !rt.engine) return;
		// Benign tool misses during planning/hacking are not crashes — snapshots
		// exist to capture execution failures for recovery.
		if (rt.state.mode === "plan" || rt.state.mode === "hack") return;
		const snapshot = createCrashSnapshot(
			{
				error: event.result,
				mode: rt.state.mode,
				plan: rt.engine.get(),
				activeDeliverableId: activeDeliverable(rt.engine.get())?.id,
				cwd: ctx.cwd,
			},
			rt.now,
		);
		pi.sendMessage(
			{
				customType: "maestro.crash.snapshot",
				content: `Maestro captured a tool failure: ${snapshot.error}`,
				display: true,
				details: snapshot,
			},
			{ triggerTurn: false },
		);
	});
}

/** Pull plain text out of an assistant message's content blocks. */
function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (typeof block === "string") return block;
			if (
				block &&
				typeof block === "object" &&
				(block as { type?: string }).type === "text"
			) {
				return (block as { text?: string }).text ?? "";
			}
			return "";
		})
		.filter((s) => s.length > 0)
		.join("\n");
}
