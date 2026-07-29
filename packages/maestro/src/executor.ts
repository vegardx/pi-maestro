// The execution loop: what maestro does, and what it never delegates.
//
// Maestro owns the mechanical work at both ends of every deliverable — the
// worktree before, the hand-off and the pull request after — and it owns the
// agent's exit. A worker's whole job is the body in between. That split is the
// point: the old model asked the agent to ship its own work, so an agent that
// wandered off, crashed, or simply forgot took the deliverable with it.
//
// Plan preflight and postflight are different: those are AUTHORED tasks, prose
// for the maestro session to carry out, not mechanics this file can perform. So
// they arrive as a callback. Nothing here pretends to run them.

import { brief, type PersonaCatalogue } from "./agent.js";
import type { Deliverable, Plan, Task } from "./plan.js";
import type { Done, Status } from "./protocol.js";
import {
	beginRun,
	type DeliverableRun,
	type FlightRun,
	nextDeliverables,
	type Run,
	readyForPostflight,
	runSettled,
	standings,
} from "./run.js";
import type { WorkerSpawn } from "./spawn.js";
import type { PlanStore } from "./store.js";
import type { ToolRegistry } from "./tool-registry.js";

/** Where a deliverable's work happens. One worktree, one branch. */
export interface Workspace {
	create(
		deliverable: Deliverable,
		repoPath: string,
	): Promise<{ readonly path: string; readonly branch: string }>;
	remove(path: string): Promise<void>;
}

export interface ShipRequest {
	readonly deliverable: Deliverable;
	readonly worktree: string;
	readonly branch: string;
	readonly handoff?: string;
}

export interface Shipping {
	/** Push and open or refresh the pull request. `undefined` = nothing to ship. */
	ship(request: ShipRequest): Promise<number | undefined>;
}

/**
 * The executor's view of the wire. Narrower than `MaestroLink` on purpose: it
 * listens, and it releases. It cannot shut an agent down, because deciding an
 * agent is finished is the same decision as releasing it.
 */
export interface AgentChannel {
	on(
		event: "status",
		listener: (agentId: string, status: Status) => void,
	): unknown;
	on(event: "done", listener: (agentId: string, done: Done) => void): unknown;
	on(
		event: "disconnected",
		listener: (agentId: string, awaitingRelease: boolean) => void,
	): unknown;
	release(agentId: string): boolean;
}

/** The executor's view of the launcher: start one, and see what it printed. */
export interface WorkerHandle {
	launch(spawn: WorkerSpawn): void;
	capture(agentId: string, lines?: number): string;
}

/** What the executor needs that it cannot do itself. */
export interface ExecutorDeps {
	readonly store: PlanStore;
	readonly link: AgentChannel;
	readonly launcher: WorkerHandle;
	readonly workspace: Workspace;
	readonly shipping: Shipping;
	readonly tools: ToolRegistry;
	readonly personas: PersonaCatalogue;
	/** The persona a deliverable's worker is given. */
	readonly workerPersona: string;
	readonly socketPath: string;
	readonly token: string;
	readonly extensions: readonly string[];
	/**
	 * Carry out authored maestro tasks. Supplied by whatever owns the maestro
	 * session, because this is prose to act on, not mechanics — the executor
	 * would only be guessing at what "make sure the repo exists" means.
	 */
	readonly runMaestroTasks: (
		tasks: readonly Task[],
		where: string,
	) => Promise<void>;
	readonly now: () => string;
	/** Where a worker's pi session file goes. */
	readonly sessionFileFor: (deliverableId: string) => string;
	readonly model?: string;
}

export type ExecutorEvent =
	| { readonly type: "started"; readonly deliverable: Deliverable }
	| { readonly type: "status"; readonly id: string; readonly status: Status }
	| {
			readonly type: "finished";
			readonly id: string;
			readonly record: DeliverableRun;
	  }
	| { readonly type: "settled"; readonly run: Run };

/**
 * Drives one plan.
 *
 * Everything it learns it writes down before acting on it, because a maestro
 * that crashes between "the worker said it succeeded" and "the run says so" has
 * lost the only copy.
 */
export class Executor {
	private run: Run;
	private readonly byAgent = new Map<string, string>();
	private readonly listeners: ((event: ExecutorEvent) => void)[] = [];

	constructor(
		private readonly plan: Plan,
		private readonly deps: ExecutorDeps,
	) {
		this.run = deps.store.loadRun(plan.slug) ?? beginRun(plan.slug, deps.now());
		this.wire();
	}

	on(listener: (event: ExecutorEvent) => void): void {
		this.listeners.push(listener);
	}

