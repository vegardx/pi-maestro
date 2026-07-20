// HUD glue: builds the live HudSnapshot from runtime state, wires actions
// (attach/steer/interrupt/answer) and owns the refresh loop — plus a 5s
// elapsed tick while any agent is live. Presentation lives in runtime/hud.ts
// (the expand-above panel) and runtime/maestro-editor.ts (the tab bar in the
// input's top border); both read the shared HudFocusState owned here.
//
// Render discipline: pi's `ui.setWidget` is NOT an update — it disposes the
// existing component and rebuilds the widget container (the flicker
// mechanism). The panel widget is therefore set ONCE with a stable wrapper;
// everything after that mutates state and calls requestRender.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CAPABILITIES,
	EVENTS,
	type PendingAsk,
	planViewTasks,
	projectPlanView,
	type RunRecord,
} from "@vegardx/pi-contracts";
import { uiTrace } from "@vegardx/pi-core";
import { openAnswerMode, paletteFromTheme } from "@vegardx/pi-ui";
import type { ExecutionAgentSnapshot } from "../exec/index.js";
import type { PendingQuestion } from "../question-queue.js";
import type { Plan } from "../schema.js";
import { handleViewCommand } from "./agent-commands.js";
import { listAgentTargets } from "./agent-targets.js";
import type { RuntimeContext } from "./context.js";
import {
	type HudAgentCapabilities,
	type HudAgentLeaf,
	type HudAgentNode,
	HudComponent,
	type HudFocusState,
	type HudPlanRow,
	type HudPlanView,
	type HudQuestionRow,
	type HudSnapshot,
	type HudStatus,
	type HudTab,
} from "./hud.js";
import { hudTabCounts, MaestroEditor } from "./maestro-editor.js";

/** Re-render cadence while agents are live, so elapsed columns tick. */
const HUD_TICK_MS = 5_000;

/** The panel's widget key — set once, mutated via state + requestRender. */
const HUD_WIDGET_KEY = "maestro.hud";

export interface HudHandle {
	readonly component: HudComponent;
	/** Shared focus/expansion state (the editor mutates, the panel reads). */
	readonly state: HudFocusState;
	/** Request a re-render and (re)arm the elapsed tick when agents are live. */
	refresh(): void;
	/** Switch tab + expand/focus the HUD (the /agents command). */
	show(tab: HudTab): void;
	dispose(): void;
}

/**
 * Install the HUD (idempotent): the panel widget directly above the editor
 * and the MaestroEditor tab bar as the session's editor component. Host
 * sessions only — worker/agent sessions strip chrome instead (hooks.ts).
 */
