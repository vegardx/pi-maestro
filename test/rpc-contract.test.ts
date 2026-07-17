// RPC router contract tests: real server + real client over a Unix socket.
// The fixture tables below are `satisfies`-checked against the full v2
// AgentMessage union — adding a message type without updating them is a
// compile error, so no type can slip through unrouted.

import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TokenSnapshot } from "@vegardx/pi-contracts";
import {
	type AgentMessage,
	type ErrorMessage,
	type HelloAckMessage,
	type HelloIdentity,
	type MaestroMessage,
	MaestroRpcClient,
	MaestroRpcServer,
	PROTOCOL_VERSION,
} from "@vegardx/pi-rpc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createRpcRouter,
	type RoutedAgentMessage,
	RpcRequestCancelledError,
	RpcRequestTimeoutError,
	type RpcRouter,
	type RpcRouterHandlers,
} from "../packages/modes/src/exec/rpc-router.js";

const TOKEN = "run-token-1";

const snapshot: TokenSnapshot = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: 0.01,
	turns: 2,
};

const assignment = {
	agentId: "g1/worker",
	kind: "worker",
	presetId: "worker",
	modelSetId: "session",
	optionId: "session",
	modelId: "session",
	runtime: {
		mode: "full",
		transport: "tmux",
		tools: {},
		session: "persistent",
		isolation: "host",
	},
	resolvedAt: "2026-01-01T00:00:00.000Z",
	source: "session",
} as const;

// One representative wire message per AgentMessage type. `satisfies` makes
// this table exhaustive: a new union member fails compilation here.
const AGENT_FIXTURES = {
	hello: {
		type: "hello",
		id: "h-1",
		v: PROTOCOL_VERSION,
		agentId: "g1/worker",
		role: "agent",
		kind: "worker",
		generation: 0,
		assignment,
		token: TOKEN,
		pid: 123,
	},
	status: { type: "status", status: "working" },
	tokens: { type: "tokens", snapshot },
	childRunSync: {
		type: "childRunSync",
		id: "crs-1",
		ownerGeneration: 0,
		reconcile: true,
		runs: [],
	},
	childRunControlResult: {
		type: "childRunControlResult",
		id: "crc-1",
		ownerGeneration: 0,
		runId: "run-1",
		action: "capture",
		ok: true,
		content: "screen",
	},
	planRead: { type: "planRead", id: "pr-1" },
	planMutate: {
		type: "planMutate",
		id: "pm-1",
		action: "toggleTask",
		deliverableId: "g1",
		params: { taskId: "t1" },
	},
	questions: {
		type: "questions",
		id: "q-1",
		questions: [{ id: "a", question: "which db?" }],
	},
	done: { type: "done", id: "d-1", summary: "did the thing" },
	summary: { type: "summary", id: "s-1", content: "forward-looking summary" },
	panelRead: { type: "panelRead", id: "pnr-1", deliverableId: "g1" },
	panelVerdict: {
		type: "panelVerdict",
		deliverableId: "g1",
		round: 1,
		verdicts: [
			{
				name: "security-audit",
				persona: "security-audit",
				required: true,
				verdict: "approve",
				ok: true,
			},
		],
	},
	debugProposal: {
		type: "debugProposal",
		id: "dbg-1",
		proposalId: "proposal-1",
		agentId: "g1/worker",
		generation: 2,
		planFingerprint: "abc123",
		observed: ["worker is blocked"],
		likelyCause: "last tool failed",
		recovery: {
			kind: "restart-resume",
			targetDeliverableId: "g1",
			expectedGeneration: 2,
			basePlanFingerprint: "abc123",
			confidence: 0.8,
			rationale: "resume after crash",
		},
	},
	interruptAck: {
		type: "interruptAck",
		id: "int-1",
		turnId: "turn-1",
		outcome: "accepted",
	},
	pong: { type: "pong", id: "po-1" },
} as const satisfies {
	[T in AgentMessage["type"]]: Extract<AgentMessage, { type: T }>;
};

// Every type the router dispatches through the handler table (hello is
// consumed by the token gate).
const ROUTED_TYPES = (
	Object.keys(AGENT_FIXTURES) as AgentMessage["type"][]
).filter((t): t is RoutedAgentMessage["type"] => t !== "hello");

function messageId(msg: AgentMessage): string | undefined {
	return "id" in msg && typeof msg.id === "string" ? msg.id : undefined;
}

