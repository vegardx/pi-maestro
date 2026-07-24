// All pi.registerCommand handlers for the mode runtime, plus the commit/ship
// tools and the Shift+Tab mode-cycle shortcut. Handlers operate on the shared
// RuntimeContext; heavy lifting stays in context.ts / the execution seam.

import { join } from "node:path";
import {
	defineTool,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	type AgentKindDefinition,
	type Answer,
	CAPABILITIES,
	SPAWNABLE_AGENT_TYPES,
	type SpawnableAgentType,
	type ThinkingLevel,
} from "@vegardx/pi-contracts";
import { runCommand } from "@vegardx/pi-git";
import {
	defaultTierForAgent,
	explainTier,
	getModelMeta,
	readV2Config,
	resolveExactModelSelection,
	resolveV2Model,
} from "@vegardx/pi-models";
import { isAgentMode } from "../agent-bridge.js";
import { createDeleteTool } from "../delete-tool.js";
import { buildRecap } from "../deliverable-recap.js";
import { reconcileShippedDeliverables } from "../exec/shipper.js";
import {
	renderVerification,
	runVerification,
	verifyTargets,
} from "../exec/verify.js";
import { writeVerificationReport } from "../exec/verify-report.js";
import { findNodeV2 } from "../plan/schema.js";
import { resolveDutyModel } from "../policy-table.js";
import { plansRoot } from "../storage.js";
import { clipReport, sendAgentEvent } from "./agent-cards.js";
import {
	handleInterruptCommand,
	handleSteerCommand,
	handleViewCommand,
} from "./agent-commands.js";
import { listAgentTargets } from "./agent-targets.js";
import { beginDistill, beginHandoff } from "./carry-commands.js";
import type { RuntimeContext } from "./context.js";
import { renderAgentsOverview } from "./dashboard.js";
import { runDebugCommand, runWorkerDebugCommand } from "./debug-command.js";

/**
 * Register a maestro slash command for every agent kind that declares one
 * (docs/design/persona-commands.md). The command spawns that persona against a
 * target and surfaces its report — report-only, no auto-remediation. Reading
 * `command` is confined to this loop; the spawn/execution path never consults
 * it, so the same persona keeps working unchanged inside a worker's review().
 */
export function registerPersonaCommands(rt: RuntimeContext): void {
	const { pi, maestro } = rt;
	const agents = maestro.capabilities.get(CAPABILITIES.agents);
	if (!agents) return;
	for (const kind of agents.kinds()) {
		const command = kind.command;
		if (!command) continue;
		pi.registerCommand(command.name, {
			description: command.description,
			handler: (args: string, ctx: ExtensionCommandContext) =>
				runPersonaCommand(rt, kind, args, ctx),
		});
	}
}

/** Current changes in the repo: staged + unstaged vs HEAD (empty if none/not a repo). */
function repoChanges(cwd: string): string {
	const diff = runCommand("git", ["diff", "HEAD"], { cwd });
	return diff.ok ? diff.stdout.trim() : "";
}

/**
 * Generic persona-command handler: resolve the kind's model, gather the target
 * (the repo's current changes), spawn the read-only persona, and surface its
 * report. No remediation — a human reads the report and decides.
 */
