// The maestro's half of the extension entry: the seat.
//
// Everything a running plan needs is assembled here, once, and handed to the
// executor as one object. There is no service locator and nothing reaches back
// out for a dependency mid-run — an executor built with a bad socket path fails
// at construction rather than the first time a worker tries to dial home.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PersonaCatalogue } from "./agent.js";
import { declareAgentTools } from "./agent-runtime.js";
import { createPlanTool } from "./authoring.js";
import { createBashTool } from "./bash-tool.js";
import { createCommitTool } from "./commit-tool.js";
import { createDeleteTool } from "./delete-tool.js";
import {
	type ExecutionPolicySettings,
	readExecutionPolicySettings,
} from "./execution-policy.js";
import { Executor, type ExecutorDeps } from "./executor.js";
import type { Mode, ModeName } from "./mode.js";
import { routeModel, routeSpawn } from "./model-routing.js";
import { plansRoot, sessionFile, socketPath } from "./paths.js";
import { BUILT_IN_PERSONAS, DELIVERABLE_WORKER } from "./personas.js";
import type { Plan } from "./plan.js";
import { createReadOnlySessionFactory } from "./read-only-session.js";
import { MaestroRuntime, type Narrator } from "./runtime.js";
import { createShipping, type ShippingOps } from "./shipping.js";
import {
	describeReadOnlyTools,
	killPidGroup,
	pidAlive,
	type SpawnProcess,
	WorkerLauncher,
} from "./spawn.js";
import { createPlanStore, type PlanStore } from "./store.js";
import { SubagentSessions } from "./subagent-sessions.js";
import { ToolRegistry } from "./tool-registry.js";
import { createWorkspace } from "./workspace.js";

export interface SeatOptions {
	readonly narrator: Narrator;
	/** Extension paths a spawned agent loads. Its whole non-builtin namespace. */
	readonly extensions: readonly string[];
	/** Branch every deliverable starts from. */
	readonly base: string;
	readonly agentDir?: string;
	readonly model?: string;
	readonly now?: () => string;
	/**
	 * The two things a test cannot have: a model, and a network.
	 *
	 * `spawn` stands in for launching `pi`; `shippingOps` for git-push and gh.
	 * Neither is a knob — every other dependency here is constructed, not
	 * injected — and both exist so the path between them can be exercised for
	 * real, which is the part that has never been tested.
	 */
	readonly spawn?: SpawnProcess;
	/**
	 * Put a question to the human and wait for an answer.
	 *
	 * One channel, used for two things: a worker's escalated question, and the
	 * seat's own confirmation of a consequential command. They were separate
	 * hooks and that was a mistake — both are "interrupt the human", and having
	 * two made it possible to wire one and forget the other, which is exactly
	 * what happened.
	 */
	readonly askHuman?: (
		question: string,
	) => Promise<{ readonly answer: string; readonly from: "maestro" | "human" }>;
	/** How to start pi. Defaults to the pi this process is running. */
	readonly piCommand?: readonly string[];
	readonly shippingOps?: Partial<ShippingOps>;
}

export interface Seat {
	readonly runtime: MaestroRuntime;
	readonly store: PlanStore;
	readonly tools: ToolRegistry;
	readonly personas: PersonaCatalogue;
	/** The readers this seat holds. Exposed so shutdown can stop them. */
	readonly subagents: SubagentSessions;
	/**
	 * Start a stored plan.
	 *
	 * Takes a `ctx` because resolving a worker's model needs pi's own model
	 * registry — for auth and for the catalogue — and the seat is built at
	 * registration time, before any context exists. A command handler has one.
	 */
	run(slug: string, ctx?: ExtensionContext): Promise<Executor>;
	setMode(name: ModeName): Mode;
	close(): Promise<void>;
}

