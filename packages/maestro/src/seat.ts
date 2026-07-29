// The maestro's half of the extension entry: the seat.
//
// Everything a running plan needs is assembled here, once, and handed to the
// executor as one object. There is no service locator and nothing reaches back
// out for a dependency mid-run — an executor built with a bad socket path fails
// at construction rather than the first time a worker tries to dial home.

import { PersonaCatalogue } from "./agent.js";
import { declareAgentTools } from "./agent-runtime.js";
import { Executor, type ExecutorDeps } from "./executor.js";
import type { Mode, ModeName } from "./mode.js";
import { plansRoot, sessionFile, socketPath } from "./paths.js";
import { BUILT_IN_PERSONAS, DELIVERABLE_WORKER } from "./personas.js";
import type { Plan } from "./plan.js";
import { createReadOnlySessionFactory } from "./read-only-session.js";
import { MaestroRuntime, type Narrator } from "./runtime.js";
import { createShipping, type ShippingOps } from "./shipping.js";
import { type SpawnProcess, WorkerLauncher } from "./spawn.js";
import { createPlanStore, type PlanStore } from "./store.js";
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
	readonly shippingOps?: Partial<ShippingOps>;
}

export interface Seat {
	readonly runtime: MaestroRuntime;
	readonly store: PlanStore;
	readonly tools: ToolRegistry;
	readonly personas: PersonaCatalogue;
	/** Start a stored plan. Throws with the reason if it cannot. */
	run(slug: string): Promise<Executor>;
	setMode(name: ModeName): Mode;
	close(): Promise<void>;
}

export function createSeat(options: SeatOptions): Seat {
	const store = createPlanStore(plansRoot(options.agentDir));
	const runtime = new MaestroRuntime({
		narrator: options.narrator,
		socketPath: socketPath(),
	});

	const readOnly = createReadOnlySessionFactory({
		extensions: options.extensions,
		...(options.model ? { model: options.model } : {}),
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
	});

	// One registry. The maestro's own tools and the ones it hands to agents are
	// the same declarations, differing only in who holds them — which is the
	// whole reason a grant cannot drift from an implementation.
	const tools = ToolRegistry.declare([
		...declareAgentTools({
			reporter: () => {
				throw new Error("the maestro reports to you, not to another maestro");
			},
			delegate: {
				cwd: () => process.cwd(),
				depth: () => 0,
				openSession: readOnly,
				briefFor: (agent, persona) => briefFor(personas, tools, agent, persona),
			},
		}),
		{ definition: runtime.flightTool(), holders: ["maestro"] },
	]);

	const personas = PersonaCatalogue.declare(BUILT_IN_PERSONAS, tools);
	const now = options.now ?? (() => new Date().toISOString());

	return {
		runtime,
		store,
		tools,
		personas,

		setMode: (name) => runtime.setMode(name),

		async run(slug: string) {
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
			await runtime.listen();
			return runtime.start(plan, (rt) => new Executor(plan, deps(plan, rt)));
		},

		close: () => runtime.close(),
	};

	function deps(plan: Plan, rt: MaestroRuntime): ExecutorDeps {
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
			runMaestroTasks: rt.runMaestroTasks,
			now,
			sessionFileFor: (id) => sessionFile(plan.slug, id, options.agentDir),
			...(options.model ? { model: options.model } : {}),
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
function briefFor(
	personas: PersonaCatalogue,
	tools: ToolRegistry,
	kind: string,
	persona: string,
): string {
	const found = personas.require(persona);
	if (found.kind !== kind)
		throw new Error(
			`persona \`${persona}\` is for a ${found.kind}, not a ${kind}`,
		);
	return `${found.prose}\n\n${tools.describeFor("read-only")}`;
}
