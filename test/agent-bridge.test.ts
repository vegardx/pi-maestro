import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaestroRpcServer } from "@vegardx/pi-rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentBridge } from "../packages/modes/src/agent-bridge.js";

function wait(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function waitForEvent(
	emitter: { once: (...args: any[]) => any },
	event: string,
	timeoutMs = 2000,
): Promise<unknown[]> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`waitForEvent(${event}) timed out`)),
			timeoutMs,
		);
		emitter.once(event, (...args: unknown[]) => {
			clearTimeout(timer);
			resolve(args);
		});
	});
}

describe("AgentBridge", () => {
	let server: MaestroRpcServer;
	let socketPath: string;
	let tmpDir: string;
	let bridge: AgentBridge;
	const mockPi = {
		sendUserMessage: vi.fn(),
	};
	const mockCtx = {
		shutdown: vi.fn(),
		abort: vi.fn(),
		isIdle: vi.fn(() => false),
		ui: { notify: vi.fn() },
	};

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "maestro-bridge-"));
		socketPath = join(tmpDir, "maestro.sock");
		server = new MaestroRpcServer();
		await server.listen(socketPath);
		mockPi.sendUserMessage.mockClear();
		mockCtx.shutdown.mockClear();
		mockCtx.abort.mockClear();
		mockCtx.isIdle.mockReturnValue(false);
		mockCtx.ui.notify.mockClear();
	});

	afterEach(async () => {
		bridge?.destroy();
		await server.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function createBridge(
		agentId = "test-agent",
		opts?: { requestTimeoutMs?: number },
	): AgentBridge {
		bridge = new AgentBridge({
			pi: mockPi as any,
			socketPath,
			agentId,
			requestTimeoutMs: opts?.requestTimeoutMs,
		});
		return bridge;
	}

	it("connects and sends hello on start", async () => {
		const b = createBridge("my-agent");
		const connected = waitForEvent(server, "connected");
		b.start(mockCtx as any);
		const [agentId] = await connected;
		expect(agentId).toBe("my-agent");
	});

	it("sends status working on turn start", async () => {
		const b = createBridge("agent-1");
		const connected = waitForEvent(server, "connected");
		b.start(mockCtx as any);
		await connected;

		const msgP = waitForEvent(server, "message");
		b.onTurnStart();
		const [id, msg] = (await msgP) as [string, any];
		expect(id).toBe("agent-1");
		expect(msg).toEqual({ type: "status", status: "working" });
	});

	it("sends status idle and tokens on turn end", async () => {
		const b = createBridge("agent-1");
		const connected = waitForEvent(server, "connected");
		b.start(mockCtx as any);
		await connected;

		const messages: any[] = [];
		server.on("message", (_id, msg) => messages.push(msg));

		b.recordUsage({ input: 100, output: 50 });
		b.onTurnEnd();
		await wait(30);

		expect(
			messages.some((m) => m.type === "status" && m.status === "idle"),
		).toBe(true);
		expect(
			messages.some(
				(m) =>
					m.type === "tokens" &&
					m.snapshot.input === 100 &&
					m.snapshot.turns === 1,
			),
		).toBe(true);
	});

	it("calls pi.sendUserMessage on steer message", async () => {
		const b = createBridge("agent-1");
		const connected = waitForEvent(server, "connected");
		b.start(mockCtx as any);
		await connected;

		server.send("agent-1", { type: "steer", content: "fix the tests" });
		await wait(50);

		expect(mockPi.sendUserMessage).toHaveBeenCalledWith("fix the tests", {
			deliverAs: "followUp",
		});
	});

	it("captures the summarize reply and queues steers meanwhile", async () => {
		const b = createBridge("agent-1");
		const connected = waitForEvent(server, "connected");
		b.start(mockCtx as any);
		await connected;

		const messages: any[] = [];
		server.on("message", (_id, msg) => messages.push(msg));

		// A turn is in flight when the summarize arrives (the completion gate
		// fires mid-turn, during the agent's toggle tool call).
		b.onTurnStart();
		server.send("agent-1", {
			type: "summarize",
			id: "sum-1",
			consumer: "the api deliverable worker",
			preamble: "worker — auth deliverable",
			budget: 5000,
		});
		await wait(50);

		// The summarization prompt was injected as a followUp
		expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
		const [prompt, opts] = mockPi.sendUserMessage.mock.calls[0];
		expect(prompt).toContain("the api deliverable worker");
		expect(opts).toEqual({ deliverAs: "followUp" });

		// A steer arriving mid-summarize is queued, not injected
		server.send("agent-1", { type: "steer", content: "also fix lint" });
		await wait(50);
		expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);

		// The in-flight turn ends with mid-work commentary — NOT the summary
		b.recordAssistantText("Toggling the task now, then wrapping up.");
		b.onTurnEnd();
		await wait(50);
		expect(messages.find((m) => m.type === "summary")).toBeUndefined();
		// The queued steer is still held back
		expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);

		// The injected prompt starts the next turn; its reply is the summary
		b.onTurnStart();
		b.recordAssistantText("## Summary\nBuilt the auth endpoints.");
		b.onTurnEnd();
		await wait(50);

		const summary = messages.find((m) => m.type === "summary");
		expect(summary).toEqual({
			type: "summary",
			id: "sum-1",
			content: "## Summary\nBuilt the auth endpoints.",
		});
		expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(2);
		expect(mockPi.sendUserMessage).toHaveBeenLastCalledWith("also fix lint", {
			deliverAs: "followUp",
		});
	});

	it("captures the summarize reply when the agent was idle", async () => {
		const b = createBridge("agent-1");
		const connected = waitForEvent(server, "connected");
		b.start(mockCtx as any);
		await connected;

		const messages: any[] = [];
		server.on("message", (_id, msg) => messages.push(msg));

		// No turn in flight: the injected followUp starts the next turn
		server.send("agent-1", {
			type: "summarize",
			id: "sum-2",
			consumer: "the maestro",
			preamble: "worker — api deliverable",
			budget: 5000,
		});
		await wait(50);

		b.onTurnStart();
		b.recordAssistantText("## Summary\nDone.");
		b.onTurnEnd();
		await wait(50);

		expect(messages.find((m) => m.type === "summary")).toEqual({
			type: "summary",
			id: "sum-2",
			content: "## Summary\nDone.",
		});
	});

	it("replies with an empty summary to a second concurrent summarize", async () => {
		const b = createBridge("agent-1");
		const connected = waitForEvent(server, "connected");
		b.start(mockCtx as any);
		await connected;

		const messages: any[] = [];
		server.on("message", (_id, msg) => messages.push(msg));

		server.send("agent-1", {
			type: "summarize",
			id: "sum-1",
			consumer: "the maestro",
			preamble: "worker",
			budget: 5000,
		});
		server.send("agent-1", {
			type: "summarize",
			id: "sum-2",
			consumer: "the maestro",
			preamble: "worker",
			budget: 5000,
		});
		await wait(50);

		// The second request settles immediately with an empty summary so the
		// maestro falls back fast instead of timing out.
		expect(messages.find((m) => m.type === "summary")).toEqual({
			type: "summary",
			id: "sum-2",
			content: "",
		});
		// The first is still pending and captures normally
		b.onTurnStart();
		b.recordAssistantText("## Summary\nReal one.");
		b.onTurnEnd();
		await wait(50);
		expect(
			messages.filter((m) => m.type === "summary").map((m) => m.id),
		).toEqual(["sum-2", "sum-1"]);
	});

	it("rejects a second ask while one is pending", async () => {
		const b = createBridge("agent-1");
		const connected = waitForEvent(server, "connected");
		b.start(mockCtx as any);
		await connected;

		const first = b.ask([{ question: "Which db?" }] as any);
		await expect(b.ask([{ question: "Which port?" }] as any)).rejects.toThrow(
			"ask already pending",
		);

		// The first ask still resolves normally
		b.destroy();
		await expect(first).resolves.toEqual([]);
	});

	it("settles a pending ask on error{id} (cancelled)", async () => {
		const b = createBridge("agent-1");
		const connected = waitForEvent(server, "connected");
		b.start(mockCtx as any);
		await connected;

		const msgP = waitForEvent(server, "message");
		const askP = b.ask([{ question: "Which db?" }] as any);
		const [, msg] = (await msgP) as [string, any];
		expect(msg.type).toBe("questions");

		server.send("agent-1", {
			type: "error",
			id: msg.id,
			code: "cancelled",
			message: "user cancelled",
		});
		await expect(askP).resolves.toEqual([]);
	});

	it("settles pending planRead and planMutate on error{id}", async () => {
		const b = createBridge("agent-1");
		const connected = waitForEvent(server, "connected");
		b.start(mockCtx as any);
		await connected;

		const readMsgP = waitForEvent(server, "message");
		const readP = b.planRead();
		const [, readMsg] = (await readMsgP) as [string, any];
		server.send("agent-1", {
			type: "error",
			id: readMsg.id,
			code: "internal",
			message: "plan unavailable",
		});
		await expect(readP).resolves.toBe("Error: plan unavailable");

		const mutMsgP = waitForEvent(server, "message");
		const mutP = b.planMutate("toggleTask", "g1", { taskId: "t1" });
		const [, mutMsg] = (await mutMsgP) as [string, any];
		server.send("agent-1", {
			type: "error",
			id: mutMsg.id,
			code: "badRequest",
			message: "no such task",
		});
		await expect(mutP).resolves.toEqual({
			type: "planMutateResult",
			id: mutMsg.id,
			success: false,
			error: "no such task",
		});
	});

	it("times out planRead and planMutate instead of hanging", async () => {
		const b = createBridge("agent-1", { requestTimeoutMs: 50 });
		const connected = waitForEvent(server, "connected");
		b.start(mockCtx as any);
		await connected;

		const readP = b.planRead();
		await expect(readP).resolves.toBe("Error: plan read timed out after 50ms.");

		const mutP = b.planMutate("toggleTask", "g1", { taskId: "t1" });
		const mutRes = await mutP;
		expect(mutRes.success).toBe(false);
		expect(mutRes.error).toBe("plan mutate timed out after 50ms");

		// A settled timeout leaves the slot free for the next request
		const readMsgP = waitForEvent(server, "message");
		const readP2 = b.planRead();
		const [, readMsg] = (await readMsgP) as [string, any];
		server.send("agent-1", {
			type: "planReadResponse",
			id: readMsg.id,
			content: "# Plan",
		});
		await expect(readP2).resolves.toBe("# Plan");
	});

	it("shuts down and settles pendings on helloAck{ok:false}", async () => {
		const b = createBridge("agent-1");
		const connected = waitForEvent(server, "connected");
		b.start(mockCtx as any);
		await connected;

		const askP = b.ask([{ question: "Which db?" }] as any);
		await wait(30);

		const disconnected = waitForEvent(server, "disconnected");
		server.send("agent-1", {
			type: "helloAck",
			ok: false,
			error: "token mismatch",
		});
		await disconnected;

		await expect(askP).resolves.toEqual([]);
		expect(mockCtx.shutdown).toHaveBeenCalledTimes(1);
		expect(mockCtx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("token mismatch"),
			"error",
		);
	});

	it("acknowledges worker interrupts, aborts the turn, and preserves process", async () => {
		const b = createBridge("agent-1");
		const connected = waitForEvent(server, "connected");
		b.start(mockCtx as any);
		await connected;
		b.onTurnStart();
		await wait(10);
		const ack = waitForEvent(server, "message");
		server.send("agent-1", {
			type: "interrupt",
			id: "int-1",
			reason: "user interrupt",
		});
		const [, message] = (await ack) as [
			string,
			{ type: string; outcome: string },
		];
		expect(message).toMatchObject({
			type: "interruptAck",
			outcome: "accepted",
		});
		expect(mockCtx.abort).toHaveBeenCalledOnce();
		expect(mockCtx.shutdown).not.toHaveBeenCalled();

		const duplicate = waitForEvent(server, "message");
		server.send("agent-1", { type: "interrupt", id: "int-2" });
		const [, duplicateMessage] = (await duplicate) as [
			string,
			{ outcome: string },
		];
		expect(duplicateMessage.outcome).toBe("already-interrupting");
	});

	it("calls ctx.shutdown on shutdown message", async () => {
		const b = createBridge("agent-1");
		const connected = waitForEvent(server, "connected");
		b.start(mockCtx as any);
		await connected;

		server.send("agent-1", { type: "shutdown", reason: "done" });
		await wait(50);

		expect(mockCtx.shutdown).toHaveBeenCalledTimes(1);
	});

	it("responds to ping with pong", async () => {
		const b = createBridge("agent-1");
		const connected = waitForEvent(server, "connected");
		b.start(mockCtx as any);
		await connected;

		const msgP = waitForEvent(server, "message");
		server.send("agent-1", { type: "ping", id: "ping-1" });
		const [id, msg] = (await msgP) as [string, any];
		expect(id).toBe("agent-1");
		expect(msg).toEqual({ type: "pong", id: "ping-1" });
	});

	it("disconnects cleanly on destroy", async () => {
		const b = createBridge("agent-1");
		const connected = waitForEvent(server, "connected");
		b.start(mockCtx as any);
		await connected;

		const disconnected = waitForEvent(server, "disconnected");
		b.destroy();
		const [agentId] = await disconnected;
		expect(agentId).toBe("agent-1");
	});
});