	state(): Run {
		return this.run;
	}

	/** Run plan preflight, then start whatever that released. */
	async start(): Promise<void> {
		if (this.run.preflight === undefined) {
			this.save({
				preflight: { state: "running", startedAt: this.deps.now() },
			});
			try {
				await this.deps.runMaestroTasks(this.plan.preflight, "plan preflight");
				this.save({ preflight: this.landed("preflight", "done") });
			} catch (error) {
				// Nothing may start: preflight is what guarantees the repos every
				// deliverable is about to be checked out of.
				this.save({
					preflight: this.landed("preflight", "failed", reasonOf(error)),
				});
				this.emit({ type: "settled", run: this.run });
				return;
			}
		}
		await this.advance();
	}

	/**
	 * Launch everything whose predecessors have succeeded.
	 *
	 * Failures do not stop this — a failed deliverable strands its own
	 * dependents and nothing else, which is what lets independent branches
	 * finish instead of one bad model turn ending the whole plan.
	 */
	async advance(): Promise<void> {
		for (const deliverable of nextDeliverables(this.plan, this.run)) {
			try {
				await this.launch(deliverable);
			} catch (error) {
				// Preflight failing is the deliverable failing. It never ran, so
				// there is no worktree to clean up and no agent to release.
				this.finished(deliverable.id, {
					state: "failed",
					failure: `preflight: ${reasonOf(error)}`,
					startedAt: this.deps.now(),
					endedAt: this.deps.now(),
				});
			}
		}
		await this.settleIfDone();
	}

	private async launch(deliverable: Deliverable): Promise<void> {
		const repo = this.repoFor(deliverable);
		const { path, branch } = await this.deps.workspace.create(
			deliverable,
			repo,
		);
		const agentId = `worker-${deliverable.id}`;

		this.byAgent.set(agentId, deliverable.id);
		this.record(deliverable.id, {
			state: "running",
			worktree: path,
			branch,
			agentId,
			session: this.deps.sessionFileFor(deliverable.id),
			startedAt: this.deps.now(),
		});

		const spawn: WorkerSpawn = {
			agentId,
			cwd: path,
			sessionFile: this.deps.sessionFileFor(deliverable.id),
			kickoff: this.briefFor(deliverable),
			socketPath: this.deps.socketPath,
			token: this.deps.token,
			extensions: this.deps.extensions,
			...(this.deps.model ? { model: this.deps.model } : {}),
		};
		this.deps.launcher.launch(spawn);
		this.emit({ type: "started", deliverable });
	}

	/** The worker's whole context: its persona, its tools, its work. */
	private briefFor(deliverable: Deliverable): string {
		return brief(
			{ kind: "worker", persona: this.deps.workerPersona },
			this.deps.personas,
			this.deps.tools,
			this.assignmentFor(deliverable),
		);
	}

	private assignmentFor(deliverable: Deliverable): string {
		const parts = [`# ${deliverable.title}`];
		if (deliverable.body?.trim()) parts.push(deliverable.body.trim());

		// Only what this deliverable DECLARED it reads. `after` is ordering: a
		// deliverable that merely waited for something does not pay for its
		// predecessor's whole hand-off in context.
		const inherited = deliverable.reads
			.map((id) => ({ id, handoff: this.run.deliverables[id]?.handoff }))
			.filter((r) => r.handoff?.trim());
		if (inherited.length > 0)
			parts.push(
				[
					"## What you inherit",
					...inherited.map((r) => `### From \`${r.id}\`\n\n${r.handoff}`),
				].join("\n\n"),
			);

		parts.push(
			[
				"## Your work, in order",
				...deliverable.tasks.map((task, i) => describeTask(task, i)),
			].join("\n\n"),
		);
		return parts.join("\n\n");
	}

	// ─── The far end of a deliverable ────────────────────────────────────────

	private wire(): void {
		this.deps.link.on("status", (agentId, status) => {
			const id = this.byAgent.get(agentId);
			if (id) this.emit({ type: "status", id, status });
		});

		this.deps.link.on("done", (agentId, done) => {
			void this.collect(agentId, done);
		});

		this.deps.link.on("disconnected", (agentId, awaitingRelease) => {
			// Awaiting release means it reported and `collect` already has the
			// result — this is just the process leaving. Anything else is a
			// worker that died mid-body.
			if (awaitingRelease) return;
			const id = this.byAgent.get(agentId);
			if (!id || this.run.deliverables[id]?.state !== "running") return;
			void this.fail(
				id,
				agentId,
				`the worker stopped without reporting.\n${this.deps.launcher.capture(agentId, 40)}`,
			);
		});
	}