export function installHud(rt: RuntimeContext, ctx: ExtensionContext): void {
	if (rt.hud) {
		rt.hud.refresh();
		return;
	}
	let timer: ReturnType<typeof setInterval> | undefined;
	let requestRender: (() => void) | undefined;

	const state: HudFocusState = { focus: "input", expanded: false };

	/** Collapse the panel and hand the keys back to the input. */
	const returnToInput = (): void => {
		state.focus = "input";
		state.expanded = false;
		requestRender?.();
	};

	const component = new HudComponent({
		state,
		data: () => buildHudSnapshot(rt),
		theme: () => ctx.ui.theme,
		actions: {
			// Enter on an agent row: the /view tmux split (read-only attach).
			attach: (targetId) => {
				returnToInput();
				void handleViewCommand(
					targetId,
					ctx,
					rt.execution,
					rt.viewState,
					rt.maestro.capabilities.get(CAPABILITIES.subagents),
				);
			},
			// s on an agent row: prefill the addressed /steer the runtime
			// already understands and hand focus back to the input.
			steer: (targetId) => {
				const prefix = steerPrefix(targetId);
				if (!prefix) return;
				returnToInput();
				ctx.ui.setEditorText(prefix);
			},
			// i on an agent row: confirm, then abort that agent's turn/run.
			interrupt: (targetId) => {
				void (async () => {
					const yes = await ctx.ui.confirm(
						"Interrupt current turn",
						`Interrupt ${targetId}? The persistent session survives; only the current turn/run is aborted.`,
					);
					if (!yes) return;
					if (targetId.startsWith("worker:")) {
						const key = targetId.slice("worker:".length);
						const [deliverableId, name] = key.split("/");
						const result =
							deliverableId && rt.execution?.interrupt
								? await rt.execution.interrupt(deliverableId, name)
								: undefined;
						ctx.ui.notify(
							`${targetId}: ${result?.outcome ?? "disconnected"}`,
							"info",
						);
					} else if (targetId.startsWith("run:")) {
						const runId = targetId.slice("run:".length);
						const subagents = rt.maestro.capabilities.get(
							CAPABILITIES.subagents,
						);
						const local = subagents?.list().find((run) => run.id === runId);
						const result = local
							? await subagents?.interrupt?.(local.id, "user interrupt")
							: await rt.execution?.interruptProjectedRun?.(
									runId as never,
									"user interrupt",
								);
						ctx.ui.notify(
							`${targetId}: ${result?.outcome ?? "disconnected"}`,
							"info",
						);
					}
					rt.hud?.refresh();
				})();
			},
			// K on any worker-owned row fails the owning delivery after the same
			// bounded shutdown barrier used by recovery. It is deliberately not a
			// stronger spelling of interrupt.
			kill: (targetId) => {
				void (async () => {
					const deliveryId = owningDeliverableId(rt, targetId);
					if (!deliveryId) {
						ctx.ui.notify(
							`${targetId} has no owning delivery to fail.`,
							"warning",
						);
						return;
					}
					const yes = await ctx.ui.confirm(
						"Fail owning delivery",
						`Bounded-shutdown ${deliveryId} and mark it failed? Resume later only through /recover ${deliveryId}.`,
					);
					if (!yes) return;
					const stopped = await rt.execution?.forceFailWorker?.(
						deliveryId,
						"user pressed HUD K",
					);
					const delivery = rt.engine
						?.get()
						.deliverables.find((item) => item.id === deliveryId);
					if (!stopped || !delivery || delivery.status !== "active") {
						ctx.ui.notify(
							`Could not prove ${deliveryId} stopped; it was not marked failed.`,
							"warning",
						);
						return;
					}
					rt.engine?.setDeliverableStatus(deliveryId, "failed", {
						code: "user-killed",
						message:
							"Owning delivery was failed from the HUD after bounded shutdown",
						failedAt: rt.now(),
						recoverable: true,
						attempt: (delivery.failure?.attempt ?? 0) + 1,
						agentId: `${deliveryId}/worker`,
					});
					rt.emitPlanChanged();
					ctx.ui.notify(
						`${deliveryId} failed and parked. Use /recover ${deliveryId} after inspection.`,
						"warning",
					);
					rt.hud?.refresh();
				})();
			},
			// Enter on a question row: answer mode. Engine questions route
			// through the ask capability (same settle paths as the engine's
			// own takeover); worker-queue questions get the same editor with
			// answers resolving back over RPC.
			answer: (question) => {
				returnToInput();
				if (question.key.startsWith("ask:")) {
					rt.maestro.capabilities
						.get(CAPABILITIES.ask)
						?.open?.(question.key.slice("ask:".length));
					return;
				}
				if (question.key.startsWith("queue:")) {
					const rest = question.key.slice("queue:".length);
					const agentId = rest.slice(0, rest.lastIndexOf(":"));
					openWorkerAnswerMode(rt, ctx, agentId);
				}
			},
		},
	});

	const refresh = (): void => {
		requestRender?.();
		const live = hasLiveAgents(rt);
		if (live && timer === undefined) {
			const t = setInterval(refresh, HUD_TICK_MS);
			t.unref?.();
			timer = t;
		} else if (!live && timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	// Event-driven refresh: plan changes, subagent run lifecycle/progress,
	// ask pending-set changes. Execution agent state changes call
	// rt.hud.refresh() directly.
	const unsubscribe = [
		rt.maestro.events.on(EVENTS.planUpdated, refresh),
		rt.maestro.events.on(EVENTS.runStatus, refresh),
		rt.maestro.events.on(EVENTS.runProgress, refresh),
		rt.maestro.events.on(EVENTS.askChanged, refresh),
	];

	// The panel widget: set ONCE with a stable wrapper (pi's setWidget
	// disposes on every call); afterwards only state changes + requestRender.
	ctx.ui.setWidget(
		HUD_WIDGET_KEY,
		(tui) => {
			requestRender = () =>
				(tui as unknown as { requestRender?: () => void })?.requestRender?.();
			return {
				render: (width: number) => component.render(width),
				invalidate: () => component.invalidate(),
			};
		},
		{ placement: "aboveEditor" },
	);

	// The tab bar rides the editor's top border: swap in MaestroEditor and
	// restore whatever factory was configured before on dispose. Answer mode
	// does its own swap/restore dance on top of this one (packages/ui).
	const previousEditor = ctx.ui.getEditorComponent();
	ctx.ui.setEditorComponent(
		(tui, theme, keybindings) =>
			new MaestroEditor(tui, theme, keybindings, {
				state,
				counts: () => hudTabCounts(buildHudSnapshot(rt)),
				panel: component,
				theme: () => ctx.ui.theme,
				requestRender: () => requestRender?.(),
			}),
	);

	rt.hud = {
		component,
		state,
		refresh,
		show(tab: HudTab): void {
			component.setTab(tab);
			state.focus = tab;
			state.expanded = true;
			refresh();
		},
		dispose(): void {
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
			for (const off of unsubscribe) off();
			ctx.ui.setEditorComponent(previousEditor);
			ctx.ui.setWidget(HUD_WIDGET_KEY, undefined);
			rt.hud = undefined;
		},
	};

	uiTrace("hud.mount");
	refresh();
}

function owningDeliverableId(
	rt: RuntimeContext,
	targetId: string,
): string | undefined {
	if (targetId.startsWith("worker:")) {
		return targetId.slice("worker:".length).split("/")[0] || undefined;
	}
	if (!targetId.startsWith("run:")) return undefined;
	const runId = targetId.slice("run:".length);
	const runs = [
		...(rt.maestro.capabilities.get(CAPABILITIES.subagents)?.list() ?? []),
		...(rt.execution?.projectedRuns?.() ?? []),
	];
	const run = runs.find((item) => item.id === runId);
	const ownerId = (run?.profile.meta as { ownerId?: string } | undefined)
		?.ownerId;
	return ownerId?.split("/")[0] || undefined;
}

/** Whether any execution agent or subagent run is still moving. */
function hasLiveAgents(rt: RuntimeContext): boolean {
	const snap = rt.execution?.snapshot();
	if (snap) {
		for (const agent of snap.agents.values()) {
			if (!["done", "failed"].includes(agent.status)) return true;
		}
	}
	if (rt.researchRuns.size > 0) return true;
	const subagents = rt.maestro.capabilities.get(CAPABILITIES.subagents);
	for (const run of [
		...(subagents?.list() ?? []),
		...(rt.execution?.projectedRuns?.() ?? []),
	]) {
		if (["queued", "starting", "running", "blocked"].includes(run.status)) {
			return true;
		}
	}
	return false;
}

/** Assemble the live snapshot the HUD renders from. */
export function buildHudSnapshot(rt: RuntimeContext): HudSnapshot {
	const subagents = rt.maestro.capabilities.get(CAPABILITIES.subagents);
	const snap = rt.execution?.snapshot();
	const projectedRuns = rt.execution?.projectedRuns?.() ?? [];
	// The HUD renders inside the TUI render loop — a store/list failure here
	// (e.g. unreadable run state) must degrade to "no runs", never crash pi.
	let storedRuns: ReturnType<NonNullable<typeof subagents>["list"]> = [];
	try {
		storedRuns = subagents?.list() ?? [];
	} catch {
		storedRuns = [];
	}
	const allRuns = [...storedRuns, ...projectedRuns];
	const targets = listAgentTargets({ execution: rt.execution, subagents });
	return {
		agents: buildAgentNodes(snap, allRuns, Date.now(), targets),
		plan: buildPlanView(rt.engine?.get(), snap),
		questions: buildQuestionRows(
			rt.maestro.capabilities.get(CAPABILITIES.ask)?.pending() ?? [],
			rt.execution?.questionQueue.all() ?? [],
		),
	};
}

// ─── Questions tab data ──────────────────────────────────────────────────────

/**
 * Questions tab rows: the ask engine's pending set (asker "maestro";
 * blocking entries carry the accent) merged with the worker question queue
 * (asker "worker · slug"). Blocking first, then oldest-first.
 */
export function buildQuestionRows(
	pendingAsks: readonly PendingAsk[],
	workerEntries: readonly PendingQuestion[],
): HudQuestionRow[] {
	const engineRows: HudQuestionRow[] = pendingAsks.map((p) => ({
		key: `ask:${p.id}`,
		asker: "maestro",
		blocking: p.blocking === true,
		...(p.deferred ? { deferred: true } : {}),
		text: p.question,
	}));
	const workerRows: HudQuestionRow[] = [...workerEntries]
		.sort((a, b) => a.receivedAt - b.receivedAt)
		.flatMap((entry) => {
			const [deliverableId = entry.agentId] = entry.agentId.split("/");
			return entry.questions.map((q) => ({
				key: `queue:${entry.agentId}:${q.id}`,
				asker: `${entry.agentName} · ${deliverableId}`,
				blocking: false,
				text: q.question,
			}));
		});
	const merged = [...engineRows, ...workerRows];
	return [
		...merged.filter((row) => row.blocking),
		...merged.filter((row) => !row.blocking),
	];
}

// ─── Plan tab data ───────────────────────────────────────────────────────────

/**
 * Plan tab rows: deliverables as checkboxes ([x] shipped/complete, [~]
 * active, [ ] queued) with the assigned worker's live status named on active
 * rows. Tasks travel along; the component auto-expands the active row's.
 *
 * Renders from the shared PlanView projection (plan-schema spike PR-1): when
 * the v2 recursive schema lands, only projectPlanView changes — this builder
 * keeps working, with row depth ready for tree indentation.
 */
export function buildPlanView(
	plan: Pick<Plan, "deliverables"> | undefined,
	execution?: { agents: ReadonlyMap<string, ExecutionAgentSnapshot> },
): HudPlanView | undefined {
	const view = projectPlanView(plan);
	if (!view) return undefined;
	let done = 0;
	const rows: HudPlanRow[] = view.nodes.map((node) => {
		const state =
			node.status === "shipped"
				? "shipped"
				: node.status === "complete"
					? "complete"
					: node.status === "active"
						? "active"
						: node.status === "failed"
							? "failed"
							: "queued";
		if (state === "shipped" || state === "complete") done++;
		const workerAgent = execution?.agents.get(`${node.id}/worker`);
		const worker = workerAgent
			? `worker ${execStatus(workerAgent, undefined)}`
			: `worker (${node.workerMode ?? "full"})`;
		return {
			id: node.id,
			title: node.title,
			state,
			...(state === "active" ? { worker } : {}),
			tasks: planViewTasks(node).map((t) => ({
				id: t.id,
				title: t.title,
				done: t.done,
			})),
		};
	});
	return { rows, done, total: rows.length };
}

// ─── Agents tab data ─────────────────────────────────────────────────────────

/** Terminal runs stay visible this long after their last event. */
const RECENT_TERMINAL_MS = 120_000;

const TERMINAL_RUN_STATUSES = new Set([
	"succeeded",
	"failed",
	"stopped",
	"canceled",
	"timed-out",
]);

function execStatus(
	agent: ExecutionAgentSnapshot,
	blocked: string | undefined,
): HudStatus {
	if (blocked) return "blocked";
	switch (agent.status) {
		case "pending":
		case "spawning":
		case "restarting":
			return "starting";
		case "done":
			return "done";
		case "failed":
			return "failed";
		default:
			return "running";
	}
}

function runStatus(status: RunRecord["status"]): HudStatus {
	switch (status) {
		case "queued":
		case "starting":
			return "starting";
		case "blocked":
			return "blocked";
		case "succeeded":
			return "done";
		case "failed":
		case "timed-out":
			return "failed";
		case "stopped":
		case "canceled":
			return "stopped";
		default:
			return "running";
	}
}

/** Compact display name for a run: displayName minus a trailing "-<runId>". */
function runLabel(run: RunRecord): string {
	const role = run.metadata?.role ?? run.profile.role ?? run.profile.profile;
	const display = run.metadata?.displayName ?? run.profile.displayName;
	if (display && display !== `${role}-${run.id}` && display !== run.id) {
		return `${role} · ${display}`;
	}
	return `${role} · ${run.id}`;
}

/**
 * Agents tab tree: execution workers at root with their same-deliverable
 * one-shot agents nested; subagent runs nest under their parent run when it
 * is displayed (auto-parent from RUN_ID_ENV), otherwise sit at root
 * (maestro-direct research/verify/delegate spawns). Terminal runs age out
 * after two minutes so the persisted run store never floods the tab.
 */
export function buildAgentNodes(
	execution:
		| {
				agents: ReadonlyMap<string, ExecutionAgentSnapshot>;
				deliverables: ReadonlyMap<string, { blocked?: string }>;
		  }
		| undefined,
	runs: readonly RunRecord[],
	now: number,
	targets: readonly import("@vegardx/pi-contracts").AgentTarget[] = [],
): HudAgentNode[] {
	const targetCapabilities = new Map<string, HudAgentCapabilities>();
	for (const target of targets) {
		targetCapabilities.set(target.id, {
			view: target.capabilities.view,
			steer: target.capabilities.steer,
			interrupt: target.capabilities.interrupt,
			kill:
				target.kind === "worker" ||
				(target.kind === "run" &&
					target.parentId?.startsWith("worker:") === true),
		});
	}
	const workers = new Map<
		string,
		{ node: HudAgentLeaf; children: HudAgentLeaf[] }
	>();
	const looseExec: HudAgentLeaf[] = [];

	for (const [key, agent] of execution?.agents ?? []) {
		const [deliverableId = "", name = key] = key.split("/");
		const blocked = execution?.deliverables.get(deliverableId)?.blocked;
		const leaf: HudAgentLeaf = {
			key: `exec:${key}`,
			label: `${name} · ${deliverableId}`,
			status: execStatus(agent, name === "worker" ? blocked : undefined),
			startedAt: agent.startedAt,
			...(agent.completedAt !== undefined
				? { completedAt: agent.completedAt }
				: {}),
			input:
				agent.tokens.promptTokens ??
				agent.tokens.input +
					(agent.tokens.cacheRead ?? 0) +
					(agent.tokens.cacheWrite ?? 0),
			output: agent.tokens.output,
			cacheRead: agent.tokens.cacheRead ?? 0,
			cacheWrite: agent.tokens.cacheWrite ?? 0,
			...(agent.model ? { model: agent.model, note: agent.model } : {}),
			...(agent.effort ? { effort: agent.effort } : {}),
			targetId: `worker:${key}`,
			capabilities: targetCapabilities.get(`worker:${key}`),
		};
		if (name === "worker") {
			const existing = workers.get(deliverableId);
			workers.set(deliverableId, {
				node: leaf,
				children: existing?.children ?? [],
			});
		} else {
			const parent = workers.get(deliverableId);
			if (parent) parent.children.push(leaf);
			else looseExec.push(leaf);
		}
	}
	// One-shots that arrived before their worker: re-home or keep at root.
	for (const leaf of looseExec) {
		const deliverableId = leaf.label.split(" · ")[1] ?? "";
		const parent = workers.get(deliverableId);
		if (parent) parent.children.push(leaf);
	}

	// Subagent runs: fresh non-terminal always; terminal only while recent.
	const visibleRuns = runs.filter((run) => {
		if (!TERMINAL_RUN_STATUSES.has(run.status)) return true;
		return now - (run.lastEventAt ?? run.updatedAt) <= RECENT_TERMINAL_MS;
	});
	const visibleIds = new Set(visibleRuns.map((run) => run.id as string));
	const rootRuns: { node: HudAgentLeaf; children: HudAgentLeaf[] }[] = [];
	const runChildren = new Map<string, HudAgentLeaf[]>();
	for (const run of visibleRuns) {
		const projection = run.profile.meta as
			| {
					ownerId?: string;
					confirmed?: boolean;
					usage?: import("@vegardx/pi-contracts").TokenSnapshot;
			  }
			| undefined;
		if (projection?.confirmed === false) continue;
		const usage = projection?.usage;
		const leaf: HudAgentLeaf = {
			key: `run:${run.id}`,
			label: runLabel(run),
			status: runStatus(run.status),
			startedAt: run.createdAt,
			...(run.completedAt !== undefined
				? { completedAt: run.completedAt }
				: {}),
			...(usage
				? {
						input: usage.promptTokens,
						output: usage.output,
						cacheRead: usage.cacheRead,
						cacheWrite: usage.cacheWrite,
					}
				: {}),
			...(run.profile.model
				? { model: run.profile.model, note: run.profile.model }
				: {}),
			...(run.profile.thinking ? { effort: run.profile.thinking } : {}),
			targetId: `run:${run.id}`,
			capabilities: targetCapabilities.get(`run:${run.id}`),
		};
		if (run.parent && visibleIds.has(run.parent as string)) {
			const list = runChildren.get(run.parent as string) ?? [];
			list.push(leaf);
			runChildren.set(run.parent as string, list);
		} else {
			const ownerId = projection?.ownerId;
			const worker = ownerId?.split("/")[0];
			const parent = worker ? workers.get(worker) : undefined;
			if (parent) parent.children.push(leaf);
			else rootRuns.push({ node: leaf, children: [] });
		}
	}
	for (const root of rootRuns) {
		const children = runChildren.get(root.node.key.slice("run:".length));
		if (children) root.children.push(...children);
	}

	const nodes: HudAgentNode[] = [];
	for (const { node, children } of workers.values()) {
		nodes.push({ ...node, children });
	}
	for (const leaf of looseExec) {
		const deliverableId = leaf.label.split(" · ")[1] ?? "";
		if (!workers.has(deliverableId)) nodes.push({ ...leaf, children: [] });
	}
	for (const { node, children } of rootRuns) {
		nodes.push({ ...node, children });
	}
	return nodes;
}

/**
 * Answer mode for a worker-queue entry: the same editor takeover the ask
 * engine uses. Answers resolve the queue entry (RPC reply to the worker) only
 * after the review screen's explicit Send action; Esc preserves a draft.
 */
function openWorkerAnswerMode(
	rt: RuntimeContext,
	ctx: ExtensionContext,
	agentId: string,
): void {
	const entry = rt.execution?.questionQueue
		.all()
		.find((candidate) => candidate.agentId === agentId);
	if (!entry) return;
	const [deliverableId = entry.agentId] = entry.agentId.split("/");
	const palette = ctx.ui.theme ? paletteFromTheme(ctx.ui.theme) : undefined;
	openAnswerMode(ctx.ui, {
		title: `${entry.agentName} · ${deliverableId}`,
		blocking: false,
		questions: entry.questions,
		...(palette ? { palette } : {}),
		...(entry.draft.length > 0 ? { initialAnswers: entry.draft } : {}),
		onDone: (answers) => {
			rt.execution?.questionQueue.answer(entry.agentId, answers);
			ctx.ui.notify(`Answered ${entry.agentName}`, "info");
		},
		onCancel: (draft) => {
			rt.execution?.questionQueue.saveDraft(entry.agentId, draft);
		},
		onClose: () => {
			rt.hud?.refresh();
		},
	});
}

/** The /steer prefix the runtime parses, addressed to the given target. */
export function steerPrefix(targetId: string): string | undefined {
	if (targetId.startsWith("worker:")) {
		const [deliverableId, name] = targetId.slice("worker:".length).split("/");
		if (!deliverableId) return undefined;
		return name && name !== "worker"
			? `/steer ${deliverableId} ${name}: `
			: `/steer ${deliverableId} `;
	}
	if (targetId.startsWith("run:")) {
		return `/steer ${targetId.slice("run:".length)} `;
	}
	return undefined;
}
