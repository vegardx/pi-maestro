// All pi.registerCommand handlers for the mode runtime, plus the commit/ship
// tools and the Shift+Tab mode-cycle shortcut. Handlers operate on the shared
// RuntimeContext; heavy lifting stays in context.ts / the execution seam.

import { join } from "node:path";
import { complete } from "@earendil-works/pi-ai/compat";
import {
	defineTool,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type Answer, CAPABILITIES, EVENTS } from "@vegardx/pi-contracts";
import { getModelMeta, resolveRolePoolWithin } from "@vegardx/pi-models";
import { isAgentMode } from "../agent-bridge.js";
import { buildCarryForwardSummary } from "../compaction.js";
import { buildRecap } from "../deliverable-recap.js";
import type { PlanEngine } from "../engine.js";
import { applyRemediation, renderRemediation } from "../exec/remediate.js";
import { reconcileShippedDeliverables } from "../exec/shipper.js";
import {
	renderVerification,
	runVerification,
	type VerifyEntry,
	verifyTargets,
} from "../exec/verify.js";
import { themeRollup, writeVerificationReport } from "../exec/verify-report.js";
import { buildForwardSummaryPrompt } from "../forward-summary.js";
import { planPhase } from "../schema.js";
import { resolveShipSummaryInput } from "../session.js";
import { readModesCompactionSettings } from "../settings.js";
import { plansRoot } from "../storage.js";
import { createModesSummariser } from "../summarise.js";
import { clipReport, sendAgentEvent } from "./agent-cards.js";
import {
	handleInterruptCommand,
	handleSteerCommand,
	handleViewCommand,
} from "./agent-commands.js";
import { listAgentTargets } from "./agent-targets.js";
import { beginDistill, beginHandoff } from "./carry-commands.js";
import type { RuntimeContext } from "./context.js";
import { renderAgentsOverview, syncAgentWidget } from "./dashboard.js";
import { runDebugCommand, runWorkerDebugCommand } from "./debug-command.js";
import {
	type Deliverable,
	type DeliverableId,
	findDeliverable,
	nextShippableDeliverable,
	renderPlanSummary,
	shipDeliverableFromPlan,
} from "./stubs.js";

