// What a worker process is, from the inside.
//
// A worker is an ordinary pi session that happens to have a maestro. It learns
// that from three environment variables and nothing else — no config file, no
// discovery, no flag it could be launched without. If they are absent this is
// not a worker, and the whole agent surface stays unregistered rather than
// registering something that will fail the first time it is called.
//
// The two tools here are the entire agent-side vocabulary. `finish` is how a
// worker reports and then waits; `subagent` is how it consults a reader. Both
// are declared through the registry like everything else, so neither can be
// granted to a posture that has no implementation for it.

import {
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Answers, Questionnaire } from "@vegardx/pi-contracts";
import { AgentLink } from "./link.js";
import {
	AGENT_ID_ENV,
	askReadOnly,
	currentDepth,
	type ReadOnlySessionFactory,
	SOCK_ENV,
	TOKEN_ENV,
} from "./spawn.js";
import type { ToolDeclaration } from "./tool-registry.js";

/** How a worker finds its maestro. All three, or this is not a worker. */
export interface AgentWiring {
	readonly agentId: string;
	readonly socketPath: string;
	readonly token: string;
	readonly depth: number;
}

/**
 * The wiring in this environment, or `null` if there is none.
 *
 * Partial wiring answers `null` too. A process holding a socket path but no
 * token cannot complete a handshake, and registering an agent surface for it
 * would turn a launch bug into a tool that fails when a model first reaches
 * for it — much further from the cause.
 */
export function readWiring(
	env: NodeJS.ProcessEnv = process.env,
): AgentWiring | null {
	const agentId = env[AGENT_ID_ENV]?.trim();
	const socketPath = env[SOCK_ENV]?.trim();
	const token = env[TOKEN_ENV]?.trim();
	if (!agentId || !socketPath || !token) return null;
	return { agentId, socketPath, token, depth: currentDepth(env) };
}

export async function dialHome(
	wiring: AgentWiring,
	options: { readonly resumed?: boolean } = {},
): Promise<AgentLink> {
	const link = new AgentLink();
	await link.connect(wiring.socketPath, {
		agentId: wiring.agentId,
		token: wiring.token,
		...(options.resumed ? { resumed: true } : {}),
	});
	return link;
}

/** The slice of the link `finish` needs. */
export interface Reporter {
	done(result: {
		outcome: "succeeded" | "failed";
		failure?: string;
		handoff?: string;
	}): Promise<void>;
}

/**
 * Report the deliverable, then wait to be released.
 *
 * THE CALL DOES NOT RETURN until maestro releases the agent, and that is the
 * design rather than an inconvenience: an agent whose exit it controls itself
 * can be gone before its result is collected, which on one run lost the output
 * of all five nodes. Blocking here makes the tool call itself the thing that
 * holds the process open.
 */
export function createFinishTool(reporter: () => Reporter): ToolDefinition {
	return defineTool({
		name: "finish",
		label: "Finish",
		description:
			"Report the outcome of this deliverable and hand back what the next deliverable needs. Blocks until maestro has collected the work.",
		promptSnippet:
			"report the outcome and the hand-off. Call it once, when the work is done or has definitively failed.",
		parameters: Type.Object({
			outcome: Type.Union([Type.Literal("succeeded"), Type.Literal("failed")]),
			handoff: Type.Optional(
				Type.String({
					description:
						"What a deliverable that reads from this one needs to know. Facts it cannot get from the diff.",
				}),
			),
			failure: Type.Optional(
				Type.String({
					description: "Required when the outcome is failed: what happened.",
				}),
			),
		}),
		async execute(_id, { outcome, handoff, failure }) {
			await reporter().done({
				outcome,
				...(handoff ? { handoff } : {}),
				...(failure ? { failure } : {}),
			});
			return {
				content: [
					{
						type: "text" as const,
						text: "Maestro has collected the work and released you. Stop here.",
					},
				],
				details: {},
			};
		},
	});
}

/** The slice of the link an ask transport needs. */
export interface Asker {
	ask(questions: Questionnaire): Promise<{
		readonly answers: Answers;
		readonly from: "maestro" | "human";
	}>;
}

/**
 * `ask.v1`'s transport for an agent: route questions up to the maestro.
 *
 * THERE IS NO SEPARATE TOOL. An agent calls the same `ask` a maestro calls, and
 * where the question goes is decided by which transport is registered — which
 * is what "aware of where it is used" means. A bespoke tool for the same act
 * would be a variant standing in for a position, and it would have collided
 * with `packages/ask`'s own `ask` the moment both extensions loaded.
 *
 * A read-only agent registers no transport (its tools, yes — `extension.ts`'s
 * no-wiring path — but nothing of this). Its caller is BLOCKED on it, so there
 * is no channel back — and a reader that cannot answer says so in its report,
 * which the caller then acts on. Readers answer; they do not ask.
 *
 * Provenance rides back with the answers, at every hop: an agent must be able
 * to tell a human's ruling from its maestro's guess.
 */
