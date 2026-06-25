// Execution driver skeleton. Modes owns orchestration and plan writes; work is
// performed either by the foreground session (sequential) or by subagents.v1
// deliverable workers (fanout). Workers never write the plan file.

import type {
	RunHandle,
	RunId,
	RunProgress,
	RunResult,
	SubagentsCapabilityV1,
} from "@vegardx/pi-contracts";
import type { PlanEngine } from "./engine.js";
import { renderPlanSeed } from "./markdown.js";
import {
	type Deliverable,
	type DeliverableStatus,
	deliverables,
	gatingTasks,
	pendingLifecycle,
	readyDeliverables,
} from "./schema.js";

export type SequentialStartResult =
	| { kind: "started"; deliverable: Deliverable; seed: string }
	| { kind: "already-active"; deliverable: Deliverable }
	| { kind: "blocked"; reason: string }
	| { kind: "idle"; reason: string };

export interface SequentialExecutionDeps {
	readonly sendSeed?: (seed: string, deliverable: Deliverable) => void;
	readonly onPlanChanged?: () => void;
}

export function completionGateSatisfied(d: Deliverable): boolean {
	const tasks = gatingTasks(d);
	return tasks.length === 0 || tasks.every((task) => task.done);
}

export function startSequentialExecution(
	engine: PlanEngine,
	deps: SequentialExecutionDeps = {},
): SequentialStartResult {
	const plan = engine.get();
	const pre = pendingLifecycle(plan, "pre");
	if (pre) {
		return { kind: "blocked", reason: `preflight \`${pre.id}\` is incomplete` };
	}
	const active = deliverables(plan).find((d) => d.status === "active");
	if (active) return { kind: "already-active", deliverable: active };
	const next = readyDeliverables(plan)[0];
	if (!next) return { kind: "idle", reason: "no ready deliverables" };
	engine.setStatus(next.id, "active");
	const deliverable =
		deliverables(engine.get()).find((d) => d.id === next.id) ?? next;
	const seed = renderPlanSeed(engine.get(), deliverable.id);
	deps.sendSeed?.(seed, deliverable);
	deps.onPlanChanged?.();
	return { kind: "started", deliverable, seed };
}

export function completeActiveDeliverable(
	engine: PlanEngine,
	deliverableId: string,
): boolean {
	const d = deliverables(engine.get()).find(
		(candidate) => candidate.id === deliverableId,
	);
	if (d?.status !== "active" || !completionGateSatisfied(d)) return false;
	engine.setStatus(deliverableId, "in-review");
	return true;
}

export type SteeringIntent = "continue" | "status" | "stop";

export function classifyExecutionSteering(text: string): SteeringIntent {
	const normalized = text.toLowerCase();
	if (/\b(stop|cancel|abort|pause)\b/.test(normalized)) return "stop";
	if (/\b(status|progress|where are we|what is running)\b/.test(normalized)) {
		return "status";
	}
	return "continue";
}

export interface FanoutDeps {
	readonly engine: PlanEngine;
	readonly subagents: SubagentsCapabilityV1;
	readonly cwd?: string;
	readonly prepareDeliverable?: (
		deliverable: Deliverable,
	) => { cwd?: string } | undefined;
	readonly onPlanChanged?: () => void;
	readonly onSpawn?: (deliverable: Deliverable, handle: RunHandle) => void;
	readonly onProgress?: (
		deliverable: Deliverable,
		progress: RunProgress,
	) => void;
}

export interface FanoutSnapshot {
	readonly active: ReadonlyMap<RunId, string>;
	readonly spawnedDeliverables: ReadonlySet<string>;
}

export class FanoutOrchestrator {
	private active = new Map<RunId, string>();
	private spawnedDeliverables = new Set<string>();

	constructor(private readonly deps: FanoutDeps) {}

	snapshot(): FanoutSnapshot {
		return {
			active: new Map(this.active),
			spawnedDeliverables: new Set(this.spawnedDeliverables),
		};
	}

