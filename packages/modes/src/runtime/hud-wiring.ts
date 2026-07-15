// HUD glue: builds the live HudSnapshot from runtime state, wires actions
// (attach/steer/interrupt/answer) and owns the refresh loop — mount-once via
// the OverlayManager, requestRender on events, plus a 5s elapsed tick while
// any agent is live. Presentation lives in runtime/hud.ts.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type Answer,
	CAPABILITIES,
	EVENTS,
	type PendingAsk,
	type RunRecord,
} from "@vegardx/pi-contracts";
import { uiTrace } from "@vegardx/pi-core";
import { openAnswerMode, paletteFromTheme } from "@vegardx/pi-ui";
import type { ExecutionAgentSnapshot } from "../exec/index.js";
import type { PendingQuestion } from "../question-queue.js";
import { effectiveWorkItemKind, type Plan } from "../schema.js";
import { handleViewCommand } from "./agent-commands.js";
import type { RuntimeContext } from "./context.js";
import {
	type HudAgentLeaf,
	type HudAgentNode,
	HudComponent,
	type HudPlanRow,
	type HudPlanView,
	type HudQuestionRow,
	type HudSnapshot,
	type HudStatus,
	type HudTab,
} from "./hud.js";

/** Re-render cadence while agents are live, so elapsed columns tick. */
const HUD_TICK_MS = 5_000;

export interface HudHandle {
	readonly component: HudComponent;
	/** Request a re-render and (re)arm the elapsed tick when agents are live. */
	refresh(): void;
	/** Switch tab + expand/focus the HUD (the /agents command). */
	show(tab: HudTab): void;
	dispose(): void;
}

/** Mount the HUD in the overlay manager's "agents" slot (idempotent). */
export function installHud(rt: RuntimeContext, ctx: ExtensionContext): void {
	if (rt.hud) {
		rt.hud.refresh();
		return;
	}
	let timer: ReturnType<typeof setInterval> | undefined;

	const component = new HudComponent({
		data: () => buildHudSnapshot(rt),
		theme: () => ctx.ui.theme,
		actions: {
			// Enter on an agent row: the /view tmux split (read-only attach).
			attach: (targetId) => {
				rt.overlayManager.focusInput();
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
				rt.overlayManager.focusInput();
				ctx.ui.setEditorText(prefix);
			},
			// i on an agent row: confirm, then abort that agent's turn/run.
			interrupt: (targetId) => {
				void (async () => {
					const yes = await ctx.ui.confirm(
						"Interrupt agent",
						`Interrupt ${targetId}? The session survives; only the current turn/run is aborted.`,
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
						const result = await subagents?.interrupt?.(
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
			// Enter on a question row: answer mode. Engine questions route
			// through the ask capability (same settle paths as the engine's
			// own takeover); worker-queue questions get the same editor with
			// answers resolving back over RPC.
			answer: (question) => {
				rt.overlayManager.focusInput();
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
		rt.overlayManager.invalidate();
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

	rt.hud = {
		component,
		refresh,
		show(tab: HudTab): void {
			component.setTab(tab);
			rt.overlayManager.focusOverlay("agents");
		},
		dispose(): void {
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
			for (const off of unsubscribe) off();
			rt.overlayManager.unmount("agents");
			rt.hud = undefined;
		},
	};

	uiTrace("hud.mount");
	rt.overlayManager.mount("agents", component);
	refresh();
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
	for (const run of subagents?.list() ?? []) {
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
	return {
		agents: buildAgentNodes(snap, subagents?.list() ?? [], Date.now()),
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
 */
export function buildPlanView(
	plan: Pick<Plan, "deliverables"> | undefined,
	execution?: { agents: ReadonlyMap<string, ExecutionAgentSnapshot> },
): HudPlanView | undefined {
	if (!plan) return undefined;
	let done = 0;
	const rows: HudPlanRow[] = plan.deliverables.map((d) => {
		const state =
			d.status === "shipped"
				? "shipped"
				: d.status === "complete"
					? "complete"
					: d.status === "active"
						? "active"
						: "queued";
		if (state === "shipped" || state === "complete") done++;
		const workerAgent = execution?.agents.get(`${d.id}/worker`);
		const worker = workerAgent
			? `worker ${execStatus(workerAgent, undefined)}`
			: `worker (${d.worker.mode})`;
		return {
			id: d.id,
			title: d.title,
			state,
			...(state === "active" ? { worker } : {}),
			tasks: d.tasks
				.filter((t) => effectiveWorkItemKind(t) === "task")
				.map((t) => ({ id: t.id, title: t.title, done: t.done })),
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
): HudAgentNode[] {
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
			...(agent.model ? { note: agent.model } : {}),
			targetId: `worker:${key}`,
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
		const leaf: HudAgentLeaf = {
			key: `run:${run.id}`,
			label: runLabel(run),
			status: runStatus(run.status),
			startedAt: run.createdAt,
			...(run.profile.model ? { note: run.profile.model } : {}),
			targetId: `run:${run.id}`,
		};
		if (run.parent && visibleIds.has(run.parent as string)) {
			const list = runChildren.get(run.parent as string) ?? [];
			list.push(leaf);
			runChildren.set(run.parent as string, list);
		} else {
			rootRuns.push({ node: leaf, children: [] });
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
 * engine uses, with committed answers resolving the queue entry (RPC reply
 * to the worker). Esc mid-way sends whatever was answered so far; nothing
 * answered leaves the entry queued.
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
	const collected: Answer[] = [];
	const palette = ctx.ui.theme ? paletteFromTheme(ctx.ui.theme) : undefined;
	openAnswerMode(ctx.ui, {
		title: `${entry.agentName} · ${deliverableId}`,
		blocking: false,
		questions: entry.questions,
		...(palette ? { palette } : {}),
		onAnswer: (answer) => collected.push(answer),
		onClose: () => {
			if (collected.length > 0) {
				rt.execution?.questionQueue.answer(entry.agentId, collected);
				ctx.ui.notify(`Answered ${entry.agentName}`, "info");
			}
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
