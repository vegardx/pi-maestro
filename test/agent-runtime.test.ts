// The worker's own surface: how it knows it is one, and the two things it can
// say.
//
// The old system decided this the other way round — every child loaded the
// maestro's whole extension and was then told which parts to switch off through
// `disableExtensions`. A forgotten entry gave a worker the orchestrator's
// surface. Here a process reads three variables and knows what it is, and the
// surface it should not have is never registered.

import { describe, expect, it } from "vitest";
import {
	createFinishTool,
	createSubagentTool,
	declareAgentTools,
	type Reporter,
	readWiring,
} from "../packages/maestro/src/agent-runtime.js";
import {
	AGENT_ID_ENV,
	buildReadOnlyInvocation,
	DEPTH_ENV,
	MAX_DEPTH,
	READ_ONLY_TOOLS,
	type ReadOnlySession,
	SOCK_ENV,
	TOKEN_ENV,
} from "../packages/maestro/src/spawn.js";
import { SubagentSessions } from "../packages/maestro/src/subagent-sessions.js";
import { ToolRegistry } from "../packages/maestro/src/tool-registry.js";

const wired = {
	[AGENT_ID_ENV]: "worker-api",
	[SOCK_ENV]: "/tmp/m.sock",
	[TOKEN_ENV]: "run-token",
	[DEPTH_ENV]: "1",
};

/** Tools take the tool-call id first; params second. */
const call = (tool: ReturnType<typeof createFinishTool>, params: unknown) =>
	(
		tool.execute as unknown as (
			id: string,
			p: unknown,
		) => Promise<{
			content: { text: string }[];
			details?: Record<string, unknown>;
		}>
	)("call-1", params);

describe("a process knows whether it is a worker", () => {
	it("reads its wiring out of the environment", () => {
		expect(readWiring(wired)).toEqual({
			agentId: "worker-api",
			socketPath: "/tmp/m.sock",
			token: "run-token",
			depth: 1,
		});
	});

	it("is not a worker when nothing wired it", () => {
		expect(readWiring({})).toBeNull();
	});

	it("is not a worker when the wiring is incomplete", () => {
		// A process with a socket but no token cannot complete a handshake.
		// Registering an agent surface for it would turn a launch bug into a tool
		// that fails when a model first reaches for it, much further from the cause.
		for (const missing of [AGENT_ID_ENV, SOCK_ENV, TOKEN_ENV]) {
			const partial = { ...wired, [missing]: "" };
			expect(readWiring(partial)).toBeNull();
		}
	});
});

describe("finish reports, then waits", () => {
	function reporter() {
		const calls: unknown[] = [];
		let release: () => void = () => {};
		const waited = new Promise<void>((r) => {
			release = r;
		});
		const impl: Reporter = {
			async done(result) {
				calls.push(result);
				return waited;
			},
		};
		return { calls, release, impl };
	}

	it("does not return until maestro releases the agent", async () => {
		// The blocking IS the design. A tool call that returns immediately puts
		// the agent's exit back under its own control, which on one run lost the
		// output of all five nodes.
		const r = reporter();
		const tool = createFinishTool(() => r.impl);
		let returned = false;
		const running = call(tool, {
			outcome: "succeeded",
			handoff: "POST /v1/things",
		}).then(() => {
			returned = true;
		});

		await new Promise((res) => setTimeout(res, 20));
		expect(r.calls).toEqual([
			{ outcome: "succeeded", handoff: "POST /v1/things" },
		]);
		expect(returned).toBe(false);

		r.release();
		await running;
		expect(returned).toBe(true);
	});

	it("carries the reason when it failed", async () => {
		const r = reporter();
		r.release();
		await call(
			createFinishTool(() => r.impl),
			{
				outcome: "failed",
				failure: "the tests never passed",
			},
		);
		expect(r.calls).toEqual([
			{ outcome: "failed", failure: "the tests never passed" },
		]);
	});

	it("says so plainly when there is no maestro yet", async () => {
		// Tools register at load time and the handshake completes behind them.
		// Calling early should explain itself rather than hang.
		const tool = createFinishTool(() => {
			throw new Error("not connected to maestro yet");
		});
		await expect(call(tool, { outcome: "succeeded" })).rejects.toThrow(
			/not connected to maestro yet/,
		);
	});
});

