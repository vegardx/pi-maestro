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
	createDelegateTool,
	createFinishTool,
	declareAgentTools,
	type Reporter,
	readWiring,
} from "../packages/maestro/src/agent-runtime.js";
import {
	AGENT_ID_ENV,
	buildReadOnlyInvocation,
	DEPTH_ENV,
	MAX_DEPTH,
	READ_ONLY_BUILTINS,
	type ReadOnlySession,
	SOCK_ENV,
	TOKEN_ENV,
} from "../packages/maestro/src/spawn.js";
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
		) => Promise<{ content: { text: string }[] }>
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

describe("delegate asks a reader and waits", () => {
	const session = (text: string): ReadOnlySession => ({
		async start() {},
		async prompt() {},
		async getLastAssistantText() {
			return text;
		},
		async stop() {},
	});

	const tool = (depth: number) =>
		createDelegateTool({
			cwd: () => "/worktrees/api",
			depth: () => depth,
			openSession: async () => session("Two findings, one real."),
			briefFor: (agent, persona) => `${agent}:${persona}`,
		});

	it("returns what the reader said", async () => {
		const result = await call(tool(1), {
			agent: "reviewer",
			persona: "security-review",
			question: "Is the auth check consistent?",
		});
		expect(result.content[0].text).toBe("Two findings, one real.");
	});

	it("obeys the nesting limit it was launched at", async () => {
		await expect(
			call(tool(MAX_DEPTH), {
				agent: "explorer",
				persona: "codebase-research",
				question: "Where is it?",
			}),
		).rejects.toThrow(/nesting limit/);
	});

	it("offers fan-out only because something is behind it now", () => {
		// It was deliberately absent until model routing was wired: a flag that
		// reads like a capability and does nothing is the defect this rebuild is
		// about. It is here because `routeSpread` is.
		expect(JSON.stringify(tool(1).parameters)).toContain("fanOut");
	});

	it("asks one agent per family and reconciles NOTHING", async () => {
		// Reconciling here would be this layer deciding which reviewer was right.
		// Flattening several opinions into one is how six real findings became a
		// sentence that said nothing.
		const asked: (string | undefined)[] = [];
		const fanned = createDelegateTool({
			cwd: () => "/w",
			depth: () => 1,
			openSession: async (spawn) => {
				asked.push(spawn.model);
				return session(`findings from ${spawn.model}`);
			},
			briefFor: () => "brief",
			route: async () => [
				{ modelId: "m-opus", family: "Anthropic" },
				{ modelId: "m-gpt", family: "OpenAI" },
			],
		});

		const result = await call(fanned, {
			agent: "reviewer",
			persona: "code-review",
			question: "look",
			fanOut: true,
		});
		expect(asked).toEqual(["m-opus", "m-gpt"]);
		const text = result.content[0].text;
		expect(text).toContain("2 model families");
		expect(text).toContain("not reconciled");
		expect(text).toContain("## Anthropic");
		expect(text).toContain("## OpenAI");
		expect(text).toContain("findings from m-opus");
		expect(text).toContain("findings from m-gpt");
	});

	it("keeps the opinions it got when one reader fails", async () => {
		// One reader failing is a missing opinion, not a failed review.
		const fanned = createDelegateTool({
			cwd: () => "/w",
			depth: () => 1,
			openSession: async (spawn) =>
				spawn.model === "m-bad"
					? Promise.reject(new Error("provider refused"))
					: session("a real finding"),
			briefFor: () => "brief",
			route: async () => [
				{ modelId: "m-good", family: "Anthropic" },
				{ modelId: "m-bad", family: "OpenAI" },
			],
		});
		const text = (
			await call(fanned, {
				agent: "reviewer",
				persona: "code-review",
				question: "look",
				fanOut: true,
			})
		).content[0].text;
		expect(text).toContain("a real finding");
		expect(text).toContain("did not answer: provider refused");
	});

	it("says how many families it actually reached, not how many it asked for", async () => {
		// With no roster there is one family, and claiming three reviewers agreed
		// when they were the same model is exactly the sort of claim this system
		// has made before.
		const single = createDelegateTool({
			cwd: () => "/w",
			depth: () => 1,
			openSession: async () => session("one opinion"),
			briefFor: () => "brief",
			route: async () => [{ modelId: "m-seat", family: "Anthropic" }],
		});
		const text = (
			await call(single, {
				agent: "reviewer",
				persona: "code-review",
				question: "look",
				fanOut: true,
			})
		).content[0].text;
		expect(text).toBe("one opinion");
	});
});

describe("the agent tools are declared, not listed", () => {
	const registry = ToolRegistry.declare(
		declareAgentTools({
			reporter: () => ({ async done() {} }),
			delegate: {
				cwd: () => "/repo",
				depth: () => 1,
				openSession: async () => ({
					async start() {},
					async prompt() {},
					async getLastAssistantText() {
						return "ok";
					},
					async stop() {},
				}),
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

	it("gives delegate to the two postures that can actually call it", () => {
		// It was granted to `read-only` too, on the reasoning that a reader
		// consulting another reader is ordinary and `checkSpawn` would do the
		// limiting. Both halves were true and the grant was still a phantom: a
		// read-only child registers NOTHING (`extension.ts` returns early for a
		// child with no wiring) and `delegate` is not in its `--tools` allowlist
		// either. So every reader was handed a generated brief naming a tool it
		// could not call, twice over — inside the registry built to stop exactly
		// that.
		for (const holder of ["maestro", "worker"] as const)
			expect(registry.grantsFor(holder)).toContain("delegate");
		expect(registry.grantsFor("read-only")).toEqual([]);
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
				kind: "reviewer",
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
		const { args } = invocation();
		expect(args).toContain("--tools");
		expect(args[args.indexOf("--tools") + 1]).toBe(
			READ_ONLY_BUILTINS.join(","),
		);
		expect(READ_ONLY_BUILTINS).not.toContain("write");
		expect(READ_ONLY_BUILTINS).not.toContain("bash");
	});

	it("carries the persona's brief as the child's system prompt", () => {
		const { args } = invocation();
		expect(args[args.indexOf("--append-system-prompt") + 1]).toContain(
			"auth checked in one path",
		);
		expect(args).toContain("--no-session");
	});
});