// Required<> forces one handler per routed type — a second compile-time
// exhaustiveness guard, independent of the fixture table.
function fullHandlers(server: MaestroRpcServer): Required<RpcRouterHandlers> {
	const ack = (agentId: string, msg: RoutedAgentMessage) => {
		server.send(agentId, { type: "steer", content: `handled:${msg.type}` });
	};
	return {
		status: ack,
		tokens: ack,
		childRunSync: ack,
		childRunControlResult: ack,
		planRead: ack,
		planMutate: ack,
		questions: ack,
		done: ack,
		summary: ack,
		panelRead: ack,
		panelVerdict: ack,
		debugProposal: ack,
		interruptAck: ack,
		pong: ack,
	};
}

describe("rpc-router contract", () => {
	let tmpDir: string;
	let socketPath: string;
	let server: MaestroRpcServer;
	let router: RpcRouter | undefined;
	const clients: MaestroRpcClient[] = [];
	const rawSockets: Socket[] = [];

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-rpc-contract-"));
		socketPath = join(tmpDir, "maestro.sock");
		server = new MaestroRpcServer();
		await server.listen(socketPath);
	});

	afterEach(async () => {
		router?.dispose();
		router = undefined;
		for (const client of clients) client.close();
		clients.length = 0;
		for (const socket of rawSockets) socket.destroy();
		rawSockets.length = 0;
		await server.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function identity(agentId: string, token = TOKEN): HelloIdentity {
		return { agentId, role: "agent", token, pid: process.pid };
	}

	function nextMessage(
		client: MaestroRpcClient,
		timeoutMs = 2000,
	): Promise<MaestroMessage> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("timeout waiting for message")),
				timeoutMs,
			);
			client.once("message", (msg) => {
				clearTimeout(timer);
				resolve(msg);
			});
		});
	}

	/** Connect a client and wait for its helloAck. */
	async function connectAgent(
		agentId: string,
		token = TOKEN,
	): Promise<{ client: MaestroRpcClient; ack: HelloAckMessage }> {
		const client = new MaestroRpcClient({ reconnect: false });
		clients.push(client);
		const ackPromise = nextMessage(client);
		client.connect(socketPath, identity(agentId, token));
		const ack = (await ackPromise) as HelloAckMessage;
		expect(ack.type).toBe("helloAck");
		return { client, ack };
	}

	describe("no-silent-drop: unhandled types answer error{unsupported}", () => {
		it.each(ROUTED_TYPES)("%s → error{unsupported}", async (type) => {
			const unhandled: [string, AgentMessage][] = [];
			router = createRpcRouter({
				server,
				token: TOKEN,
				handlers: {},
				onUnhandled: (agentId, msg) => unhandled.push([agentId, msg]),
			});
			const { client } = await connectAgent("g1/worker");

			const fixture = AGENT_FIXTURES[type];
			const reply = nextMessage(client);
			client.send(fixture);

			const err = (await reply) as ErrorMessage;
			expect(err.type).toBe("error");
			expect(err.code).toBe("unsupported");
			expect(err.message).toContain(type);
			expect(err.id).toBe(messageId(fixture));
			expect(unhandled).toEqual([["g1/worker", fixture]]);
		});
	});

	describe("no-silent-drop: handled types reach their handler", () => {
		it.each(ROUTED_TYPES)("%s → handler response", async (type) => {
			const seen: [string, AgentMessage][] = [];
			router = createRpcRouter({
				server,
				token: TOKEN,
				handlers: fullHandlers(server),
				onUnhandled: (agentId, msg) => seen.push([`UNHANDLED:${agentId}`, msg]),
			});
			const { client } = await connectAgent("g1/worker");

			const reply = nextMessage(client);
			client.send(AGENT_FIXTURES[type]);

			expect(await reply).toEqual({
				type: "steer",
				content: `handled:${type}`,
			});
			expect(seen).toEqual([]);
		});
	});

	describe("hello gate", () => {
		it("accepts a matching token and version, echoing the hello id", async () => {
			router = createRpcRouter({ server, token: TOKEN, handlers: {} });
			const { client, ack } = await connectAgent("g1/worker");
			expect(ack.ok).toBe(true);
			expect(ack.id).toBeTruthy();
			expect(router.isRejected("g1/worker")).toBe(false);
			expect(client.connected).toBe(true);
		});

		it("rejects a token mismatch with helloAck{ok:false}", async () => {
			router = createRpcRouter({ server, token: TOKEN, handlers: {} });
			const { ack } = await connectAgent("g1/worker", "wrong-token");
			expect(ack.ok).toBe(false);
			expect(ack.error).toContain("token");
			expect(router.isRejected("g1/worker")).toBe(true);
		});

		it("rejects a protocol version mismatch", async () => {
			router = createRpcRouter({ server, token: TOKEN, handlers: {} });
			const socket = connect(socketPath);
			rawSockets.push(socket);
			const ack = await new Promise<HelloAckMessage>((resolve) => {
				let buffer = "";
				socket.on("data", (chunk) => {
					buffer += chunk.toString();
					const idx = buffer.indexOf("\n");
					if (idx !== -1) resolve(JSON.parse(buffer.slice(0, idx)));
				});
				socket.on("connect", () => {
					const hello = {
						...AGENT_FIXTURES.hello,
						agentId: "g1/old-agent",
						v: 1,
					};
					socket.write(`${JSON.stringify(hello)}\n`);
				});
			});
			expect(ack.type).toBe("helloAck");
			expect(ack.ok).toBe(false);
			expect(ack.error).toContain("version");
			expect(router.isRejected("g1/old-agent")).toBe(true);
		});

		it("answers messages from rejected agents with error{cancelled}", async () => {
			router = createRpcRouter({
				server,
				token: TOKEN,
				handlers: fullHandlers(server),
			});
			const { client } = await connectAgent("g1/worker", "wrong-token");

			const reply = nextMessage(client);
			client.send(AGENT_FIXTURES.planRead);
			const err = (await reply) as ErrorMessage;
			expect(err.type).toBe("error");
			expect(err.code).toBe("cancelled");
			expect(err.id).toBe("pr-1");
		});

		it("re-runs the gate on reconnect after a rejection", async () => {
			router = createRpcRouter({ server, token: TOKEN, handlers: {} });
			await connectAgent("g1/worker", "wrong-token");
			expect(router.isRejected("g1/worker")).toBe(true);

			const { ack } = await connectAgent("g1/worker");
			expect(ack.ok).toBe(true);
			expect(router.isRejected("g1/worker")).toBe(false);
		});
	});

	describe("outbound requests", () => {
		it("request() resolves when the agent replies (ping → pong)", async () => {
			router = createRpcRouter({ server, token: TOKEN, handlers: {} });
			const { client } = await connectAgent("g1/worker");
			client.on("message", (msg) => {
				if (msg.type === "ping") client.send({ type: "pong", id: msg.id });
			});

			const pong = await router.request(
				"g1/worker",
				{ type: "ping", id: "req-1" },
				2000,
			);
			expect(pong).toEqual({ type: "pong", id: "req-1" });
		});

		it("request() correlates summarize → summary by id", async () => {
			router = createRpcRouter({ server, token: TOKEN, handlers: {} });
			const { client } = await connectAgent("g1/worker");
			client.on("message", (msg) => {
				if (msg.type === "summarize") {
					client.send({ type: "summary", id: msg.id, content: "the summary" });
				}
			});

			const summary = await router.request(
				"g1/worker",
				{
					type: "summarize",
					id: "req-2",
					consumer: "g2/worker",
					preamble: "write for the next deliverable",
					budget: 500,
				},
				2000,
			);
			expect(summary).toEqual({
				type: "summary",
				id: "req-2",
				content: "the summary",
			});
		});

		it("a correlated response is consumed, not routed as unsupported", async () => {
			router = createRpcRouter({ server, token: TOKEN, handlers: {} });
			const { client } = await connectAgent("g1/worker");
			const received: MaestroMessage[] = [];
			client.on("message", (msg) => {
				received.push(msg);
				if (msg.type === "ping") client.send({ type: "pong", id: msg.id });
			});

			await router.request("g1/worker", { type: "ping", id: "req-3" }, 2000);
			await new Promise((r) => setTimeout(r, 50));
			expect(received.filter((m) => m.type === "error")).toEqual([]);
		});

		it("request() rejects with a typed timeout error", async () => {
			router = createRpcRouter({ server, token: TOKEN, handlers: {} });
			await connectAgent("g1/worker");

			const err = await router
				.request("g1/worker", { type: "ping", id: "req-4" }, 100)
				.then(() => undefined)
				.catch((e: unknown) => e);
			expect(err).toBeInstanceOf(RpcRequestTimeoutError);
			expect((err as RpcRequestTimeoutError).code).toBe("timeout");
		});

		it("request() rejects immediately for a disconnected agent", async () => {
			router = createRpcRouter({ server, token: TOKEN, handlers: {} });
			const err = await router
				.request("g1/nobody", { type: "ping", id: "req-5" }, 2000)
				.then(() => undefined)
				.catch((e: unknown) => e);
			expect(err).toBeInstanceOf(RpcRequestCancelledError);
			expect((err as RpcRequestCancelledError).code).toBe("cancelled");
		});

		it("request() rejects when the agent disconnects mid-flight", async () => {
			router = createRpcRouter({ server, token: TOKEN, handlers: {} });
			const { client } = await connectAgent("g1/worker");

			const pending = router.request(
				"g1/worker",
				{ type: "ping", id: "req-6" },
				5000,
			);
			client.close();

			const err = await pending.then(() => undefined).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(RpcRequestCancelledError);
		});

		it("send() is a fire-and-forget passthrough", async () => {
			router = createRpcRouter({ server, token: TOKEN, handlers: {} });
			const { client } = await connectAgent("g1/worker");

			const reply = nextMessage(client);
			expect(router.send("g1/worker", { type: "steer", content: "go" })).toBe(
				true,
			);
			expect(await reply).toEqual({ type: "steer", content: "go" });
			expect(router.send("g1/nobody", { type: "ping", id: "x" })).toBe(false);
		});
	});

	describe("lifecycle", () => {
		it("surfaces disconnects via onDisconnect", async () => {
			const disconnected: string[] = [];
			router = createRpcRouter({
				server,
				token: TOKEN,
				handlers: {},
				onDisconnect: (agentId) => disconnected.push(agentId),
			});
			const { client } = await connectAgent("g1/worker");

			client.close();
			await new Promise((r) => setTimeout(r, 50));
			expect(disconnected).toEqual(["g1/worker"]);
		});

		it("surfaces accepted hellos via onConnect", async () => {
			const connectedIds: string[] = [];
			router = createRpcRouter({
				server,
				token: TOKEN,
				handlers: {},
				onConnect: (agentId, hello) => {
					connectedIds.push(agentId);
					expect(hello.token).toBe(TOKEN);
				},
			});
			await connectAgent("g1/worker");
			await connectAgent("g1/reviewer", "wrong-token");
			expect(connectedIds).toEqual(["g1/worker"]);
		});

		it("a handler that throws answers error{internal}, never silence", async () => {
			router = createRpcRouter({
				server,
				token: TOKEN,
				handlers: {
					planRead: () => {
						throw new Error("boom");
					},
					planMutate: async () => {
						throw new Error("async boom");
					},
				},
			});
			const { client } = await connectAgent("g1/worker");

			const reply1 = nextMessage(client);
			client.send(AGENT_FIXTURES.planRead);
			const err1 = (await reply1) as ErrorMessage;
			expect(err1).toEqual({
				type: "error",
				id: "pr-1",
				code: "internal",
				message: "boom",
			});

			const reply2 = nextMessage(client);
			client.send(AGENT_FIXTURES.planMutate);
			const err2 = (await reply2) as ErrorMessage;
			expect(err2).toEqual({
				type: "error",
				id: "pm-1",
				code: "internal",
				message: "async boom",
			});
		});

		it("dispose() detaches from the server and cancels pending requests", async () => {
			router = createRpcRouter({ server, token: TOKEN, handlers: {} });
			const { client } = await connectAgent("g1/worker");

			const pending = router.request(
				"g1/worker",
				{ type: "ping", id: "req-7" },
				5000,
			);
			router.dispose();
			const err = await pending.then(() => undefined).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(RpcRequestCancelledError);

			// Detached: messages no longer produce router replies (the in-flight
			// ping from before dispose() may still arrive; ignore it).
			const received: MaestroMessage[] = [];
			client.on("message", (msg) => received.push(msg));
			client.send(AGENT_FIXTURES.planRead);
			await new Promise((r) => setTimeout(r, 50));
			expect(received.filter((m) => m.type !== "ping")).toEqual([]);
			router = undefined;
		});
	});
});
