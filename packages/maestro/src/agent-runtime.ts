// What a worker process is, from the inside.
//
// A worker is an ordinary pi session that happens to have a maestro. It learns
// that from three environment variables and nothing else — no config file, no
// discovery, no flag it could be launched without. If they are absent this is
// not a worker, and the whole agent surface stays unregistered rather than
// registering something that will fail the first time it is called.
//
// The two tools here are the entire agent-side vocabulary. `finish` is how a
// worker reports and then waits; `delegate` is how it consults a reader. Both
// are declared through the registry like everything else, so neither can be
// granted to a posture that has no implementation for it.

import {
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Answers, Questionnaire } from "@vegardx/pi-contracts";
import { AgentLink } from "./link.js";
import { DELEGABLE, type Delegable } from "./plan.js";
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
			"finish — report the outcome and the hand-off. Call it once, when the work is done or has definitively failed.",
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
 * A read-only agent registers nothing. Its caller is BLOCKED on it, so there is
 * no channel back — and a reader that cannot answer says so in its report,
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

export interface DelegateDeps {
	readonly cwd: () => string;
	readonly depth: () => number;
	readonly openSession: ReadOnlySessionFactory;
	/** Turn a persona id into its brief. Unknown ids throw, and should. */
	readonly briefFor: (agent: Delegable, persona: string) => string;
	/**
	 * Which models to ask. One entry = one agent; several = a fan-out, one per
	 * family. Absent, or one entry, means the caller's own model is inherited.
	 *
	 * Present only because model routing is now wired: a `fanOut` parameter with
	 * nothing behind it would be a flag that reads like a capability and does
	 * nothing, which is the defect this rebuild exists to remove.
	 */
	readonly route?: (
		agent: Delegable,
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
export function createDelegateTool(deps: DelegateDeps): ToolDefinition {
	return defineTool({
		name: "delegate",
		label: "Delegate",
		description:
			"Ask a read-only agent to look at something and report back. Blocks until it answers.",
		promptSnippet:
			"delegate — hand a question to an explorer, reviewer or advisor and wait for what it finds.",
		parameters: Type.Object({
			agent: Type.Union(DELEGABLE.map((kind) => Type.Literal(kind))),
			persona: Type.String({
				description: "Which persona — what it should be looking for.",
			}),
			question: Type.String({
				description: "The specific thing you want it to answer.",
			}),
			fanOut: Type.Optional(
				Type.Boolean({
					description:
						"Ask one agent per model family and get every answer back, unreconciled. Worth it when you want a second opinion rather than a second run.",
				}),
			),
		}),
		async execute(_id, { agent, persona, question, fanOut }, _signal, _u, ctx) {
			const models = deps.route
				? await deps.route(agent, fanOut === true, ctx)
				: [];
			const ask = (model?: string) =>
				askReadOnly(
					{
						kind: agent,
						cwd: deps.cwd(),
						brief: deps.briefFor(agent, persona),
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
					details: { agent, persona, families: models.length },
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
							`${models.length} ${agent}s answered, across ${reached} model famil${reached === 1 ? "y" : "ies"}. They are not reconciled — that is yours to do.`,
							"",
							...parts,
						].join("\n"),
					},
				],
				details: { agent, persona, families: reached },
			};
		},
	});
}

/**
 * The declared tools, and who may hold them.
 *
 * `finish` is for agents that report to a maestro, which is workers. The
 * maestro reports to the human and has nothing to finish. `delegate` is held by
 * everyone, because a reader consulting another reader is ordinary — `checkSpawn`
 * is what stops it going too deep or producing a writer, and it does that from
 * one place rather than by withholding the tool from some list.
 */
export function declareAgentTools(deps: {
	readonly reporter: () => Reporter;

	readonly delegate: DelegateDeps;
	/**
	 * The gated shell for this holder.
	 *
	 * Declared like everything else, because a shell reached any other way is a
	 * shell with no safeguards — which is what the rebuilt system had until the
	 * classifier was wired back in.
	 */
	readonly bash?: ToolDefinition;
	// A read-only agent is NOT a holder of this. It runs with pi's read-only
	// builtin set, which has no shell in it at all — so declaring `bash` for
	// `read-only` would put a tool in its generated brief that it cannot call,
	// which is the phantom-grant defect this whole registry exists to prevent.
}): readonly ToolDeclaration[] {
	return [
		...(deps.bash
			? [
					{
						definition: deps.bash,
						holders: ["maestro", "worker"] as const,
					},
				]
			: []),
		{
			definition: createFinishTool(deps.reporter),
			holders: ["worker"],
		},
		{
			definition: createDelegateTool(deps.delegate),
			holders: ["maestro", "worker", "read-only"],
		},
	];
}
