// Runtime command/tool repairs: the agent commit tool must call the
// registered commit.v1 commitLocal (shipDeliverable never existed), the ship
// tool must refuse in agent context (maestro owns shipping), /answer must
// dequeue through QuestionQueue, and /sync + /park must not crash.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DebugController } from "../packages/modes/src/debug.js";
import { QuestionQueue } from "../packages/modes/src/question-queue.js";
import { registerRuntimeCommands } from "../packages/modes/src/runtime/commands.js";
import type { RuntimeContext } from "../packages/modes/src/runtime/context.js";

// The /debug review posts through the real gh wrapper; intercept only that
// export so the wiring (cwd, target repo, exact bytes) stays observable.
const createIssueMock = vi.hoisted(() => vi.fn());
vi.mock("@vegardx/pi-github", async (importOriginal) => ({
	...(await importOriginal<typeof import("@vegardx/pi-github")>()),
	createIssue: createIssueMock,
}));

type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

type ToolResult = { content: { type: string; text: string }[] };

type ToolDef = {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		active: { cwd: string },
	) => Promise<ToolResult>;
};

function makeRuntime(overrides: Record<string, unknown> = {}) {
	const commands = new Map<string, CommandHandler>();
	const tools = new Map<string, ToolDef>();
	const capabilities = new Map<string, unknown>();

	const pi = {
		registerCommand: (name: string, def: { handler: CommandHandler }) => {
			commands.set(name, def.handler);
		},
		registerTool: (def: unknown) => {
			const tool = def as ToolDef;
			tools.set(tool.name, tool);
		},
		registerShortcut: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
	};
	const maestro = {
		capabilities: { get: (id: string) => capabilities.get(id) },
		events: { emit: () => {} },
	};

	const rt = {
		pi,
		maestro,
		engine: null,
		execution: undefined,
		state: { mode: "plan", execution: { stage: "idle" } },
		...overrides,
	} as unknown as RuntimeContext;
	registerRuntimeCommands(rt);
	return { rt, commands, tools, capabilities };
}

function makeCmdCtx(inputValue: string | undefined = undefined) {
	const notify = vi.fn();
	const input = vi.fn(async () => inputValue);
	return { ctx: { ui: { notify, input } }, notify, input };
}

const prevAgentId = process.env.PI_MAESTRO_AGENT_ID;

afterEach(() => {
	if (prevAgentId === undefined) {
		delete process.env.PI_MAESTRO_AGENT_ID;
	} else {
		process.env.PI_MAESTRO_AGENT_ID = prevAgentId;
	}
});

describe("mode transition commands", () => {
	it("routes Plan /auto and /hack through the gate, then starts ready work", async () => {
		const runStart = vi.fn(async () => {});
		const requestMode = vi.fn(async () => true);
		const { commands } = makeRuntime({
			state: { mode: "plan", execution: { stage: "idle" } },
			runStart,
			requestMode,
		});
		const { ctx } = makeCmdCtx();
		await commands.get("auto")?.("", ctx);
		await commands.get("hack")?.("", ctx);
		expect(requestMode).toHaveBeenNthCalledWith(1, "auto", ctx);
		expect(requestMode).toHaveBeenNthCalledWith(2, "hack", ctx);
		expect(runStart).toHaveBeenNthCalledWith(1, undefined, ctx);
		expect(runStart).toHaveBeenNthCalledWith(2, undefined, ctx);
	});

	it("routes non-Plan mode requests through the coordinator entry", async () => {
		const requestMode = vi.fn(async () => true);
		const { commands } = makeRuntime({
			state: { mode: "recon", execution: { stage: "idle" } },
			requestMode,
		});
		const { ctx } = makeCmdCtx();
		await commands.get("auto")?.("", ctx);
		expect(requestMode).toHaveBeenCalledWith("auto", ctx);
	});
});

