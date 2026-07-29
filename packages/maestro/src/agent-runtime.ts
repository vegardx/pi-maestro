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

export interface DelegateDeps {
	readonly cwd: () => string;
	readonly depth: () => number;
	readonly openSession: ReadOnlySessionFactory;
	/** Turn a persona id into its brief. Unknown ids throw, and should. */
	readonly briefFor: (agent: Delegable, persona: string) => string;
}

/**
 * Ask a read-only agent something, and wait for the answer.
 *
 * There is no fan-out parameter. Fanning out means several agents across model
 * families whose answers are reconciled, and the model diversity that makes
 * that worth doing is not wired yet — so a `fanOut` flag here would be a
 * parameter that reads like a capability and quietly does nothing, which is
 * precisely the defect this rebuild exists to remove.
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
		}),
		async execute(_id, { agent, persona, question }) {
			const answer = await askReadOnly(
				{
					kind: agent,
					cwd: deps.cwd(),
					brief: deps.briefFor(agent, persona),
					prompt: question,
					parentDepth: deps.depth(),
				},
				deps.openSession,
			);
			return {
				content: [{ type: "text" as const, text: answer }],
				details: { agent, persona },
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
}): readonly ToolDeclaration[] {
	return [
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
