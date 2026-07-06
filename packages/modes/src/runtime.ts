import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	CAPABILITIES,
	type DeliverableId,
	EVENTS,
	type ModeName,
	type ModesExecutionStatus,
	type PlanId,
	type TokenSnapshot,
} from "@vegardx/pi-contracts";
import type { MaestroContext } from "@vegardx/pi-core";
import {
	addWorktree,
	checkoutOrCreateBranch,
	detectDefaultBranch,
	gitToplevel,
	removeWorktree,
} from "@vegardx/pi-git";
import { isTmuxAvailable } from "@vegardx/pi-tmux";
import {
	type AgentBridge,
	initAgentBridge,
	isAgentMode,
} from "./agent-bridge.js";
import { runAgentsDashboard } from "./agents-dashboard.js";
import { ModesAskQueue } from "./ask-queue.js";
import { classifyBashFast, classifyBashIntent } from "./bash-classifier.js";
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
	createCrashSnapshot,
	decideCompactionOwnership,
	type PendingModesCompaction,
	readModesCompactionDetails,
} from "./compaction.js";
import { PLAN_CONTAINER, PlanEngine } from "./engine.js";
import { TmuxFanout } from "./execution-tmux.js";
import { installFooter } from "./install-footer.js";
import { renderPlanSummary } from "./markdown.js";
import {
	handleSteerCommand,
	handleViewCommand,
	type ViewState,
} from "./orchestrator-tmux.js";
import { OverlayManager } from "./overlay-manager.js";
import { computeActiveTools, toolBlockedInPlanMode } from "./policy.js";
import { formatRecap } from "./recap.js";
import {
	type Deliverable,
	deliverables,
	derivePlanName,
	findDeliverable,
	gatingTasks,
	planRepoMismatch,
	repoFor,
	repoNameFromPath,
	slugify,
} from "./schema.js";
import {
	appendModesState,
	collectBudgetText,
	hydrateModesState,
	resolveShipSummaryInput,
} from "./session.js";
import {
	getModeRoleModel,
	type ImplementOverrides,
	MAESTRO_ENV,
	readModesCompactionSettings,
	setImplementOverrides,
} from "./settings.js";
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
import { renderModeFooter } from "./ui.js";
import {
	accumulate,
	incrementTurns,
	type UsageDelta,
	UsageLedger,
} from "./usage-ledger.js";
import { WorkerPanes } from "./worker-panes.js";
import { cleanupInactiveWorktrees, recordPlanSession } from "./worktree.js";

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
	const _branchDeps = {
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
	const overlayManager = new OverlayManager();
	let engine: PlanEngine | undefined;

	// While a draft plan is open: the entry count at /plan time (to locate the
	// first planning message) and an explicit name from `/plan <name>`.
	let draftStartEntries = 0;
	let draftExplicitName: string | undefined;
	let _orchestratorCtx: ExtensionContext | undefined;
	let invalidateFooter: (() => void) | undefined;
	let agentBridge: AgentBridge | undefined;
	let tmuxFanout: TmuxFanout | undefined;
	let agentSeedContent: string | undefined;
	// Central usage ledger (usage.v1). Records maestro + agent usage.
	const usageLedger = new UsageLedger();
	let orchestratorUsage: TokenSnapshot | undefined;
	const recordOrchestratorUsage = (usage: unknown): void => {
		orchestratorUsage = accumulate(orchestratorUsage, usage as UsageDelta);
		usageLedger.record({ kind: "orchestrator" }, orchestratorUsage);
		invalidateFooter?.();
	};
	const incrementOrchestratorTurn = (): void => {
		if (orchestratorUsage) {
			orchestratorUsage = incrementTurns(orchestratorUsage);
			usageLedger.record({ kind: "orchestrator" }, orchestratorUsage);
		}
	};
	const viewState: ViewState = { viewPaneId: undefined };
	const workerPanes = new WorkerPanes();

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
	let _seedSummaryBudgetWarnFired = false;
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
		if (invalidateFooter) {
			invalidateFooter();
		} else {
			// Fallback before footer is installed (e.g. early session_start)
			ctx.ui.setStatus(
				"maestro.mode",
				renderModeFooter({
					mode: state.mode,
					planSlug: state.activePlanSlug,
					budget: budgetFooter(ctx),
					contextPercent: ctx.getContextUsage?.()?.percent,
				}),
			);
		}
		if (engine) ctx.ui.setWidget?.("maestro.plan", undefined);
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
		if (state.mode !== "auto") return undefined;
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
		// Entering plan mode without an active plan auto-opens a draft so the
		// planning tools work immediately — no need for an explicit /plan first.
		if (mode === "plan" && !engine && ctx) {
			openPlan(undefined, ctx);
		}
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
		const explicit = titleOrSlug?.trim() || undefined;
		const slug = explicit ? slugify(explicit) || "plan" : undefined;
		// No explicit name and there's already an active plan -> keep it.
		if (!slug && engine) return engine;
		// Reopen an existing named plan.
		if (slug && store.exists(slug)) {
			engine = loadEngine(slug);
			if (!engine) throw new Error(`plan ${slug} not found on disk`);
			state = setActivePlan(state, slug, now);
			const sessionPath = ctx.sessionManager.getSessionFile();
			if (sessionPath) recordPlanSession(engine, sessionPath);
			persist();
			maestro.events.emit(EVENTS.planUpdated, { planId: slug as PlanId });
			return engine;
		}
		// A new plan starts as an in-memory draft. It's named and persisted lazily
		// on the first turn that adds content (see finalizeDraftPlan), so an
		// exploratory /plan that adds nothing never hits disk.
		engine = PlanEngine.createDraft(
			store,
			{
				slug: "draft",
				title: explicit ?? "Untitled plan",
				repoPath: ctx.cwd,
			},
			now,
		);
		draftExplicitName = explicit;
		draftStartEntries = ctx.sessionManager.getEntries().length;
		const sessionPath = ctx.sessionManager.getSessionFile();
		if (sessionPath) recordPlanSession(engine, sessionPath);
		return engine;
	}

	// Name and persist a draft plan once it has content. Called at turn_end while
	// planning and before implement/ship so the plan survives. No-op otherwise.
	function finalizeDraftPlan(ctx: ExtensionContext): void {
		if (!engine?.isDraft()) return;
		if (engine.get().nodes.length === 0) return;
		const firstMessage = firstUserMessageText(
			ctx.sessionManager.getEntries() as readonly Entryish[],
			draftStartEntries,
		);
		const { slug: base, title } = derivePlanName(
			draftExplicitName ?? firstMessage,
			repoNameFromPath(ctx.cwd),
		);
		let slug = base;
		for (let n = 2; store.exists(slug); n++) slug = `${base}-${n}`;
		engine.materialize(slug, title);
		state = setActivePlan(state, slug, now);
		persist();
		maestro.events.emit(EVENTS.planUpdated, { planId: slug as PlanId });
		ctx.ui.notify(`Plan saved as \`${slug}\`.`, "info");
		draftExplicitName = undefined;
	}

	async function cycle(ctx: ExtensionContext): Promise<void> {
		if (state.mode === "plan") {
			// Prompt which mode to enter from plan
			const choice = await ctx.ui.select("Switch to", [
				"auto — fully autonomous",
				"hack — fully autonomous, all tools",
			]);
			if (choice?.startsWith("auto")) {
				await runImplement("", ctx);
			} else if (choice?.startsWith("hack")) {
				setMode("hack", ctx);
			}
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
		// Re-tick: if a new deliverable was added (or deps changed), spawn it.
		tmuxFanout?.tick();
	}

	// Sequential execution stays in the session's cwd; check out the deliverable
	// branch in plan.repoPath instead of spinning up an unused worktree.
	// Refuse to act when the session cwd doesn't resolve to the repo a specific
	// deliverable targets — otherwise sequential implement/ship would silently hit
	// the wrong tree. Returns true when it's safe to proceed (and when there's no
	// plan to guard). Fanout uses per-deliverable worktrees and is not guarded.
	function assertDeliverableRepo(
		ctx: ExtensionContext,
		d: Deliverable,
	): boolean {
		if (!engine) return true;
		const repoPath = repoFor(engine.get(), d).path;
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

	// Resolve the default branch for a deliverable's repo: prefer the registry's
	// cached value (set at register-repo time), fall back to git detection, then
	// "main". This avoids the failure when origin/HEAD isn't configured and the
	// repo's default branch isn't main/master (e.g. sandbox repos use `dev`).
	function _defaultBranchFor(d: Deliverable | null | undefined): string {
		if (!engine) return "main";
		const plan = engine.get();
		const repo = d ? repoFor(plan, d) : undefined;
		const fromRegistry = repo?.defaultBranch;
		const result =
			(fromRegistry || detectDefaultBranch(repo?.path ?? plan.repoPath)) ??
			"main";
		// Guard: DEFAULT_REPO_KEY ("default") is a registry key, never a branch.
		if (result === "default") return "main";
		return result;
	}

	// The deliverable a sequential /implement would execute next: the active one,
	// else the first ready deliverable.
	for (const tool of createPlanTools({
		engine: () => engine,
		onPlanChanged: emitPlanChanged,
		mode: () => state.mode,
		steerAgent: (deliverableId, guidance) => {
			tmuxFanout?.steer(deliverableId, guidance);
		},
		onTaskToggle: (taskId) => {
			agentBridge?.onTaskComplete(taskId);
		},
		seedContent: () => agentSeedContent,
	})) {
		pi.registerTool(tool);
	}

	pi.registerCommand("plan", {
		description: "Open or create a Maestro plan for this repo.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const opened = openPlan(args, ctx);
			setMode("plan", ctx);
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
				setMode(mode, ctx);
			},
		});
	}

	function parseImplementFlags(args: string): ImplementOverrides | undefined {
		const parts = args.split(/\s+/);
		let agentModel: string | undefined;
		let agentThinking: string | undefined;
		let analyzeModel: string | undefined;
		let analyzeThinking: string | undefined;

		for (let i = 0; i < parts.length; i++) {
			const p = parts[i];
			if (p.startsWith("--model=")) {
				agentModel = p.slice("--model=".length);
			} else if (p === "--model" && parts[i + 1]) {
				agentModel = parts[++i];
			} else if (p.startsWith("--thinking=")) {
				agentThinking = p.slice("--thinking=".length);
			} else if (p === "--thinking" && parts[i + 1]) {
				agentThinking = parts[++i];
			} else if (p.startsWith("--analyze-model=")) {
				analyzeModel = p.slice("--analyze-model=".length);
			} else if (p === "--analyze-model" && parts[i + 1]) {
				analyzeModel = parts[++i];
			} else if (p.startsWith("--analyze-thinking=")) {
				analyzeThinking = p.slice("--analyze-thinking=".length);
			} else if (p === "--analyze-thinking" && parts[i + 1]) {
				analyzeThinking = parts[++i];
			}
		}

		const VALID_THINKING = new Set(["off", "minimal", "low", "medium", "high"]);
		const wt =
			agentThinking && VALID_THINKING.has(agentThinking)
				? (agentThinking as ImplementOverrides["agentThinking"])
				: undefined;
		const at =
			analyzeThinking && VALID_THINKING.has(analyzeThinking)
				? (analyzeThinking as ImplementOverrides["analyzeThinking"])
				: undefined;

		if (!agentModel && !wt && !analyzeModel && !at) return undefined;
		return {
			agentModel,
			agentThinking: wt,
			analyzeModel,
			analyzeThinking: at,
		};
	}

	async function runImplement(
		args: string,
		ctx: ExtensionContext,
	): Promise<void> {
		// Parse flags
		const overrides = parseImplementFlags(args);
		setImplementOverrides(overrides);

		if (!engine) openPlan(undefined, ctx);
		if (!engine) return;
		finalizeDraftPlan(ctx);
		const activeEngine = engine;
		const mode = args.includes("--hack") ? "hack" : "auto";
		setMode(mode as ModeName, ctx);

		// Tmux fanout: spawn agents in isolated tmux sessions with RPC.
		if (isTmuxAvailable() && !isAgentMode()) {
			if (!tmuxFanout) {
				_orchestratorCtx = ctx;
				const planDir = join(plansRoot(), activeEngine.get().slug);
				const extRoot = resolve(
					dirname(fileURLToPath(import.meta.url)),
					"../../..",
				);
				tmuxFanout = new TmuxFanout({
					engine: activeEngine,
					extensionPath: extRoot,
					planDir,
					defaultBranch: detectDefaultBranch(ctx.cwd) ?? "main",
					ctx,
					onPlanChanged: emitPlanChanged,
					onAgentStateChanged: (id, state) => {
						usageLedger.record({ kind: "agent", id }, state.tokens);
						invalidateFooter?.();
						if (tmuxFanout) {
							// Only sync worker panes on status transitions
							if (
								workerPanes.isOpen() &&
								workerPanes.shouldSync(id, state.status)
							) {
								workerPanes.sync(tmuxFanout.snapshot().agents).catch(() => {});
							}
						}
					},
					onQuestionsReceived: (_id, count) => {
						ctx.ui.notify(
							`Agent has ${count} question(s) — /answer to respond.`,
							"info",
						);
					},
					onAllSettled: () => {
						if (!tmuxFanout || !engine) return;
						const titles = new Map<string, string>();
						for (const n of engine.get().nodes) {
							if (n.type === "deliverable") titles.set(n.id, n.title);
						}
						const recap = formatRecap(
							tmuxFanout.snapshot().agents,
							usageLedger,
							titles,
						);
						pi.sendMessage(
							{
								customType: "maestro.execution.recap",
								content: recap,
								display: true,
							},
							{ triggerTurn: false },
						);
						invalidateFooter?.();
					},
				});
				await tmuxFanout.start();
			}
			const spawned = await tmuxFanout.tick();
			if (spawned > 0) {
				ctx.ui.notify(`Spawned ${spawned} tmux agent(s).`, "info");
				setExecutionStage(
					{ stage: "executing", deliverableId: "orchestrator" },
					ctx,
				);
			} else {
				ctx.ui.notify("No deliverables ready to start.", "warning");
			}
			return;
		}

		// tmux is required for agent execution
		ctx.ui.notify(
			"tmux is required for /implement. Install tmux and try again.",
			"warning",
		);
	}

	pi.registerCommand("implement", {
		description:
			"Start executing the active plan. Agents auto-spawn when subagents are available.",
		handler: runImplement,
	});

	pi.registerCommand("ship", {
		description: "Ship the next shippable deliverable via commit.v1.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!engine) {
				ctx.ui.notify("No active plan.", "warning");
				return;
			}
			finalizeDraftPlan(ctx);
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
			const target = findDeliverable(engine.get(), id);
			if (target && !assertDeliverableRepo(ctx, target)) return;
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
			// No session-repo guard: sync is gh-only and reconciles each
			// deliverable against its own repo, regardless of the session cwd.
			const result = await syncPrState(engine, {
				state: async (prNumber, repoPath) =>
					prStateViaGh(pi, repoPath, prNumber),
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
			const result = await parkPlan(engine, {
				createIssue: (input, repoPath) => createIssueViaGh(pi, repoPath, input),
			});
			emitPlanChanged();
			ctx.ui.notify(
				`Parked plan as issue #${result.parent} (${result.children.length} deliverable issues).`,
				"info",
			);
		},
	});

	pi.registerCommand("agents", {
		description: "Interactive dashboard of active agents.",
		handler: async (_args: string, cmdCtx: ExtensionCommandContext) => {
			if (!tmuxFanout || !engine) {
				cmdCtx.ui.notify("No agents active.", "info");
				return;
			}
			const queue = tmuxFanout.questionQueue;
			await runAgentsDashboard(
				cmdCtx as any,
				tmuxFanout,
				engine,
				usageLedger,
				queue,
			);
		},
	});

	pi.registerCommand("view", {
		description:
			"View an agent's tmux session in a split pane. /view <name> or /view for dialog.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (tmuxFanout) {
				await handleViewCommand(args, ctx, tmuxFanout, viewState);
			} else {
				ctx.ui.notify("No agents active (tmux required).", "info");
			}
		},
	});

	pi.registerCommand("workers", {
		description:
			"Toggle stacked tmux panes showing all active workers on the right side.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!tmuxFanout) {
				ctx.ui.notify("No agents active (tmux required).", "info");
				return;
			}
			if (workerPanes.isOpen() || workerPanes.isEnabled()) {
				await workerPanes.close();
				ctx.ui.notify("Worker panes closed.", "info");
			} else {
				await workerPanes.open(tmuxFanout.snapshot().agents);
				if (workerPanes.terminalTooSmall()) {
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
			if (tmuxFanout) {
				handleSteerCommand(args, ctx, tmuxFanout);
			} else {
				ctx.ui.notify("No agents active (tmux required).", "info");
			}
		},
	});

	pi.registerCommand("answer", {
		description: "Answer pending agent questions.",
		handler: async (_args: string, cmdCtx: ExtensionCommandContext) => {
			if (!tmuxFanout) {
				cmdCtx.ui.notify("No questions pending.", "info");
				return;
			}
			const pending = tmuxFanout.questionQueue.all();
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
				cmdCtx.ui.notify(`\u2713 Answered ${entry.agentName}`, "info");
			}
		},
	});

	pi.registerCommand("recap", {
		description: "Show summary of completed agent work.",
		handler: async (_args: string, cmdCtx: ExtensionCommandContext) => {
			if (!tmuxFanout || tmuxFanout.snapshot().agents.size === 0) {
				cmdCtx.ui.notify("No agent work to recap.", "info");
				return;
			}
			const titles = new Map<string, string>();
			if (engine) {
				for (const n of engine.get().nodes) {
					if (n.type === "deliverable") titles.set(n.id, n.title);
				}
			}
			const recap = formatRecap(
				tmuxFanout.snapshot().agents,
				usageLedger,
				titles,
			);
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
				if (deliverableId && agentBridge) {
					const planContent = await agentBridge.planRead();
					// Parse task IDs from plan markdown: lines matching "- [ ] ... `taskId`"
					const untoggled: string[] = [];
					for (const line of planContent.split("\n")) {
						const m = line.match(/^- \[ \] .+`([^`]+)`/);
						if (m) untoggled.push(m[1]);
					}
					for (const taskId of untoggled) {
						await agentBridge.planMutate("toggleTask", deliverableId, {
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
		description: "Cycle Maestro mode: hack → plan → auto.",
		handler: cycle,
	});

	pi.on("before_agent_start", (event) => {
		if (state.mode === "plan") {
			const preamble = buildPlanModePreamble(engine);
			return { systemPrompt: `${event.systemPrompt}\n\n${preamble}` };
		}
		if (state.mode === "hack" && tmuxFanout) {
			const preamble = buildHackModePreamble();
			return { systemPrompt: `${event.systemPrompt}\n\n${preamble}` };
		}
		if (tmuxFanout) {
			const preamble = buildOrchestratorPreamble(engine, tmuxFanout);
			return { systemPrompt: `${event.systemPrompt}\n\n${preamble}` };
		}
		if (agentBridge) {
			const preamble = buildAgentWorkerPreamble();
			return { systemPrompt: `${event.systemPrompt}\n\n${preamble}` };
		}
	});

	pi.on("session_start", (_event, ctx) => {
		if (!isAgentMode()) {
		}
		const hydrated = hydrateModesState(ctx.sessionManager.getEntries());
		if (hydrated) state = hydrated;
		// Extract seed content for workers (read-only plan context)
		if (state.mode === "agent") {
			for (const entry of ctx.sessionManager.getEntries()) {
				const e = entry as unknown as Record<string, unknown>;
				if (
					(e.type === "custom" && e.customType === "maestro-execution-seed") ||
					(e.type === "custom_message" &&
						e.customType === "maestro.execution.seed")
				) {
					const data = e.data as Record<string, unknown> | undefined;
					const content = data?.content ?? e.content;
					if (typeof content === "string") agentSeedContent = content;
				}
			}
		}
		compactionInFlight = false;
		pendingCompaction = undefined;
		compactionCooldownUntil = 0;
		summaryBudgetWarnFired = false;
		_seedSummaryBudgetWarnFired = false;
		calibration = undefined;
		if (state.activePlanSlug) engine = loadEngine(state.activePlanSlug);
		// Auto-open a draft plan when starting in plan mode with no active plan
		if (state.mode === "plan" && !engine) {
			openPlan(undefined, ctx);
		}
		applyTools();
		overlayManager.attach(ctx);
		// Install custom footer (before notifyMode so invalidate handle exists)
		if (!agentBridge && state.mode !== "agent") {
			invalidateFooter = installFooter({
				pi,
				ctx,
				getMode: () => state.mode,
				getLedger: () => usageLedger,
				getAgentStatus: () => {
					if (!tmuxFanout || !engine) return undefined;
					const agents = tmuxFanout.snapshot().agents;
					// Total = all non-terminal deliverables in the plan
					const plan = engine.get();
					const allDeliverables = plan.nodes.filter(
						(n) =>
							n.type === "deliverable" &&
							n.status !== "shipped" &&
							n.status !== "abandoned",
					);
					const total = allDeliverables.length;
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
					if (!tmuxFanout) return 0;
					return tmuxFanout.questionQueue.all().length;
				},
			});
		}
		notifyMode(ctx);
		if (state.activePlanSlug) {
		}
		// Agent-side RPC bridge: connect to orchestrator if running as agent
		agentBridge = initAgentBridge(pi);
		if (agentBridge) {
			const bridge = agentBridge;
			bridge.start(ctx);
			// Ensure agents have the tools they need (baseline strips `task`;
			// `ask`/`review`/`ship`/`commit` must be present for the decision loop).
			const available = new Set(pi.getAllTools().map((t) => t.name));
			const active = pi.getActiveTools();
			const agentModeEnv = process.env.PI_MAESTRO_AGENT_MODE;

			if (agentModeEnv === "read-only") {
				// Read-only agents: strip write/commit/ship/ask tools
				const writeTool = new Set(["commit", "ship", "edit", "write", "ask"]);
				const readOnlyActive = active.filter((t) => !writeTool.has(t));
				// Ensure task + plan are present for findings reporting
				const needed = ["task", "plan"].filter(
					(t) => available.has(t) && !readOnlyActive.includes(t),
				);
				pi.setActiveTools([...readOnlyActive, ...needed]);
			} else {
				// Full-mode agents: ensure commit/ship/task/ask/review present
				const missing = ["task", "ask", "review", "commit", "ship"].filter(
					(t) => available.has(t) && !active.includes(t),
				);
				if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
			}

			// Route the ask tool to the orchestrator over RPC (G1 transport).
			maestro.capabilities.register(CAPABILITIES.askTransport, {
				present: (questions) => bridge.ask(questions),
			});
		}

		// Worker mode: strip TUI chrome so panes show only output
		if (state.mode === "agent") {
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
		invalidateFooter = undefined;
		if (workerPanes.isOpen()) {
			await workerPanes.close();
		}
		if (tmuxFanout) {
			await tmuxFanout.destroy();
			tmuxFanout = undefined;
		}
		if (agentBridge) {
			agentBridge.destroy();
			agentBridge = undefined;
		}
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
		if (
			state.mode !== "plan" &&
			state.mode !== "auto" &&
			state.mode !== "agent"
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
				if (!fast.allowed && state.mode === "agent") {
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
			if (state.mode === "agent") {
				if (process.env.PI_MAESTRO_AGENT_MODE === "read-only") {
					return {
						block: true,
						reason:
							"Read-only agent: only read commands allowed (ls, cat, grep, git log/status/diff, test/lint).",
					};
				}
				return;
			}
			// Ambiguous: LLM classification (orchestrator only)
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
		// (+ bridge force-add for workers). Only block in plan mode.
		if (state.mode === "plan") {
			const reason = toolBlockedInPlanMode(event.toolName);
			if (reason) return { block: true, reason };
		}
	});

	pi.on("turn_start", () => {
		agentBridge?.onTurnStart();
	});

	// Accumulate real usage from assistant messages (tokens + cost). In agent
	// mode the bridge reports it over RPC; the orchestrator records its own
	// usage into the ledger (wired by the usage deliverable).
	pi.on("message_end", (event) => {
		const message = (event as { message?: { role?: string; usage?: unknown } })
			.message;
		if (message?.role !== "assistant" || !message.usage) return;
		if (agentBridge) agentBridge.recordUsage(message.usage as never);
		else recordOrchestratorUsage(message.usage);
	});

	pi.on("turn_end", async (_event, ctx) => {
		agentBridge?.onTurnEnd();
		if (!agentBridge) incrementOrchestratorTurn();
		if (state.mode === "plan") {
			finalizeDraftPlan(ctx);
			askQueue.flushTo(maestro.capabilities.get(CAPABILITIES.ask));
			return;
		}
		if (state.mode !== "auto") return;

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

	maestro.capabilities.register(CAPABILITIES.usage, usageLedger);
	maestro.capabilities.register(CAPABILITIES.overlays, overlayManager);

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

type Entryish = {
	type: string;
	message?: { role?: string; content?: unknown };
};

function isTextPart(p: unknown): p is { type: "text"; text: string } {
	return (
		typeof p === "object" &&
		p !== null &&
		(p as { type?: unknown }).type === "text" &&
		typeof (p as { text?: unknown }).text === "string"
	);
}

/** First user message text at/after `fromIndex`, or undefined. */
function firstUserMessageText(
	entries: readonly Entryish[],
	fromIndex: number,
): string | undefined {
	for (let i = Math.max(0, fromIndex); i < entries.length; i++) {
		const entry = entries[i];
		if (entry?.type !== "message" || entry.message?.role !== "user") continue;
		const content = entry.message.content;
		if (typeof content === "string") return content.trim() || undefined;
		if (Array.isArray(content)) {
			const text = content
				.map((p) => (isTextPart(p) ? p.text : ""))
				.join(" ")
				.trim();
			return text || undefined;
		}
	}
	return undefined;
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

	// If the deliverable was worked in a different session (e.g. by a worker
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

export { PLAN_CONTAINER };

// --- Plan-mode system prompt preamble -----------------------------------

function buildPlanModePreamble(engine: PlanEngine | undefined): string {
	const isNew = !engine || engine.isDraft();
	const header = isNew
		? "You are in PLAN MODE. Structure the user's request into deliverables and tasks."
		: `You are in PLAN MODE updating plan \`${engine.get().slug}\`.`;

	return `${header}

Before creating deliverables:
- Identify ambiguous decisions (error types, edge cases, API shapes)
- Ask the user to resolve them (batch questions, offer options with the ask tool when high confidence, or ask in plain text for open-ended questions)
- Do NOT create deliverables until decisions are resolved

When you have enough information (all design questions answered, scope clear, dependencies mappable):
1. If multi-repo: register repos with \`deliverable register-repo\`.
2. Add deliverables (\`deliverable add\`) with titles + bodies. Use \`dependsOn\` for ordering. Pass \`dependsOn: []\` explicitly for independent/parallel deliverables (default auto-chains to previous).
3. Add gating tasks to each deliverable (\`task add\`). Tasks describe WHAT to implement — files, functions, behavior. Do NOT add workflow steps like "run review", "address findings", or "commit/push" — those are handled automatically by the worker lifecycle.
4. After all tool calls, write out the plan summary as text (do NOT call the plan tool — it renders as a collapsed tool result).
5. End with: "Ready to implement."

Rules:
- Be concise. No narration, no thinking out loud, no explanations between tool calls.
- Each deliverable = one PR. Keep them small and focused.
- For multi-repo: assign deliverables to repos with \`repo: <key>\`.
- Do NOT read files unless the user's request is ambiguous and you need to clarify scope.
- Do NOT implement code yourself.`;
}

function buildOrchestratorPreamble(
	engine: PlanEngine | undefined,
	fanout: TmuxFanout,
): string {
	if (!engine) return "";
	const plan = engine.get();
	const active = deliverables(plan).filter((d) => d.status === "active");
	const agents = fanout.snapshot().agents;
	const now = Date.now();

	const warnings: string[] = [];
	const workerLines = active.map((d) => {
		const s = agents.get(d.id);
		if (!s) return `  agent:${d.id} — spawning`;
		const elapsed = formatElapsedShort(now - s.startedAt);
		const tIn = shortTokens(s.tokens.input);
		const tOut = shortTokens(s.tokens.output);
		return `  agent:${d.id} — ${s.status} · ${s.tokens.turns} turns · ↑${tIn} ↓${tOut} · ${elapsed}`;
	});

	const warningBlock = warnings.length > 0 ? `\n\n${warnings.join("\n")}` : "";

	return `You are in ORCHESTRATOR MODE. Agents are implementing deliverables.

Active agents:
${workerLines.join("\n") || "  (none currently running)"}${warningBlock}

You can observe agent status and intervene when needed:
- If an agent is looping (high review count), steer it to ship.
- If an agent is stuck idle, check if tasks are truly done or if it needs guidance.

When the user discusses new ideas or changes:
- Propose as a concrete deliverable with tasks and dependencies. Ask before adding.
- If it touches active work: explain impact, offer alternatives (steer now vs follow-up deliverable).
- If confirmed: add it. It spawns automatically when dependencies are met.

You can add deliverables and tasks (spawned/relayed automatically).
You CANNOT implement code yourself \u2014 that's what workers do.
Do NOT call edit, write, or mutating bash. Use plan tools to delegate work.`;
}

function shortTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

function formatElapsedShort(ms: number): string {
	if (ms < 0 || !Number.isFinite(ms)) return "—";
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const hr = Math.floor(min / 60);
	return `${hr}h${min % 60}m`;
}

function buildHackModePreamble(): string {
	return `You are in HACK MODE. Full tool access. Implement directly when asked.
Workers continue running in the background independently.
You can still add deliverables/tasks if needed.
Switch back to /auto when done with direct work.`;
}

function buildAgentWorkerPreamble(): string {
	const agentMode = process.env.PI_MAESTRO_AGENT_MODE;
	if (agentMode === "read-only") {
		return `You are a READ-ONLY REVIEW AGENT managed by a maestro orchestrator.

Review the code for your deliverable described in the first message.
You CANNOT modify files, commit, or push. You CAN read, run tests/lint, and
report findings.

## Workflow
1. Read the code in the worktree (it’s the author’s branch)
2. Run tests/linters to verify correctness: bash({command: "npm test"})
3. Record your findings by updating your task body:
   task({action: "update", phaseId: "<your-deliverable-id>", taskId: "<your-task-id>", body: "<findings>"})
4. Toggle your task done when finished:
   task({action: "toggle", phaseId: "<your-deliverable-id>", taskId: "<your-task-id>"})

## Guidelines
- Focus on correctness bugs, edge cases, missing tests, security issues
- Be specific: file, line, what’s wrong, suggested fix
- Note uncertainty (“I’m not sure if X is intentional”) rather than asking
- Do NOT ask questions — report findings only
- Severity: CRITICAL > IMPORTANT > MINOR > STYLE
- Skip STYLE unless egregious`;
	}

	return `You are an AGENT WORKER managed by a maestro orchestrator.

Implement the deliverable described in your first message, then ship.
Work through these phases. Reference tools BY NAME — never hand-run
\`pi\`, \`git\`, or \`gh\` for these steps.

## Phase 1: IMPLEMENT
Edit code, write/fix tests, verify they pass. Mark tasks done as you finish:
  task({action: "toggle", phaseId: "<deliverable-id>", taskId: "<task-id>"})
Task IDs are in the plan context above (the maestro-execution-seed).
Commit incrementally as you make progress:
  commit({message: "feat(scope): subject", paths: ["src/file.ts"]})

## Phase 2: ADDRESS REVIEW FINDINGS (if present)
If your plan shows review summaries or a reviews-gate task was toggled,
read the review findings. For each finding:
- Agree → fix it and commit
- Disagree → note why in your task body
- Uncertain → ask the orchestrator

## Phase 3: SHIP
When all tasks are done and tests pass, ship:
  ship()
This pushes, opens/updates a PR, and auto-toggles remaining tasks.
Do NOT run git/gh yourself.

## Phase 4: VERIFY
Re-read your requirements (the seed). Does the PR address everything?
Any gaps → fix, commit, and ship again. Otherwise you’re done — just stop;
the orchestrator detects completion. If blocked, describe the problem in
your final message so the orchestrator can steer you.`;
}
