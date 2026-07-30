// The maestro's own session: what it holds, and what it narrates.
//
// A worker's job ends at `finish`. The maestro's does not end at all — it is
// the seat a human sits in, so this holds the mode, the socket, the executor
// for whatever plan is running, and the narration that makes a fleet of
// detached processes legible from one terminal.
//
// The interesting piece is `runMaestroTasks`. Plan preflight and postflight are
// AUTHORED PROSE, not mechanics, so the executor cannot perform them — it hands
// them back here, and here they are given to the maestro's own model, which
// signals completion the same way a worker does. Same shape, one level up: the
// thing that was asked to do work says when it is done.

import { randomUUID } from "node:crypto";
import {
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Answers, AskInboxV1 } from "@vegardx/pi-contracts";
import type { Executor, ExecutorEvent } from "./executor.js";
import { MaestroLink } from "./link.js";
import { type Mode, type ModeName, mode as modeNamed } from "./mode.js";
import type { Plan, Task } from "./plan.js";
import type { Run } from "./run.js";

/** A flight the maestro has been asked to carry out and has not finished. */
interface PendingFlight {
	readonly where: string;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
}

export interface Narrator {
	/** One line about what the fleet just did. */
	say(line: string): void;
	/** Prose the maestro's own model must act on. */
	ask(prompt: string): void;
}

export interface RuntimeOptions {
	readonly narrator: Narrator;
	/**
	 * Where a worker's question goes: `packages/ask`'s inbox.
	 *
	 * A function rather than a value because the capability is registered by
	 * another extension, and load order is not ours to depend on — resolved when
	 * a question actually arrives, which is always after boot.
	 *
	 * Absent = nothing can answer, and a worker is told so rather than left
	 * blocked forever.
	 */
	readonly inbox?: () => AskInboxV1 | undefined;
	readonly socketPath: string;
	/** Absent = a fresh token per session, which is what an ordinary run wants. */
	readonly token?: string;
	readonly now?: () => string;
}

/**
 * What a maestro session holds.
 *
 * One at a time, deliberately: a second concurrent plan would need a second
 * socket, a second token and a second fleet of narration, and nothing has asked
 * for that. The plan model already expresses "several things at once" as
 * deliverables in one DAG.
 */
export class MaestroRuntime {
	readonly link: MaestroLink;
	readonly token: string;
	private current: Mode = modeNamed("plan");
	private executor: Executor | undefined;
	private pending: PendingFlight | undefined;

	constructor(private readonly options: RuntimeOptions) {
		this.token = options.token ?? randomUUID();
		this.link = new MaestroLink({ token: this.token });
	}

	mode(): Mode {
		return this.current;
	}

	setMode(name: ModeName): Mode {
		this.current = modeNamed(name);
		return this.current;
	}

	async listen(): Promise<void> {
		this.link.on("asked", (agentId, ask) => {
			const key = `${agentId}/${ask.id}`;
			const inbox = this.options.inbox?.();
			if (!inbox) {
				// Nothing can answer, so say so rather than leaving the worker
				// blocked on a question nobody will ever see.
				this.link.answer(
					agentId,
					ask.id,
					ask.questions.map((question) => ({
						questionId: question.id,
						value:
							"nobody can answer this — the maestro has no question inbox. Decide for yourself and say in your hand-off what you assumed.",
					})),
					"maestro",
				);
				return;
			}

			// Delivered into `packages/ask`'s inbox, which owns what a question
			// is and what answering a SET of them means. This used to be a
			// registry here, with an answer that was one string copied across
			// every question the worker asked.
			inbox.deliver(
				{
					id: key,
					from: agentId,
					questions: ask.questions,
					receivedAt: this.options.now?.() ?? "",
				},
				(answers: Answers) => {
					// `from` is the maestro either way. If the human decided it, the
					// maestro got there by calling `ask` itself, and that answer
					// already carries its own provenance through `ask.v1`.
					this.link.answer(agentId, ask.id, answers, "maestro");
				},
			);

			// Announcing is ours: only the seat knows whose attention this is,
			// and that a question is a rare interruption rather than a queue.
			this.options.narrator.ask(
				[
					`# A worker is blocked on a question`,
					"",
					...ask.questions.flatMap((question) => [
						`\`${agentId}\` asks (\`${question.id}\`): ${question.question}`,
						...(question.context
							? [`What it already knows: ${question.context}`]
							: []),
						...(question.options?.length
							? [
									`Its options: ${question.options
										.map((option) => option.value ?? option.label)
										.join(", ")}`,
								]
							: []),
						"",
					]),
					`Answer with \`respond\` (id \`${key}\`), one entry per question.`,
					`Answer from what you know about this plan if you can. If you genuinely cannot, use \`ask\` to put it to the user, then respond with what they say — they are not watching this run, so only interrupt them when it matters.`,
				].join("\n"),
			);
		});
		await this.link.listen(this.options.socketPath);
	}

