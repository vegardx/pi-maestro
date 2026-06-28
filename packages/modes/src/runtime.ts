import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
	CAPABILITIES,
	type DeliverableId,
	EVENTS,
	type ModeName,
	type ModesExecutionStatus,
	type PlanId,
} from "@vegardx/pi-contracts";
import type { MaestroContext } from "@vegardx/pi-core";
import {
	addWorktree,
	checkoutOrCreateBranch,
	detectDefaultBranch,
	gitToplevel,
	removeWorktree,
} from "@vegardx/pi-git";
import { ModesAskQueue } from "./ask-queue.js";
import {
	calibrateSys,
	calibrationKey,
	computeBuckets,
	estimateTokens,
	formatBudget,
} from "./budget.js";
import {
	buildCarryForwardSummary,
	buildCompactionMarker,
	buildDeliverableSliceCompactionResult,
	collectDependencySummaries,
	createCrashSnapshot,
	decideCompactionOwnership,
	type PendingModesCompaction,
	readModesCompactionDetails,
} from "./compaction.js";
import { PLAN_CONTAINER, PlanEngine } from "./engine.js";
import { FanoutOrchestrator, startSequentialExecution } from "./execution.js";
import { renderPlanMarkdown } from "./markdown.js";
import {
	classifyBash,
	computeActiveTools,
	toolBlockedInPlanMode,
} from "./policy.js";
import {
	type Deliverable,
	deliverables,
	gatingTasks,
	planRepoMismatch,
	repoNameFromPath,
	slugify,
} from "./schema.js";
import {
	appendModesState,
	collectBudgetText,
	EXECUTION_SEED_ENTRY,
	hasExecutionSeed,
	hydrateModesState,
	resolveShipSummaryInput,
} from "./session.js";
import { readModesCompactionSettings } from "./settings.js";
import {
	nextShippableDeliverable,
	parkPlan,
	shipDeliverableFromPlan,
	syncPrState,
} from "./shipping.js";
import {
	type ExecutionState,
	initialModesState,
	type ModesState,
	nextMode,
	setActivePlan,
	setExecution,
	transitionMode,
} from "./state.js";
import { createPlanStore, type PlanStore, plansRoot } from "./storage.js";
import { createModesSummariser } from "./summarise.js";
import { createPlanTools } from "./tools.js";
import {
	awaitCompaction,
	diagnoseResumeAfterCompaction,
	shouldCompactMidDeliverable,
} from "./trigger.js";
import { renderModeFooter, renderPlanPanel } from "./ui.js";
import {
	activateDeliverableBranch,
	activateDeliverableWorktree,
	cleanupInactiveWorktrees,
	recordDeliverableSession,
	recordPlanSession,
} from "./worktree.js";

export interface ModesRuntimeOptions {
	readonly store?: PlanStore;
	readonly now?: () => string;
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
	const store = opts.store ?? createPlanStore(plansRoot());
	const now = opts.now ?? (() => new Date().toISOString());
	const askQueue = new ModesAskQueue();
	const worktreeDeps = { addWorktree, removeWorktree };
	const branchDeps = {
		checkoutOrCreateBranch: (
			repoPath: string,
			branch: string,
			baseBranch: string,
		): { ok: true } | { ok: false; error: string } => {
			const r = checkoutOrCreateBranch(repoPath, branch, baseBranch);
			return r.ok
				? { ok: true }
				: {
						ok: false,
						error: r.stderr.trim() || `failed to checkout ${branch}`,
					};
		},
	};
	let state: ModesState = initialModesState(now);
	let engine: PlanEngine | undefined;
	let fanout: FanoutOrchestrator | undefined;
	let baselineTools: string[] | undefined;
	// Transient (not persisted): a modes-owned compaction is in flight.
	let compactionInFlight = false;
	// Transient (not persisted): what modes is about to compact. Set just
	// before `ctx.compact({ customInstructions: marker })`; the
	// `session_before_compact` handler matches the incoming marker against this
	// nonce to claim ownership. The trigger that populates it lands in a later
	// deliverable; for now it stays undefined and every compaction is generic.
	let pendingCompaction: PendingModesCompaction | undefined;
	// Transient: after a timed-out/aborted compaction pi may still be summarising
	// in the background; hold off re-triggering until this deadline passes.
	let compactionCooldownUntil = 0;
	// Transient: soft summary-budget warning fires at most once per session.
	let summaryBudgetWarnFired = false;
	// Transient: per-session guard for the seed dependency-summary budget warning.
	let seedSummaryBudgetWarnFired = false;
	// Cached system-prompt+tools token estimate, invalidated when the
	// calibration key (mode/toolset/system-prompt length) changes.
	let calibration: { sig: string; sys: number } | undefined;
	const listeners = new Set<(mode: ModeName, previous: ModeName) => void>();