export function createSeat(options: SeatOptions): Seat {
	const store = createPlanStore(plansRoot(options.agentDir));
	const now = options.now ?? (() => new Date().toISOString());
	const runtime = new MaestroRuntime({
		narrator: options.narrator,
		socketPath: socketPath(),
		now,
		...(options.askHuman ? { askHuman: options.askHuman } : {}),
	});

	const readOnly = createReadOnlySessionFactory({
		extensions: options.extensions,
		...(options.model ? { model: options.model } : {}),
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
	});
	// The seat's held readers. One per process, like a worker's: what this seat
	// starts stays its own, re-askable until the session ends.
	const subagents = new SubagentSessions(readOnly);

	// The model this run's workers were routed to, remembered only so the
	// seat's listing can show it. Live status like everything the listing
	// shows: per-process, never written to the run.
	let workerModel: string | undefined;

	// One registry. The maestro's own tools and the ones it hands to agents are
	// the same declarations, differing only in who holds them — which is the
	// whole reason a grant cannot drift from an implementation.
	// Read once per call rather than cached: settings change under a running
	// session, and a stale policy is a policy nobody asked for.
	const policy = (): ExecutionPolicySettings =>
		readExecutionPolicySettings(process.cwd(), options.agentDir);

	const tools = ToolRegistry.declare([
		...declareAgentTools({
			bash: createBashTool({
				holder: "maestro",
				cwd: process.cwd(),
				mode: () => runtime.mode(),
				policy,
				// The seat's own shell confirmation rides the same channel as a
				// worker's escalated question, because both are "interrupt the
				// human". A yes is a yes; anything else is not.
				...(options.askHuman
					? {
							confirm: async (command: string, reason: string) => {
								const asker = options.askHuman as NonNullable<
									typeof options.askHuman
								>;
								const reply = await asker(
									`Run this? ${command}\n\nWhy it is being asked: ${reason}\n\nAnswer yes to allow it.`,
								);
								// Only a HUMAN yes allows it. An autopilot answer or a
								// deferral is not consent to a consequential command.
								return (
									reply.from === "human" && /^\s*y(es)?\s*$/i.test(reply.answer)
								);
							},
						}
					: {}),
			}),
			// The maestro is refused `git commit` and `rm` by the same classifier
			// that refuses a worker, and pointed at the same tools — which it did
			// not hold. A refusal may only name a tool the refused agent has, and
			// the guard only ever checked the WORKER posture, so the seat's own
			// dead ends went unseen.
			commit: createCommitTool({ cwd: () => process.cwd() }),
			remove: createDeleteTool(),
			reporter: () => {
				throw new Error("the maestro reports to you, not to another maestro");
			},
			subagent: {
				cwd: () => process.cwd(),
				depth: () => 0,
				sessions: subagents,
				briefFor: (persona) => briefFor(personas, persona),
				// The seat's own readers route too. Research while planning is the
				// point of planning, and it should be able to use a cheap model
				// for it — or a fan-out lead, when it wants second opinions.
				route: (request, ctx) => routeSpawn(ctx as ExtensionContext, request),
				// The seat's listing shows its whole subtree: the run's live workers,
				// and under each the readers it reported holding over the socket it
				// already dials. Read from the run and the link at the moment of
				// asking — live status, derived from nothing, gone when they are.
				descendants: () => {
					const executor = runtime.running();
					if (!executor) return [];
					return Object.entries(executor.state().deliverables)
						.filter(
							([, record]) =>
								record.state === "running" && record.agentId !== undefined,
						)
						.map(([id, record]) => ({
							id,
							state: record.state,
							...(workerModel ? { modelId: workerModel } : {}),
							held: runtime.link.heldBy(record.agentId as string),
						}));
				},
			},
		}),
		{ definition: runtime.flightTool(), holders: ["maestro"] },
		// No `respond` here. It belongs to `packages/ask`, which owns what a
		// question is — the version that lived on this runtime answered every
		// question in a set with the same string, because the code settling them
		// had never seen a questionnaire.
		// Only the seat authors plans. A worker asked to write one would be
		// writing work for itself, which is the shape the deliverable model
		// exists to replace.
		{
			definition: createPlanTool({ store, cwd: () => process.cwd() }),
			holders: ["maestro"],
		},
	]);

	const personas = PersonaCatalogue.declare(BUILT_IN_PERSONAS, tools);

	return {
		runtime,
		store,
		tools,
		personas,
		subagents,

		setMode: (name) => runtime.setMode(name),

		async run(slug: string, ctx?: ExtensionContext) {
			const plan = store.loadPlan(slug);
			if (!plan)
				throw new Error(
					`no plan \`${slug}\` (have: ${
						store
							.list()
							.map((p) => p.slug)
							.join(", ") || "none"
					})`,
				);
			// One resolution per run, not per deliverable: in this model every
			// deliverable is a worker, so they all route the same way.
			const routed = ctx ? await routeModel(ctx, "worker") : undefined;
			if (routed?.fallbackReason)
				options.narrator.say(
					`Workers fall back to the seat model: ${routed.fallbackReason}`,
				);
			// Remembered for the listing's model column. Undefined stays honest:
			// with no routing and no pin the worker inherits, and the listing says
			// "(inherited)" rather than inventing a name.
			workerModel = options.model ?? routed?.modelId;
			await runtime.listen();
			return runtime.start(
				plan,
				(rt) => new Executor(plan, deps(plan, rt, routed?.modelId)),
			);
		},

		close: async () => {
			// Hygiene, not the mechanism — held readers are child processes of
			// this one and die with it; stopping them makes the close orderly.
			await subagents.stopAll();
			await runtime.close();
		},
	};

	function deps(
		plan: Plan,
		rt: MaestroRuntime,
		workerModel?: string,
	): ExecutorDeps {
		// No git identity is resolved here, and none is handed to a worker.
		//
		// It used to be: a live drive watched a worker with no identity reach for
		// `git config user.email`, and a linked worktree shares the repository's
		// config file, so that one command rewrote the identity for the whole
		// checkout. The fix was to resolve identity in the seat and pass it as
		// GIT_AUTHOR_*/GIT_COMMITTER_* — which stopped the worker needing to ask,
		// and was the wrong layer.
		//
		// Wrong because a single resolution cannot stand in for git's own. The
		// developer's `includeIf gitdir:` conditions are PATH-SCOPED, so one
		// identity resolved from `repos[0]` and broadcast to every worker
		// overrides the scoping for every other repository in the plan — and
		// environment beats config, which is exactly why it was chosen. The
		// mechanism that guaranteed an identity also guaranteed it could be the
		// wrong one, silently.
		//
		// Git resolves its own identity, per worktree, from the configuration the
		// developer already wrote. What makes the original incident impossible is
		// the sandbox's write-deny on `.git/config` — a guard that was already
		// implemented and merely unwired. See task #83.
		return {
			store,
			link: rt.link,
			launcher: new WorkerLauncher(
				options.spawn ? { spawn: options.spawn } : {},
			),
			workspace: createWorkspace({ baseBranch: options.base }),
			shipping: createShipping({
				base: options.base,
				...(options.shippingOps ? { ops: options.shippingOps } : {}),
			}),
			tools,
			personas,
			workerPersona: DELIVERABLE_WORKER,
			socketPath: socketPath(),
			token: rt.token,
			extensions: options.extensions,
			...(options.piCommand ? { piCommand: options.piCommand } : {}),
			isAlive: pidAlive,
			killPid: (pid) => killPidGroup(pid, "SIGKILL"),
			runMaestroTasks: rt.runMaestroTasks,
			now,
			sessionFileFor: (id) => sessionFile(plan.slug, id, options.agentDir),
			// An explicit option wins over routing: it is how a drive pins a model.
			...((options.model ?? workerModel)
				? { model: options.model ?? (workerModel as string) }
				: {}),
		};
	}
}

/**
 * A read-only agent's brief: its persona's prose plus the tools its posture
 * holds, generated.
 *
 * Deliberately not `brief()` from the agent model — that one also carries the
 * assignment, and here the assignment is the question, which arrives separately
 * as the child's first prompt.
 */
function briefFor(personas: PersonaCatalogue, persona: string): string {
	const found = personas.require(persona);
	// The subagent tool starts read-only agents only, so a writer's persona is
	// refused here — `deliverable-worker` cannot be smuggled into a reader.
	if (found.kind !== "read-only")
		throw new Error(
			`persona \`${persona}\` is for a ${found.kind}, which this tool does not start — writers are plan-authored`,
		);
	return `${found.prose}\n\n${describeReadOnlyTools()}`;
}
