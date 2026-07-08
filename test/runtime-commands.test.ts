// Runtime command/tool repairs: the agent commit tool must call the
// registered commit.v1 commitLocal (shipDeliverable never existed), the ship
// tool must refuse in agent context (maestro owns shipping), /answer must
// dequeue through QuestionQueue, and /sync + /park must not crash.

import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionQueue } from "../packages/modes/src/question-queue.js";
import { registerRuntimeCommands } from "../packages/modes/src/runtime/commands.js";
import type { RuntimeContext } from "../packages/modes/src/runtime/context.js";

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
