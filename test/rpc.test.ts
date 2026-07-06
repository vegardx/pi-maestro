import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentMessage,
	createSocketPath,
	type MaestroMessage,
	MaestroRpcClient,
	MaestroRpcServer,
} from "@vegardx/pi-rpc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function wait(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function waitForEvent(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	emitter: { once: (event: any, cb: (...args: any[]) => void) => any },
	event: string,
	timeoutMs = 2000,
): Promise<any[]> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`Timeout waiting for "${event}"`)),
			timeoutMs,
		);
		emitter.once(event, (...args: any[]) => {
			clearTimeout(timer);
			resolve(args);
		});
	});
}

describe("@vegardx/pi-rpc", () => {
	let tmpDir: string;
	let socketPath: string;
	let server: MaestroRpcServer;
	const clients: MaestroRpcClient[] = [];

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-rpc-test-"));
		socketPath = join(tmpDir, "maestro.sock");
		server = new MaestroRpcServer();
	});

	afterEach(async () => {
		for (const client of clients) {
			client.close();
		}
		clients.length = 0;
		await server.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function createClient(opts?: { reconnect?: boolean }): MaestroRpcClient {
		const client = new MaestroRpcClient({
			reconnect: opts?.reconnect ?? false,
			retryDelayMs: 50,
			maxRetryDelayMs: 200,
		});
		clients.push(client);
		return client;
	}

	describe("createSocketPath", () => {
		it("returns a short path under tmpdir with a hash", () => {
			const result = createSocketPath(
				"/home/user/.config/pi/agent/plans/my-plan",
			);
			expect(result).toMatch(/maestro-[a-f0-9]{12}\.sock$/);
			// Must stay under 104 bytes (macOS limit)
			expect(result.length).toBeLessThan(104);
		});

		it("is deterministic for the same planDir", () => {
			const a = createSocketPath("/some/plan/dir");
			const b = createSocketPath("/some/plan/dir");
			expect(a).toBe(b);
		});

		it("differs for different planDirs", () => {
			const a = createSocketPath("/plan/a");
			const b = createSocketPath("/plan/b");
			expect(a).not.toBe(b);
		});
	});

	describe("server", () => {
		it("starts and accepts connections", async () => {
			await server.listen(socketPath);
			const client = createClient();
			const connected = waitForEvent(server, "connected");
			client.connect(socketPath, "agent-1");
			const [agentId] = await connected;
			expect(agentId).toBe("agent-1");
			expect(server.size).toBe(1);
			expect(server.has("agent-1")).toBe(true);
		});

		it("emits disconnected when client closes", async () => {
			await server.listen(socketPath);
			const client = createClient();
			const connected = waitForEvent(server, "connected");
			client.connect(socketPath, "agent-1");
			await connected;

			const disconnected = waitForEvent(server, "disconnected");
			client.close();
			const [agentId] = await disconnected;
			expect(agentId).toBe("agent-1");
			expect(server.size).toBe(0);
		});

		it("routes messages to correct agent by ID", async () => {
			await server.listen(socketPath);
			const client = createClient();
			const connected = waitForEvent(server, "connected");
			client.connect(socketPath, "agent-1");
			await connected;

			const msgPromise = waitForEvent(server, "message");
			client.send({ type: "status", status: "working" });
			const [agentId, msg] = (await msgPromise) as [string, AgentMessage];
			expect(agentId).toBe("agent-1");
			expect(msg).toEqual({ type: "status", status: "working" });
		});

		it("delivers steer message to client", async () => {
			await server.listen(socketPath);
			const client = createClient();
			const connected = waitForEvent(server, "connected");
			client.connect(socketPath, "agent-1");
			await connected;

			const msgPromise = waitForEvent(client, "message");
			server.send("agent-1", { type: "steer", content: "focus on tests" });
			const [msg] = (await msgPromise) as [MaestroMessage];
			expect(msg).toEqual({
				type: "steer",
				content: "focus on tests",
			});
		});

		it("handles EADDRINUSE by unlinking stale socket", async () => {
			await server.listen(socketPath);
			await server.close();

			// Socket file may linger — new server should handle it
			const server2 = new MaestroRpcServer();
			await server2.listen(socketPath);
			expect(server2.size).toBe(0);
			await server2.close();
		});

		it("supports multiple agents simultaneously", async () => {
			await server.listen(socketPath);
			const client1 = createClient();
			const client2 = createClient();

			const connected1 = waitForEvent(server, "connected");
			client1.connect(socketPath, "agent-1");
			await connected1;

			const connected2 = waitForEvent(server, "connected");
			client2.connect(socketPath, "agent-2");
			await connected2;

			expect(server.size).toBe(2);
			expect(server.has("agent-1")).toBe(true);
			expect(server.has("agent-2")).toBe(true);
		});

		it("broadcast reaches all agents", async () => {
			await server.listen(socketPath);
			const client1 = createClient();
			const client2 = createClient();

			const connected1 = waitForEvent(server, "connected");
			client1.connect(socketPath, "agent-1");
			await connected1;

			const connected2 = waitForEvent(server, "connected");
			client2.connect(socketPath, "agent-2");
			await connected2;

			const msg1 = waitForEvent(client1, "message");
			const msg2 = waitForEvent(client2, "message");
			server.broadcast({ type: "ping" });

			const [received1] = (await msg1) as [MaestroMessage];
			const [received2] = (await msg2) as [MaestroMessage];
			expect(received1).toEqual({ type: "ping" });
			expect(received2).toEqual({ type: "ping" });
		});

		it("close() cleans up socket file", async () => {
			const { existsSync } = await import("node:fs");
			await server.listen(socketPath);
			expect(existsSync(socketPath)).toBe(true);
			await server.close();
			expect(existsSync(socketPath)).toBe(false);
		});

		it("send returns false for unknown agent", async () => {
			await server.listen(socketPath);
			expect(server.send("unknown", { type: "ping" })).toBe(false);
		});
	});

	describe("client", () => {
		it("connects and sends hello automatically", async () => {
			await server.listen(socketPath);
			const client = createClient();
			const connected = waitForEvent(server, "connected");
			client.connect(socketPath, "agent-1");
			await connected;
			expect(client.connected).toBe(true);
		});

		it("reconnects on disconnect when enabled", async () => {
			await server.listen(socketPath);
			const client = createClient({ reconnect: true });
			const connected1 = waitForEvent(server, "connected");
			client.connect(socketPath, "agent-1");
			await connected1;

			// Force disconnect by closing server
			await server.close();
			await wait(50);

			// Restart server — client should reconnect
			server = new MaestroRpcServer();
			await server.listen(socketPath);
			const connected2 = waitForEvent(server, "connected");
			const [agentId] = await connected2;
			expect(agentId).toBe("agent-1");
		});

		it("does not reconnect when closed explicitly", async () => {
			await server.listen(socketPath);
			const client = createClient({ reconnect: true });
			const connected = waitForEvent(server, "connected");
			client.connect(socketPath, "agent-1");
			await connected;

			client.close();
			expect(client.connected).toBe(false);

			// Wait to ensure no reconnect attempt
			await wait(150);
			expect(server.size).toBe(0);
		});

		it("handles rapid sequential messages", async () => {
			await server.listen(socketPath);
			const client = createClient();
			const connected = waitForEvent(server, "connected");
			client.connect(socketPath, "agent-1");
			await connected;

			const received: MaestroMessage[] = [];
			client.on("message", (msg) => {
				received.push(msg as MaestroMessage);
			});

			server.send("agent-1", { type: "steer", content: "msg1" });
			server.send("agent-1", { type: "steer", content: "msg2" });
			server.send("agent-1", { type: "ping" });

			// Give time for messages to arrive
			await wait(50);

			expect(received).toEqual([
				{ type: "steer", content: "msg1" },
				{ type: "steer", content: "msg2" },
				{ type: "ping" },
			]);
		});

		it("shutdown message is received by client", async () => {
			await server.listen(socketPath);
			const client = createClient();
			const connected = waitForEvent(server, "connected");
			client.connect(socketPath, "agent-1");
			await connected;

			const msgPromise = waitForEvent(client, "message");
			server.send("agent-1", {
				type: "shutdown",
				reason: "deliverable complete",
			});
			const [msg] = (await msgPromise) as [MaestroMessage];
			expect(msg).toEqual({
				type: "shutdown",
				reason: "deliverable complete",
			});
		});
	});
});
