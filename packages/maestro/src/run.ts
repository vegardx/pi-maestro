// The run: what happened, keyed by what was authored.
//
// `plan.ts` holds the agreement; this holds the outcome. They are separate
// types because they have separate lifetimes — a plan is written when it is
// authored and rewritten only when it is amended, while a run is rewritten on
// every transition. Conflating them is why the old model needed rules about
// which fields could be edited once a node had started, and why "is this plan
// valid" was never answerable from the plan alone.
//
// NOTHING DERIVABLE IS STORED. A deliverable that no dependent could ever
// reach is *stranded*, but stranding is a fact about the plan's shape plus the
// set of failures, so it is computed, never written down. A second place to
// record the same fact is a second place for it to be wrong, which is the
// defect class this rebuild exists to remove.

import {
	type Deliverable,
	type Plan,
	readyDeliverables,
	strandedByFailure,
} from "./plan.js";

/**
 * A deliverable's state. There is no `pending`: a deliverable absent from the
 * run has not started. One representation, so "no record" and "a record saying
 * pending" cannot disagree.
 */
export type DeliverableState = "running" | "done" | "failed";

export interface DeliverableRun {
	readonly state: DeliverableState;
	/** The worktree maestro's preflight created for it. */
	readonly worktree?: string;
	/** The worker running the body, while one is running. */
	readonly agentId?: string;
	/**
	 * That worker's process id.
	 *
	 * Written down because the launcher's handle on a worker lives in memory and
	 * dies with the maestro. A maestro restarting onto a run it did not start
	 * cannot otherwise tell a worker still building from one that died in the
	 * same crash — and the difference is relaunching a deliverable versus
	 * putting two workers on one branch.
	 */
	readonly pid?: number;
	/** Its session file — how a restarted maestro re-attaches rather than restarts. */
	readonly session?: string;
	readonly branch?: string;
	readonly pr?: number;
	/**
	 * What postflight collected: the hand-off that dependents naming this
	 * deliverable in `reads` are given. Absent means it produced none.
	 */
	readonly handoff?: string;
	/** Why it failed. Required when the state is `failed`. */
	readonly failure?: string;
	readonly startedAt: string;
	/** Set exactly when the state is terminal. */
	readonly endedAt?: string;
}

export type FlightState = "running" | "done" | "failed";

/** Plan-level preflight or postflight — maestro's own work, not a deliverable's. */
export interface FlightRun {
	readonly state: FlightState;
	readonly failure?: string;
	readonly startedAt: string;
	readonly endedAt?: string;
}

export interface Run {
	readonly slug: string;
	readonly startedAt: string;
	/** Absent = not yet run. Nothing may start until this is `done`. */
	readonly preflight?: FlightRun;
	readonly postflight?: FlightRun;
	readonly deliverables: Readonly<Record<string, DeliverableRun>>;
}

export function beginRun(slug: string, startedAt: string): Run {
	return { slug, startedAt, deliverables: {} };
}

/**
 * Everything wrong with a run *against the plan it claims to be a run of*.
 *
 * The check that matters is the first one: a run whose ids the plan does not
 * declare is drift — the same shape of defect as a tool granted by name with no
 * implementation behind it. It is cheap to catch here and invisible everywhere
 * else.
 */
export function validateRun(plan: Plan, run: Run): string[] {
	const errors: string[] = [];

	if (run.slug !== plan.slug)
		errors.push(`run is for \`${run.slug}\`, plan is \`${plan.slug}\``);

	const ids = new Set(plan.deliverables.map((d) => d.id));
	for (const [id, record] of Object.entries(run.deliverables)) {
		if (!ids.has(id))
			errors.push(`run records \`${id}\`, which the plan does not declare`);
		if (record.state === "failed" && !record.failure?.trim())
			errors.push(`${id}: failed with no reason recorded`);
		if (record.state === "running" && record.endedAt !== undefined)
			errors.push(`${id}: still running, but has an end time`);
		if (record.state !== "running" && record.endedAt === undefined)
			errors.push(`${id}: ${record.state}, but never ended`);
	}

	const flights = [
		["preflight", run.preflight],
		["postflight", run.postflight],
	] as const;
	for (const [where, flight] of flights) {
		if (!flight) continue;
		if (flight.state === "failed" && !flight.failure?.trim())
			errors.push(`${where}: failed with no reason recorded`);
		if (flight.state !== "running" && flight.endedAt === undefined)
			errors.push(`${where}: ${flight.state}, but never ended`);
	}

	return errors;
}

/** Deliverables that finished successfully. */
export function succeededIds(run: Run): Set<string> {
	return idsWhere(run, (r) => r.state === "done");
}

/** Deliverables that failed on their own terms — not ones stranded by another. */
export function failedIds(run: Run): Set<string> {
	return idsWhere(run, (r) => r.state === "failed");
}

