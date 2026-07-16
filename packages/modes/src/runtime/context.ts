// Shared runtime context: the mutable state and core helpers that the
// command handlers, event hooks, and dashboard glue all operate on.
// createRuntimeContext constructs it; runtime/index.ts wires the pieces.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	BashOperations,
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
import { CarryForwardController } from "../carry-forward.js";
import type { PendingModesCompaction } from "../compaction.js";
import { DebugController } from "../debug.js";
import { PlanEngine } from "../engine.js";
import { createExecution, type ExecutionHandle } from "../exec/index.js";
import { readKnowledgeSession } from "../exec/knowledge.js";
import { auditPlan, renderAudit } from "../exec/recovery.js";
import {
	type IsolationBackend,
	ReservedStrongIsolationBackend,
} from "../isolation/backend.js";
import { LightweightSeatbeltBackend } from "../isolation/lightweight-seatbelt.js";
import { OverlayManager } from "../overlay-manager.js";
import { panelTopologyGaps } from "../personas.js";
import { computeActiveTools } from "../policy.js";
import type { ResearchRunView } from "../research.js";
import {
	type Deliverable,
	deliverableWorkspace,
	derivePlanName,
	planPhase,
	planRepoMismatch,
	repoFor,
	repoNameFromPath,
	slugify,
} from "../schema.js";
import { appendModesState } from "../session.js";
import {
	getImplementOverrides,
	type ImplementOverrides,
	readChildExtensions,
	readWorktreeSetupSettings,
	setImplementOverrides,
} from "../settings.js";
import { resolveSpawnModelSafe } from "../spawn-model.js";
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
import {
	accumulate,
	incrementTurns,
	type UsageDelta,
	UsageLedger,
} from "../usage-ledger.js";
import { WorkerPanes } from "../worker-panes.js";
import { sendAgentEvent } from "./agent-cards.js";
import type { ViewState } from "./agent-commands.js";
import { installDebugProposalHandler } from "./debug-command.js";
import { GateTriage } from "./gate-triage.js";
import { cleanupInactiveWorktrees, recordPlanSession } from "./stubs.js";

export interface ModesRuntimeOptions {
	readonly store?: PlanStore;
	readonly now?: () => string;
	/** Injectable execution providers; missing isolation tiers fail closed. */
	readonly bashBackends?: {
		readonly direct?: (cwd: string) => BashOperations | undefined;
		readonly hostRead?: (cwd: string) => BashOperations | undefined;
		readonly lightweight?: (cwd: string) => BashOperations | undefined;
		readonly strong?: (cwd: string) => BashOperations | undefined;
	};
	/** Stateful isolation providers. Defaults install Lightweight and reserved Strong. */
	readonly isolationBackends?: {
		readonly lightweight?: IsolationBackend;
		readonly strong?: IsolationBackend;
	};
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
	readonly bashBackends: NonNullable<ModesRuntimeOptions["bashBackends"]>;
	readonly isolationBackends: {
		readonly lightweight: IsolationBackend;
		readonly strong: IsolationBackend;
	};
	/** Explicit per-session fallback after a visible isolation failure. */
	isolationNoneSession: boolean;
	readonly viewState: ViewState;
	readonly listeners: Set<(mode: ModeName, previous: ModeName) => void>;

	state: ModesState;
	engine: PlanEngine | undefined;
	agentBridge: AgentBridge | undefined;
	execution: ExecutionHandle | undefined;
	/** Ship-gate triage controller (maestro-first escalation); with execution. */
	gateTriage: GateTriage | undefined;
	/** Active, persisted diagnosis/recovery episode. */
	readonly debug: DebugController;
	/** Carry-forward episode controller (/distill and /handoff). */
	readonly carryForward: CarryForwardController;
	/** Live research runs (plan-mode fan-out), keyed by run id. */
	readonly researchRuns: Map<string, ResearchRunView>;
	agentSeedContent: string | undefined;
	invalidateFooter: (() => void) | undefined;
	/** The live HUD handle (mounted at session_start in TUI sessions). */
	hud: import("./hud-wiring.js").HudHandle | undefined;
	// Transient: a post-handoff arrival delivery is idle-polling (dedupes the
	// sink's schedule against session_start's).
	handoffArrivalScheduled?: boolean;
	// Transient: the ladder crossed forceAt mid-run; agent_settled fires the
	// forced distill once the session is truly idle.
	pendingForcedDistill?: { fillPct: number };
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
	// Highest context-fill warning step already fired (70/90); 0 = armed.
	contextWarnedAt: number;