export function registerRuntimeCommands(rt: RuntimeContext): void {
	const { pi, maestro } = rt;

	pi.registerCommand("plan", {
		description: "Open or create a Maestro plan for this repo.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const opened = rt.openPlan(args, ctx);
			rt.setMode("plan", ctx);
			ctx.ui.notify(
				opened.isDraft()
					? "Planning mode — this plan is named from your first message."
					: `Plan ${opened.get().slug} active.`,
				"info",
			);
			pi.sendMessage(
				{
					customType: "maestro.plan.document",
					content: renderPlanSummary(opened.get()),
					display: true,
				},
				{ triggerTurn: false },
			);
		},
	});

	for (const mode of ["hack", "auto"] as const) {
		pi.registerCommand(mode, {
			description: `Switch to Maestro ${mode} mode.`,
			handler: async (_args: string, ctx: ExtensionCommandContext) => {
				rt.setMode(mode, ctx);
			},
		});
	}

	// Recon is command-only on re-entry (never part of the Shift+Tab cycle):
	// the mode's whole point is that leaving it is a deliberate one-way step.
	pi.registerCommand("recon", {
		description: "Switch to Maestro recon mode (read-only research posture).",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (rt.execution) {
				ctx.ui.notify(
					"Execution is running — recon is unavailable until it settles.",
					"warning",
				);
				return;
			}
			rt.setMode("recon", ctx);
		},
	});

	// Manual escape hatch for the readiness gate: flip the plan to structuring
	// without waiting for the model to call `readiness`.
	pi.registerCommand("ready", {
		description:
			"Unlock plan structuring (skip the exploring phase's readiness gate).",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const engine = rt.engine;
			if (!engine) {
				ctx.ui.notify("No plan active — run /plan first.", "warning");
				return;
			}
			if (planPhase(engine.get()) === "structuring") {
				ctx.ui.notify("Plan is already structuring.", "info");
				return;
			}
			engine.setPhase("structuring");
			rt.applyTools();
			rt.notifyMode(ctx);
			ctx.ui.notify("Structure tools unlocked — plan away.", "info");
			pi.sendUserMessage(
				"The user unlocked plan structuring (/ready). Form the plan now: create deliverables and tasks from what you know, then the knowledge doc.",
				{ deliverAs: "followUp" },
			);
		},
	});

	pi.registerCommand("implement", {
		description:
			"Start executing the active plan. Agents auto-spawn when subagents are available.",
		handler: (args, ctx) => rt.runImplement(args, ctx),
	});

	pi.registerCommand("ship", {
		description: "Ship the next shippable deliverable via commit.v1.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!rt.engine) {
				ctx.ui.notify("No active plan.", "warning");
				return;
			}
			rt.finalizeDraftPlan(ctx);
			const activeEngine = rt.engine;
			const commit = maestro.capabilities.get(CAPABILITIES.commit);
			if (!commit) {
				ctx.ui.notify("commit.v1 unavailable.", "warning");
				return;
			}
			const id = args.trim() || nextShippableDeliverable(rt.engine.get())?.id;
			if (!id) {
				ctx.ui.notify("No shippable deliverable.", "warning");
				return;
			}
			const target = findDeliverable(rt.engine.get(), id);
			if (target && !rt.assertDeliverableRepo(ctx, target)) return;
			const shipped = await shipDeliverableFromPlan(rt.engine, id, {
				commit,
				confirm: ({ message }: { message: string }) =>
					ctx.ui.confirm("Ship deliverable", message),
				summarise: (deliverable: Deliverable) =>
					buildShipSummary(
						deliverable,
						activeEngine,
						ctx,
						readModesCompactionSettings,
					),
			});
			if (shipped.kind !== "shipped") {
				ctx.ui.notify(
					shipped.kind === "canceled" ? "Ship canceled." : shipped.reason,
					"warning",
				);
				return;
			}
			rt.emitPlanChanged();
			if (rt.state.execution.deliverableId === shipped.deliverable.id)
				rt.setExecutionStage({ stage: "idle" }, ctx);
			maestro.events.emit(EVENTS.shipCompleted, {
				deliverableId: shipped.deliverable.id as DeliverableId,
				pr: shipped.result.pr,
			});
			ctx.ui.notify(
				shipped.result.pr
					? `Shipped ${id} → PR #${shipped.result.pr}.`
					: `Shipped ${id}.`,
				"info",
			);
		},
	});

	pi.registerCommand("sync", {
		description:
			"Reconcile shipped deliverables' PRs: retarget stacked PRs whose base merged.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!rt.engine) {
				ctx.ui.notify("No active plan.", "warning");
				return;
			}
			// No session-repo guard: sync is gh-only and reconciles each deliverable
			// against its own repo, regardless of the session cwd.
			const report = await reconcileShippedDeliverables({
				plan: rt.engine.get(),
			});
			const lines: string[] = [];
			for (const r of report.retargeted) {
				lines.push(
					`retargeted ${r.deliverableId} PR #${r.prNumber}: ${r.from} → ${r.to}`,
				);
			}
			for (const r of report.needsRebase) {
				lines.push(`needs-rebase ${r.deliverableId}: ${r.message}`);
			}
			for (const e of report.errors) {
				lines.push(`error ${e.deliverableId}: ${e.message}`);
			}
			const summary = `Sync complete: retargeted=${report.retargeted.length} needs-rebase=${report.needsRebase.length} errors=${report.errors.length}.`;
			ctx.ui.notify(
				lines.length > 0 ? `${summary}\n${lines.join("\n")}` : summary,
				report.errors.length > 0 || report.needsRebase.length > 0
					? "warning"
					: "info",
			);
		},
	});

	pi.registerCommand("park", {
		description: "Create GitHub tracking issues for the active plan.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!rt.engine) {
				ctx.ui.notify("No active plan.", "warning");
				return;
			}
			ctx.ui.notify(
				"/park is not yet implemented in the deliverable model — the plan stays in maestro/plans/ and can be resumed with /plan.",
				"warning",
			);
		},
	});

	pi.registerCommand("agents", {
		description: "Show active deliverables and agent status.",
		handler: async (_args: string, cmdCtx: ExtensionCommandContext) => {
			if (!rt.engine) {
				cmdCtx.ui.notify("No active plan.", "info");
				return;
			}
			const plan = rt.engine.get();
			if (plan.deliverables.length === 0) {
				cmdCtx.ui.notify("No deliverables in plan.", "info");
				return;
			}
			const subagents = maestro.capabilities.get(CAPABILITIES.subagents);
			const targets = listAgentTargets({ execution: rt.execution, subagents });
			const runLines = targets
				.filter((target) => target.kind === "run")
				.map((target) => {
					const elapsed = Math.max(0, Date.now() - target.createdAt);
					const age = Math.max(0, Date.now() - target.updatedAt);
					return `${target.id} · ${target.role} · ${target.status} · ${Math.round(elapsed / 1000)}s elapsed · event ${Math.round(age / 1000)}s ago · ${target.model ?? "default model"}`;
				});
			const overview = renderAgentsOverview(plan, rt.execution);
			cmdCtx.ui.notify(
				runLines.length
					? `${overview}\n\nInspectable runs:\n${runLines.join("\n")}`
					: overview,
				"info",
			);
		},
	});

	pi.registerCommand("recover", {
		description:
			"Recover an interrupted execution: audit the plan against reality (worktrees, branches, PRs) and resume interrupted workers from their saved sessions.",
		handler: (_args: string, ctx: ExtensionCommandContext) =>
			rt.runRecover(ctx),
	});

	pi.registerCommand("distill", {
		description:
			"Curated in-place compaction: carry the essentials (you pick the " +
			"threads), cut the rest, keep working — same plan, same session.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (isAgentMode()) {
				ctx.ui.notify("/distill is a maestro command.", "warning");
				return;
			}
			beginDistill(rt, ctx);
		},
	});

	pi.registerCommand("handoff", {
		description:
			"Close this arc: curate the unfinished threads (a transcript " +
			"archaeologist hunts dropped balls) and seed a NEW planning session " +
			"with no active plan. Refuses while workers are mid-flight.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (isAgentMode()) {
				ctx.ui.notify("/handoff is a maestro command.", "warning");
				return;
			}
			await beginHandoff(rt, ctx);
		},
	});

	pi.registerCommand("verify", {
		description:
			"Deep-verify started deliverables: read-only subagents read each " +
			"deliverable's actual diff and judge whether its tasks were genuinely " +
			"accomplished. /verify [deliverable-id]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!rt.engine) {
				ctx.ui.notify("No active plan.", "warning");
				return;
			}
			const subagents = maestro.capabilities.get(CAPABILITIES.subagents);
			if (!subagents) {
				ctx.ui.notify(
					"Verify unavailable: the subagents extension is not loaded.",
					"warning",
				);
				return;
			}
			const plan = rt.engine.get();
			const id = args.trim() || undefined;
			const targets = verifyTargets(plan, id);
			if (targets.length === 0) {
				ctx.ui.notify(
					id
						? `Nothing to verify for "${id}" — unknown id or not started yet.`
						: "Nothing to verify — no deliverable has started work.",
					"info",
				);
				return;
			}
			const verifierResolution = await resolveRolePoolWithin(
				ctx,
				{ role: "verifier", requireApiKey: true },
				30_000,
			);
			const verifier = verifierResolution.selected;
			if (!verifier) {
				ctx.ui.notify(
					`Verification unavailable: ${verifierResolution.errors.map((item) => item.message).join("; ")}`,
					"error",
				);
				return;
			}
			const meta = getModelMeta(ctx, verifier.modelId);
			ctx.ui.notify(
				`Verifying ${targets.length} deliverable(s) — read-only agents are checking the actual diffs…`,
				"info",
			);
			const entries = await runVerification(plan, targets, {
				spawn: (prompt, profile) =>
					subagents.spawn(prompt, {
						...profile,
						model: verifier.modelId,
						...(verifier.effort ? { thinking: verifier.effort } : {}),
					}),
				display: {
					model: meta.shortName,
					adaptive: meta.adaptive,
					effort: verifier.effort,
				},
				onStarted: (view) => {
					rt.researchRuns.set(view.id, view);
					sendAgentEvent(pi, {
						kind: "research-spawn",
						question: view.question,
						research: "verify",
					});
					syncAgentWidget(rt, ctx);
				},
				onSettled: (view, entry) => {
					rt.researchRuns.delete(view.id);
					sendAgentEvent(pi, {
						kind: "research-done",
						question: view.question,
						research: "verify",
						ok: entry.verdict === "pass",
						durationMs: Date.now() - view.startedAt,
						// Clipped: the round file under verification/ has the full text.
						...(entry.report ? { report: clipReport(entry.report) } : {}),
						...(entry.error ? { error: entry.error } : {}),
					});
					syncAgentWidget(rt, ctx);
				},
			});
			const problems = entries.some(
				(e) => e.verdict === "fail" || e.verdict === "error",
			);
			// Persist the round: the markdown is the triage surface, the JSON is
			// what the remediation flow consumes.
			let reportNote = "";
			let round: number | undefined;
			try {
				const paths = writeVerificationReport(
					join(plansRoot(), plan.slug),
					entries,
				);
				round = paths.round;
				reportNote = `\nFull report: ${paths.mdPath}`;
			} catch {
				// Report persistence is best-effort — the notify still carries
				// the findings.
			}
			ctx.ui.notify(
				`${renderVerification(entries)}${reportNote}`,
				problems ? "warning" : "info",
			);
			const failed = entries.filter((e) => e.verdict === "fail");
			if (failed.length > 0) {
				await presentRemediationTriage(rt, ctx, entries, round, failed.length);
			}
		},
	});

	pi.registerCommand("debug", {
		description:
			"Diagnose this session and choose one explicit recovery action.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (isAgentMode()) await runWorkerDebugCommand(rt, args, ctx);
			else await runDebugCommand(rt, args, ctx);
		},
	});

	pi.registerCommand("retry", {
		description:
			"Clear a blocked deliverable and re-attempt it. /retry <deliverable-id>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!rt.execution) {
				ctx.ui.notify("No execution running — /implement first.", "info");
				return;
			}
			const executor = rt.execution.getExecutor();
			const blocked = [...executor.getStates().entries()].filter(
				([, s]) => s.blocked,
			);
			const id = args.trim();
			if (!id) {
				ctx.ui.notify(
					blocked.length
						? `Blocked deliverables:\n${blocked
								.map(([bid, s]) => `  ${bid} — ${s.blocked}`)
								.join("\n")}\nRun /retry <deliverable-id>.`
						: "Nothing is blocked.",
					"info",
				);
				return;
			}
			const state = executor.getStates().get(id);
			if (!state) {
				ctx.ui.notify(`Unknown deliverable: ${id}`, "warning");
				return;
			}
			if (!state.blocked) {
				ctx.ui.notify(`${id} is not blocked.`, "info");
				return;
			}
			const reason = state.blocked;
			executor.unblockDeliverable(id);
			ctx.ui.notify(
				`Cleared block on ${id} (was: ${reason}) — retrying.`,
				"info",
			);
			await rt.execution.tick();
		},
	});

	pi.registerCommand("view", {
		description:
			"View any tmux-backed agent session in a split pane. /view <opaque-id> or /view for dialog.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const subagents = maestro.capabilities.get(CAPABILITIES.subagents);
			await handleViewCommand(args, ctx, rt.execution, rt.viewState, subagents);
		},
	});

	pi.registerCommand("watch", {
		description:
			"Toggle stacked tmux panes showing all active agents on the right side.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!rt.execution) {
				ctx.ui.notify("No agents active (tmux required).", "info");
				return;
			}
			if (rt.workerPanes.isOpen() || rt.workerPanes.isEnabled()) {
				await rt.workerPanes.close();
				ctx.ui.notify("Worker panes closed.", "info");
			} else {
				await rt.workerPanes.open(rt.execution.getWorkerSessions());
				if (rt.workerPanes.terminalTooSmall()) {
					ctx.ui.notify(
						"Worker panes enabled — will appear when terminal is larger (≥160×40).",
						"info",
					);
				} else {
					ctx.ui.notify("Worker panes opened.", "info");
				}
			}
		},
	});

	pi.registerCommand("steer", {
		description: "Steer an agent. /steer <name> <guidance>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (rt.execution) {
				handleSteerCommand(
					args,
					ctx,
					rt.execution,
					maestro.capabilities.get(CAPABILITIES.subagents),
				);
			} else {
				ctx.ui.notify("No agents active (tmux required).", "info");
			}
		},
	});

	pi.registerCommand("interrupt", {
		description:
			"Abort one agent turn/run without shutdown. /interrupt [target] [--children|--tree|--all]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await handleInterruptCommand(
				args,
				ctx,
				rt.execution,
				maestro.capabilities.get(CAPABILITIES.subagents),
			);
		},
	});

	pi.registerCommand("answer", {
		description: "Answer pending agent questions.",
		handler: async (_args: string, cmdCtx: ExtensionCommandContext) => {
			if (!rt.execution) {
				cmdCtx.ui.notify("No questions pending.", "info");
				return;
			}
			const pending = rt.execution.questionQueue.all();
			if (pending.length === 0) {
				cmdCtx.ui.notify("No questions pending.", "info");
				return;
			}
			// Answer the oldest pending entry (FIFO), one prompt per question.
			const entry = pending[0];
			const answers: Answer[] = [];
			for (const question of entry.questions) {
				const answer = await cmdCtx.ui.input(
					`${entry.agentName}: ${question.question}`,
					"Type your answer...",
				);
				if (answer) answers.push({ questionId: question.id, value: answer });
			}
			if (answers.length > 0) {
				// Dequeue through the queue so the entry doesn't linger as a
				// phantom question after it has been resolved.
				rt.execution.questionQueue.answer(entry.agentId, answers);
				cmdCtx.ui.notify(`✓ Answered ${entry.agentName}`, "info");
			}
		},
	});

	pi.registerCommand("recap", {
		description: "Show summary of completed agent work.",
		handler: async (_args: string, cmdCtx: ExtensionCommandContext) => {
			if (!rt.engine || !rt.execution) {
				cmdCtx.ui.notify("No agent work to recap.", "info");
				return;
			}
			const recap = buildRecap(rt.engine, rt.execution.getExecutor(), {
				includeSummaries: true,
			});
			pi.sendMessage(
				{
					customType: "maestro.execution.recap",
					content: recap,
					display: true,
				},
				{ triggerTurn: false },
			);
		},
	});

	pi.registerTool(
		defineTool({
			name: "commit",
			label: "Commit changes",
			description:
				"Stage files and commit locally. Use for incremental checkpoints as you work. " +
				"You MUST provide a conventional commit message and explicit file paths.",
			parameters: Type.Object({
				message: Type.String({
					description:
						"Full conventional commit: subject (type(scope): what, max 72 chars), " +
						"blank line, then body explaining what changed and why. " +
						"Example: feat(math): implement multiply\\n\\nAdd multiply(a,b) with overflow guard.",
				}),
				paths: Type.Array(Type.String(), {
					description:
						"Files to stage (explicit paths only, never use . or -A).",
				}),
			}),
			async execute(_id, params, _signal, _onUpdate, active) {
				const commit = maestro.capabilities.get(CAPABILITIES.commit);
				if (!commit) {
					return {
						content: [
							{
								type: "text",
								text: "Commit unavailable (commit capability absent).",
							},
						],
						details: {},
					};
				}
				const result = await commit.commitLocal({
					message: params.message,
					paths: params.paths,
					cwd: active.cwd,
				});
				const text = result.committed
					? `Committed ${result.sha ?? "changes"}.`
					: `Nothing committed: ${result.error ?? "no changes staged"}.`;
				return { content: [{ type: "text", text }], details: { result } };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "ship",
			label: "Ship branch",
			description:
				"Push the current branch and open/update a PR. Maestro/interactive " +
				"use only — execution agents commit locally and let the maestro " +
				"ship the deliverable.",
			parameters: Type.Object({}),
			async execute(_id, _params, _signal, _onUpdate, active) {
				// Execution agents never ship: the maestro pushes the deliverable's
				// branch and opens the PR once the deliverable completes (exec/shipper).
				if (process.env.PI_MAESTRO_AGENT_ID) {
					return {
						content: [
							{
								type: "text",
								text:
									"Shipping is owned by the maestro. Commit your work with " +
									"the commit tool and toggle your tasks when done — the " +
									"maestro pushes the branch and opens the PR when the " +
									"deliverable completes.",
							},
						],
						details: {},
					};
				}
				const shipper = maestro.capabilities.get(CAPABILITIES.ship);
				if (!shipper) {
					return {
						content: [
							{
								type: "text",
								text: "Ship unavailable (ship capability absent).",
							},
						],
						details: {},
					};
				}
				const result = await shipper.ship({
					autoApprove: true,
					cwd: active.cwd,
				});
				const text = result.pr
					? `Shipped ${result.branch} → PR #${result.pr}.`
					: result.pushed
						? `Pushed ${result.branch}.`
						: "Nothing shipped (push failed or no commits to push).";
				return { content: [{ type: "text", text }], details: { result } };
			},
		}),
	);

	pi.registerCommand("modes-status", {
		description: "Show Maestro mode and active plan status.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const plan = rt.engine?.get();
			ctx.ui.notify(
				`mode=${rt.state.mode} plan=${plan?.slug ?? "none"} deliverables=${
					plan?.deliverables.length ?? 0
				}`,
				"info",
			);
		},
	});

	pi.registerShortcut("shift+tab", {
		description:
			"Cycle Maestro mode: plan ⇄ auto (recon and hack exit into plan).",
		handler: (ctx) => rt.cycle(ctx),
	});
}

