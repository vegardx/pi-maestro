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
	};

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "maestro-bridge-"));
		socketPath = join(tmpDir, "maestro.sock");
		server = new MaestroRpcServer();
		await server.listen(socketPath);
		mockPi.sendUserMessage.mockClear();
		mockCtx.shutdown.mockClear();
	});

	afterEach(async () => {
		bridge?.destroy();
		await server.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function createBridge(agentId = "test-agent"): AgentBridge {
		bridge = new AgentBridge({
			pi: mockPi as any,
			socketPath,
			agentId,
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
		server.send("agent-1", { type: "ping" });
		const [id, msg] = (await msgP) as [string, any];
		expect(id).toBe("agent-1");
		expect(msg).toEqual({ type: "pong" });
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