	async close(): Promise<void> {
		this.pending?.reject(new Error("the maestro session ended"));
		this.pending = undefined;
		await this.link.close();
	}

	running(): Executor | undefined {
		return this.executor;
	}

	/**
	 * Halt the running plan, if there is one.
	 *
	 * Returns what was halted, or null when nothing was running — the caller
	 * says so rather than this pretending it stopped something.
	 */
	async stop(reason: string): Promise<Run | null> {
		const executor = this.executor;
		if (!executor) return null;
		return executor.stop(reason);
	}

	/**
	 * Give the maestro's model prose to act on, and wait for it to say it is
	 * done.
	 *
	 * The wait is not a formality. Plan preflight is what guarantees the repos
	 * every deliverable is about to be checked out of, so "start the
	 * deliverables once preflight has probably finished" is how you get a fleet
	 * of workers all failing to find a remote.
	 */
	runMaestroTasks = async (
		tasks: readonly Task[],
		where: string,
	): Promise<void> => {
		// Nothing to do is done. An empty flight list is the ordinary case for a
		// plan whose repos already exist, and making the model confirm it would
		// be ceremony.
		if (tasks.length === 0) return;
		if (this.pending)
			throw new Error(
				`already waiting on ${this.pending.where}; one flight at a time`,
			);

		this.options.narrator.ask(
			[
				`# ${where}`,
				"",
				"Carry these out yourself, in order. Call `flight` when they are done, or when one of them cannot be.",
				"",
				...tasks.map((task, i) => describeFlightTask(task, i)),
			].join("\n"),
		);

		return new Promise<void>((resolve, reject) => {
			this.pending = { where, resolve, reject };
		});
	};

	/** The maestro's answer to `runMaestroTasks`. */
	private settleFlight(ok: boolean, detail?: string): string {
		const flight = this.pending;
		if (!flight) return "Nothing is waiting on a flight right now.";
		this.pending = undefined;
		if (ok) {
			flight.resolve();
			return `${flight.where} recorded as done.`;
		}
		flight.reject(new Error(detail?.trim() || "no reason given"));
		return `${flight.where} recorded as failed.`;
	}

	/**
	 * Start a plan.
	 *
	 * Refused in a mode that cannot write, because every deliverable produces a
	 * worker, and a read-only seat producing writers is the delegation hole that
	 * would make plan mode advisory.
	 */
	async start(
		plan: Plan,
		build: (runtime: MaestroRuntime) => Executor,
	): Promise<Executor> {
		if (this.current.cwd === "read")
			throw new Error(
				`${this.current.name} mode cannot write, so it cannot run a plan — every deliverable produces a worker`,
			);
		if (this.executor)
			throw new Error("a plan is already running in this session");

		const executor = build(this);
		this.executor = executor;
		executor.on((event) => this.narrate(event));
		await executor.start();
		return executor;
	}