describe("execution lifecycle commands", () => {
	it("registers start/stop/restart/recover/kill and removes implement/retry", () => {
		const { commands } = makeRuntime({});
		for (const name of ["start", "stop", "restart", "recover", "kill"]) {
			expect(commands.has(name)).toBe(true);
		}
		expect(commands.has("implement")).toBe(false);
		expect(commands.has("retry")).toBe(false);
	});

	it("passes optional delivery targets to start, restart, and recover", async () => {
		const runStart = vi.fn(async () => {});
		const runRestart = vi.fn(async () => {});
		const runRecover = vi.fn(async () => {});
		const { commands } = makeRuntime({ runStart, runRestart, runRecover });
		const { ctx } = makeCmdCtx();
		await commands.get("start")?.("auth", ctx);
		await commands.get("restart")?.("", ctx);
		await commands.get("recover")?.("api", ctx);
		expect(runStart).toHaveBeenCalledWith("auth", ctx);
		expect(runRestart).toHaveBeenCalledWith(undefined, ctx);
		expect(runRecover).toHaveBeenCalledWith("api", ctx);
	});
});

describe("/debug", () => {
	type AskQuestion = {
		id: string;
		blocking?: boolean;
		context?: string;
		recommendation?: string;
	};

	function makeDebugCtx(inputValue: string | undefined = undefined) {
		const notify = vi.fn();
		const input = vi.fn(async () => inputValue);
		return {
			ctx: {
				cwd: "/repo",
				ui: { notify, input },
				sessionManager: {
					getSessionFile: () => "/sessions/current.jsonl",
					getEntries: () => [],
				},
			},
			notify,
			input,
		};
	}

	beforeEach(() => {
		delete process.env.PI_MAESTRO_AGENT_ID;
		createIssueMock.mockReset();
	});

	it("diagnoses inline context without prompting and fails closed on canceled review", async () => {
		const shown: AskQuestion[] = [];
		const ask = vi.fn(async (questions: readonly AskQuestion[]) => {
			const question = questions[0]!;
			shown.push(question);
			return [
				{
					questionId: question.id,
					value: question.id.startsWith("debug-recovery-")
						? question.recommendation
						: "cancel",
				},
			];
		});
		const debug = new DebugController();
		const { commands, capabilities } = makeRuntime({
			debug,
			state: { mode: "auto", execution: { stage: "executing" } },
		});
		capabilities.set("ask.v1", { ask });
		const { ctx, notify, input } = makeDebugCtx();

		await commands.get("debug")?.("worker cannot toggle its tasks", ctx);

		expect(input).not.toHaveBeenCalled();
		expect(shown[0]?.blocking).toBe(true);
		expect(shown[0]?.context).toContain("worker cannot toggle its tasks");
		// Without a live execution only the safe no-op recovery is offered.
		expect(shown[0]?.recommendation).toMatch(/^none-/);
		expect(notify).toHaveBeenCalledWith(
			"Recovery completed: No recovery action was performed.",
			"info",
		);
		// The exact issue draft was displayed, then cancel posted nothing.
		expect(shown[1]?.context).toMatch(/^# /);
		expect(shown[1]?.context).toContain("worker cannot toggle its tasks");
		expect(createIssueMock).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			"Issue review canceled; nothing was posted.",
			"info",
		);
		expect(debug.get()).toBeUndefined();
	});

	it("posts the reviewed issue to vegardx/pi-maestro with the exact shown draft", async () => {
		createIssueMock.mockResolvedValueOnce({
			url: "https://github.com/vegardx/pi-maestro/issues/7",
		});
		let shownDraft = "";
		const ask = vi.fn(async (questions: readonly AskQuestion[]) => {
			const question = questions[0]!;
			if (question.id.startsWith("debug-recovery-"))
				return [{ questionId: question.id, value: question.recommendation }];
			shownDraft = question.context ?? "";
			return [{ questionId: question.id, value: "create" }];
		});
		const { commands, capabilities } = makeRuntime({
			debug: new DebugController(),
			state: { mode: "auto", execution: { stage: "executing" } },
		});
		capabilities.set("ask.v1", { ask });
		const { ctx, notify } = makeDebugCtx();

		await commands.get("debug")?.("toggles fail", ctx);

		expect(createIssueMock).toHaveBeenCalledOnce();
		const [cwd, posted] = createIssueMock.mock.calls[0] as [
			string,
			{ title: string; body: string; target: unknown },
		];
		expect(cwd).toBe("/repo");
		expect(posted.target).toEqual({
			host: "github.com",
			owner: "vegardx",
			repo: "pi-maestro",
		});
		expect(shownDraft).toBe(`# ${posted.title}\n\n${posted.body}`);
		expect(notify).toHaveBeenCalledWith(
			"Created pi-maestro issue: https://github.com/vegardx/pi-maestro/issues/7",
			"info",
		);
	});

	it("prompts when no inline context is given and cancels without diagnosing", async () => {
		const ask = vi.fn();
		const debug = new DebugController();
		const { commands, capabilities } = makeRuntime({
			debug,
			state: { mode: "auto", execution: { stage: "executing" } },
		});
		capabilities.set("ask.v1", { ask });
		const { ctx, notify, input } = makeDebugCtx(undefined);

		await commands.get("debug")?.("", ctx);

		expect(input).toHaveBeenCalledOnce();
		expect(ask).not.toHaveBeenCalled();
		expect(debug.get()).toBeUndefined();
		expect(notify).toHaveBeenCalledWith(
			"Debug canceled; no recovery was attempted.",
			"info",
		);
	});

	it("fails safe in a worker session when the maestro bridge is unavailable", async () => {
		const prevSock = process.env.PI_MAESTRO_SOCK;
		process.env.PI_MAESTRO_AGENT_ID = "deliverable-one/worker";
		process.env.PI_MAESTRO_SOCK = "/tmp/pi-maestro-test.sock";
		try {
			const { commands } = makeRuntime({ debug: new DebugController() });
			const { ctx, notify } = makeDebugCtx();

			await commands.get("debug")?.("stuck", ctx);

			expect(notify).toHaveBeenCalledWith(
				expect.stringContaining("Maestro is unavailable"),
				"warning",
			);
		} finally {
			if (prevSock === undefined) delete process.env.PI_MAESTRO_SOCK;
			else process.env.PI_MAESTRO_SOCK = prevSock;
		}
	});
});

