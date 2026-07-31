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
import { AGENT_ID_ENV, currentDepth, SOCK_ENV, TOKEN_ENV } from "./spawn.js";
import type { HeldSubagent, SubagentSessions } from "./subagent-sessions.js";
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

/**
 * One live worker of the run, with the subagents it last reported holding.
 *
 * ONE HOP ONLY, by construction. A worker reports its held map over the socket
 * it already dials, so the maestro sees its own readers, the run's workers,
 * and each worker's readers. A reader's own readers — the grandchildren of a
 * reader — would need a channel that does not exist: a reader is a call over
 * pi's session RPC, and the `ReadOnlySession` slice is start/prompt/read/stop
 * with no event surface underneath it. Until one exists, a reader's subtree is
 * its own map, invisible from above, and this type deliberately does not
 * pretend otherwise.
 */
export interface DescendantHolder {
	/** The deliverable id — how the run, and every error here, names the worker. */
	readonly id: string;
	/** The run's state for it. Only live workers appear at all. */
	readonly state: string;
	readonly modelId?: string;
	/** What it last reported over the wire. Status: only the holder can ask them. */
	readonly held: readonly HeldSubagent[];
}

export interface SubagentDeps {
	readonly cwd: () => string;
	readonly depth: () => number;
	/**
	 * The held sessions this caller owns. One per process — every subagent this
	 * process starts stays in it until the process ends, which is what makes a
	 * follow-up possible and the listing true.
	 */
	readonly sessions: SubagentSessions;
	/** Turn a persona id into its brief. Unknown ids throw, and should. */
	readonly briefFor: (persona: string) => string;
	/**
	 * Which model(s) this start resolves to. A `family` in the request is
	 * exactly that family through the caller's roster, or a refusal naming the
	 * families that exist; `fanOut` is the spread — one entry per family, and
	 * how many entries come back is the honest answer, never padded. A bare
	 * request resolves the persona's direct model, and an empty result means
	 * the caller's own model is inherited.
	 *
	 * Keyed by persona: `code-review` wanting a heavy tier is a statement about
	 * the work, not about a posture.
	 *
	 * Present only because model routing is now wired: a `fanOut` parameter with
	 * nothing behind it would be a flag that reads like a capability and does
	 * nothing, which is the defect this rebuild exists to remove.
	 */
	readonly route?: (
		request: {
			readonly persona: string;
			readonly fanOut: boolean;
			readonly family?: string;
		},
		ctx: unknown,
	) => Promise<
		readonly { readonly modelId: string; readonly family?: string }[]
	>;
	/**
	 * The caller's SUBTREE below its own held map: the run's live workers and
	 * what each reported holding. Supplied by the seat only — a worker's
	 * subtree IS its own map until reader-grandchildren have a channel — and
	 * folded into the `{}` listing rather than given a tool of its own,
	 * because "what is running under me" is the same question as "what do I
	 * hold", answered one level deeper.
	 */
	readonly descendants?: () => readonly DescendantHolder[];
}

/** The three ways to call `subagent`, named in every shape refusal. */
const CALL_SHAPES =
	"subagent takes one of three shapes: {persona, question} starts a subagent, {id, question} asks a held one a follow-up, {} lists what you hold";

/**
 * What a caller holds — and, for the seat, what runs beneath it — as one
 * monospace block. Derived from the live map and the workers' latest reports
 * at the moment of asking, so it cannot drift from the truth.
 *
 * Every row says WHO HOLDS it, because only some of these ids answer to
 * {id, question}: yours do; a row a worker holds is status, and asking it here
 * is corrected to its holder rather than half-working.
 */
