// Shared runtime context: the mutable state and core helpers that the
// command handlers, event hooks, and dashboard glue all operate on.
// createRuntimeContext constructs it; runtime/index.ts wires the pieces.

import { existsSync } from "node:fs";
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
import { type AgentBridge, isAgentMode } from "../agent-bridge.js";
import { ModesAskQueue } from "../ask-queue.js";
import {
	calibrateSys,
	calibrationKey,
	computeBuckets,
	estimateTokens,
	formatBudget,
} from "../budget.js";
import type { PendingModesCompaction } from "../compaction.js";
import { PlanEngine } from "../engine.js";
import { createExecution, type ExecutionHandle } from "../exec/index.js";
import { readKnowledgeSession } from "../exec/knowledge.js";
import { OverlayManager } from "../overlay-manager.js";
import { computeActiveTools } from "../policy.js";
import { clearResearchScratch, type ResearchRunView } from "../research.js";
import {
	type Deliverable,
	derivePlanName,
	planPhase,
	slugify,
} from "../schema.js";
import { appendModesState, collectBudgetText } from "../session.js";
import {
	type ImplementOverrides,
	readChildExtensions,
	readModesCompactionSettings,
	readWorktreeSetupSettings,
	setImplementOverrides,
} from "../settings.js";
import {
	type ExecutionState,
	initialModesState,
	type ModesState,
	nextMode,
	setActivePlan,
	setExecution,
	transitionMode,
} from "../state.js";
import { createPlanStore, type PlanStore, plansRoot } from "../storage.js";
import { renderModeFooter } from "../ui.js";
import {
	accumulate,
	incrementTurns,
	type UsageDelta,
	UsageLedger,
} from "../usage-ledger.js";
import { WorkerPanes } from "../worker-panes.js";
import { sendAgentEvent } from "./agent-cards.js";
import type { ViewState } from "./agent-commands.js";
import { syncAgentWidget } from "./dashboard.js";
import { presentGateDecision } from "./gate-decision.js";
import {
	cleanupInactiveWorktrees,
	planRepoMismatch,
	recordPlanSession,
	repoFor,
	repoNameFromPath,
} from "./stubs.js";

export interface ModesRuntimeOptions {
	readonly store?: PlanStore;
	readonly now?: () => string;
}

export interface BudgetSnapshot {
	buckets: ReturnType<typeof computeBuckets>;
	settings: ReturnType<typeof readModesCompactionSettings>;
}

/**
 * Everything the runtime modules share. Mutable fields are reassigned across
 * commands/hooks; methods close over the context so callers see live state.
 */
export interface RuntimeContext {
	readonly pi: ExtensionAPI;
	readonly maestro: MaestroContext;
	readonly store: PlanStore;
	readonly now: () => string;
	readonly askQueue: ModesAskQueue;
	readonly overlayManager: OverlayManager;
	readonly usageLedger: UsageLedger;
	readonly workerPanes: WorkerPanes;
	readonly viewState: ViewState;
	readonly listeners: Set<(mode: ModeName, previous: ModeName) => void>;

	state: ModesState;
	engine: PlanEngine | undefined;
	agentBridge: AgentBridge | undefined;
	execution: ExecutionHandle | undefined;
	/** Live research runs (plan-mode fan-out), keyed by run id. */
	readonly researchRuns: Map<string, ResearchRunView>;
	agentSeedContent: string | undefined;
	invalidateFooter: (() => void) | undefined;
	// Transient: 5s re-render timer for the live agent widget (elapsed ticks).
	agentWidgetTimer: ReturnType<typeof setInterval> | undefined;
	// The agent widget is mounted once and re-rendered in place — re-setting
	// it per sync reshuffles the widget stack and blinks the ask overlays.
	agentWidgetMounted: boolean;
	agentWidgetRefresh: (() => void) | undefined;
	// Transient (not persisted): a modes-owned compaction is in flight.
	compactionInFlight: boolean;
	// Transient (not persisted): what modes is about to compact. Set just
	// before `ctx.compact({ customInstructions: marker })`; the
	// `session_before_compact` handler matches the incoming marker against this
	// nonce to claim ownership.
	pendingCompaction: PendingModesCompaction | undefined;
	// Transient: after a timed-out/aborted compaction pi may still be
	// summarising in the background; hold off re-triggering until this passes.
	compactionCooldownUntil: number;
	// Transient: soft summary-budget warning fires at most once per session.
	summaryBudgetWarnFired: boolean;
	// Highest context-fill warning step already fired (70/90); 0 = armed.
	contextWarnedAt: number;
	// Transient: per-session guard for the seed dependency-summary warning.
	seedSummaryBudgetWarnFired: boolean;