describe("AgentBridge planMutate serialization", () => {
	let server: MaestroRpcServer;
	let socketPath: string;
	let tmpDir: string;
	let bridge: AgentBridge;
	const mockPi = { sendUserMessage: vi.fn() };
	const mockCtx = { shutdown: vi.fn(), ui: { notify: vi.fn() } };

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "maestro-bridge-mutate-"));
		socketPath = join(tmpDir, "maestro.sock");
		server = new MaestroRpcServer();
		await server.listen(socketPath);
	});

	afterEach(async () => {
		bridge?.destroy();
		await server.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("queues concurrent toggles instead of rejecting with busy", async () => {
		// A model turn toggles several tasks as PARALLEL tool calls; the old
		// single-flight guard accepted one and returned "busy" for the rest —
		// task state silently drifted from the real work (radicalai dogfood).
		bridge = new AgentBridge({
			pi: mockPi as any,
			socketPath,
			agentId: "worker-1",
		});
		const connected = waitForEvent(server, "connected");
		bridge.start(mockCtx as any);
		await connected;

		const seen: any[] = [];
		server.on("message", (_id, msg: any) => {
			if (msg.type !== "planMutate") return;
			seen.push(msg);
			// Answer each request after a beat, like the real adapter.
			setTimeout(() => {
				server.send("worker-1", {
					type: "planMutateResult",
					id: msg.id,
					success: true,
					taskId: msg.params.taskId,
				});
			}, 20);
		});

		const results = await Promise.all([
			bridge.planMutate("toggleTask", "d1", { taskId: "t1" }),
			bridge.planMutate("toggleTask", "d1", { taskId: "t2" }),
			bridge.planMutate("toggleTask", "d1", { taskId: "t3" }),
		]);

		expect(results.map((r) => r.success)).toEqual([true, true, true]);
		expect(results.every((r) => r.error === undefined)).toBe(true);
		// All three reached the maestro, one at a time.
		expect(seen.map((m) => m.params.taskId).sort()).toEqual(["t1", "t2", "t3"]);
	});
});