async function runPersonaCommand(
	rt: RuntimeContext,
	kind: AgentKindDefinition,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const command = kind.command;
	if (!command) return;
	// Deliverable-targeted personas (e.g. /verify) fan out over the plan's
	// started deliverables with per-deliverable evidence — a different flow from
	// the single-spawn repo-changes review below.
	if (command.target === "deliverables") {
		await runDeliveryVerification(rt, args, ctx);
		return;
	}
	const subagents = rt.maestro.capabilities.get(CAPABILITIES.subagents);
	if (!subagents) {
		ctx.ui.notify(
			`/${command.name} unavailable: the subagents extension is not loaded.`,
			"warning",
		);
		return;
	}
	const resolution = await resolveExactModelSelection(ctx, {
		role: kind.modelRole,
		requireApiKey: true,
	});
	const selected = resolution.selected;
	if (!selected) {
		ctx.ui.notify(
			`/${command.name} unavailable: ${resolution.errors.map((e) => e.message).join("; ")}`,
			"error",
		);
		return;
	}
	const cwd = process.cwd();
	const changes = repoChanges(cwd);
	const prompt = [
		kind.prompt,
		"",
		command.instruction,
		args.trim() ? `\nUser request: ${args.trim()}` : "",
		changes
			? `\n\nChanges under review (git diff HEAD):\n${changes}`
			: "\n\nNo uncommitted changes; review the working tree at HEAD.",
	].join("\n");
	const meta = getModelMeta(ctx, selected.modelId);
	ctx.ui.notify(`/${command.name}: ${meta.shortName} reviewing…`, "info");
	try {
		const handle = subagents.spawn(prompt, {
			profile: "general",
			role: kind.id,
			displayName: command.name,
			cwd,
			model: selected.modelId,
			...(selected.effort ? { thinking: selected.effort } : {}),
		});
		const result = await handle.result();
		const report = result.summary?.trim() || result.error || "(no report)";
		ctx.ui.notify(report, result.status === "succeeded" ? "info" : "warning");
	} catch (err) {
		ctx.ui.notify(
			`/${command.name} failed: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}

/**
 * `/verify` — deep-verify started deliverables against their real diffs.
 * Read-only and report-only: fans out one verifier per started deliverable,
 * persists the round, and surfaces the findings; the worker owns what to do.
 * Registered via the persona loop (delivery-verifier kind, target "deliverables").
 */
async function runDeliveryVerification(
	rt: RuntimeContext,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const { pi, maestro } = rt;
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
	// duty:verify-delivery row first (v2 tier via the resolver); v1 verifier
	// role is the fallback so verification never regresses on a bad table.
	let verifier: { modelId: string; effort?: ThinkingLevel } | null =
		await resolveDutyModel(ctx, "verify-delivery");
	if (!verifier) {
		const verifierResolution = await resolveExactModelSelection(ctx, {
			role: "verifier",
			requireApiKey: true,
		});
		verifier = verifierResolution.selected;
		if (!verifier) {
			ctx.ui.notify(
				`Verification unavailable: ${verifierResolution.errors.map((item) => item.message).join("; ")}`,
				"error",
			);
			return;
		}
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
			rt.hud?.refresh();
		},
		onSettled: (view, entry) => {
			rt.researchRuns.delete(view.id);
			sendAgentEvent(pi, {
				kind: "research-done",
				question: view.question,
				research: "verify",
				ok: entry.verdict === "pass",
				durationMs: Date.now() - view.startedAt,
				...(entry.report ? { report: clipReport(entry.report) } : {}),
				...(entry.error ? { error: entry.error } : {}),
			});
			rt.hud?.refresh();
		},
	});
	const problems = entries.some(
		(e) => e.verdict === "fail" || e.verdict === "error",
	);
	// Persist the round on disk (the markdown is the triage surface).
	let reportNote = "";
	try {
		const paths = writeVerificationReport(
			join(plansRoot(), plan.slug),
			entries,
		);
		reportNote = `\nFull report: ${paths.mdPath}`;
	} catch {
		// Report persistence is best-effort — the notify still carries findings.
	}
	// Report-only: surface the findings; the worker owns them, a human decides.
	ctx.ui.notify(
		`${renderVerification(entries)}${reportNote}`,
		problems ? "warning" : "info",
	);
}

export function registerRuntimeCommands(rt: RuntimeContext): void {
	const { pi, maestro } = rt;

	registerPersonaCommands(rt);

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
		},
	});

	for (const mode of ["hack", "auto"] as const) {
		pi.registerCommand(mode, {
			description: `Switch to Maestro ${mode} mode through execution readiness.`,
			handler: async (_args: string, ctx: ExtensionCommandContext) => {
				// Only a human operator changes mode. A spawned agent must not be
				// able to widen its own posture (hack lifts every restriction) — the
				// escalation guard `/distill` and `/handoff` already carry.
				if (isAgentMode()) {
					ctx.ui.notify(
						`/${mode} is operator-only — an agent cannot change mode.`,
						"warning",
					);
					return;
				}
				if (rt.state.mode === "plan") {
					if (await rt.requestMode(mode, ctx))
						await rt.runStart(undefined, ctx);
					return;
				}
				await rt.requestMode(mode, ctx);
			},
		});
	}

	// Recon is command-only on re-entry (never part of the Shift+Tab cycle):
	// the mode's whole point is that leaving it is a deliberate one-way step.
	pi.registerCommand("recon", {
		description: "Switch to Maestro recon mode (read-only research posture).",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await rt.enterRecon(ctx);
		},
	});

	pi.registerCommand("start", {
		description: "Activate ready planned work. /start [deliverable-id]",
		handler: (args, ctx) => rt.runStart(args.trim() || undefined, ctx),
	});

	pi.registerCommand("stop", {
		description: "Intentionally park all active workers behind a bounded stop.",
		handler: (_args, ctx) => rt.runStop(ctx),
	});

	pi.registerCommand("restart", {
		description:
			"Resume a clean stop without starting unrelated planned work. /restart [deliverable-id]",
		handler: (args, ctx) => rt.runRestart(args.trim() || undefined, ctx),
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

	pi.registerCommand("agents", {
		description: "Show active deliverables and agent status.",
		handler: async (_args: string, cmdCtx: ExtensionCommandContext) => {
			// The HUD is the agents surface: expand + focus it on the Agents tab.
			if (rt.hud) {
				rt.hud.show("agents");
				return;
			}
			// No HUD (headless/RPC session): fall back to the text overview.
			if (!rt.engine) {
				cmdCtx.ui.notify("No active plan.", "info");
				return;
			}
			const plan = rt.engine.get();
			if (plan.nodes.length === 0) {
				cmdCtx.ui.notify("No deliverables in plan.", "info");
				return;
			}
			const subagents = maestro.capabilities.get(CAPABILITIES.subagents);
			const targets = listAgentTargets({
				execution: rt.execution,
				subagents,
				watches: rt.watches,
			});
			const runLines = targets
				.filter((target) => target.kind === "run")
				.map((target) => {
					const elapsed = Math.max(
						0,
						(target.completedAt ?? Date.now()) - target.createdAt,
					);
					const age = Math.max(0, Date.now() - target.updatedAt);
					return `${target.id} · ${target.role} · ${target.status} · ${Math.round(elapsed / 1000)}s elapsed · event ${Math.round(age / 1000)}s ago · ${target.model ?? "default model"}`;
				});
			// Watches are runs too: goal (clipped) + status word, cancellable.
			const watchLines = targets
				.filter((target) => target.kind === "watch")
				.map(
					(target) => `${target.id} · ${target.status} · ${target.displayName}`,
				);
			const overview = renderAgentsOverview(plan, rt.execution);
			const sections = [
				overview,
				...(runLines.length
					? [`Inspectable runs:\n${runLines.join("\n")}`]
					: []),
				...(watchLines.length ? [`Watches:\n${watchLines.join("\n")}`] : []),
			];
			cmdCtx.ui.notify(sections.join("\n\n"), "info");
		},
	});

	pi.registerCommand("recover", {
		description:
			"Audit and recover failed, crashed, stale, or inconsistent execution state. /recover [deliverable-id]",
		handler: (args: string, ctx: ExtensionCommandContext) =>
			rt.runRecover(args.trim() || undefined, ctx),
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

	pi.registerCommand("debug", {
		description:
			"Diagnose this session and choose one explicit recovery action.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (isAgentMode()) await runWorkerDebugCommand(rt, args, ctx);
			else await runDebugCommand(rt, args, ctx);
		},
	});

	pi.registerCommand("view", {
		description:
			"Open a live read-only view of an agent's work. /view <opaque-id> or /view for dialog.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const subagents = maestro.capabilities.get(CAPABILITIES.subagents);
			await handleViewCommand(args, ctx, rt.execution, rt.viewState, subagents);
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
				ctx.ui.notify("No agents active.", "info");
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

	pi.registerCommand("kill", {
		description:
			"Bounded-shutdown and fail an owning delivery. /kill <deliverable-id>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const id = args.trim();
			// Node ids are plan-unique, so /kill reaches any depth — the agent
			// key IS the node id (no `${id}/worker` compound key).
			const delivery =
				id && rt.engine ? findNodeV2(rt.engine.get(), id) : undefined;
			if (!id || !delivery) {
				ctx.ui.notify(
					id ? `Unknown deliverable: ${id}` : "Usage: /kill <deliverable-id>",
					"warning",
				);
				return;
			}
			if (delivery.status !== "active" || !rt.execution?.forceFailWorker) {
				ctx.ui.notify(`${id} is not an active delivery.`, "warning");
				return;
			}
			const yes = await ctx.ui.confirm(
				"Fail delivery",
				`Bounded-shutdown ${id} and mark it failed?`,
			);
			if (!yes) return;
			if (!(await rt.execution.forceFailWorker(id, "user ran /kill"))) {
				ctx.ui.notify(
					`Could not prove ${id} stopped; it was not marked failed.`,
					"warning",
				);
				return;
			}
			rt.engine?.setNodeStatus(id, "failed", {
				code: "user-killed",
				message: "Delivery was failed by the user after bounded shutdown",
				failedAt: rt.now(),
				recoverable: true,
				attempt: (delivery.failure?.attempt ?? 0) + 1,
				agentId: id,
			});
			rt.emitPlanChanged();
			rt.hud?.refresh();
			ctx.ui.notify(
				`${id} failed and parked. Use /recover ${id} after inspection.`,
				"warning",
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
				maestroStage: Type.Optional(
					Type.String({
						description:
							"Optional compact workflow boundary id (for example implementation or verification). Adds a Maestro-Stage trailer; omit for ordinary incremental commits.",
					}),
				),
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
					...(params.maestroStage ? { maestroStage: params.maestroStage } : {}),
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

	pi.registerTool(createDeleteTool());

	pi.registerCommand("modes-status", {
		description: "Show Maestro mode and active plan status.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const plan = rt.engine?.get();
			ctx.ui.notify(
				`mode=${rt.state.mode} plan=${plan?.slug ?? "none"} deliverables=${
					plan?.nodes.length ?? 0
				}`,
				"info",
			);
		},
	});

	pi.registerCommand("models", {
		description:
			"Show how each maestro agent type resolves to a model (v2 routing). " +
			"`/models <agent>` details one agent's tier candidates and why each was picked or skipped.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const agentArg = args.trim();
			let config: ReturnType<typeof readV2Config> | undefined;
			try {
				config = readV2Config(ctx.cwd);
			} catch (error) {
				ctx.ui.notify(
					`Model config did not parse: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
				return;
			}

			// `/models <agent>`: the candidate walk for one agent type's tiers.
			if (agentArg) {
				if (!(SPAWNABLE_AGENT_TYPES as readonly string[]).includes(agentArg)) {
					ctx.ui.notify(
						`Unknown agent "${agentArg}". Agents: ${SPAWNABLE_AGENT_TYPES.join(", ")}`,
						"warning",
					);
					return;
				}
				const agent = agentArg as SpawnableAgentType;
				const tiers = config?.allowances[agent]?.tiers ?? [];
				if (tiers.length === 0) {
					// No tier allowance → inherits the session model (e.g. worker).
					try {
						const res = await resolveV2Model(ctx, { agent });
						ctx.ui.notify(
							`${agent} — no tier allowance → inherits the session model: ${res.modelId}${res.effort ? ` @${res.effort}` : ""} [${res.source}]`,
							"info",
						);
					} catch (error) {
						ctx.ui.notify(
							`${agent} — inherit failed: ${error instanceof Error ? error.message : String(error)}`,
							"warning",
						);
					}
					return;
				}
				const defaultTier = tiers[0];
				const lines = [
					`${agent} — allowed tiers: ${tiers.join(", ")} (default: ${defaultTier})`,
				];
				for (const tier of tiers) {
					const ex = await explainTier(ctx, agent, tier);
					lines.push(
						`  tier ${tier}${tier === defaultTier ? " (default)" : ""} — binding ${ex.bindingId ?? "none"} / roster ${ex.rosterId ?? "none"}:`,
					);
					// The resolver takes the first AVAILABLE ref; mark it in the default tier.
					let picked = false;
					for (const candidate of ex.candidates) {
						const isPick =
							tier === defaultTier && !picked && candidate.available;
						if (isPick) picked = true;
						const mark = isPick ? "▶" : candidate.available ? "·" : "✗";
						const model = candidate.model ?? "(no attachment)";
						const why = candidate.available
							? ""
							: ` — ${candidate.reason ?? "unavailable"}`;
						lines.push(
							`    ${mark} ${candidate.ref}: ${model}${candidate.effort ? ` @${candidate.effort}` : ""}${why}`,
						);
					}
					if (ex.candidates.length === 0) lines.push("    (roster tier empty)");
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			// Table: what each spawnable agent type resolves to right now. Workers
			// with no tier inherit the session model; the rest resolve through the
			// active binding→roster→tier. Source is inherit | tier | fallback.
			const resolutions = await Promise.all(
				SPAWNABLE_AGENT_TYPES.map(async (agent) => {
					const tier = defaultTierForAgent(ctx, agent);
					try {
						const res = await resolveV2Model(ctx, {
							agent,
							...(tier ? { tier } : {}),
						});
						return { agent, tier, res };
					} catch (error) {
						return {
							agent,
							tier,
							err: error instanceof Error ? error.message : String(error),
						};
					}
				}),
			);
			const roster = resolutions.find((r) => r.res?.rosterId)?.res;
			const region = config?.region?.active;
			const width = Math.max(...SPAWNABLE_AGENT_TYPES.map((a) => a.length));
			const rows = resolutions.map(({ agent, tier, res, err }) =>
				res
					? `  ${agent.padEnd(width)} → ${res.modelId}${res.effort ? ` @${res.effort}` : ""} [${res.source}]${tier ? ` (tier ${tier})` : " (inherit)"}`
					: `  ${agent.padEnd(width)} → (unresolved: ${err})`,
			);
			ctx.ui.notify(
				[
					`Model routing (v2)${roster ? ` — binding ${roster.bindingId} / roster ${roster.rosterId}` : ""}${region ? ` · region ${region}` : ""}  (\`/models <agent>\` for candidate detail)`,
					...rows,
				].join("\n"),
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