	function currentMode(): ModeName {
		return state.mode;
	}

	function currentEngine(): PlanEngine | undefined {
		return engine;
	}

	function persist(): void {
		appendModesState(pi, state);
	}

	function notifyMode(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			"maestro.mode",
			renderModeFooter({
				mode: state.mode,
				planSlug: state.activePlanSlug,
				budget: budgetFooter(ctx),
				contextPercent: ctx.getContextUsage?.()?.percent,
			}),
		);
		if (engine)
			ctx.ui.setWidget?.("maestro.plan", renderPlanPanel(engine.get(), 18));
	}

	// Best-effort context-budget breakdown. Deterministic given its inputs and
	// defensive: when total usage is unknown (e.g. right after compaction)
	// `hotTail` is 0 and a prior calibrated `sys` is reused. Returns undefined
	// outside ask/auto execution. Shared by the footer and the trigger so both
	// read the SAME bucket math.
	function budgetSnapshot(ctx: ExtensionContext):
		| {
				buckets: ReturnType<typeof computeBuckets>;
				settings: ReturnType<typeof readModesCompactionSettings>;
		  }
		| undefined {
		if (state.mode !== "ask" && state.mode !== "auto") return undefined;
		const entries = ctx.sessionManager?.getEntries?.() ?? [];
		const text = collectBudgetText(entries);
		const seed = estimateTokens(text.seed);
		const rollingSummary = estimateTokens(text.rollingSummary);
		const total = ctx.getContextUsage?.()?.tokens ?? null;
		const systemPrompt = ctx.getSystemPrompt?.() ?? "";
		const sig = calibrationKey({
			mode: state.mode,
			toolSignature: pi.getActiveTools().join(","),
			systemPromptLength: systemPrompt.length,
		});
		if (calibration && calibration.sig !== sig) calibration = undefined;
		let sys: number;
		if (total !== null) {
			sys = calibrateSys({
				total,
				seed,
				rollingSummary,
				hotTailEstimate: estimateTokens(text.hotTail),
			});
			calibration = { sig, sys };
		} else {
			sys = calibration?.sys ?? estimateTokens(systemPrompt);
		}
		const buckets = computeBuckets({ total, sys, seed, rollingSummary });
		const settings = readModesCompactionSettings(ctx.cwd);
		return { buckets, settings };
	}

	function budgetFooter(ctx: ExtensionContext): string | undefined {
		const snapshot = budgetSnapshot(ctx);
		if (!snapshot) return undefined;
		return formatBudget(
			snapshot.buckets,
			snapshot.settings.workingTokens + snapshot.settings.summaryTokens,
		);
	}

	function applyTools(): void {
		const active = pi.getActiveTools();
		if (!baselineTools || state.mode === "hack") {
			baselineTools = active.filter(
				(name) => !["deliverable", "task", "plan"].includes(name),
			);
		}
		pi.setActiveTools(
			computeActiveTools({
				mode: state.mode,
				availableTools: pi.getAllTools().map((t) => t.name),
				baselineTools,
			}),
		);
	}

	function emitMode(previous: ModeName): void {
		maestro.events.emit(EVENTS.modeChanged, { mode: state.mode, previous });
		for (const listener of listeners) listener(state.mode, previous);
	}

	function setMode(mode: ModeName, ctx?: ExtensionContext): void {
		const changed = transitionMode(state, mode, now);
		state = changed.state;
		persist();
		applyTools();
		if (ctx) {
			notifyMode(ctx);
			ctx.ui.notify(`Maestro ${mode} mode`, "info");
		}
		emitMode(changed.previous);
	}

	function setExecutionStage(
		execution: ExecutionState,
		ctx?: ExtensionContext,
	): void {
		state = setExecution(state, execution, now);
		persist();
		if (ctx) notifyMode(ctx);
	}

	function loadEngine(slug: string): PlanEngine | undefined {
		const plan = store.load(slug);
		if (!plan) return undefined;
		return new PlanEngine(plan, store, now);
	}

	function openPlan(
		titleOrSlug: string | undefined,
		ctx: ExtensionContext,
	): PlanEngine {
		const title = titleOrSlug?.trim() || repoNameFromPath(ctx.cwd);
		const slug = slugify(title) || "plan";
		engine = store.exists(slug)
			? loadEngine(slug)
			: PlanEngine.create(store, { slug, title, repoPath: ctx.cwd }, now);
		if (!engine) throw new Error(`plan ${slug} not found on disk`);
		state = setActivePlan(state, slug, now);
		const sessionPath = ctx.sessionManager.getSessionFile();
		if (sessionPath) recordPlanSession(engine, sessionPath);
		persist();
		maestro.events.emit(EVENTS.planUpdated, { planId: slug as PlanId });
		ctx.ui.setStatus("maestro.plan", `plan: ${slug}`);
		return engine;
	}

	async function planToAsk(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || !engine) {
			setMode("ask", ctx);
			return;
		}
		const choice = await ctx.ui.select("Leave plan mode", [
			"Implement (ask)",
			"Implement (auto)",
			"Continue planning",
		]);
		if (choice === "Implement (auto)") setMode("auto", ctx);
		else if (choice === "Implement (ask)") setMode("ask", ctx);
	}

	async function cycle(ctx: ExtensionContext): Promise<void> {
		if (state.mode === "plan") {
			await planToAsk(ctx);
			return;
		}
		setMode(nextMode(state.mode), ctx);
	}

	function emitPlanChanged(): void {
		if (!engine) return;
		cleanupInactiveWorktrees(engine, worktreeDeps);
		maestro.events.emit(EVENTS.planUpdated, {
			planId: engine.get().slug as PlanId,
		});
	}

	function prepareWorktree(
		deliverableId: string,
		ctx: ExtensionContext,
	): string | undefined {
		if (!engine) return undefined;
		const defaultBranch = detectDefaultBranch(engine.get().repoPath) ?? "main";
		const prepared = activateDeliverableWorktree(
			engine,
			deliverableId,
			defaultBranch,
			worktreeDeps,
		);
		if (prepared.kind === "error") {
			ctx.ui.notify(prepared.error, "warning");
			return undefined;
		}
		const sessionPath = ctx.sessionManager.getSessionFile();
		if (sessionPath)
			recordDeliverableSession(engine, deliverableId, sessionPath);
		return prepared.path;
	}

	// Sequential execution stays in the session's cwd; check out the deliverable
	// branch in plan.repoPath instead of spinning up an unused worktree.
	function prepareSequentialBranch(
		deliverableId: string,
		ctx: ExtensionContext,
	): void {
		if (!engine) return;
		const defaultBranch = detectDefaultBranch(engine.get().repoPath) ?? "main";
		const prepared = activateDeliverableBranch(
			engine,
			deliverableId,
			defaultBranch,
			branchDeps,
		);
		if (prepared.kind === "error") {
			ctx.ui.notify(prepared.error, "warning");
			return;
		}
		const sessionPath = ctx.sessionManager.getSessionFile();
		if (sessionPath)
			recordDeliverableSession(engine, deliverableId, sessionPath);
	}

	// Refuse to act when the session cwd doesn't resolve to the plan's repo —
	// otherwise commit/sync/park would silently hit the wrong tree. Returns true
	// when it's safe to proceed (and when there's no plan to guard).
	function assertPlanRepo(ctx: ExtensionContext): boolean {
		if (!engine) return true;
		const repoPath = engine.get().repoPath;
		const problem = planRepoMismatch(
			gitToplevel(repoPath),
			gitToplevel(ctx.cwd),
			repoPath,
			ctx.cwd,
		);
		if (problem) {
			ctx.ui.notify(problem, "warning");
			return false;
		}
		return true;
	}

	for (const tool of createPlanTools({
		engine: () => engine,
		onPlanChanged: emitPlanChanged,
	})) {
		pi.registerTool(tool);
	}

	pi.registerCommand("plan", {
		description: "Open or create a Maestro plan for this repo.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const opened = openPlan(args, ctx);
			setMode("plan", ctx);
			ctx.ui.notify(`Plan ${opened.get().slug} active.`, "info");
			pi.sendMessage(
				{
					customType: "maestro.plan.document",
					content: renderPlanMarkdown(opened.get()),
					display: true,
				},
				{ triggerTurn: false },
			);
		},
	});

	for (const mode of ["hack", "ask", "auto"] as const) {
		pi.registerCommand(mode, {
			description: `Switch to Maestro ${mode} mode.`,
			handler: async (_args: string, ctx: ExtensionCommandContext) => {
				setMode(mode, ctx);
			},
		});
	}

	pi.registerCommand("implement", {
		description: "Start executing the active plan. Pass --fanout for workers.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!engine) openPlan(undefined, ctx);
			if (!engine) return;
			if (!assertPlanRepo(ctx)) return;
			const activeEngine = engine;
			setMode(args.includes("--ask") ? "ask" : "auto", ctx);
			if (args.includes("--fanout")) {
				const subagents = maestro.capabilities.get(CAPABILITIES.subagents);
				if (subagents) {
					fanout = new FanoutOrchestrator({
						engine,
						subagents,
						cwd: ctx.cwd,
						prepareDeliverable: (deliverable) => ({
							cwd: prepareWorktree(deliverable.id, ctx),
						}),
						onPlanChanged: emitPlanChanged,
						onSpawn: (deliverable, handle) =>
							ctx.ui.notify(
								`Spawned ${deliverable.id} as ${handle.id}.`,
								"info",
							),
						onProgress: (deliverable, progress) =>
							ctx.ui.setStatus(
								"maestro.execution",
								`${deliverable.id}: ${progress.text ?? "running"}`,
							),
					});
					const spawned = fanout.tick();
					ctx.ui.notify(`Fanout spawned ${spawned} worker(s).`, "info");
					return;
				}
				ctx.ui.notify(
					"subagents.v1 unavailable; falling back to sequential.",
					"warning",
				);
			}
			const result = startSequentialExecution(engine, {
				onPlanChanged: emitPlanChanged,
				sendSeed: (seed, deliverable) => {
					// Byte-stable single entry per deliverable: never re-emit on
					// resume/switch so the cache prefix stays intact.
					if (hasExecutionSeed(ctx.sessionManager.getEntries(), deliverable.id))
						return;
					// Surface (once) when the dependency summaries carried into this
					// seed outgrow the summary budget; never silently drop them.
					if (!seedSummaryBudgetWarnFired) {
						const depText = collectDependencySummaries(
							activeEngine.get(),
							deliverable.id,
						)
							.map((d) => d.summary)
							.join("\n");
						const depTokens = estimateTokens(depText);
						const { summaryTokens } = readModesCompactionSettings(ctx.cwd);
						if (depTokens > summaryTokens) {
							seedSummaryBudgetWarnFired = true;
							ctx.ui.notify(
								`Maestro dependency carry-forward summaries for ${deliverable.id} (${depTokens} tokens) exceed compaction.summaryTokens (${summaryTokens}).`,
								"warning",
							);
						}
					}
					pi.sendMessage(
						{
							customType: EXECUTION_SEED_ENTRY,
							content: seed,
							display: true,
							details: { deliverableId: deliverable.id },
						},
						{ triggerTurn: false },
					);
				},
			});
			const message =
				result.kind === "started"
					? `Started ${result.deliverable.id}.`
					: result.kind === "already-active"
						? `${result.deliverable.id} is already active.`
						: result.reason;
			if (result.kind === "started") {
				prepareSequentialBranch(result.deliverable.id, ctx);
				setExecutionStage(
					{ stage: "executing", deliverableId: result.deliverable.id },
					ctx,
				);
			}
			ctx.ui.notify(message, result.kind === "blocked" ? "warning" : "info");
		},
	});

	pi.registerCommand("ship", {
		description: "Ship the next shippable deliverable via commit.v1.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!engine) {
				ctx.ui.notify("No active plan.", "warning");
				return;
			}
			if (!assertPlanRepo(ctx)) return;
			const activeEngine = engine;
			const commit = maestro.capabilities.get(CAPABILITIES.commit);
			if (!commit) {
				ctx.ui.notify("commit.v1 unavailable.", "warning");
				return;
			}
			const id = args.trim() || nextShippableDeliverable(engine.get())?.id;
			if (!id) {
				ctx.ui.notify("No shippable deliverable.", "warning");
				return;
			}
			const shipped = await shipDeliverableFromPlan(engine, id, {
				commit,
				confirm: ({ message }) => ctx.ui.confirm("Ship deliverable", message),
				summarise: (deliverable) =>
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
			emitPlanChanged();
			if (state.execution.deliverableId === shipped.deliverable.id)
				setExecutionStage({ stage: "idle" }, ctx);
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
			if (!engine) {
				ctx.ui.notify("No active plan.", "warning");
				return;
			}
			if (!assertPlanRepo(ctx)) return;
			const repoPath = engine.get().repoPath;
			const result = await syncPrState(engine, {
				state: async (prNumber) => prStateViaGh(pi, repoPath, prNumber),
			});
			emitPlanChanged();
			ctx.ui.notify(
				`Sync complete: shipped=${result.shipped.length} closed=${result.closed.length}.`,
				"info",
			);
		},
	});

	pi.registerCommand("park", {
		description: "Create GitHub tracking issues for the active plan.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!engine) {
				ctx.ui.notify("No active plan.", "warning");
				return;
			}
			const repoPath = engine.get().repoPath;
			const result = await parkPlan(engine, {
				createIssue: (input) => createIssueViaGh(pi, repoPath, input),
			});
			emitPlanChanged();
			ctx.ui.notify(
				`Parked plan as issue #${result.parent} (${result.children.length} deliverable issues).`,
				"info",
			);
		},
	});

	pi.registerCommand("modes-status", {
		description: "Show Maestro mode and active plan status.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const plan = engine?.get();
			ctx.ui.notify(
				`mode=${state.mode} plan=${plan?.slug ?? "none"} loose=${
					plan?.nodes.filter((n) => n.type === "work-item").length ?? 0
				}`,
				"info",
			);
		},
	});

	pi.registerShortcut("shift+tab", {
		description: "Cycle Maestro mode: hack → plan → ask → auto.",
		handler: cycle,
	});

	pi.on("session_start", (_event, ctx) => {
		const hydrated = hydrateModesState(ctx.sessionManager.getEntries());
		if (hydrated) state = hydrated;
		compactionInFlight = false;
		pendingCompaction = undefined;
		compactionCooldownUntil = 0;
		summaryBudgetWarnFired = false;
		seedSummaryBudgetWarnFired = false;
		calibration = undefined;
		if (state.activePlanSlug) engine = loadEngine(state.activePlanSlug);
		applyTools();
		notifyMode(ctx);
		if (state.activePlanSlug) {
			ctx.ui.setStatus("maestro.plan", `plan: ${state.activePlanSlug}`);
		}
	});

	pi.on("tool_call", (event: ToolCallEvent) => {
		if (state.mode !== "plan") return;
		if (event.toolName === "ask") return;
		if (event.toolName === "bash") {
			const command =
				typeof event.input.command === "string" ? event.input.command : "";
			const classified = classifyBash(command);
			if (!classified.readOnly)
				return { block: true, reason: classified.reason };
			return;
		}
		const reason = toolBlockedInPlanMode(event.toolName);
		if (reason) return { block: true, reason };
	});

	maestro.events.on(EVENTS.runProgress, ({ runId, progress }) => {
		fanout?.progress(runId, progress);
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (state.mode === "plan") {
			askQueue.flushTo(maestro.capabilities.get(CAPABILITIES.ask));
			return;
		}
		if (state.mode !== "ask" && state.mode !== "auto") return;

		const snapshot = budgetSnapshot(ctx);
		if (!snapshot || !engine) return;
		const { buckets, settings } = snapshot;

		// Soft warn (once per session) when the stable summary burden
		// (seed + rollingSummary) outgrows its budget. Not enforced — dropping
		// older summaries would lose the carry-forward signal that motivates them.
		if (
			!summaryBudgetWarnFired &&
			buckets.summaryUsed > settings.summaryTokens
		) {
			summaryBudgetWarnFired = true;
			ctx.ui.notify(
				`Maestro carry-forward summaries (${buckets.summaryUsed} tokens) exceed compaction.summaryTokens (${settings.summaryTokens}); consider lowering compaction.phaseTokens`,
				"warning",
			);
		}

		const active = activeDeliverable(engine.get());
		const fire = shouldCompactMidDeliverable({
			mode: state.mode,
			compactionInFlight,
			hasActiveDeliverable: !!active,
			// Never trigger on stale data: when total is unknown `workingUsed`
			// collapses to `sys`, so gate it out explicitly.
			workingUsed: buckets.total === null ? null : buckets.workingUsed,
			workingTokens: settings.workingTokens,
		});
		if (!fire || !active) return;
		// A timed-out/aborted compaction may still be running in pi; don't stack a
		// second until the orphan should have settled.
		if (Date.now() < compactionCooldownUntil) return;

		const nonce = randomUUID();
		const stageAtEntry = state.execution.stage;
		const modeAtEntry = state.mode;
		const deliverableAtEntry = active.id;
		pendingCompaction = {
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
		compactionInFlight = true;

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
				compactionCooldownUntil = Date.now() + settings.timeoutMs;
			}
		} finally {
			compactionInFlight = false;
			pendingCompaction = undefined;
		}

		// Resume the auto loop exactly once when the gates still hold. The nonce
		// already guarantees exact-once ownership of THIS compaction; the gates
		// guard against mid-flight drift (Shift+Tab, deliverable switch, finish).
		const current = activeDeliverable(engine.get());
		const remaining = current
			? gatingTasks(current).filter((t) => !t.done).length
			: 0;
		const decision = diagnoseResumeAfterCompaction({
			compacted,
			stageAtEntry,
			modeAtEntry,
			deliverableAtEntry,
			currentStage: state.execution.stage,
			currentMode: state.mode,
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
		const decision = decideCompactionOwnership(
			event.customInstructions,
			pendingCompaction,
		);
		// No modes marker → generic smart-compact or pi default owns it. Returning
		// undefined leaves the result slot untouched so an earlier handler wins.
		if (decision.kind === "decline") return undefined;

		// Marker present but no matching pending claim → never let the marker text
		// fall through into pi's default "Additional focus" prompt.
		if (decision.kind === "leak-guard" || !engine) {
			pendingCompaction = undefined;
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
				plan: engine.get(),
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
			pendingCompaction = undefined;
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
		if (!event.isError || !engine) return;
		const snapshot = createCrashSnapshot(
			{
				error: event.result,
				mode: state.mode,
				plan: engine.get(),
				activeDeliverableId: activeDeliverable(engine.get())?.id,
				cwd: ctx.cwd,
			},
			now,
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

	maestro.capabilities.register(CAPABILITIES.modes, {
		current: currentMode,
		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		execution: (): ModesExecutionStatus => ({
			mode: state.mode,
			activePlanSlug: state.activePlanSlug,
			activeDeliverableId:
				state.execution.deliverableId ??
				(engine ? activeDeliverable(engine.get())?.id : undefined),
			executing: state.execution.stage === "executing",
			compactionInFlight,
		}),
	});

	return { askQueue, currentMode, currentEngine, setMode, openPlan, cycle };
}

function activeDeliverable(plan: {
	nodes: Parameters<typeof deliverables>[0]["nodes"];
}) {
	return deliverables(plan).find((d) => d.status === "active");
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
	const entries = ctx.sessionManager.getEntries();
	const resolved = resolveShipSummaryInput(
		entries,
		deliverable,
		ctx.sessionManager.getSessionFile?.(),
	);
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

export { PLAN_CONTAINER };