	currentMode(): ModeName;
	currentEngine(): PlanEngine | undefined;
	persist(): void;
	notifyMode(ctx: ExtensionContext): void;
	applyTools(): void;
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
	/** Build the execution adapter for the active plan if absent (idempotent). */
	ensureExecution(ctx: ExtensionContext): Promise<void>;
	/** Audit the plan against reality and resume interrupted deliverables. */
	runRecover(ctx: ExtensionContext): Promise<void>;
}

/**
 * One-shot orientation instruction fired on the recon → plan toggle. This
 * message (and the model's reply to it) IS the recon handoff: generated
 * in-band from full context, visible to the user, cached as part of the
 * message prefix — no seed document.
 */
const RECON_TO_PLAN_ORIENTATION =
	"[Mode switch: recon → plan. Orient before planning: review the " +
	"conversation and research so far, then reply with (1) a short summary " +
	"of what we intend to build or do, and (2) a bullet list of the open " +
	"questions that must be answered before a solid plan can form — noting " +
	"for each whether research or only the user can answer it. If nothing " +
	"is open, say so. Do not call readiness or fire research yet — wait for " +
	"the user's reaction.]";

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
	const lightweightIsolation =
		opts.isolationBackends?.lightweight ?? new LightweightSeatbeltBackend();
	const strongIsolation =
		opts.isolationBackends?.strong ?? new ReservedStrongIsolationBackend();
	const bashBackends = {
		...opts.bashBackends,
		// Protected reads use the same private-workspace policy rather than an
		// unrestricted local shell. This also avoids a separate writable host-read
		// implementation accidentally broadening the policy.
		hostRead:
			opts.bashBackends?.hostRead ??
			((cwd: string) => lightweightIsolation.operations(cwd)),
		lightweight:
			opts.bashBackends?.lightweight ??
			((cwd: string) => lightweightIsolation.operations(cwd)),
		strong:
			opts.bashBackends?.strong ??
			((cwd: string) => strongIsolation.operations(cwd)),
	};

	// While a draft plan is open: the entry count at /plan time (to locate the
	// first planning message) and an explicit name from `/plan <name>`.
	let draftStartEntries = 0;
	let draftExplicitName: string | undefined;
	// Central usage ledger (usage.v1). Records maestro + agent usage.
	const usageLedger = new UsageLedger();
	let maestroUsage: TokenSnapshot | undefined;
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
		bashBackends,
		isolationBackends: {
			lightweight: lightweightIsolation,
			strong: strongIsolation,
		},
		isolationNoneSession: false,
		viewState: { viewPaneId: undefined },
		listeners: new Set(),

		state: initialModesState(now),
		engine: undefined,
		agentBridge: undefined,
		execution: undefined,
		gateTriage: undefined,
		debug: new DebugController(),
		carryForward: new CarryForwardController(() => rt.applyTools()),
		researchRuns: new Map(),
		agentSeedContent: undefined,
		invalidateFooter: undefined,
		hud: undefined,
		compactionInFlight: false,
		pendingCompaction: undefined,
		compactionCooldownUntil: 0,
		contextWarnedAt: 0,

		currentMode(): ModeName {
			return rt.state.mode;
		},

		currentEngine(): PlanEngine | undefined {
			return rt.engine;
		},

		persist(): void {
			appendModesState(pi, rt.state);
		},

		notifyMode(_ctx: ExtensionContext): void {
			rt.invalidateFooter?.();
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
					carryForwardActive: Boolean(rt.carryForward.get()),
				}),
			);
		},

		setMode(mode: ModeName, ctx?: ExtensionContext): void {
			// Auto/Hack are an authorization boundary: invalidate the private
			// research epoch synchronously and finish cleanup in the background.
			if (
				(mode === "auto" || mode === "hack") &&
				(rt.state.mode === "recon" || rt.state.mode === "plan")
			) {
				void Promise.allSettled([
					rt.isolationBackends.lightweight.destroy(),
					rt.isolationBackends.strong.destroy(),
				]);
			}
			// Entering plan mode without an active plan auto-opens a draft so the
			// planning tools work immediately — no need for an explicit /plan.
			// Recon gets the same invisible draft: it keys the research scratch
			// dir so research/dig work, but no plan tool ever surfaces it.
			if ((mode === "plan" || mode === "recon") && !rt.engine && ctx) {
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
			if (rt.state.mode === "recon") {
				// One-way exit: recon → plan. The toggle IS the readiness signal.
				// The first plan-mode turn orients — summary + open questions —
				// generated from the full recon conversation; that in-band message
				// is the handoff (no seed document, no re-research).
				rt.setMode("plan", ctx);
				const hasConversation = ctx.sessionManager
					.getEntries()
					.some(
						(entry) =>
							(entry as { type?: string }).type === "message" &&
							(entry as { message?: { role?: string } }).message?.role ===
								"user",
					);
				if (hasConversation) {
					pi.sendUserMessage(RECON_TO_PLAN_ORIENTATION, {
						deliverAs: "followUp",
					});
				}
				return;
			}
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
			// auto → plan; hack (off-cycle) also exits to plan — see nextMode.
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
			// Scratch deliverables have no repo to mismatch.
			if (deliverableWorkspace(d) === "scratch") return true;
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

			// Panel topology preflight: a code-changing deliverable without a
			// required reviewer ships ungated (the orchestra-baseline hole).
			// Surface the gaps BEFORE any worker spawns; proceeding is a
			// deliberate human choice, not a silent default.
			if (!isAgentMode()) {
				const gaps = panelTopologyGaps(activeEngine.get().deliverables);
				if (gaps.length > 0) {
					const proceed = await ctx.ui.confirm(
						"Review panel gaps",
						`${gaps.length} gap(s) mean work could ship without a gating review:\n` +
							`${gaps.map((g) => `  • ${g}`).join("\n")}\n` +
							"Start implementation anyway?",
					);
					if (!proceed) {
						ctx.ui.notify(
							"Implementation not started — fix the panel via the subagent tool (add required reviewers), then /implement again.",
							"info",
						);
						return;
					}
				}
			}

			const mode = args.includes("--hack") ? "hack" : "auto";
			rt.setMode(mode as ModeName, ctx);

			// Deliverable execution via the execution seam
			if (!isAgentMode()) {
				await rt.ensureExecution(ctx);
				if (!rt.execution) return;
				const activated = await rt.execution.tick();
				rt.hud?.refresh();
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

		// Build (once) the execution adapter for the active plan. Shared by
		// /implement and /recover — a restarted session has mode/plan hydrated
		// but no adapter until one of them runs.
		async ensureExecution(ctx: ExtensionContext): Promise<void> {
			if (rt.execution || !rt.engine || isAgentMode()) return;
			const activeEngine = rt.engine;
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
				resolveWorkerModel: async (choice) => {
					const authored = getImplementOverrides();
					const resolved = await resolveSpawnModelSafe(ctx, {
						role: "worker",
						model: choice.model ?? authored?.agentModel,
						effort: choice.effort ?? authored?.agentThinking,
					});
					return { modelId: resolved.modelId, effort: resolved.effort };
				},
				// New deliverables activate only while autonomous. The adapter
				// outlives mode switches (running workers must finish and ship),
				// and every plan mutation ticks it — without this gate a `task
				// add` in plan/recon mode spawns workers.
				canActivate: () => rt.state.mode === "auto" || rt.state.mode === "hack",
				onPlanChanged: () => rt.emitPlanChanged(),
				onAgentStateChanged: (id, state) => {
					usageLedger.record({ kind: "agent", id }, state.tokens);
					rt.invalidateFooter?.();
					rt.hud?.refresh();
					// Sync worker panes when agents complete
					if (rt.execution && rt.workerPanes.isOpen()) {
						rt.workerPanes
							.sync(rt.execution.getWorkerSessions())
							.catch(() => {});
					}
				},
				// The settled card (onEvent) is the recap now; onAllSettled
				// refreshes the footer and clears the agent widget. Research
				// reports are NOT wiped — they live in the plan dir and stay
				// dig()-able across arcs (carry-forward advertises exactly that).
				// Gate disagreements go to the MAESTRO first (triage: one
				// send-back with guidance, or escalate with a recommendation);
				// the human decides genuine disagreements. Override still
				// executes extension-side on the human's answer only.
				onShipGateBlocked: (deliverableId, reason) => {
					rt.gateTriage?.handleBlock(deliverableId, reason);
				},
				onAllSettled: () => {
					rt.invalidateFooter?.();
					rt.hud?.refresh();
					// The arc is over: every deliverable is terminal. Return to
					// PLAN mode — the maestro ends the arc standing at the
					// /handoff doorway (or ready to extend the plan).
					if (rt.state.mode !== "plan") {
						rt.setMode("plan", ctx);
						ctx.ui.notify(
							"All work delivered — back to plan mode. Extend the plan, or /handoff to seed the next arc.",
							"info",
						);
					}
				},
				onEvent: (event) => sendAgentEvent(pi, event),
			});
			rt.gateTriage = new GateTriage({
				ask: () => maestro.capabilities.get(CAPABILITIES.ask),
				execution: () => rt.execution,
				pi,
				notify: (m, level) => ctx.ui.notify(m, level),
			});
			installDebugProposalHandler(rt, ctx);
			await rt.execution.start();
		},

		// /recover: audit the plan against reality (worktrees, branches, PRs),
		// then resume every deliverable interrupted by the restart — workers
		// respawn RESUMED from their persisted session files.
		async runRecover(ctx: ExtensionContext): Promise<void> {
			if (!rt.engine) {
				ctx.ui.notify("No active plan — /plan <slug> first.", "warning");
				return;
			}
			const plan = rt.engine.get();
			const started = plan.deliverables.some((g) => g.status !== "planned");
			if (!started) {
				ctx.ui.notify("Nothing to recover — the plan never started.", "info");
				return;
			}

			// 1. Reality check: verify claimed statuses against disk/git/GitHub.
			const audit = await auditPlan(plan);
			ctx.ui.notify(
				renderAudit(audit),
				audit.problems > 0 ? "warning" : "info",
			);

			// 2. Resume interrupted execution.
			if (rt.state.mode !== "auto" && rt.state.mode !== "hack") {
				rt.setMode("auto", ctx);
			}
			await rt.ensureExecution(ctx);
			if (!rt.execution) {
				ctx.ui.notify("tmux is required to resume workers.", "warning");
				return;
			}

			// 3. Stuck-live preflight: workers still (nominally) running are
			// invisible to recoverInterrupted, and force-exiting one by hand just
			// triggers the crash-respawn loop. Offer to force-fail them into the
			// recoverable shape so this run picks them up too.
			const liveWorkers: string[] = [];
			for (const [id, state] of rt.execution.getExecutor().getStates()) {
				const worker = state.agents.get("worker");
				if (!worker) continue;
				if (
					worker.status === "working" ||
					worker.status === "spawning" ||
					worker.status === "restarting"
				) {
					liveWorkers.push(id);
				}
			}
			if (liveWorkers.length > 0) {
				const proceed = await ctx.ui.confirm(
					"Recover running workers",
					`${liveWorkers.length} worker(s) are still running:\n` +
						`${liveWorkers.map((id) => `  • ${id}`).join("\n")}\n` +
						"Force-fail them so recovery can re-provision and respawn? " +
						"(No leaves them running and recovers only parked deliverables.)",
				);
				if (proceed) {
					for (const id of liveWorkers) {
						const ok = await rt.execution.forceFailWorker?.(
							id,
							"user ran /recover",
						);
						if (!ok) {
							ctx.ui.notify(
								`Could not force-fail ${id} — its session refused to die; try again or kill it manually.`,
								"warning",
							);
						}
					}
				}
			}

			const { recovered, failed } = await rt.execution
				.getExecutor()
				.recoverInterrupted();
			await rt.execution.tick();
			rt.hud?.refresh();
			if (recovered.length > 0) {
				rt.setExecutionStage(
					{ stage: "executing", deliverableId: "maestro" },
					ctx,
				);
				const sessions = rt.execution.getWorkerSessions();
				if (sessions.length > 0) await rt.workerPanes.open(sessions);
			}
			const parts = [
				recovered.length > 0
					? `Resumed ${recovered.length} deliverable(s): ${recovered.join(", ")}.`
					: "No interrupted deliverables to resume.",
				...failed.map((f) => `✗ ${f.id}: ${f.error}`),
			];
			ctx.ui.notify(parts.join("\n"), failed.length > 0 ? "warning" : "info");
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
		}
	}

	const VALID_THINKING = new Set(["off", "minimal", "low", "medium", "high"]);
	const wt =
		agentThinking && VALID_THINKING.has(agentThinking)
			? (agentThinking as ImplementOverrides["agentThinking"])
			: undefined;

	if (!agentModel && !wt) return undefined;
	return {
		agentModel,
		agentThinking: wt,
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
