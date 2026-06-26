// Shipping policy for modes. Commit/GitHub mechanics live in pi-commit and
// pi-github; modes decides which deliverable is being shipped and writes the
// plan state after gates/reconciliation.

import type {
	CommitCapabilityV1,
	DeliverableId,
	ShipResult,
} from "@vegardx/pi-contracts";
import type { PlanEngine } from "./engine.js";
import { transitionThrough } from "./execution.js";
import { renderPlanMarkdown } from "./markdown.js";
import {
	type Deliverable,
	deliverables,
	findDeliverable,
	type Plan,
	readyDeliverables,
} from "./schema.js";

export interface ShipGateSummary {
	readonly deliverable: Deliverable;
	readonly message: string;
}

export interface ShipDeps {
	readonly commit: CommitCapabilityV1;
	readonly confirm: (summary: ShipGateSummary) => Promise<boolean> | boolean;
	readonly paths?: readonly string[];
	/**
	 * Produce the deliverable's forward-looking carry-forward summary. Called
	 * once per ship, only when `Deliverable.summary` is not already set. Returns
	 * undefined to ship without a summary (soft-fail: no model, empty session,
	 * wrong session, summariser failure). Never throws into the ship path.
	 */
	readonly summarise?: (
		deliverable: Deliverable,
	) => Promise<string | undefined> | string | undefined;
}

export type ShipDeliverableResult =
	| { kind: "shipped"; deliverable: Deliverable; result: ShipResult }
	| { kind: "canceled"; deliverable: Deliverable }
	| { kind: "missing"; reason: string };

export async function shipDeliverableFromPlan(
	engine: PlanEngine,
	deliverableId: string,
	deps: ShipDeps,
): Promise<ShipDeliverableResult> {
	const d = findDeliverable(engine.get(), deliverableId);
	if (!d)
		return { kind: "missing", reason: `unknown deliverable: ${deliverableId}` };
	const ok = await deps.confirm({
		deliverable: d,
		message: `Ship ${d.id}: ${d.title}`,
	});
	if (!ok) return { kind: "canceled", deliverable: d };
	const result = await deps.commit.shipDeliverable({
		deliverableId: d.id as DeliverableId,
		paths: deps.paths,
		openPr: true,
	});
	// `Deliverable.summary` is the one-time distilled, forward-looking hand-off
	// (see compaction.ts) — NOT a record of the PR. Write it once; never
	// regenerate or overwrite an existing summary (idempotent re-ship).
	let summary = d.summary;
	if (!summary && deps.summarise) {
		try {
			summary = (await deps.summarise(d)) ?? undefined;
		} catch {
			summary = undefined;
		}
	}
	engine.updateDeliverable(d.id, {
		prNumber: result.pr,
		...(summary ? { summary } : {}),
	});
	if (result.pr) transitionThrough(engine, d.id, "in-review");
	const updated = findDeliverable(engine.get(), d.id) ?? d;
	return { kind: "shipped", deliverable: updated, result };
}

export interface PrStateDeps {
	readonly state: (
		prNumber: number,
	) =>
		| Promise<"open" | "merged" | "closed" | null>
		| "open"
		| "merged"
		| "closed"
		| null;
}

export async function syncPrState(
	engine: PlanEngine,
	deps: PrStateDeps,
): Promise<{ shipped: string[]; closed: string[] }> {
	const shipped: string[] = [];
	const closed: string[] = [];
	for (const d of deliverables(engine.get())) {
		if (!d.prNumber || d.status === "shipped" || d.status === "abandoned") {
			continue;
		}
		const state = await deps.state(d.prNumber);
		if (state === "merged") {
			transitionThrough(engine, d.id, "shipped");
			shipped.push(d.id);
		} else if (state === "closed") {
			engine.setStatus(d.id, "needs-attention");
			closed.push(d.id);
		}
	}
	return { shipped, closed };
}

export interface ParkDeps {
	readonly createIssue: (input: {
		title: string;
		body: string;
		parent?: number;
	}) => Promise<number> | number;
}

export async function parkPlan(
	engine: PlanEngine,
	deps: ParkDeps,
): Promise<{ parent: number; children: number[] }> {
	const plan = engine.get();
	const parent = await deps.createIssue({
		title: plan.title,
		body: renderPlanMarkdown(plan),
	});
	engine.updatePlan({ parentIssueNumber: parent });
	const children: number[] = [];
	for (const d of deliverables(engine.get()).filter(
		(item) => !item.lifecycle,
	)) {
		if (d.issueNumber) continue;
		const issue = await deps.createIssue({
			title: d.title,
			body: deliverableIssueBody(engine.get(), d),
			parent,
		});
		engine.updateDeliverable(d.id, { issueNumber: issue });
		children.push(issue);
	}
	return { parent, children };
}

export function deliverableIssueBody(plan: Plan, d: Deliverable): string {
	const lines = [`Plan: ${plan.title} (${plan.slug})`, "", d.body];
	if (d.dependsOn?.length)
		lines.push("", `Depends on: ${d.dependsOn.join(", ")}`);
	return lines.join("\n").trim();
}

export function nextShippableDeliverable(plan: Plan): Deliverable | null {
	return (
		deliverables(plan).find((d) => d.status === "ready-to-ship") ??
		deliverables(plan).find((d) => d.status === "in-review") ??
		readyDeliverables(plan)[0] ??
		null
	);
}

export async function sweepMergedPrs(
	engine: PlanEngine,
	deps: PrStateDeps,
): Promise<string[]> {
	return (await syncPrState(engine, deps)).shipped;
}