describe("the subagent tool asks a reader and waits", () => {
	const session = (text: string): ReadOnlySession => ({
		async start() {},
		async prompt() {},
		async getLastAssistantText() {
			return text;
		},
		async stop() {},
	});

	const tool = (depth: number) => {
		const open = async () => session("Two findings, one real.");
		return createSubagentTool({
			cwd: () => "/worktrees/api",
			depth: () => depth,
			sessions: new SubagentSessions(open),
			briefFor: (persona) => `brief:${persona}`,
		});
	};

	it("returns what the reader said", async () => {
		const result = await call(tool(1), {
			persona: "security-review",
			question: "Is the auth check consistent?",
		});
		expect(result.content[0].text).toBe("Two findings, one real.");
	});

	it("obeys the nesting limit it was launched at", async () => {
		await expect(
			call(tool(MAX_DEPTH), {
				persona: "codebase-research",
				question: "Where is it?",
			}),
		).rejects.toThrow(/nesting limit/);
	});

	it("offers fan-out and family only because something is behind them", () => {
		// Both were deliberately absent until model routing was wired: a flag
		// that reads like a capability and does nothing is the defect this
		// rebuild is about. `fanOut` is here because `routeSpread` is; `family`
		// because `routeFamily` is.
		const parameters = JSON.stringify(tool(1).parameters);
		expect(parameters).toContain("fanOut");
		expect(parameters).toContain("family");
	});
});

describe("fan-out is one lead, the aggregator", () => {
	const session = (text: string): ReadOnlySession => ({
		async start() {},
		async prompt() {},
		async getLastAssistantText() {
			return text;
		},
		async stop() {},
	});

	const harness = (options: {
		readonly answer: string;
		readonly route: NonNullable<
			Parameters<typeof createSubagentTool>[0]["route"]
		>;
	}) => {
		const spawns: { model?: string; brief: string }[] = [];
		const open = async (spawn: { model?: string; brief: string }) => {
			spawns.push(spawn);
			return session(options.answer);
		};
		return {
			spawns,
			tool: createSubagentTool({
				cwd: () => "/w",
				depth: () => 1,
				sessions: new SubagentSessions(open),
				briefFor: (persona) => `brief:${persona}`,
				route: options.route,
			}),
		};
	};

	const spread = [
		{ modelId: "m-opus", family: "Anthropic" },
		{ modelId: "m-gpt", family: "OpenAI" },
	];

	it("starts exactly ONE reader — the lead — on the caller's own model", async () => {
		// The old fan-out stapled every reader's answer together under family
		// headers, "attributed, unreconciled". Wrong twice over: attribution
		// passed upstream invites the caller to inherit the verdicts of a model
		// it recognizes as itself, and raw unaggregated findings flood the one
		// context window whose clarity the exercise exists to protect. So the
		// members are now the LEAD's problem, in the lead's process.
		const h = harness({
			answer: "the aggregated findings",
			route: async () => spread,
		});
		const result = await call(h.tool, {
			persona: "code-review",
			question: "look at the diff",
			fanOut: true,
		});
		expect(h.spawns).toHaveLength(1);
		// No model on the spawn: the lead inherits, because it is the caller's
		// reasoning surface extended — routing it elsewhere would put the
		// aggregation judgment on a model the caller never chose.
		expect(h.spawns[0]?.model).toBeUndefined();
		// The caller reads the lead's answer verbatim. Anything added here about
		// families or members would undo the de-attribution one layer up.
		expect(result.content[0]?.text).toBe("the aggregated findings");
	});

	it("hands the lead its persona's brief plus the resolved fan-out block", async () => {
		const h = harness({ answer: "findings", route: async () => spread });
		await call(h.tool, {
			persona: "code-review",
			question: "look",
			fanOut: true,
		});
		const brief = h.spawns[0]?.brief ?? "";
		// The persona is orthogonal: the same prose the members get, and the
		// fan-out behavior arrives as a brief block, not a special persona.
		expect(brief).toContain("brief:code-review");
		// The family list is resolved by code, never left for the lead to guess.
		expect(brief).toContain("Anthropic, OpenAI");
		// Members are started blind, per family, with the material only.
		expect(brief).toContain('{persona: "code-review", family:');
		expect(brief).toContain("nothing else");
		// And what comes back is aggregated and de-attributed before the caller
		// sees a word of it.
		expect(brief).toContain("remove every model and family name");
		expect(brief).toContain("no severity labels, no counts");
	});

	it("reports coverage to the harness, in details", async () => {
		const h = harness({ answer: "findings", route: async () => spread });
		const result = await call(h.tool, {
			persona: "code-review",
			question: "look",
			fanOut: true,
		});
		// familiesResolved is what the spread yielded. What the lead actually
		// reached is not knowable from here — its members are held sessions in
		// its own process — so nothing pretends to know it.
		expect(result.details).toMatchObject({
			id: "code-review-1",
			fanOut: true,
			familiesResolved: ["Anthropic", "OpenAI"],
		});
	});

	it("keeps the lead held, like any subagent", async () => {
		const h = harness({ answer: "findings", route: async () => spread });
		await call(h.tool, {
			persona: "code-review",
			question: "look",
			fanOut: true,
		});
		const listing = await call(h.tool, {});
		expect(listing.details?.held).toEqual([
			{ id: "code-review-1", persona: "code-review", state: "idle", asked: 1 },
		]);
	});

	it("degrades to a direct start when the spread reaches one family", async () => {
		// One family is one opinion. A lead over one member would be theater,
		// and pretending to a diversity the roster did not yield is exactly the
		// claim this system has been caught making before.
		const h = harness({
			answer: "one opinion",
			route: async () => [{ modelId: "m-seat", family: "Anthropic" }],
		});
		const result = await call(h.tool, {
			persona: "code-review",
			question: "look",
			fanOut: true,
		});
		expect(h.spawns).toHaveLength(1);
		expect(h.spawns[0]?.model).toBe("m-seat");
		expect(result.content[0]?.text).toBe("one opinion");
		// The shortfall is the harness's fact, in details — the content the
		// calling model reads never mentions families or counts.
		for (const part of result.content) {
			expect(part.text).not.toMatch(/famil/i);
			expect(part.text).not.toMatch(/model/i);
		}
		expect(result.details).toMatchObject({
			fanOut: true,
			familiesResolved: ["Anthropic"],
		});
	});
});

