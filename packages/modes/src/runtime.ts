import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
	CAPABILITIES,
	EVENTS,
	type ModeName,
	type PlanId,
} from "@vegardx/pi-contracts";
import type { MaestroContext } from "@vegardx/pi-core";
import { ModesAskQueue } from "./ask-queue.js";
import { PLAN_CONTAINER, PlanEngine } from "./engine.js";
import { FanoutOrchestrator, startSequentialExecution } from "./execution.js";
import { renderPlanMarkdown } from "./markdown.js";
import {
	classifyBash,
	computeActiveTools,
	toolBlockedInPlanMode,
} from "./policy.js";
import { repoNameFromPath, slugify } from "./schema.js";
import { appendModesState, hydrateModesState } from "./session.js";
import {
	initialModesState,
	type ModesState,
	nextMode,
	setActivePlan,
	transitionMode,
} from "./state.js";
import { createPlanStore, type PlanStore, plansRoot } from "./storage.js";
import { createPlanTools } from "./tools.js";

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
	let state: ModesState = initialModesState(now);
	let engine: PlanEngine | undefined;
	let fanout: FanoutOrchestrator | undefined;
	let baselineTools: string[] | undefined;
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
		ctx.ui.setStatus("maestro.mode", `mode: ${state.mode}`);
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
		maestro.events.emit(EVENTS.planUpdated, {
			planId: engine.get().slug as PlanId,
		});
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
					pi.sendMessage(
						{
							customType: "maestro.execution.seed",
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
			ctx.ui.notify(message, result.kind === "blocked" ? "warning" : "info");
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

	maestro.capabilities.register(CAPABILITIES.modes, {
		current: currentMode,
		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	});

	return { askQueue, currentMode, currentEngine, setMode, openPlan, cycle };
}

export { PLAN_CONTAINER };