/** Everything that has a record at all: started is started, however it ended. */
export function startedIds(run: Run): Set<string> {
	return new Set(Object.keys(run.deliverables));
}

function idsWhere(
	run: Run,
	predicate: (record: DeliverableRun) => boolean,
): Set<string> {
	return new Set(
		Object.entries(run.deliverables)
			.filter(([, record]) => predicate(record))
			.map(([id]) => id),
	);
}

/**
 * What maestro may start right now.
 *
 * Plan preflight is a barrier, not a DAG root — "every deliverable waits for
 * this" is a global fact, and expressing it as edges would depend on the author
 * remembering one edge per deliverable. So the gate lives here, once, where it
 * cannot be forgotten. A plan with an empty preflight list still records a
 * `done` flight; satisfying the barrier has exactly one representation.
 */
export function nextDeliverables(plan: Plan, run: Run): Deliverable[] {
	if (run.preflight?.state !== "done") return [];
	return readyDeliverables(plan, succeededIds(run), startedIds(run));
}

/**
 * Whether plan postflight may run: every deliverable succeeded, and it has not
 * run already.
 *
 * Success-path only. Plan postflight is the step that acts on the whole — the
 * release, the summary that claims the arc landed — and running it over a plan
 * that half-failed produces exactly the confidently-wrong artifact this system
 * has produced before. A partial run ends without it, and the standings say why.
 */
export function readyForPostflight(plan: Plan, run: Run): boolean {
	if (run.preflight?.state !== "done") return false;
	if (run.postflight !== undefined) return false;
	const done = succeededIds(run);
	return plan.deliverables.every((d) => done.has(d.id));
}

/**
 * Where each deliverable stands.
 *
 * `stranded` is separated from `waiting` deliberately: both have never run, and
 * a final report that shows them alike is a report that hides the failure that
 * caused half of it. Once independent branches are allowed to finish, "the plan
 * ran" stops meaning "the plan is done", and the difference has to be legible.
 */
export type Standing =
	| "shipped"
	| "failed"
	| "stranded"
	| "running"
	| "waiting";

export function standings(plan: Plan, run: Run): Map<string, Standing> {
	const stranded = strandedByFailure(plan, failedIds(run));
	const out = new Map<string, Standing>();
	for (const d of plan.deliverables) {
		const record = run.deliverables[d.id];
		if (record?.state === "done") out.set(d.id, "shipped");
		else if (record?.state === "failed") out.set(d.id, "failed");
		else if (record?.state === "running") out.set(d.id, "running");
		else if (stranded.has(d.id)) out.set(d.id, "stranded");
		else out.set(d.id, "waiting");
	}
	return out;
}

/**
 * Whether the run can make no further progress: nothing is running, and nothing
 * is startable. True for a clean finish and for a half-failed one alike — which
 * of those it was is the standings' job to say, not this one's.
 */
/**
 * Why a run can neither finish nor progress — or null if that is not its state.
 *
 * Derived, like everything else here. The case that forced it: a maestro killed
 * during plan preflight leaves `preflight: {state: "running"}`, and on restart
 * `start()` skips preflight (it is no longer `undefined`), `nextDeliverables`
 * returns nothing (it gates on preflight being done), `settleIfDone` finds
 * nothing to settle, and NO EVENT IS EMITTED AT ALL. `/run` launched nothing and
 * narrated nothing, forever, and the only remedy was deleting `run.json`.
 *
 * The fix is not another recovery mechanism. It is that a run which cannot move
 * must SAY SO — for this cause and for the ones nobody has thought of, which is
 * why the last branch is a catch-all rather than an enumeration.
 */
export function stuckReason(plan: Plan, run: Run): string | null {
	if (runSettled(plan, run)) return null;
	// Something is working, or something can start: not stuck, just busy.
	if (Object.values(run.deliverables).some((r) => r.state === "running"))
		return null;
	if (nextDeliverables(plan, run).length > 0) return null;
	if (readyForPostflight(plan, run)) return null;

	if (run.preflight === undefined) return "plan preflight has not run yet";
	if (run.preflight.state === "running")
		return "plan preflight was left running — the maestro that began it is gone, so nothing can start";
	if (run.postflight?.state === "running")
		return "plan postflight was left running — the maestro that began it is gone";
	return "nothing is running and nothing can start";
}

export function runSettled(plan: Plan, run: Run): boolean {
	if (run.preflight === undefined) return false;
	if (run.preflight.state === "running") return false;
	if (run.preflight.state === "failed") return true;
	if (run.postflight?.state === "running") return false;
	const anyRunning = Object.values(run.deliverables).some(
		(r) => r.state === "running",
	);
	if (anyRunning) return false;
	if (nextDeliverables(plan, run).length > 0) return false;
	return !readyForPostflight(plan, run);
}