	private narrate(event: ExecutorEvent): void {
		const say = this.options.narrator.say;
		switch (event.type) {
			case "started":
				say(`Started ${event.deliverable.id} — ${event.deliverable.title}`);
				return;
			case "finished": {
				const record = event.record;
				say(
					record.state === "done"
						? `${event.id} shipped${record.pr ? ` as #${record.pr}` : " (nothing to ship)"}`
						: `${event.id} failed: ${firstLine(record.failure)}`,
				);
				return;
			}
			case "settled":
				// The whole standing, not just a count. Once independent branches
				// are allowed to finish, "the plan ran" stops meaning "the plan is
				// done", and a reader needs to see which of shipped, failed,
				// stranded or never-started each deliverable was.
				say(summarise(this.executor));
				// A run that has ended is not a run in progress. Without this the
				// seat could run exactly ONE plan per session: `start` refuses
				// while an executor is held, and nothing ever let one go — so the
				// second `/run` was told a plan was already running, which was
				// false and unrecoverable short of restarting.
				this.executor = undefined;
				return;
			case "stuck":
				// Said out loud and NOT cleared: unlike settling or stopping, the
				// run is still the current one, and the seat has something the
				// operator has to decide about rather than a finished result.
				say(
					`This plan cannot go any further: ${event.reason}. Nothing is running. Say what you want to do — the run record is at plans/${event.run.slug}/run.json.`,
				);
				return;
			case "reclaimed":
				// Said out loud, always. The failure this replaces was silent: a
				// restarted maestro launched nothing and explained nothing, so a
				// wedged plan looked exactly like an idle seat.
				say(
					`Picked up a run left mid-flight: ${event.relaunched.join(", ")} will start again from ${event.relaunched.length === 1 ? "its worktree" : "their worktrees"}.${
						event.killed.length > 0
							? ` Ended ${event.killed.join(", ")}, still running with nobody to report to.`
							: ""
					}`,
				);
				return;
			case "stopped":
				say(
					event.halted.length > 0
						? `Stopped: ${event.reason}. ${event.halted.join(", ")} halted mid-flight and will start over from ${event.halted.length === 1 ? "its worktree" : "their worktrees"} on the next run.`
						: `Stopped: ${event.reason}. Nothing was in flight.`,
				);
				this.executor = undefined;
				return;
			default:
				return;
		}
	}

	/** The tool the maestro calls to answer `runMaestroTasks`. */
	flightTool(): ToolDefinition {
		return defineTool({
			name: "flight",
			label: "Flight",
			description:
				"Report that the plan preflight or postflight you were asked to carry out is finished, or that it cannot be.",
			promptSnippet:
				"report the plan preflight or postflight you were asked to carry out.",
			parameters: Type.Object({
				outcome: Type.Union([Type.Literal("done"), Type.Literal("failed")]),
				detail: Type.Optional(
					Type.String({
						description: "Required when it failed: what stopped it.",
					}),
				),
			}),
			execute: async (_id, { outcome, detail }) => ({
				content: [
					{
						type: "text" as const,
						text: this.settleFlight(outcome === "done", detail),
					},
				],
				details: {},
			}),
		});
	}
}

function describeFlightTask(task: Task, index: number): string {
	const lines = [`## ${index + 1}. ${task.title}`];
	if (task.body?.trim()) lines.push("", task.body.trim());
	return lines.join("\n");
}

function firstLine(text: string | undefined): string {
	return (text ?? "no reason given").split("\n")[0] as string;
}

function summarise(executor: Executor | undefined): string {
	if (!executor) return "Nothing ran.";
	const counts = new Map<string, string[]>();
	for (const [id, standing] of executor.report()) {
		const bucket = counts.get(standing) ?? [];
		bucket.push(id);
		counts.set(standing, bucket);
	}
	const parts = [...counts.entries()].map(
		([standing, ids]) => `${standing}: ${ids.join(", ")}`,
	);
	return parts.length > 0
		? `Plan settled. ${parts.join(" · ")}`
		: "Plan settled.";
}