describe("the family parameter starts a member on a named family", () => {
	const session = (text: string): ReadOnlySession => ({
		async start() {},
		async prompt() {},
		async getLastAssistantText() {
			return text;
		},
		async stop() {},
	});

	it("resolves the family through routing and runs on its model", async () => {
		const requests: unknown[] = [];
		const spawns: { model?: string }[] = [];
		const open = async (spawn: { model?: string }) => {
			spawns.push(spawn);
			return session("a member's findings");
		};
		const tool = createSubagentTool({
			cwd: () => "/w",
			depth: () => 2,
			sessions: new SubagentSessions(open),
			briefFor: () => "brief",
			route: async (request) => {
				requests.push(request);
				return [{ modelId: "m-gpt", family: "OpenAI" }];
			},
		});
		const result = await call(tool, {
			persona: "code-review",
			family: "OpenAI",
			question: "look",
		});
		expect(requests).toEqual([
			{ persona: "code-review", fanOut: false, family: "OpenAI" },
		]);
		expect(spawns[0]?.model).toBe("m-gpt");
		expect(result.details).toMatchObject({ family: "OpenAI" });
	});

	it("lets an unknown family's refusal through, naming what exists", async () => {
		// The lookup is the guard: the refusal comes from the resolver, which
		// knows the bound roster, and it teaches rather than just denies.
		const open = async () => session("never reached");
		const tool = createSubagentTool({
			cwd: () => "/w",
			depth: () => 2,
			sessions: new SubagentSessions(open),
			briefFor: () => "brief",
			route: async () => {
				throw new Error(
					"no available model in family Google for persona code-review — the bound roster reaches: Anthropic, OpenAI",
				);
			},
		});
		await expect(
			call(tool, { persona: "code-review", family: "Google", question: "x" }),
		).rejects.toThrow(/the bound roster reaches: Anthropic, OpenAI/);
	});

	it("refuses family alongside fanOut — they contradict", async () => {
		const open = async () => session("never reached");
		const tool = createSubagentTool({
			cwd: () => "/w",
			depth: () => 1,
			sessions: new SubagentSessions(open),
			briefFor: () => "brief",
			route: async () => [],
		});
		await expect(
			call(tool, {
				persona: "code-review",
				family: "OpenAI",
				question: "x",
				fanOut: true,
			}),
		).rejects.toThrow(/do not compose/);
	});

	it("refuses a family start when no routing is wired", async () => {
		// Without routing the family would silently become an inherited model —
		// the exact substitution the parameter exists to rule out.
		const open = async () => session("never reached");
		const tool = createSubagentTool({
			cwd: () => "/w",
			depth: () => 1,
			sessions: new SubagentSessions(open),
			briefFor: () => "brief",
		});
		await expect(
			call(tool, { persona: "code-review", family: "OpenAI", question: "x" }),
		).rejects.toThrow(/needs model routing/);
	});
});