/**
 * Build a deliverable's forward-looking carry-forward summary at ship time.
 * Reads the deliverable's OWN session (soft-fails if /ship runs elsewhere),
 * distils rolling summary + raw tail once, and returns undefined on any
 * soft-failure so shipping always proceeds.
 */
async function buildShipSummary(
	deliverable: Deliverable,
	engine: PlanEngine,
	ctx: ExtensionContext,
	readSettings: typeof readModesCompactionSettings,
): Promise<string | undefined> {
	const settings = readSettings(ctx.cwd);
	const currentSessionFile = ctx.sessionManager.getSessionFile?.();

	// If the deliverable was worked in a different session (e.g. by an agent
	// subagent), load that session's entries from disk so the carry-forward
	// summary reflects the actual implementation work.
	let entries = ctx.sessionManager.getEntries();
	let sessionFile = currentSessionFile;
	if (
		deliverable.sessionPath &&
		currentSessionFile &&
		deliverable.sessionPath !== currentSessionFile
	) {
		try {
			const { readFileSync } = await import("node:fs");
			const raw = readFileSync(deliverable.sessionPath, "utf8");
			entries = raw
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			sessionFile = deliverable.sessionPath;
		} catch {
			// Worker session file missing or unreadable; fall through to
			// resolveShipSummaryInput which will soft-fail gracefully.
		}
	}

	const resolved = resolveShipSummaryInput(entries, deliverable, sessionFile);
	if (!resolved.ok) return undefined;
	const summarise = createModesSummariser(ctx, settings.timeoutMs);
	const text = await buildCarryForwardSummary({
		plan: engine.get(),
		deliverable,
		rollingSummary: resolved.input.rollingSummary,
		rawTail: resolved.input.rawTail,
		summarise,
		maxTokens: settings.phaseTokens,
	});
	return text ?? undefined;
}