function renderHeld(
	held: readonly HeldSubagent[],
	workers: readonly DescendantHolder[] = [],
): string {
	if (held.length === 0 && workers.length === 0)
		return "You hold no subagents. Start one with {persona, question}.";
	const model = (h: HeldSubagent) => h.modelId ?? h.family ?? "(inherited)";
	const header = ["id", "persona", "model", "state", "asked", "held by"];
	const rows = [
		...held.map((h) => [
			h.id,
			h.persona,
			model(h),
			h.state,
			String(h.asked),
			"you",
		]),
		...workers.flatMap((w) => [
			// The run's worker, named the way the run names it. Not askable here —
			// it is not a held session — so `asked` has nothing to count.
			[
				`worker:${w.id}`,
				"deliverable-worker",
				w.modelId ?? "(inherited)",
				w.state,
				"-",
				"you (the run)",
			],
			...w.held.map((h) => [
				`  ${h.id}`,
				h.persona,
				model(h),
				h.state,
				String(h.asked),
				`\`${w.id}\``,
			]),
		]),
	];
	const widths = header.map((name, i) =>
		Math.max(name.length, ...rows.map((row) => (row[i] as string).length)),
	);
	const line = (cells: readonly string[]) =>
		cells
			.map((cell, i) => cell.padEnd(widths[i] as number))
			.join("  ")
			.trimEnd();
	return [
		line(header),
		...rows.map(line),
		"",
		...(held.length > 0
			? ["Ask one of yours a follow-up with {id, question}."]
			: []),
		...(workers.length > 0
			? [
					"Rows held by a worker are status — they answer their holder, not you.",
				]
			: []),
	].join("\n");
}

/**
 * The fan-out block a lead's brief carries, after the persona prose and the
 * generated tool list. Brief-level on purpose: the persona is orthogonal —
 * lead and members run the same one — so what makes a lead a lead is this
 * block, not a special persona. It names `subagent` and nothing else; the
 * persona-prose guard (`PersonaCatalogue.declare`) scopes to PERSONAS, and
 * this is the same kind of generated, declaration-fed text as the tool list
 * it follows — it cannot drift from the grant, because the family list is
 * resolved by the code that grants it.
 */
function fanOutBrief(persona: string, families: readonly string[]): string {
	return [
		"## Fanning out",
		"",
		`You are the lead of a review that spans model families: ${families.join(", ")}. Your caller will read only what you return, so what you return must stand on its own.`,
		"",
		`Start one member per family with your \`subagent\` tool, as {persona: "${persona}", family: "<one family from the list above>", question: ...}. Give each member the material itself — the diff, the contract, the question — and nothing else. Never your own analysis, never what your caller intends or believes, never another member's answer: tell a reviewer what to expect and you have handed it a hypothesis to confirm.`,
		"",
		"When every member has answered, aggregate before you return: merge findings that say the same thing, normalize the wording, remove every model and family name, and drop what would not change anything.",
		"",
		"Then return the clean findings and nothing else — no severity labels, no counts, no word on who found what. If a member fails or a family cannot be reached, the findings say nothing about it; coverage is reported on another channel.",
	].join("\n");
}

/**
 * Ask a read-only agent something, and wait for the answer.
 *
 * Every subagent started here is HELD: it stays its caller's until the caller
 * finishes, re-askable by id — a follow-up is one more turn in a conversation
 * that kept its context, not a fresh reader re-reading the world. "One-shot"
 * is just the caller choosing not to ask twice.
 *
 * `fanOut` starts ONE subagent — a lead, on the caller's own model — whose
 * brief tells it to consult one member per family the spread resolved, then
 * aggregate: duplicates merged, wording normalized, every model and family
 * name removed, noise dropped. The caller reads clean findings, nothing else.
 * This replaced a version of fan-out that stapled raw answers together under
 * family headers, which was wrong twice over: attribution passed upstream
 * invites a caller to inherit the verdicts of a model it recognizes as
 * itself, and unaggregated findings flood the one context window whose
 * clarity the whole exercise exists to protect. The lead inherits rather
 * than routes because it IS the caller's reasoning surface, extended —
 * keeping member noise out of the caller's context is its entire job.
 *
 * `family` starts a subagent on a NAMED family's model, resolved through the
 * caller's roster — it is how the lead starts its members, and an unknown
 * family is refused naming the families that exist.
 *
 * Coverage honesty lives in `details`, never in the content the calling
 * model reads: a spread that resolves to one family runs a plain direct
 * start and records the shortfall where the harness can see it.
 */