export function createAskTransport(asker: () => Asker): {
	present(questions: Questionnaire): Promise<Answers>;
} {
	return {
		present: async (questions) => {
			const answered = await asker().ask(questions);
			// The attribution is appended to each answer's value rather than
			// dropped, because `ask.v1` hands the caller plain answers and an agent
			// that cannot see who decided will read a maestro's guess as a ruling.
			return answered.answers.map((answer) => ({
				...answer,
				value: `${answer.value}\n\n(answered by the ${answered.from})`,
				source: answered.from === "human" ? ("human" as const) : undefined,
			}));
		},
	};
}

export interface SubagentDeps {
	readonly cwd: () => string;
	readonly depth: () => number;
	readonly openSession: ReadOnlySessionFactory;
	/** Turn a persona id into its brief. Unknown ids throw, and should. */
	readonly briefFor: (persona: string) => string;
	/**
	 * Which models to ask. One entry = one agent; several = a fan-out, one per
	 * family. Absent, or one entry, means the caller's own model is inherited.
	 *
	 * Keyed by persona: `code-review` wanting a heavy tier is a statement about
	 * the work, not about a posture.
	 *
	 * Present only because model routing is now wired: a `fanOut` parameter with
	 * nothing behind it would be a flag that reads like a capability and does
	 * nothing, which is the defect this rebuild exists to remove.
	 */
	readonly route?: (
		persona: string,
		fanOut: boolean,
		ctx: unknown,
	) => Promise<
		readonly { readonly modelId: string; readonly family?: string }[]
	>;
}

/**
 * Ask one or several read-only agents something, and wait for the answers.
 *
 * `fanOut` asks the same question of one agent per model family and returns
 * every answer, attributed by family and NOT reconciled. Reconciling them here
 * would be this layer deciding which reviewer was right, which is the caller's
 * judgement to make — and flattening several opinions into one is how six real
 * findings became a sentence saying nothing.
 *
 * With no roster configured, `fanOut` reaches exactly one family and says so
 * rather than pretending to a diversity it did not get.
 */
export function createSubagentTool(deps: SubagentDeps): ToolDefinition {
	return defineTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Start a read-only subagent — an explorer, reviewer or advisor — and wait for what it reports. Blocks until it answers.",
		promptSnippet: "start a read-only subagent and wait for what it reports.",
		parameters: Type.Object({
			persona: Type.String({
				description: "Which persona — what it should be looking for.",
			}),
			question: Type.String({
				description: "The specific thing you want it to answer.",
			}),
			kind: Type.Optional(
				Type.Union([Type.Literal("read-only"), Type.Literal("worker")], {
					description:
						"What to start. Defaults to read-only, which is the only kind this tool starts today.",
				}),
			),
			fanOut: Type.Optional(
				Type.Boolean({
					description:
						"Ask one agent per model family and get every answer back, unreconciled. Worth it when you want a second opinion rather than a second run.",
				}),
			),
		}),
		async execute(_id, { persona, question, kind, fanOut }, _signal, _u, ctx) {
			// `worker` is in the schema and refused: there is a future where the
			// seat runs a worker directly through this tool, and when it arrives
			// it should be an implementation filling in, not a vocabulary change.
			if (kind === "worker")
				return {
					content: [
						{
							type: "text" as const,
							text: "refused: writers are plan-authored — author a deliverable and run the plan. This tool starts read-only subagents only, for now.",
						},
					],
					details: { persona, families: 0 },
				};
			const models = deps.route
				? await deps.route(persona, fanOut === true, ctx)
				: [];
			const ask = (model?: string) =>
				askReadOnly(
					{
						kind: "read-only",
						cwd: deps.cwd(),
						brief: deps.briefFor(persona),
						prompt: question,
						parentDepth: deps.depth(),
						...(model ? { model } : {}),
					},
					deps.openSession,
				);

			if (models.length <= 1) {
				const answer = await ask(models[0]?.modelId);
				return {
					content: [{ type: "text" as const, text: answer }],
					details: { persona, families: models.length },
				};
			}

			// Settled, not all: one reader failing is a missing opinion, not a
			// failed review. Losing the other two because of it would be.
			const answers = await Promise.allSettled(
				models.map((model) => ask(model.modelId)),
			);
			const parts = answers.map((answer, i) => {
				const family = models[i]?.family ?? models[i]?.modelId ?? "unknown";
				return answer.status === "fulfilled"
					? `## ${family}\n\n${answer.value}`
					: `## ${family}\n\nThis one did not answer: ${
							answer.reason instanceof Error
								? answer.reason.message
								: String(answer.reason)
						}`;
			});
			const reached = new Set(models.map((m) => m.family).filter(Boolean)).size;
			return {
				content: [
					{
						type: "text" as const,
						text: [
							`${models.length} subagents answered, across ${reached} model famil${reached === 1 ? "y" : "ies"}. They are not reconciled — that is yours to do.`,
							"",
							...parts,
						].join("\n"),
					},
				],
				details: { persona, families: reached },
			};
		},
	});
}