type ForwardSummaryInput = {
	completed: { title: string; body: string };
	agentOutput: string;
	consumers: { title: string; body: string; tasks: string[] }[];
};

/**
 * Create a forward-looking summary generator bound to the extension context.
 * Uses the plan-summarizer role policy default for the LLM call.
 */
function _createForwardSummaryGenerator(
	ctx: ExtensionContext,
): (input: ForwardSummaryInput) => Promise<string> {
	return async (input) => {
		const resolution = await resolveRolePoolWithin(
			ctx,
			{ role: "plan-summarizer", requireApiKey: true },
			30_000,
		);
		const resolved = resolution.selected;
		if (!resolved?.apiKey) {
			throw new Error("No model available for summary generation");
		}

		const promptText = buildForwardSummaryPrompt(input);
		const response = await complete(
			resolved.model,
			{
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: promptText }],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: resolved.apiKey,
				headers: resolved.headers,
				maxTokens: 512,
			},
		);

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		if (!text) throw new Error("Empty summary response");
		return text;
	};
}

// ─── /verify remediation triage ──────────────────────────────────────────────

const REMEDIATE_LEADERS = "Remediate: theme leaders first";
const REMEDIATE_ALL = "Remediate: reopen all now";
const REMEDIATE_NONE = "Report only";

