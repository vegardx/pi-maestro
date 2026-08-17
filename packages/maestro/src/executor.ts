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
	stuckReason,
} from "./run.js";
import type { WorkerSpawn } from "./spawn.js";
import type { PlanStore } from "./store.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * Where a deliverable's work happens. One worktree, one branch.
 *
 * There is no `remove`. Nothing tears a worktree down, because nothing has
 * needed to: a shipped deliverable's checkout is the thing you look at when the
 * pull request reads oddly, and a failed one's is the evidence. A cleanup
 * method nobody calls is a method that will be wired wrongly the day someone
 * does call it.
 */
export interface Workspace {
	create(
		deliverable: Deliverable,
		repoPath: string,
	): Promise<{ readonly path: string; readonly branch: string }>;
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
	on(
		event: "agentError",
		listener: (agentId: string, message: string) => void,
	): unknown;
	release(agentId: string): boolean;
}

/** The executor's view of the launcher: start one, and see how it ended. */
export interface WorkerHandle {
	/**
	 * Start a worker, and answer with its pid.
	 *
	 * Typed `void` until now, while the caller wrote the return value into the
	 * run record as the pid. TypeScript's void-return bivariance accepts both,
	 * so a conforming implementation returning nothing typechecks clean and
	 * silently records `pid: undefined` on every deliverable — which disables
	 * the orphan kill in `reclaim()` and puts two workers on one branch, the
	 * exact outcome the pid was written down to prevent.
	 */
	launch(spawn: WorkerSpawn): number | undefined;
	/**
	 * End a worker's process.
	 *
	 * The mechanism, not `shutdown`. A `shutdown` message says WHY over the wire
	 * and nothing in an agent acts on it — an agent is a pi session mid-turn, and
	 * an extension cannot politely end one. So the message is the courtesy and
	 * the signal is the effect; sending only the message would be a stop that
	 * stops nothing.
	 */
	kill(agentId: string): void;
	/** Resolves once the process is reaped, so its exit status is in hand. */
	settled(agentId: string): Promise<void>;
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
	/** How to start pi. Defaults to the pi this process is running. */
	readonly piCommand?: readonly string[];
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
	/**
	 * Whether a pid is a live process, and how to end one.
	 *
	 * Injected as two functions rather than taken from the launcher, because the
	 * pids these act on belong to a PREVIOUS maestro's workers — the launcher
	 * has no handle on them, only the run record does.
	 */
	readonly isAlive: (pid: number) => boolean;
	readonly killPid: (pid: number) => void;
}