export function createSubagentTool(deps: SubagentDeps): ToolDefinition {
	return defineTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Start a read-only subagent — an explorer, reviewer or advisor — and wait for what it reports. It stays yours afterwards: {id, question} asks it a follow-up in the same conversation, {} lists what you hold.",
		promptSnippet:
			"start a read-only subagent and wait for what it reports. A started subagent stays held: ask it a follow-up with {id, question}, or call with no arguments to list what you hold.",
		parameters: Type.Object({
			persona: Type.Optional(
				Type.String({
					description:
						"Which persona — what it should be looking for. Starts a new subagent, together with `question`.",
				}),
			),
			question: Type.Optional(
				Type.String({
					description: "The specific thing you want it to answer.",
				}),
			),
			id: Type.Optional(
				Type.String({
					description:
						"A held subagent's id, to ask it a follow-up instead of starting a new one.",
				}),
			),
			kind: Type.Optional(
				Type.Union([Type.Literal("read-only"), Type.Literal("worker")], {
					description:
						"What to start. Defaults to read-only, which is the only kind this tool starts today.",
				}),
			),
			fanOut: Type.Optional(
				Type.Boolean({
					description:
						"Review across model families: one lead subagent consults a blind member per family and returns a single aggregated answer. Worth it when you want second opinions rather than a second run.",
				}),
			),
			family: Type.Optional(
				Type.String({
					description:
						"A model family to draw the subagent's model from — the maker, as your roster names it. Composes with a start: {persona, family, question}. An unknown family is refused naming the ones that exist.",
				}),
			),
		}),
		async execute(
			_id,
			{ persona, question, id, kind, fanOut, family },
			_signal,
			_u,
			ctx,
		) {
			// A follow-up into a held session. A persona alongside the id would be
			// a contradiction — the session already has one — and so would a
			// family: the session already has a model.
			if (id !== undefined) {
				if (
					persona !== undefined ||
					family !== undefined ||
					question === undefined
				)
					throw new Error(CALL_SHAPES);
				// An id from the listing that is NOT yours: a descendant's session,
				// shown as status. Corrected by name BEFORE the map miss, because
				// "no subagent `code-review-1` — yours are: …" would be true and
				// useless: the listing just showed that id, and the caller needs to
				// hear whose it is, not that it does not exist. A plain miss still
				// falls through to the map — the map stays the permission.
				if (
					deps.descendants &&
					!deps.sessions.list().some((h) => h.id === id)
				) {
					const holder = deps
						.descendants()
						.find((w) => w.held.some((h) => h.id === id));
					if (holder)
						throw new Error(
							`\`${id}\` is held by \`${holder.id}\`, who reports to you — its row is status, and its answers go to its holder, not to you`,
						);
				}
				const answer = await deps.sessions.askAgain(id, question);
				const held = deps.sessions.list().find((h) => h.id === id);
				return {
					content: [{ type: "text" as const, text: answer }],
					details: {
						id,
						...(held
							? { persona: held.persona, state: held.state, asked: held.asked }
							: {}),
					},
				};
			}

			// `subagent {}`: what do I hold — and, for the seat, what runs under
			// me? The own rows derive from the live session map, which is also
			// what `askAgain` consults — the map IS the permission, so no row of
			// YOURS can miss. Descendant rows are the workers' latest reports:
			// visible, labeled with their holder, and deliberately not askable.
			// A bare `{family}` is not a listing — it falls through to the shape
			// refusal below, which names the shapes that exist.
			if (
				persona === undefined &&
				question === undefined &&
				family === undefined
			) {
				const held = deps.sessions.list();
				const workers = deps.descendants?.() ?? [];
				return {
					content: [{ type: "text" as const, text: renderHeld(held, workers) }],
					details: {
						held: held.map((h) => ({
							id: h.id,
							persona: h.persona,
							state: h.state,
							asked: h.asked,
						})),
						...(deps.descendants
							? {
									workers: workers.map((w) => ({
										id: w.id,
										state: w.state,
										held: w.held.map((h) => ({
											id: h.id,
											persona: h.persona,
											state: h.state,
										})),
									})),
								}
							: {}),
					},
				};
			}

			if (persona === undefined || question === undefined)
				throw new Error(CALL_SHAPES);

			// `family` names one; `fanOut` asks one per family. Together they
			// contradict each other, and a contradiction obeyed either way would
			// be this layer guessing which half the caller meant.
			if (family !== undefined && fanOut === true)
				throw new Error(
					"`family` and `fanOut` do not compose: family starts one subagent on that family's model, fanOut spans them all. Pick one.",
				);

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
					details: { persona },
				};

			// A named family with no routing wired would silently inherit, which
			// is precisely the substitution the family parameter exists to refuse.
			if (family !== undefined && !deps.route)
				throw new Error("`family` needs model routing, and none is wired here");
			const models = deps.route
				? await deps.route(
						{
							persona,
							fanOut: fanOut === true,
							...(family !== undefined ? { family } : {}),
						},
						ctx,
					)
				: [];
			const held = (heldId: string) => ({
				type: "text" as const,
				text: `(held as \`${heldId}\` — a follow-up goes to {id: "${heldId}", question}; {} lists what you hold)`,
			});

			// A fan-out that resolved two or more families starts ONE lead — the
			// aggregator — on the caller's own model: no model in the spawn means
			// the child inherits, and inheriting is the point, because the lead is
			// the caller's reasoning surface extended and keeping member noise out
			// of the caller's context window is its whole job. The lead's brief
			// carries the family list; the members it starts through its own
			// `subagent` tool are its held sessions, in its process, which is why
			// `familiesReached` is not reported here — this side cannot see them.
			if (fanOut === true && models.length > 1) {
				const families = models
					.map((m) => m.family)
					.filter((f): f is string => Boolean(f));
				const { id: leadId, answer } = await deps.sessions.start({
					persona,
					spawn: {
						kind: "read-only",
						cwd: deps.cwd(),
						brief: `${deps.briefFor(persona)}\n\n${fanOutBrief(persona, families)}`,
						prompt: question,
						parentDepth: deps.depth(),
					},
				});
				return {
					// The lead's answer, verbatim. It arrives already aggregated and
					// de-attributed; adding anything about families or members here
					// would undo the de-attribution one layer up.
					content: [{ type: "text" as const, text: answer }, held(leadId)],
					details: {
						id: leadId,
						persona,
						state: "idle",
						fanOut: true,
						familiesResolved: families,
					},
				};
			}

			// A direct start — and the DEGRADED fan-out: a spread of at most one
			// family is one opinion, and running it as such is honest where a lead
			// over one member would be theater. The shortfall goes into `details`,
			// where the harness reads it; the content the calling model reads
			// never mentions families or counts, because coverage is the
			// harness's fact to weigh, not a verdict to hand the caller.
			const resolvedFamily = models[0]?.family;
			const { id: heldId, answer } = await deps.sessions.start({
				persona,
				spawn: {
					kind: "read-only",
					cwd: deps.cwd(),
					brief: deps.briefFor(persona),
					prompt: question,
					parentDepth: deps.depth(),
					...(models[0]?.modelId ? { model: models[0].modelId } : {}),
				},
				...(resolvedFamily ? { family: resolvedFamily } : {}),
			});
			return {
				content: [{ type: "text" as const, text: answer }, held(heldId)],
				details: {
					id: heldId,
					persona,
					state: "idle",
					...(resolvedFamily ? { family: resolvedFamily } : {}),
					...(fanOut === true
						? {
								fanOut: true,
								familiesResolved: resolvedFamily ? [resolvedFamily] : [],
							}
						: {}),
				},
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
