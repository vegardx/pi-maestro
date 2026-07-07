// All pi.registerCommand handlers for the mode runtime, plus the commit/ship
// tools and the Shift+Tab mode-cycle shortcut. Handlers operate on the shared
// RuntimeContext; heavy lifting stays in context.ts / the execution seam.

import { complete } from "@earendil-works/pi-ai/compat";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { CAPABILITIES, EVENTS } from "@vegardx/pi-contracts";
import { resolveModelWithin } from "@vegardx/pi-models";
import { buildCarryForwardSummary } from "../compaction.js";
import type { PlanEngine } from "../engine.js";
import { buildForwardSummaryPrompt } from "../forward-summary.js";
import { buildRecap } from "../group-recap.js";
import { resolveShipSummaryInput } from "../session.js";
import { readModesCompactionSettings } from "../settings.js";
import { createModesSummariser } from "../summarise.js";
import { handleSteerCommand, handleViewCommand } from "./agent-commands.js";
import type { RuntimeContext } from "./context.js";
import { renderAgentsOverview } from "./dashboard.js";
import {
	type Deliverable,
	type DeliverableId,
	findDeliverable,
	nextShippableDeliverable,
	parkPlan,
	renderPlanSummary,
	shipDeliverableFromPlan,
	syncPrState,
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
		description: "Reconcile merged/closed deliverable PRs back into the plan.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!rt.engine) {
				ctx.ui.notify("No active plan.", "warning");
				return;
			}
			// No session-repo guard: sync is gh-only and reconciles each
			// deliverable against its own repo, regardless of the session cwd.
			const result = await syncPrState(rt.engine, {
				state: async (prNumber: number, repoPath: string) =>
					prStateViaGh(pi, repoPath, prNumber),
			});
			rt.emitPlanChanged();
			ctx.ui.notify(
				`Sync complete: shipped=${result.shipped.length} closed=${result.closed.length}.`,
				"info",
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
			const result = await parkPlan(rt.engine, {
				createIssue: (
					input: { title: string; body: string; parent?: number },
					repoPath: string,
				) => createIssueViaGh(pi, repoPath, input),
			});
			rt.emitPlanChanged();
			ctx.ui.notify(
				`Parked plan as issue #${result.parent} (${result.children.length} deliverable issues).`,
				"info",
			);
		},
	});

	pi.registerCommand("agents", {
		description: "Show active groups and agent status.",
		handler: async (_args: string, cmdCtx: ExtensionCommandContext) => {
			if (!rt.engine) {
				cmdCtx.ui.notify("No active plan.", "info");
				return;
			}
			const plan = rt.engine.get();
			if (plan.groups.length === 0) {
				cmdCtx.ui.notify("No groups in plan.", "info");
				return;
			}
			cmdCtx.ui.notify(renderAgentsOverview(plan, rt.execution), "info");
		},
	});

	pi.registerCommand("view", {
		description:
			"View an agent's tmux session in a split pane. /view <name> or /view for dialog.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (rt.execution) {
				await handleViewCommand(args, ctx, rt.execution, rt.viewState);
			} else {
				ctx.ui.notify("No agents active (tmux required).", "info");
			}
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
				handleSteerCommand(args, ctx, rt.execution);
			} else {
				ctx.ui.notify("No agents active (tmux required).", "info");
			}
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
			// Answer the first pending question
			const entry = pending[0];
			const answer = await cmdCtx.ui.input(
				`${entry.agentName}: ${entry.questions[0]?.question ?? "Question"}`,
				"Type your answer...",
			);
			if (answer) {
				entry.resolve([
					{ questionId: entry.questions[0]?.id ?? "0", value: answer },
				]);
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
				const deliverableId = process.env.PI_MAESTRO_AGENT_ID as
					| DeliverableId
					| undefined;
				const result = await commit.shipDeliverable({
					autoApprove: true,
					deliverableId,
					message: params.message,
					paths: params.paths,
					openPr: false,
					cwd: active.cwd,
				});
				const text = !result.committed
					? "Nothing to commit."
					: `Committed ${result.sha ?? result.branch}.`;
				return { content: [{ type: "text", text }], details: { result } };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "ship",
			label: "Ship deliverable",
			description:
				"Push your branch and open/update a PR. This is the FINAL step — " +
				"commit your work first with the commit tool, then ship when done. " +
				"Auto-toggles remaining tasks on success.",
			parameters: Type.Object({}),
			async execute(_id, _params, _signal, _onUpdate, active) {
				const commit = maestro.capabilities.get(CAPABILITIES.commit);
				if (!commit) {
					return {
						content: [
							{
								type: "text",
								text: "Ship unavailable (commit capability absent).",
							},
						],
						details: {},
					};
				}
				const deliverableId = process.env.PI_MAESTRO_AGENT_ID as
					| DeliverableId
					| undefined;
				const result = await commit.shipDeliverable({
					autoApprove: true,
					deliverableId,
					openPr: true,
					cwd: active.cwd,
				});
				if (!result.pushed && !result.pr) {
					return {
						content: [
							{ type: "text", text: "Nothing to ship (no commits to push)." },
						],
						details: {},
					};
				}

				// Auto-toggle remaining gating tasks on successful ship
				if (deliverableId && rt.agentBridge) {
					const planContent = await rt.agentBridge.planRead();
					// Parse task IDs from plan markdown: lines matching "- [ ] ... `taskId`"
					const untoggled: string[] = [];
					for (const line of planContent.split("\n")) {
						const m = line.match(/^- \[ \] .+`([^`]+)`/);
						if (m) untoggled.push(m[1]);
					}
					for (const taskId of untoggled) {
						await rt.agentBridge.planMutate("toggleTask", deliverableId, {
							taskId,
						});
					}
				}

				const text = result.pr
					? `Shipped ${result.branch} → PR #${result.pr}.`
					: `Pushed ${result.branch}.`;
				return { content: [{ type: "text", text }], details: { result } };
			},
		}),
	);

	pi.registerCommand("modes-status", {
		description: "Show Maestro mode and active plan status.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const plan = rt.engine?.get();
			ctx.ui.notify(
				`mode=${rt.state.mode} plan=${plan?.slug ?? "none"} groups=${
					plan?.groups.length ?? 0
				}`,
				"info",
			);
		},
	});

	pi.registerShortcut("shift+tab", {
		description: "Cycle Maestro mode: hack → plan → auto.",
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

async function prStateViaGh(
	pi: ExtensionAPI,
	cwd: string,
	prNumber: number,
): Promise<"open" | "merged" | "closed" | null> {
	const result = await pi.exec(
		"gh",
		["pr", "view", String(prNumber), "--json", "state,mergedAt"],
		{ cwd },
	);
	if (result.code !== 0) return null;
	const parsed = JSON.parse(result.stdout) as {
		state?: string;
		mergedAt?: string;
	};
	if (parsed.mergedAt) return "merged";
	if (parsed.state === "OPEN") return "open";
	if (parsed.state === "CLOSED") return "closed";
	return null;
}

async function createIssueViaGh(
	pi: ExtensionAPI,
	cwd: string,
	input: { title: string; body: string; parent?: number },
): Promise<number> {
	const body = input.parent
		? `${input.body}\n\nParent: #${input.parent}`
		: input.body;
	const result = await pi.exec(
		"gh",
		["issue", "create", "--title", input.title, "--body", body],
		{ cwd },
	);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || "gh issue create failed");
	}
	const match =
		result.stdout.match(/\/(?:issues|issue)\/(\d+)\b/) ??
		result.stdout.match(/#(\d+)\b/);
	if (!match) throw new Error(`could not parse issue number: ${result.stdout}`);
	return Number(match[1]);
}

type ForwardSummaryInput = {
	completed: { title: string; body: string };
	agentOutput: string;
	consumers: { title: string; body: string; tasks: string[] }[];
};

/**
 * Create a forward-looking summary generator bound to the extension context.
 * Uses the modes normal-tier model for the LLM call.
 */
function _createForwardSummaryGenerator(
	ctx: ExtensionContext,
): (input: ForwardSummaryInput) => Promise<string> {
	return async (input) => {
		const resolved = await resolveModelWithin(
			ctx,
			{ name: "modes", tier: "normal", requireApiKey: true },
			30_000,
		);
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