export type ExecutorEvent =
	| { readonly type: "started"; readonly deliverable: Deliverable }
	| { readonly type: "status"; readonly id: string; readonly status: Status }
	| {
			readonly type: "finished";
			readonly id: string;
			readonly record: DeliverableRun;
	  }
	| { readonly type: "settled"; readonly run: Run }
	| {
			/**
			 * An agent said something went wrong.
			 *
			 * `link` emitted this for an explicit `error` message and for a
			 * malformed `done`, and NOTHING listened — so a worker saying "I
			 * cannot proceed, and here is why" was talking into the void, and a
			 * maestro looking at a stalled deliverable had no idea it had spoken.
			 */
			readonly type: "agentError";
			/** Absent when the agent is not one this run launched. */
			readonly id: string | undefined;
			readonly agentId: string;
			readonly message: string;
	  }
	| {
			/** The run can neither finish nor progress. Said, never silent. */
			readonly type: "stuck";
			readonly run: Run;
			readonly reason: string;
	  }
	| {
			readonly type: "reclaimed";
			/** In flight under a maestro that is gone; now unstarted again. */
			readonly relaunched: readonly string[];
			/** Of those, the ones whose worker was still executing. */
			readonly killed: readonly string[];
	  }
	| {
			readonly type: "stopped";
			readonly run: Run;
			readonly reason: string;
			/** Deliverables that were in flight, and are now unstarted again. */
			readonly halted: readonly string[];
	  };

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
	private halted = false;

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

	/**
	 * Take over a run this process did not start.
	 *
	 * A `running` record can only have been written by a live executor, and this
	 * executor is new — so any that survive belong to a maestro that is gone.
	 * Their workers are unreachable whether or not they are still executing: the
	 * socket they hold died with their maestro, so they can never report and can
	 * never be released. Left alone they wedge the plan permanently, because a
	 * `running` record sits in `startedIds` and is never launched again. A live
	 * drive proved exactly that — a SIGKILLed maestro left `stats: running`, the
	 * next `/run` launched nothing, and narrated nothing either.
	 *
	 * So the record is removed, which is the same answer `stop` reaches for the
	 * same reason: absent means unstarted, and unstarted is what it now is. The
	 * worktree and its commits stay, so the relaunch re-enters the same tree.
	 *
	 * The orphan is killed FIRST. It cannot finish anything useful, and it can
	 * still commit — so relaunching beside it would put two workers on one
	 * branch. This is also why the pid is written down: without it there is no
	 * way to tell a worker still running from one that died in the same crash.
	 */
	private reclaim(): void {
		const deliverables = { ...this.run.deliverables };
		const relaunched: string[] = [];
		const killed: string[] = [];
		for (const [id, record] of Object.entries(this.run.deliverables)) {
			if (record.state !== "running") continue;
			relaunched.push(id);
			delete deliverables[id];
			if (record.pid !== undefined && this.deps.isAlive(record.pid)) {
				this.deps.killPid(record.pid);
				killed.push(id);
			}
		}
		if (relaunched.length === 0) return;
		this.save({ deliverables });
		this.emit({ type: "reclaimed", relaunched, killed });
	}

	/** Run plan preflight, then start whatever that released. */
	async start(): Promise<void> {
		// Before anything else: a run left mid-flight by a maestro that is gone
		// is not a run in progress. Done here rather than in the constructor so
		// the seat has attached its listener and can narrate it.
		this.reclaim();
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
		// SERIALISED. `collect` runs as `void this.collect(...)` and awaits a
		// push and a `gh` call — seconds — so two workers finishing in that
		// window gave two overlapping `advance` calls. Both read the same run
		// state, both saw the same successor ready, and both called
		// `workspace.create` on one worktree; whichever lost wrote `failed` over
		// the `running` record the winner had just written, stranding dependents
		// while a live worker was still building it, and its eventual `done` was
		// dropped because the record no longer agreed.
		//
		// One queue rather than a lock: the second call waits, then reads state
		// that already includes the first's launches.
		this.advancing = this.advancing.then(() => this.advanceOnce());
		return this.advancing;
	}

	private advancing: Promise<void> = Promise.resolve();

	private async advanceOnce(): Promise<void> {
		if (this.halted) return;
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
		this.reportIfStuck();
	}

	/**
	 * Say so when the run can neither finish nor progress.
	 *
	 * The failure this closes was SILENCE, not the wedge itself. A maestro
	 * killed during plan preflight left a run that launched nothing and
	 * narrated nothing on every subsequent `/run` — indistinguishable from an
	 * idle seat, and only fixable by deleting `run.json`.
	 *
	 * Deliberately one check over the run's whole state rather than a repair for
	 * that one cause: a plan that cannot move is worth saying whatever put it
	 * there, including reasons nobody has thought of yet.
	 */
	private reportIfStuck(): void {
		if (this.halted) return;
		const reason = stuckReason(this.plan, this.run);
		if (reason) this.emit({ type: "stuck", run: this.run, reason });
	}

	private async launch(deliverable: Deliverable): Promise<void> {
		const repo = this.repoFor(deliverable);
		const { path, branch } = await this.deps.workspace.create(
			deliverable,
			repo,
		);
		const agentId = `worker-${deliverable.id}`;

		this.byAgent.set(agentId, deliverable.id);
		const started = this.deps.now();

		const spawn: WorkerSpawn = {
			agentId,
			cwd: path,
			sessionFile: this.deps.sessionFileFor(deliverable.id),
			kickoff: this.briefFor(deliverable),
			socketPath: this.deps.socketPath,
			token: this.deps.token,
			extensions: this.deps.extensions,
			...(this.deps.piCommand ? { piCommand: this.deps.piCommand } : {}),
			...(this.deps.model ? { model: this.deps.model } : {}),
		};
		// Launched BEFORE the record is written, so the record can carry the pid.
		// A record written first would be a record of a worker that might never
		// have started, and the pid is the only thing that survives this process
		// to tell a live worker from a dead one.
		const pid = this.deps.launcher.launch(spawn);
		// Watch the PROCESS, not just the socket.
		//
		// `disconnected` only fires for a worker that completed its handshake —
		// the link has no idea a socket exists until then. So a worker that died
		// BEFORE connecting produced no wire event at all: pi failing to start,
		// a bad extension path, a crash during load. The deliverable stayed
		// `running` forever, the run never settled, and nothing was narrated.
		// The launcher held the whole answer the entire time — exit code and
		// stderr — and nothing on that path ever read it.
		void this.watchProcess(deliverable.id, agentId);
		this.record(deliverable.id, {
			state: "running",
			worktree: path,
			branch,
			agentId,
			...(pid !== undefined ? { pid } : {}),
			session: this.deps.sessionFileFor(deliverable.id),
			startedAt: started,
		});
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

		// An agent reporting trouble used to reach NOBODY. `link` emitted
		// `agentError` for an explicit `error` message and for a malformed
		// `done`, and nothing anywhere listened — so a worker saying "I cannot
		// proceed and here is why" was talking into the void, and a maestro
		// looking at a stalled deliverable had no idea it had said anything.
		this.deps.link.on("agentError", (agentId, message) => {
			const id = this.byAgent.get(agentId);
			this.emit({ type: "agentError", id, agentId, message });
		});

		this.deps.link.on("disconnected", (agentId, awaitingRelease) => {
			// Awaiting release means it reported and `collect` already has the
			// result — this is just the process leaving. Anything else is a
			// worker that died mid-body.
			if (awaitingRelease) return;
			const id = this.byAgent.get(agentId);
			if (!id || this.run.deliverables[id]?.state !== "running") return;
			void this.recordSilentDeath(id, agentId);
		});
	}

	/**
	 * A worker whose PROCESS ended while its deliverable was still running.
	 *
	 * Covers the case the socket cannot see: a worker that never connected at
	 * all. For one that dies mid-body this simply arrives alongside
	 * `disconnected`, and `recordSilentDeath` drops the second arrival.
	 */
	private async watchProcess(id: string, agentId: string): Promise<void> {
		await this.deps.launcher.settled(agentId);
		if (this.halted) return;
		// Exited having reported: `collect` already has the result.
		if (this.run.deliverables[id]?.state !== "running") return;
		await this.recordSilentDeath(id, agentId);
	}

	/**
	 * A worker that closed its socket without reporting.
	 *
	 * The pause is the point. A socket closes the instant the process starts
	 * dying, but its stderr — the ONLY evidence of why, since it never reached
	 * the wire and may have written nothing to its session — arrives with the
	 * exit that follows — including the exit code, which is the difference
	 * between "it crashed", "it was killed" and "it decided it was done".
	 * Capturing at socket-close read an empty buffer and reported "the worker
	 * stopped without reporting" with nothing after it, which is the least
	 * useful true sentence available.
	 */
	private async recordSilentDeath(id: string, agentId: string): Promise<void> {
		await this.deps.launcher.settled(agentId);
		// Two sensors reach here — the socket closing, and the process being
		// reaped — and for a worker that dies mid-body BOTH fire. Whichever
		// arrives second must not record a second failure over the first.
		if (this.run.deliverables[id]?.state !== "running") return;
		const said = this.deps.launcher.capture(agentId, 40).trim();
		await this.fail(
			id,
			agentId,
			`the worker stopped without reporting.${said ? `\n${said}` : " It printed nothing on the way out."}`,
		);
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

	/**
	 * Halt the run: no more launches, and the workers in flight are ended.
	 *
	 * A halted deliverable is REMOVED from the run rather than marked. The run
	 * record says what happened, and "it was interrupted" is not an outcome — it
	 * did not fail, so recording a failure would strand its dependents for a
	 * reason that never occurred, and it is not still running, so leaving the
	 * record would put it in `startedIds` forever and it would never launch
	 * again. Absent means unstarted, which is exactly what it now is.
	 *
	 * Nothing is lost by that. The worktree and its branch stay on disk with
	 * whatever the worker committed, and `workspace.create` answers with the
	 * existing checkout — so resuming re-enters the same tree rather than
	 * starting the work over.
	 */
	async stop(reason: string): Promise<Run> {
		this.halted = true;
		const deliverables = { ...this.run.deliverables };
		const halted: string[] = [];
		for (const [id, record] of Object.entries(this.run.deliverables)) {
			if (record.state !== "running") continue;
			halted.push(id);
			delete deliverables[id];
			if (!record.agentId) continue;
			// The signal, and only the signal. There is a `shutdown` message on
			// the protocol and it is tempting to send it first as a courtesy —
			// but nothing in an agent listens for it, so it would be a message
			// into the void that made this read as a graceful stop. `shutdown`
			// belongs to the maestro REFUSING a connection, where the agent is
			// about to be dropped and the reason is all it will ever get.
			//
			// `AgentChannel` deliberately cannot shut an agent down: deciding an
			// agent is finished is the same decision as releasing it. Stopping is
			// not that decision, so it goes through the launcher — the thing that
			// owns the process — rather than widening the channel.
			this.deps.launcher.kill(record.agentId);
			this.byAgent.delete(record.agentId);
		}
		this.save({ deliverables });
		this.emit({ type: "stopped", run: this.run, reason, halted });
		return this.run;
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
			`Review through the \`${task.by.lens}\` lens with ${task.by.model}.` +
				(task.by.skill ? ` Use the available \`${task.by.skill}\` skill.` : ""),
		);
	return lines.join("\n\n");
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
