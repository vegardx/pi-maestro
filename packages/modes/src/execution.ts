// Execution driver: sequential execution, steering classification, and
// status transition helpers. Fanout is handled by HerdrFanout.

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