	tick(): number {
		const plan = this.deps.engine.get();
		if (pendingLifecycle(plan, "pre")) return 0;
		let spawned = 0;
		for (const d of readyDeliverables(plan)) {
			if (this.spawnedDeliverables.has(d.id)) continue;
			this.deps.engine.setStatus(d.id, "active");
			const current =
				deliverables(this.deps.engine.get()).find((x) => x.id === d.id) ?? d;
			const prepared = this.deps.prepareDeliverable?.(current);
			const handle = this.deps.subagents.spawn(
				renderPlanSeed(this.deps.engine.get(), d.id),
				{
					profile: "deliverable-worker",
					cwd: prepared?.cwd ?? this.deps.cwd ?? plan.repoPath,
				},
			);
			this.spawnedDeliverables.add(d.id);
			this.active.set(handle.id, d.id);
			this.deps.onSpawn?.(current, handle);
			handle.result().then((result) => this.settle(handle.id, result));
			spawned += 1;
		}
		if (spawned > 0) this.deps.onPlanChanged?.();
		return spawned;
	}

	settle(runId: RunId, result: RunResult): void {
		const deliverableId = this.active.get(runId);
		if (!deliverableId) return;
		this.active.delete(runId);
		if (result.status === "succeeded") {
			this.markSucceeded(deliverableId, result.summary);
		} else if (result.status === "failed") {
			this.markNeedsAttention(deliverableId, result.error ?? result.summary);
		}
		this.deps.onPlanChanged?.();
		this.tick();
	}

	progress(runId: RunId, progress: RunProgress): void {
		const deliverableId = this.active.get(runId);
		if (!deliverableId) return;
		const deliverable = deliverables(this.deps.engine.get()).find(
			(d) => d.id === deliverableId,
		);
		if (deliverable) this.deps.onProgress?.(deliverable, progress);
	}

	private markSucceeded(
		deliverableId: string,
		summary: string | undefined,
	): void {
		const shipped = parseShippedPr(summary ?? "");
		if (shipped) {
			this.deps.engine.updateDeliverable(deliverableId, {
				prNumber: shipped,
				summary,
			});
			transitionThrough(this.deps.engine, deliverableId, "shipped");
			return;
		}
		this.deps.engine.updateDeliverable(deliverableId, { summary });
		transitionThrough(this.deps.engine, deliverableId, "in-review");
	}

	private markNeedsAttention(
		deliverableId: string,
		summary: string | undefined,
	): void {
		this.deps.engine.updateDeliverable(deliverableId, { summary });
		transitionThrough(this.deps.engine, deliverableId, "needs-attention");
	}
}

export function parseShippedPr(text: string): number | null {
	const match =
		text.match(/(?:PR|pull request|#)\s*#?(\d+)/i) ??
		text.match(/\/pull\/(\d+)/i);
	if (!match) return null;
	const n = Number(match[1]);
	return Number.isInteger(n) && n > 0 ? n : null;
}

export function transitionThrough(
	engine: PlanEngine,
	deliverableId: string,
	target: DeliverableStatus,
): void {
	const order: readonly DeliverableStatus[] = [
		"planned",
		"active",
		"in-review",
		"ready-to-ship",
		"shipped",
	];
	let current = deliverables(engine.get()).find(
		(d) => d.id === deliverableId,
	)?.status;
	if (!current || current === target) return;
	if (target === "needs-attention") {
		if (current === "planned") engine.setStatus(deliverableId, "active");
		current = deliverables(engine.get()).find(
			(d) => d.id === deliverableId,
		)?.status;
		if (current === "active") engine.setStatus(deliverableId, "in-review");
		current = deliverables(engine.get()).find(
			(d) => d.id === deliverableId,
		)?.status;
		if (current === "in-review")
			engine.setStatus(deliverableId, "needs-attention");
		return;
	}
	const from = order.indexOf(current);
	const to = order.indexOf(target);
	if (from < 0 || to < 0 || from > to) return;
	for (const status of order.slice(from + 1, to + 1)) {
		engine.setStatus(deliverableId, status);
	}
}