	/**
	 * Postflight: take the hand-off, ship the branch, then let the agent go.
	 *
	 * The order is the whole reason maestro owns the exit. Shipping happens
	 * while the worker is still alive, so a push that fails can still be told
	 * apart from a worker that never produced anything — and the release only
	 * happens once the result is recorded.
	 */
	private async collect(agentId: string, done: Done): Promise<void> {
		const id = this.byAgent.get(agentId);
		if (!id) return;
		const deliverable = this.plan.deliverables.find((d) => d.id === id);
		const record = this.run.deliverables[id];
		if (!deliverable || !record) return;

		if (done.outcome === "failed") {
			await this.fail(id, agentId, done.failure ?? "no reason given");
			return;
		}

		let pr: number | undefined;
		try {
			pr = await this.deps.shipping.ship({
				deliverable,
				worktree: record.worktree as string,
				branch: record.branch as string,
				...(done.handoff ? { handoff: done.handoff } : {}),
			});
		} catch (error) {
			await this.fail(id, agentId, `shipping: ${reasonOf(error)}`);
			return;
		}

		this.finished(id, {
			...record,
			state: "done",
			...(done.handoff ? { handoff: done.handoff } : {}),
			...(pr !== undefined ? { pr } : {}),
			endedAt: this.deps.now(),
		});
		this.release(agentId);
		await this.advance();
	}

	private async fail(
		id: string,
		agentId: string,
		failure: string,
	): Promise<void> {
		const record = this.run.deliverables[id];
		this.finished(id, {
			...(record ?? { state: "failed", startedAt: this.deps.now() }),
			state: "failed",
			failure,
			endedAt: this.deps.now(),
		});
		this.release(agentId);
		await this.advance();
	}

	private release(agentId: string): void {
		this.byAgent.delete(agentId);
		// Released only after the result is written down. An agent let go any
		// earlier is an agent whose result exists nowhere but in memory.
		this.deps.link.release(agentId);
	}

	private async settleIfDone(): Promise<void> {
		if (readyForPostflight(this.plan, this.run)) {
			this.save({
				postflight: { state: "running", startedAt: this.deps.now() },
			});
			try {
				await this.deps.runMaestroTasks(
					this.plan.postflight,
					"plan postflight",
				);
				this.save({ postflight: this.landed("postflight", "done") });
			} catch (error) {
				this.save({
					postflight: this.landed("postflight", "failed", reasonOf(error)),
				});
			}
		}
		if (runSettled(this.plan, this.run))
			this.emit({ type: "settled", run: this.run });
	}

	/** Where each deliverable stands — shipped, failed, stranded or never run. */
	report(): Map<string, string> {
		return standings(this.plan, this.run);
	}

	// ─── Bookkeeping ─────────────────────────────────────────────────────────

	private repoFor(deliverable: Deliverable): string {
		const key = deliverable.repo;
		const repo = key
			? this.plan.repos.find((r) => r.key === key)
			: this.plan.repos[0];
		if (!repo)
			throw new Error(
				`deliverable \`${deliverable.id}\` names repo \`${key}\`, which the plan does not declare`,
			);
		return repo.path;
	}

	private landed(
		which: "preflight" | "postflight",
		state: "done" | "failed",
		failure?: string,
	): FlightRun {
		const flight = this.run[which];
		return {
			state,
			...(failure ? { failure } : {}),
			startedAt: flight?.startedAt ?? this.deps.now(),
			endedAt: this.deps.now(),
		};
	}

	private record(id: string, record: DeliverableRun): void {
		this.save({ deliverables: { ...this.run.deliverables, [id]: record } });
	}

	private finished(id: string, record: DeliverableRun): void {
		this.record(id, record);
		this.emit({ type: "finished", id, record });
	}

	private save(patch: Partial<Run>): void {
		this.run = { ...this.run, ...patch };
		this.deps.store.saveRun(this.run);
	}

	private emit(event: ExecutorEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}

function describeTask(task: Task, index: number): string {
	const lines = [`### ${index + 1}. ${task.title}`];
	if (task.body?.trim()) lines.push(task.body.trim());
	if (task.by)
		lines.push(
			// The kind and persona, never a tool name — what an agent can call is
			// generated from the declaration, and prose that repeats it can drift.
			`Delegate this to ${article(task.by.agent)} ${task.by.agent} with the \`${task.by.persona}\` persona` +
				(task.by.fanOut
					? ", across several model families, and reconcile what they return."
					: "."),
		);
	return lines.join("\n\n");
}

function article(word: string): string {
	return /^[aeiou]/.test(word) ? "an" : "a";
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