/**
 * After a failing verification round: ask the human how to remediate, then
 * execute the choice. Theme-leaders mode reopens everything but sequences
 * cross-cutting themes behind ONE leader deliverable via ordinary dependsOn
 * edges — the executor's DAG activation runs wave 2 automatically when a
 * leader re-lands, so no human action is needed between waves.
 */
async function presentRemediationTriage(
	rt: RuntimeContext,
	ctx: ExtensionCommandContext,
	entries: readonly VerifyEntry[],
	round: number | undefined,
	failedCount: number,
): Promise<void> {
	const ask = rt.maestro.capabilities.get(CAPABILITIES.ask);
	if (!ask || !rt.engine) return;
	const themes = themeRollup(entries.filter((e) => e.verdict === "fail"))
		.filter((t) => t.deliverables.length > 1)
		.map(
			(t) =>
				`${t.category} — ${t.count} finding(s) across ${t.deliverables.length}: ${t.deliverables.join(", ")}`,
		);
	const qid = `verify-remediate:${round ?? 0}`;
	let answers: readonly Answer[];
	try {
		answers = await ask.ask([
			{
				id: qid,
				question: `Verification found ${failedCount} failing deliverable(s). Remediate?`,
				...(themes.length > 0
					? { context: `Cross-cutting themes:\n${themes.join("\n")}` }
					: {}),
				options: [
					{
						label: REMEDIATE_LEADERS,
						description:
							"Reopen every failing deliverable with its findings as gating " +
							"tasks. Each cross-cutting theme converges on ONE leader first; " +
							"the rest reopen queued and activate automatically when their " +
							"leader lands.",
					},
					{
						label: REMEDIATE_ALL,
						description:
							"Reopen everything at once — no theme sequencing; workers may " +
							"solve the same cross-repo pattern independently.",
					},
					{
						label: REMEDIATE_NONE,
						description:
							"Do nothing — the report is on disk; run /verify again later " +
							"or remediate manually.",
					},
				],
			},
		]);
	} catch {
		return; // ask surface unavailable — the report notify already landed
	}
	const answer = answers.find((a: Answer) => a.questionId === qid);
	if (!answer || answer.deferred || answer.skipped) return;
	if (answer.value !== REMEDIATE_LEADERS && answer.value !== REMEDIATE_ALL)
		return;

	const result = await applyRemediation(entries, {
		engine: rt.engine,
		...(round !== undefined ? { round } : {}),
		waves: answer.value === REMEDIATE_LEADERS,
	});
	rt.emitPlanChanged();
	ctx.ui.notify(renderRemediation(result), "info");
	if (result.reopened.length === 0) return;

	// Reopened deliverables sit in `planned` — run the ordinary execution
	// loop: wave 1 activates now, wave 2 follows its leaders through the DAG.
	if (rt.state.mode !== "auto" && rt.state.mode !== "hack") {
		rt.setMode("auto", ctx);
	}
	await rt.ensureExecution(ctx);
	if (!rt.execution) return;
	const activated = await rt.execution.tick();
	syncAgentWidget(rt, ctx);
	if (activated > 0) {
		ctx.ui.notify(
			`Activated ${activated} deliverable(s) — remediation wave 1 running.`,
			"info",
		);
	}
}