describe("commit tool", () => {
	it("calls commit.v1 commitLocal with message, paths, and cwd", async () => {
		const { tools, capabilities } = makeRuntime();
		const commitLocal = vi.fn(async () => ({
			committed: true,
			sha: "abc1234",
		}));
		capabilities.set("commit.v1", { commitLocal });

		const tool = tools.get("commit");
		expect(tool).toBeDefined();
		const result = await tool?.execute(
			"t1",
			{ message: "feat(x): add y", paths: ["src/y.ts"] },
			undefined,
			undefined,
			{ cwd: "/worktree" },
		);

		expect(commitLocal).toHaveBeenCalledWith({
			message: "feat(x): add y",
			paths: ["src/y.ts"],
			cwd: "/worktree",
		});
		expect(result?.content[0]?.text).toContain("Committed abc1234");
	});

	it("reports the error when nothing was committed", async () => {
		const { tools, capabilities } = makeRuntime();
		capabilities.set("commit.v1", {
			commitLocal: vi.fn(async () => ({
				committed: false,
				error: "nothing to commit",
			})),
		});

		const result = await tools
			.get("commit")
			?.execute("t1", { message: "m", paths: [] }, undefined, undefined, {
				cwd: "/worktree",
			});
		expect(result?.content[0]?.text).toContain("nothing to commit");
	});
});