/**
 * The declared tools, and who may hold them.
 *
 * `finish` is for agents that report to a maestro, which is workers. The
 * maestro reports to the human and has nothing to finish. `subagent` is held by
 * every posture — depth is the cap, and `checkSpawn` enforces it in one place.
 */
export function declareAgentTools(deps: {
	readonly reporter: () => Reporter;

	readonly subagent: SubagentDeps;
	/**
	 * The gated shell for this holder.
	 *
	 * Declared like everything else, because a shell reached any other way is a
	 * shell with no safeguards — which is what the rebuilt system had until the
	 * classifier was wired back in.
	 */
	readonly bash?: ToolDefinition;
	// `read-only` holds one too, now. The old rule — a shell is a write tool,
	// so a reader gets none — predated ambient confinement: the classifier's
	// read-only branch refuses write-effect commands, and the kernel write
	// profile scopes a read-only actor to scratch space, so a reader's shell
	// can walk git history and inspect the tree while unable to change it.
	// What stays withheld is pi's `edit`/`write` pair — those write
	// in-process, where the sandbox cannot see them.

	/**
	 * How a worker records its work.
	 *
	 * Declared HERE, beside the shell, because the two are one decision: the
	 * classifier refuses `git commit` through bash and names this tool as the
	 * way instead. Declaring the shell without it is what left a worker unable
	 * to commit at all — the refusal pointed at nothing.
	 */
	readonly commit?: ToolDefinition;
	/**
	 * Deletion, as a recoverable move to trash.
	 *
	 * Declared beside the shell for the same reason `commit` is: the classifier
	 * refuses `rm` and names this tool instead. Declaring the shell without it
	 * leaves that refusal pointing at nothing — which is exactly what the flip
	 * did, silently, because the refusal kept working after its target was
	 * deleted with `packages/modes`.
	 */
	readonly remove?: ToolDefinition;
}): readonly ToolDeclaration[] {
	return [
		...(deps.bash
			? [
					{
						definition: deps.bash,
						// Every posture. Each caller passes an instance built for ONE
						// holder — the gate and the write profile are baked into it —
						// so this list says who may hold a gated shell at all, and the
						// instance decides whose it is.
						holders: ["maestro", "worker", "read-only"] as const,
					},
				]
			: []),
		...(deps.commit
			? [
					{
						definition: deps.commit,
						// The maestro too. It is refused `git commit` by the same
						// classifier and pointed at this same tool, so granting it to
						// the worker alone left the seat with a dead end in the
						// operator's own session.
						holders: ["maestro", "worker"] as const,
					},
				]
			: []),
		...(deps.remove
			? [
					{
						definition: deps.remove,
						holders: ["maestro", "worker"] as const,
					},
				]
			: []),
		{
			definition: createFinishTool(deps.reporter),
			holders: ["worker"],
		},
		{
			// EVERY posture, `read-only` included. This grant has been wrong in
			// both directions. It first included the reader while a read-only
			// child registered nothing (`extension.ts` returned early for a child
			// with no wiring) and `subagent` was missing from its `--tools`
			// allowlist — a tool doubly absent while the generated brief promised
			// it, the phantom grant inside the registry built to prevent it. The
			// exclusion that fixed the phantom was then overruled on the design:
			// every agent holds `subagent`, depth is the cap — that is what
			// MAX_DEPTH exists for — and a reader consulting another reader is
			// ordinary. What makes the grant real this time is the no-wiring path
			// in `extension.ts`, which registers the tool, and the reader's
			// allowlist in `spawn.ts`, which lets a launched reader call it.
			definition: createSubagentTool(deps.subagent),
			holders: ["maestro", "worker", "read-only"],
		},
	];
}
