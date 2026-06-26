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
import { addWorktree, removeWorktree } from "@vegardx/pi-git";
import { ModesAskQueue } from "./ask-queue.js";
import {
	calibrateSys,
	calibrationKey,
	computeBuckets,
	estimateTokens,
	formatBudget,
} from "./budget.js";
import {
	buildDeliverableSliceCompactionResult,
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
import { deliverables, repoNameFromPath, slugify } from "./schema.js";
import {
	appendModesState,
	collectBudgetText,
	EXECUTION_SEED_ENTRY,
	hasExecutionSeed,
	hydrateModesState,
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
import { renderModeFooter, renderPlanPanel } from "./ui.js";
import {
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

	// Best-effort context-budget breakdown for the footer. Deterministic given
	// its inputs and defensive: when total usage is unknown (e.g. right after
	// compaction) `hotTail` is reported as 0 and a prior calibrated `sys` is
	// reused. Only shown during ask/auto execution.
	function budgetFooter(ctx: ExtensionContext): string | undefined {
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
		return formatBudget(
			buckets,
			settings.workingTokens + settings.summaryTokens,
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
		const prepared = activateDeliverableWorktree(
			engine,
			deliverableId,
			"main",
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
				prepareWorktree(result.deliverable.id, ctx);
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
			const result = await syncPrState(engine, {
				state: async (prNumber) => prStateViaGh(pi, ctx.cwd, prNumber),
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
				createIssue: (input) => createIssueViaGh(pi, ctx.cwd, input),
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

	pi.on("turn_end", () => {
		if (state.mode !== "plan") return;
		askQueue.flushTo(maestro.capabilities.get(CAPABILITIES.ask));
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