describe("ship tool", () => {
	it("refuses in agent context — the maestro owns shipping", async () => {
		process.env.PI_MAESTRO_AGENT_ID = "deliverable-one/worker";
		const { tools, capabilities } = makeRuntime();
		const ship = vi.fn();
		capabilities.set("ship.v1", { ship });

		const result = await tools
			.get("ship")
			?.execute("t1", {}, undefined, undefined, { cwd: "/worktree" });
		expect(result?.content[0]?.text).toContain("owned by the maestro");
		expect(ship).not.toHaveBeenCalled();
	});

	it("ships via ship.v1 outside agent context", async () => {
		delete process.env.PI_MAESTRO_AGENT_ID;
		const { tools, capabilities } = makeRuntime();
		const ship = vi.fn(async () => ({
			branch: "feat/x",
			pushed: true,
			pr: 5,
		}));
		capabilities.set("ship.v1", { ship });

		const result = await tools
			.get("ship")
			?.execute("t1", {}, undefined, undefined, { cwd: "/repo" });
		expect(ship).toHaveBeenCalledWith({ autoApprove: true, cwd: "/repo" });
		expect(result?.content[0]?.text).toContain("Shipped feat/x → PR #5.");
	});
});

describe("/answer", () => {
	it("dequeues through QuestionQueue and resolves the agent's answers", async () => {
		const queue = new QuestionQueue();
		const resolve = vi.fn();
		queue.enqueue({
			agentId: "deliverable-one/worker",
			agentName: "worker",
			deliverableTitle: "Deliverable One",
			questions: [{ id: "q1", question: "Proceed with plan B?" }],
			resolve,
		});
		const { commands } = makeRuntime({
			execution: { questionQueue: queue },
		});
		const { ctx, notify } = makeCmdCtx("yes, plan B");

		await commands.get("answer")?.("", ctx);

		expect(resolve).toHaveBeenCalledWith([
			{ questionId: "q1", value: "yes, plan B" },
		]);
		// The entry must be gone — no phantom question left in the queue.
		expect(queue.count()).toBe(0);
		expect(notify).toHaveBeenCalledWith("✓ Answered worker", "info");
	});

	it("keeps the entry queued when the user cancels the input", async () => {
		const queue = new QuestionQueue();
		const resolve = vi.fn();
		queue.enqueue({
			agentId: "deliverable-one/worker",
			agentName: "worker",
			deliverableTitle: "Deliverable One",
			questions: [{ id: "q1", question: "Proceed?" }],
			resolve,
		});
		const { commands } = makeRuntime({
			execution: { questionQueue: queue },
		});
		const { ctx } = makeCmdCtx(undefined);

		await commands.get("answer")?.("", ctx);

		expect(resolve).not.toHaveBeenCalled();
		expect(queue.count()).toBe(1);
	});
});

describe("/agents", () => {
	it("expands and focuses the HUD on the Agents tab", async () => {
		const show = vi.fn();
		const { commands } = makeRuntime({
			hud: { show, refresh: vi.fn(), component: {}, dispose: vi.fn() },
		});
		const { ctx, notify } = makeCmdCtx();

		await commands.get("agents")?.("", ctx);

		expect(show).toHaveBeenCalledWith("agents");
		expect(notify).not.toHaveBeenCalled();
	});

	it("falls back to the text overview without a HUD (headless)", async () => {
		const { commands } = makeRuntime({ hud: undefined, engine: null });
		const { ctx, notify } = makeCmdCtx();

		await commands.get("agents")?.("", ctx);

		expect(notify).toHaveBeenCalledWith("No active plan.", "info");
	});
});

describe("/sync and /park", () => {
	it("/sync reports an empty reconcile without crashing", async () => {
		const { commands } = makeRuntime({
			engine: { get: () => ({ deliverables: [], repoPath: "/repo" }) },
		});
		const { ctx, notify } = makeCmdCtx();

		await commands.get("sync")?.("", ctx);

		expect(notify).toHaveBeenCalledWith(
			"Sync complete: retargeted=0 needs-rebase=0 errors=0.",
			"info",
		);
	});

	it("/park degrades gracefully instead of crashing", async () => {
		const { commands } = makeRuntime({
			engine: { get: () => ({ deliverables: [], repoPath: "/repo" }) },
		});
		const { ctx, notify } = makeCmdCtx();

		await commands.get("park")?.("", ctx);

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("not yet implemented"),
			"warning",
		);
	});
});