	currentMode(): ModeName;
	currentEngine(): PlanEngine | undefined;
	persist(): void;
	notifyMode(ctx: ExtensionContext): void;
	budgetSnapshot(ctx: ExtensionContext): BudgetSnapshot | undefined;
	budgetFooter(ctx: ExtensionContext): string | undefined;
	applyTools(): void;
	resetCalibration(): void;
	setMode(mode: ModeName, ctx?: ExtensionContext): void;
	setExecutionStage(execution: ExecutionState, ctx?: ExtensionContext): void;
	loadEngine(slug: string): PlanEngine | undefined;
	openPlan(titleOrSlug: string | undefined, ctx: ExtensionContext): PlanEngine;
	finalizeDraftPlan(ctx: ExtensionContext, opts?: { force?: boolean }): void;
	cycle(ctx: ExtensionContext): Promise<void>;
	emitPlanChanged(): void;
	assertDeliverableRepo(ctx: ExtensionContext, d: Deliverable): boolean;
	recordMaestroUsage(usage: unknown): void;
	incrementMaestroTurn(): void;
	runImplement(args: string, ctx: ExtensionContext): Promise<void>;
}

export function createRuntimeContext(
	pi: ExtensionAPI,
	maestro: MaestroContext,
	opts: ModesRuntimeOptions = {},
): RuntimeContext {
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
	const overlayManager = new OverlayManager();

	// While a draft plan is open: the entry count at /plan time (to locate the
	// first planning message) and an explicit name from `/plan <name>`.
	let draftStartEntries = 0;
	let draftExplicitName: string | undefined;
	// Central usage ledger (usage.v1). Records maestro + agent usage.
	const usageLedger = new UsageLedger();
	let maestroUsage: TokenSnapshot | undefined;
	// Cached system-prompt+tools token estimate, invalidated when the
	// calibration key (mode/toolset/system-prompt length) changes.
	let calibration: { sig: string; sys: number } | undefined;
	let baselineTools: string[] | undefined;

	const rt: RuntimeContext = {
		pi,
		maestro,
		store,
		now,
		askQueue,
		overlayManager,
		usageLedger,
		workerPanes: new WorkerPanes(),
		viewState: { viewPaneId: undefined },
		listeners: new Set(),

		state: initialModesState(now),
		engine: undefined,
		agentBridge: undefined,
		execution: undefined,
		researchRuns: new Map(),
		agentSeedContent: undefined,
		invalidateFooter: undefined,
		agentWidgetTimer: undefined,
		agentWidgetMounted: false,
		agentWidgetRefresh: undefined,
		compactionInFlight: false,
		pendingCompaction: undefined,
		compactionCooldownUntil: 0,
		summaryBudgetWarnFired: false,
		contextWarnedAt: 0,
		seedSummaryBudgetWarnFired: false,

		currentMode(): ModeName {
			return rt.state.mode;
		},

		currentEngine(): PlanEngine | undefined {
			return rt.engine;
		},

		persist(): void {
			appendModesState(pi, rt.state);
		},

		notifyMode(ctx: ExtensionContext): void {
			if (rt.invalidateFooter) {
				rt.invalidateFooter();
			} else {
				// Fallback before footer is installed (e.g. early session_start)
				ctx.ui.setStatus(
					"maestro.mode",
					renderModeFooter({
						mode: rt.state.mode,
						planSlug: rt.state.activePlanSlug,
						budget: rt.budgetFooter(ctx),
						contextPercent: ctx.getContextUsage?.()?.percent,
					}),
				);
			}
			if (rt.engine) ctx.ui.setWidget?.("maestro.plan", undefined);
		},

		// Best-effort context-budget breakdown. Deterministic given its inputs
		// and defensive: when total usage is unknown (e.g. right after
		// compaction) `hotTail` is 0 and a prior calibrated `sys` is reused.
		// Returns undefined outside ask/auto execution. Shared by the footer and
		// the trigger so both read the SAME bucket math.
		budgetSnapshot(ctx: ExtensionContext): BudgetSnapshot | undefined {
			if (rt.state.mode !== "auto") return undefined;
			const entries = ctx.sessionManager?.getEntries?.() ?? [];
			const text = collectBudgetText(entries);
			const seed = estimateTokens(text.seed);
			const rollingSummary = estimateTokens(text.rollingSummary);
			const total = ctx.getContextUsage?.()?.tokens ?? null;
			const systemPrompt = ctx.getSystemPrompt?.() ?? "";
			const sig = calibrationKey({
				mode: rt.state.mode,
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
		},

		budgetFooter(ctx: ExtensionContext): string | undefined {
			const snapshot = rt.budgetSnapshot(ctx);
			if (!snapshot) return undefined;
			return formatBudget(
				snapshot.buckets,
				snapshot.settings.workingTokens + snapshot.settings.summaryTokens,
			);
		},

		applyTools(): void {
			const active = pi.getActiveTools();
			if (!baselineTools || rt.state.mode === "hack") {
				baselineTools = active.filter(
					(name) => !["deliverable", "task", "plan"].includes(name),
				);
			}
			pi.setActiveTools(
				computeActiveTools({
					mode: rt.state.mode,
					availableTools: pi.getAllTools().map((t) => t.name),
					baselineTools,
					isAgent: isAgentMode(),
					phase: rt.engine ? planPhase(rt.engine.get()) : undefined,
				}),
			);
		},

		resetCalibration(): void {
			calibration = undefined;
		},

		setMode(mode: ModeName, ctx?: ExtensionContext): void {
			// Entering plan mode without an active plan auto-opens a draft so the
			// planning tools work immediately — no need for an explicit /plan.
			if (mode === "plan" && !rt.engine && ctx) {
				rt.openPlan(undefined, ctx);
			}
			const changed = transitionMode(rt.state, mode, now);
			rt.state = changed.state;
			rt.persist();
			rt.applyTools();
			if (ctx) {
				rt.notifyMode(ctx);
				ctx.ui.notify(`Maestro ${mode} mode`, "info");
			}
			emitMode(changed.previous);
		},

		setExecutionStage(execution: ExecutionState, ctx?: ExtensionContext): void {
			rt.state = setExecution(rt.state, execution, now);
			rt.persist();
			if (ctx) rt.notifyMode(ctx);
		},

		loadEngine(slug: string): PlanEngine | undefined {
			const plan = store.load(slug);
			if (!plan) return undefined;
			return new PlanEngine(plan, store, now);
		},

		openPlan(
			titleOrSlug: string | undefined,
			ctx: ExtensionContext,
		): PlanEngine {
			const explicit = titleOrSlug?.trim() || undefined;
			const slug = explicit ? slugify(explicit) || "plan" : undefined;
			// No explicit name and there's already an active plan -> keep it.
			if (!slug && rt.engine) return rt.engine;
			// Reopen an existing named plan.
			if (slug && store.exists(slug)) {
				rt.engine = rt.loadEngine(slug);
				if (!rt.engine) throw new Error(`plan ${slug} not found on disk`);
				rt.state = setActivePlan(rt.state, slug, now);
				const sessionPath = ctx.sessionManager.getSessionFile();
				if (sessionPath) recordPlanSession(rt.engine, sessionPath);
				rt.persist();
				maestro.events.emit(EVENTS.planUpdated, { planId: slug as PlanId });
				return rt.engine;
			}
			// A new plan starts as an in-memory draft. It's named and persisted
			// lazily on the first turn that adds content (see finalizeDraftPlan),
			// so an exploratory /plan that adds nothing never hits disk.
			rt.engine = PlanEngine.createDraft(
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
			if (sessionPath) recordPlanSession(rt.engine, sessionPath);
			return rt.engine;
		},

		// Name and persist a draft plan once it has content. Called at turn_end
		// while planning and before implement/ship so the plan survives.
		// `force` materializes even an empty plan — the research tool needs the
		// plan directory on disk before any deliverable exists (report persistence).
		finalizeDraftPlan(ctx: ExtensionContext, opts?: { force?: boolean }): void {
			if (!rt.engine?.isDraft()) return;
			if (!opts?.force && rt.engine.get().deliverables.length === 0) return;
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
			rt.engine.materialize(slug, title);
			rt.state = setActivePlan(rt.state, slug, now);
			rt.persist();
			maestro.events.emit(EVENTS.planUpdated, { planId: slug as PlanId });
			ctx.ui.notify(`Plan saved as \`${slug}\`.`, "info");
			draftExplicitName = undefined;
		},

		async cycle(ctx: ExtensionContext): Promise<void> {
			if (rt.state.mode === "plan") {
				// Prompt which mode to enter from plan
				const choice = await ctx.ui.select("Switch to", [
					"auto — fully autonomous",
					"hack — fully autonomous, all tools",
				]);
				if (choice?.startsWith("auto")) {
					await rt.runImplement("", ctx);
				} else if (choice?.startsWith("hack")) {
					rt.setMode("hack", ctx);
				}
				return;
			}
			rt.setMode(nextMode(rt.state.mode), ctx);
		},

		emitPlanChanged(): void {
			if (!rt.engine) return;
			cleanupInactiveWorktrees(rt.engine, worktreeDeps);
			maestro.events.emit(EVENTS.planUpdated, {
				planId: rt.engine.get().slug as PlanId,
			});
			// Re-tick: if a new deliverable was added (or deps changed), spawn it.
			// Floating on purpose — but NEVER let a rejection escape (it becomes
			// an uncaughtException and kills pi). Failures park the deliverable
			// blocked (activation catch) or resurface on the next poll tick.
			rt.execution?.tick().catch(() => {});
		},

		// Sequential execution stays in the session's cwd; check out the
		// deliverable branch in plan.repoPath instead of spinning up an unused
		// worktree. Refuse to act when the session cwd doesn't resolve to the
		// repo a specific deliverable targets — otherwise sequential
		// implement/ship would silently hit the wrong tree. Returns true when
		// it's safe to proceed (and when there's no plan to guard). Fanout uses
		// per-deliverable worktrees and is not guarded.
		assertDeliverableRepo(ctx: ExtensionContext, d: Deliverable): boolean {
			if (!rt.engine) return true;
			const repoPath = repoFor(rt.engine.get(), d).path;
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
		},

		recordMaestroUsage(usage: unknown): void {
			maestroUsage = accumulate(maestroUsage, usage as UsageDelta);
			usageLedger.record({ kind: "maestro" }, maestroUsage);
			rt.invalidateFooter?.();
		},

		incrementMaestroTurn(): void {
			if (maestroUsage) {
				maestroUsage = incrementTurns(maestroUsage);
				usageLedger.record({ kind: "maestro" }, maestroUsage);
			}
		},

		async runImplement(args: string, ctx: ExtensionContext): Promise<void> {
			// Parse flags
			const overrides = parseImplementFlags(args);
			setImplementOverrides(overrides);

			if (!rt.engine) rt.openPlan(undefined, ctx);
			if (!rt.engine) return;
			rt.finalizeDraftPlan(ctx);
			const activeEngine = rt.engine;

			// Gate: agents fork from the plan's knowledge session — refuse to
			// start without it and ask the model to author it now.
			const knowledgePath = join(
				plansRoot(),
				activeEngine.get().slug,
				"base-knowledge.jsonl",
			);
			let knowledgeProblem: string | undefined;
			if (!isAgentMode()) {
				if (!existsSync(knowledgePath)) {
					knowledgeProblem = "missing";
				} else {
					try {
						readKnowledgeSession(knowledgePath);
					} catch (e) {
						knowledgeProblem = e instanceof Error ? e.message : String(e);
					}
				}
			}
			if (knowledgeProblem) {
				ctx.ui.notify(
					knowledgeProblem === "missing"
						? "No knowledge base yet — asking the model to write it; run /implement again after."
						: `Knowledge base failed validation (${knowledgeProblem}) — asking the model to rewrite it.`,
					"warning",
				);
				pi.sendUserMessage(
					"Before implementation can start, distill your codebase understanding into the shared knowledge base: call the `knowledge` tool with the codebase reference document (Project Structure / Key Patterns / Conventions / Key Interfaces — reference material only, framed as CONTEXT ONLY). Use the persisted research reports in the plan directory's research/ folder as source material if your own exploration has been compacted away.",
					{ deliverAs: "followUp" },
				);
				return;
			}

			const mode = args.includes("--hack") ? "hack" : "auto";
			rt.setMode(mode as ModeName, ctx);

			// Deliverable execution via the execution seam
			if (!isAgentMode()) {
				if (!rt.execution) {
					const maestroRoot = resolve(
						dirname(fileURLToPath(import.meta.url)),
						"../../../..",
					);
					rt.execution = createExecution({
						engine: activeEngine,
						ctx,
						extensionPath: maestroRoot,
						// Workers MUST load the maestro package itself (agent bridge,
						// task tool, RPC idle reports) — argv discovery alone finds
						// nothing when the maestro is loaded via pi's `packages`
						// mechanism instead of -e, which left workers as vanilla pi:
						// they finished their work but could never report back, so
						// the run hung forever. Then any extra -e extensions the
						// maestro was launched with, then the childExtensions
						// passthrough (custom model providers etc).
						extensionPaths: [
							...new Set([
								maestroRoot,
								...discoverExtensionPaths().map((p) => resolve(p)),
								...readChildExtensions(ctx.cwd).map((p) => resolve(p)),
							]),
						],
						planDir: join(plansRoot(), activeEngine.get().slug),
						defaultBranch: detectDefaultBranch(ctx.cwd) ?? "main",
						worktreeSetup: readWorktreeSetupSettings(ctx.cwd),
						onPlanChanged: () => rt.emitPlanChanged(),
						onAgentStateChanged: (id, state) => {
							usageLedger.record({ kind: "agent", id }, state.tokens);
							rt.invalidateFooter?.();
							syncAgentWidget(rt, ctx);
							// Sync worker panes when agents complete
							if (rt.execution && rt.workerPanes.isOpen()) {
								rt.workerPanes
									.sync(rt.execution.getWorkerSessions())
									.catch(() => {});
							}
						},
						// The settled card (onEvent) is the recap now; onAllSettled
						// refreshes the footer, clears the agent widget, and wipes the
						// plan's research scratch (full reports are throwaway once the
						// plan has shipped).
						// Gate disagreements go to the HUMAN as a question; the
						// override route executes extension-side on their answer.
						onShipGateBlocked: (deliverableId, reason) => {
							void presentGateDecision(
								{
									ask: () => maestro.capabilities.get(CAPABILITIES.ask),
									execution: () => rt.execution,
									pi,
									notify: (m, level) => ctx.ui.notify(m, level),
								},
								deliverableId,
								reason,
							);
						},
						onAllSettled: () => {
							rt.invalidateFooter?.();
							syncAgentWidget(rt, ctx);
							const eng = rt.engine;
							if (eng) clearResearchScratch(eng.get().slug);
						},
						onEvent: (event) => sendAgentEvent(pi, event),
					});
					await rt.execution.start();
				}
				const activated = await rt.execution.tick();
				syncAgentWidget(rt, ctx);
				if (activated > 0) {
					ctx.ui.notify(`Activated ${activated} deliverable(s).`, "info");
					rt.setExecutionStage(
						{ stage: "executing", deliverableId: "maestro" },
						ctx,
					);
					// Auto-open worker panes
					const sessions = rt.execution.getWorkerSessions();
					if (sessions.length > 0) {
						await rt.workerPanes.open(sessions);
					}
				} else {
					const plan = activeEngine.get();
					const active = plan.deliverables.filter((g) => g.status === "active");
					if (active.length > 0) {
						ctx.ui.notify(
							`${active.length} deliverable(s) already executing.`,
							"info",
						);
					} else {
						ctx.ui.notify("No deliverables ready to start.", "warning");
					}
				}
				return;
			}

			// tmux is required for agent execution
			ctx.ui.notify(
				"tmux is required for /implement. Install tmux and try again.",
				"warning",
			);
		},
	};

	function emitMode(previous: ModeName): void {
		maestro.events.emit(EVENTS.modeChanged, {
			mode: rt.state.mode,
			previous,
		});
		for (const listener of rt.listeners) listener(rt.state.mode, previous);
	}

	// Resolve the default branch for a deliverable's repo: prefer the
	// registry's cached value (set at register-repo time), fall back to git
	// detection, then "main". This avoids the failure when origin/HEAD isn't
	// configured and the repo's default branch isn't main/master.
	function _defaultBranchFor(d: Deliverable | null | undefined): string {
		if (!rt.engine) return "main";
		const plan = rt.engine.get();
		const repo = d ? repoFor(plan, d) : undefined;
		const fromRegistry = repo?.defaultBranch;
		const result =
			(fromRegistry || detectDefaultBranch(repo?.path ?? plan.repoPath)) ??
			"main";
		// Guard: DEFAULT_REPO_KEY ("default") is a registry key, never a branch.
		if (result === "default") return "main";
		return result;
	}

	return rt;
}

export function activeDeliverable(plan: { deliverables: Deliverable[] }) {
	return plan.deliverables.find((g) => g.status === "active");
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

export function parseImplementFlags(
	args: string,
): ImplementOverrides | undefined {
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

/**
 * Discover all -e/--extension paths from process.argv.
 * These are the extensions the maestro was launched with.
 */
function discoverExtensionPaths(): string[] {
	const paths: string[] = [];
	const args = process.argv;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "-e" || args[i] === "--extension") {
			if (args[i + 1]) paths.push(args[i + 1]);
		} else if (args[i]?.startsWith("-e=")) {
			paths.push(args[i].slice(3));
		} else if (args[i]?.startsWith("--extension=")) {
			paths.push(args[i].slice(12));
		}
	}
	return paths;
}