describe("a started subagent stays its caller's", () => {
	// Lifetime is ownership: every subagent stays held until its caller ends,
	// and "one-shot" is just the caller choosing not to ask twice.
	const harness = () => {
		const opened: { prompts: string[] }[] = [];
		const open = async () => {
			const record = { prompts: [] as string[] };
			opened.push(record);
			return {
				async start() {},
				async prompt(p: string) {
					record.prompts.push(p);
				},
				async getLastAssistantText() {
					return "an answer";
				},
				async stop() {},
			};
		};
		const tool = createSubagentTool({
			cwd: () => "/w",
			depth: () => 1,
			sessions: new SubagentSessions(open),
			briefFor: (persona) => `brief:${persona}`,
		});
		return { opened, tool };
	};

	it("reaches the held session with {id, question}: one session, two prompts", async () => {
		const h = harness();
		const started = await call(h.tool, {
			persona: "code-review",
			question: "look at the diff",
		});
		expect(started.details?.id).toBe("code-review-1");
		// The trailer names the id, or the caller would have to guess it.
		expect(started.content[1]?.text).toContain("code-review-1");

		await call(h.tool, { id: "code-review-1", question: "and the tests?" });
		// A follow-up is one more turn in the SAME conversation — not a fresh
		// reader re-reading the world.
		expect(h.opened).toHaveLength(1);
		expect(h.opened[0]?.prompts).toEqual([
			"look at the diff",
			"and the tests?",
		]);
	});

	it("lists what is held on {}", async () => {
		const h = harness();
		const empty = await call(h.tool, {});
		expect(empty.content[0]?.text).toContain("You hold no subagents");

		await call(h.tool, { persona: "code-review", question: "look" });
		const listing = await call(h.tool, {});
		const text = listing.content[0]?.text as string;
		expect(text).toContain("code-review-1");
		expect(text).toContain("idle");
		expect(text).toContain("{id, question}");
		expect(listing.details?.held).toEqual([
			{ id: "code-review-1", persona: "code-review", state: "idle", asked: 1 },
		]);
	});

	it("refuses a call that is none of the three shapes, naming them", async () => {
		const h = harness();
		await expect(call(h.tool, { question: "look" })).rejects.toThrow(
			/three shapes/,
		);
		await expect(
			call(h.tool, { id: "code-review-1", persona: "code-review" }),
		).rejects.toThrow(/three shapes/);
		// A bare family is not a listing, and a family on a follow-up would be a
		// second model for a session that already has one.
		await expect(call(h.tool, { family: "OpenAI" })).rejects.toThrow(
			/three shapes/,
		);
		await expect(
			call(h.tool, { id: "code-review-1", question: "x", family: "OpenAI" }),
		).rejects.toThrow(/three shapes/);
	});

	it("answers an unknown id by naming the real ones", async () => {
		const h = harness();
		await call(h.tool, { persona: "code-review", question: "look" });
		await expect(
			call(h.tool, { id: "reviewer-7", question: "anything" }),
		).rejects.toThrow(/yours are: code-review-1/);
	});
});

describe("the agent tools are declared, not listed", () => {
	const registry = ToolRegistry.declare(
		declareAgentTools({
			reporter: () => ({ async done() {} }),
			subagent: {
				cwd: () => "/repo",
				depth: () => 1,
				sessions: new SubagentSessions(async () => ({
					async start() {},
					async prompt() {},
					async getLastAssistantText() {
						return "ok";
					},
					async stop() {},
				})),
				briefFor: () => "brief",
			},
		}),
	);

	it("gives finish only to those who report to a maestro", () => {
		// The maestro reports to the human, and has nothing to finish.
		expect(registry.grantsFor("worker")).toContain("finish");
		expect(registry.grantsFor("maestro")).not.toContain("finish");
		expect(registry.grantsFor("read-only")).not.toContain("finish");
	});

	it("gives subagent to every posture — depth is the cap", () => {
		// This grant has been wrong in both directions. It once included
		// `read-only` while a read-only child registered NOTHING (`extension.ts`
		// returned early for a child with no wiring) and `subagent` was missing
		// from its `--tools` allowlist besides — every reader handed a brief
		// naming a tool it could not call, the phantom inside the registry built
		// to stop phantoms — so the grant was withdrawn. The ruling that
		// reversed the withdrawal: every agent holds `subagent`, depth is the
		// cap (that is what MAX_DEPTH exists for), and a reader consulting
		// another reader is ordinary. What makes the grant real this time is the
		// no-wiring registration path in `extension.ts` and the reader's
		// allowlist in `spawn.ts`; `refusals-name-real-tools.test.ts` holds the
		// two together.
		for (const holder of ["maestro", "worker", "read-only"] as const)
			expect(registry.grantsFor(holder)).toContain("subagent");
	});

	it("describes each tool from its own declaration", () => {
		expect(registry.describeFor("worker")).toContain("finish — report");
		expect(registry.describeFor("read-only")).not.toContain("finish");
	});
});

describe("a read-only child is launched with nothing to dial", () => {
	const invocation = (parentDepth = 1) =>
		buildReadOnlyInvocation(
			{
				kind: "read-only",
				cwd: "/worktrees/api",
				brief: "Look for auth checked in one path and not another.",
				prompt: "Review the diff.",
				parentDepth,
			},
			{ extensions: ["/repo/packages/maestro"], agentDir: "/cfg" },
		);

	it("BLANKS the wiring rather than omitting it", () => {
		// Omitting only keeps a variable out if nothing merges the parent's
		// environment underneath, and pi's own RpcClient spawns with
		// `{...process.env, ...options.env}` — so an omitted variable is an
		// inherited one. A live drive paid for this: a reviewer inherited its
		// worker's socket, token and AGENT ID, dialled home as that worker, and
		// the maestro destroyed the real worker's connection as a reconnect.
		const { env } = invocation();
		expect(env[SOCK_ENV]).toBe("");
		expect(env[TOKEN_ENV]).toBe("");
		expect(env[AGENT_ID_ENV]).toBe("");
		// And blank reads as absent, so nothing downstream thinks it is wired.
		expect(readWiring(env)).toBeNull();
	});

	it("counts its depth from whoever asked", () => {
		expect(invocation(1).env[DEPTH_ENV]).toBe("2");
	});

	it("allows exactly one definition of pi's read-only tools", () => {
		// The old system had two that had drifted: one copy allowed a `plan` tool
		// the other did not, so what "read-only" meant depended on which file you
		// were standing in.
		// The allowlist filters EXTENSION tools too, not just pi's builtins, so
		// it is the whole of what a reader can call — `READ_ONLY_TOOLS`: the
		// builtins, the web tools `research-tools` defines, and the two tools the
		// reader's own process registers. `bash` in the list names OUR gated
		// shell, which replaces pi's builtin of the same name at registration.
		// Never `edit` or `write` — they write in-process, where the sandbox
		// cannot see them — and never `delete`, which is a write tool however
		// recoverable its writes are.
		const { args } = invocation();
		expect(args).toContain("--tools");
		expect(args[args.indexOf("--tools") + 1]).toBe(READ_ONLY_TOOLS.join(","));
		expect(READ_ONLY_TOOLS).toContain("bash");
		expect(READ_ONLY_TOOLS).toContain("subagent");
		expect(READ_ONLY_TOOLS).not.toContain("write");
		expect(READ_ONLY_TOOLS).not.toContain("edit");
		expect(READ_ONLY_TOOLS).not.toContain("delete");
	});

	it("carries the persona's brief as the child's system prompt", () => {
		const { args } = invocation();
		expect(args[args.indexOf("--append-system-prompt") + 1]).toContain(
			"auth checked in one path",
		);
		expect(args).toContain("--no-session");
	});
});
