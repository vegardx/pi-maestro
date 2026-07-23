// Self-tests for the fake-agent harness (test/fixtures/fake-agent.ts): each
// role is run against a real MaestroRpcServer with a minimal hand-rolled
// maestro stub, asserting the scripted message sequences. Wave 3 supervisor
// tests build on these fixtures.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Questionnaire } from "@vegardx/pi-contracts";
import {
	type AgentMessage,
	type HelloMessage,
	MaestroRpcServer,
	PROTOCOL_VERSION,
} from "@vegardx/pi-rpc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type FakeAgentHandle,
	type FakeAgentScript,
	runFakeAgent,
} from "./fixtures/fake-agent.js";

const TOKEN = "run-token-1";

function wait(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

interface ReceivedEntry {
	readonly agentId: string;
	readonly msg: AgentMessage;
}

interface PendingQuestions {
	readonly agentId: string;
	readonly id: string;
	readonly questions: Questionnaire;
}

/**
 * Minimal hand-rolled maestro: acks hellos (rejecting bad tokens), answers
 * planMutate/planRead/done, and parks questions for the test to answer.
 */
class MaestroStub {
	readonly hellos: HelloMessage[] = [];
	readonly received: ReceivedEntry[] = [];
	readonly toggled: string[] = [];
	readonly pendingQuestions: PendingQuestions[] = [];
	readonly disconnected: string[] = [];

	private readonly waiters: {
		pred: () => boolean;
		resolve: () => void;
	}[] = [];

	constructor(private readonly server: MaestroRpcServer) {
		server.on("connected", (agentId, hello) => {
			this.hellos.push(hello);
			const ok = hello.token === TOKEN;
			server.send(agentId, {
				type: "helloAck",
				id: hello.id,
				ok,
				...(ok ? { planSlug: "test-plan" } : { error: "token mismatch" }),
			});
			this.poke();
		});
		server.on("disconnected", (agentId) => {
			this.disconnected.push(agentId);
			this.poke();
		});
		server.on("message", (agentId, msg) => {
			this.received.push({ agentId, msg });
			this.handle(agentId, msg);
			this.poke();
		});
	}

	messagesFrom(agentId: string): AgentMessage[] {
		return this.received.filter((e) => e.agentId === agentId).map((e) => e.msg);
	}

	/** Resolves once the given condition over stub state holds. */
	until(pred: () => boolean, timeoutMs = 5000): Promise<void> {
		if (pred()) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("timed out waiting for stub condition")),
				timeoutMs,
			);
			this.waiters.push({
				pred,
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
			});
		});
	}

	private handle(agentId: string, msg: AgentMessage): void {
		switch (msg.type) {
			case "planMutate":
				this.toggled.push(msg.params.taskId ?? "");
				this.server.send(agentId, {
					type: "planMutateResult",
					id: msg.id,
					success: true,
					taskId: msg.params.taskId,
				});
				break;
			case "planRead":
				this.server.send(agentId, {
					type: "planReadResponse",
					id: msg.id,
					content: "# plan",
				});
				break;
			case "questions":
				this.pendingQuestions.push({
					agentId,
					id: msg.id,
					questions: msg.questions,
				});
				break;
			case "done":
				this.server.send(agentId, { type: "doneAck", id: msg.id });
				break;
			default:
				break;
		}
	}

	private poke(): void {
		for (let i = this.waiters.length - 1; i >= 0; i--) {
			if (this.waiters[i].pred()) {
				const [waiter] = this.waiters.splice(i, 1);
				waiter.resolve();
			}
		}
	}
}

describe("fake-agent harness", () => {
	let tmpDir: string;
	let socketPath: string;
	let server: MaestroRpcServer;
	let stub: MaestroStub;
	const handles: FakeAgentHandle[] = [];

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "fake-agent-test-"));
		socketPath = join(tmpDir, "maestro.sock");
		server = new MaestroRpcServer();
		stub = new MaestroStub(server);
		await server.listen(socketPath);
	});

	afterEach(async () => {
		for (const handle of handles.splice(0)) handle.close();
		await server.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function run(agentId: string, script: FakeAgentScript): FakeAgentHandle {
		const handle = runFakeAgent({ socketPath, agentId, token: TOKEN, script });
		handles.push(handle);
		return handle;
	}

	describe("happyWorker", () => {
		it("hellos with v2 identity, toggles tasks in order, idles, honors shutdown", async () => {
			const handle = run("g1/worker", {
				kind: "happyWorker",
				taskIds: ["t1", "t2"],
			});

			await stub.until(
				() => stub.toggled.length === 2 && handle.state === "idle",
			);
			expect(stub.toggled).toEqual(["t1", "t2"]);

			const hello = stub.hellos[0];
			expect(hello.v).toBe(PROTOCOL_VERSION);
			expect(hello.role).toBe("agent");
			expect(hello.token).toBe(TOKEN);
			expect(hello.pid).toBe(process.pid);
			expect(hello.id).toBeTruthy();

			// Sequence: working → toggle t1 → toggle t2 → idle.
			const types = stub
				.messagesFrom("g1/worker")
				.map((m) => (m.type === "status" ? `status:${m.status}` : m.type));
			expect(types).toEqual([
				"status:working",
				"planMutate",
				"planMutate",
				"status:idle",
			]);

			// Clean exit on shutdown.
			server.send("g1/worker", { type: "shutdown", reason: "complete" });
			await handle.waitFor("exited");
			await stub.until(() => stub.disconnected.includes("g1/worker"));
			await expect(handle.finished).resolves.toBeUndefined();
		});

		it("fails hello when the run token mismatches", async () => {
			const handle = runFakeAgent({
				socketPath,
				agentId: "g1/worker",
				token: "wrong-token",
				script: { kind: "happyWorker", taskIds: ["t1"] },
			});
			handles.push(handle);

			await expect(handle.finished).rejects.toThrow(/hello rejected/);
			expect(stub.toggled).toEqual([]);
		});

		it("replies pong to ping with the echoed id", async () => {
			const handle = run("g1/worker", { kind: "happyWorker", taskIds: [] });
			await handle.waitFor("idle");

			server.send("g1/worker", { type: "ping", id: "ping-7" });
			await stub.until(() =>
				stub
					.messagesFrom("g1/worker")
					.some((m) => m.type === "pong" && m.id === "ping-7"),
			);
		});
	});

	describe("asker", () => {
		it("blocks on questions until answers, then toggles the remaining task and idles", async () => {
			const handle = run("g1/worker", {
				kind: "asker",
				question: "Which schema version?",
				taskId: "t9",
			});

			await stub.until(() => stub.pendingQuestions.length === 1);
			const pending = stub.pendingQuestions[0];
			expect(pending.agentId).toBe("g1/worker");
			expect(pending.questions[0].question).toBe("Which schema version?");

			// Still blocked: no answers yet, so no toggle and no idle.
			await wait(100);
			expect(handle.state).toBe("blocked");
			expect(stub.toggled).toEqual([]);

			server.send("g1/worker", {
				type: "answers",
				id: pending.id,
				answers: [{ questionId: "q1", value: "v2" }],
			});
			await handle.waitFor("idle");
			expect(stub.toggled).toEqual(["t9"]);

			server.send("g1/worker", { type: "shutdown" });
			await handle.waitFor("exited");
		});
	});

	describe("crasher", () => {
		it("disconnects mid-work without done or idle", async () => {
			const handle = run("g1/worker", { kind: "crasher" });

			await handle.waitFor("working");
			await handle.waitFor("exited");
			await stub.until(() => stub.disconnected.includes("g1/worker"));

			const types = stub.messagesFrom("g1/worker").map((m) => m.type);
			expect(types).toEqual(["status"]);
			expect(types).not.toContain("done");
		});
	});

	describe("silent", () => {
		it("holds a TCP connection but never hellos", async () => {
			const handle = run("g1/worker", { kind: "silent" });

			await handle.waitFor("connected");
			await wait(150);
			expect(stub.hellos).toEqual([]);
			expect(server.size).toBe(0);
			expect(server.has("g1/worker")).toBe(false);

			handle.close();
			await handle.waitFor("exited");
		});
	});

	describe("summarizer", () => {
		it("works tasks, answers summarize by id, and completes on shutdown", async () => {
			const handle = run("g1/worker", {
				kind: "summarizer",
				taskIds: ["t1"],
			});
			await handle.waitFor("idle");
			expect(stub.toggled).toEqual(["t1"]);

			server.send("g1/worker", {
				type: "summarize",
				id: "sum-1",
				consumer: "g2/worker",
				preamble: "Write for the next deliverable.",
				budget: 500,
			});
			await stub.until(() =>
				stub
					.messagesFrom("g1/worker")
					.some((m) => m.type === "summary" && m.id === "sum-1"),
			);
			const summary = stub
				.messagesFrom("g1/worker")
				.find((m) => m.type === "summary");
			expect(summary?.type).toBe("summary");
			if (summary?.type === "summary") {
				expect(summary.content).toMatch(/^## Summary/);
			}

			server.send("g1/worker", { type: "shutdown" });
			await handle.waitFor("exited");
			await expect(handle.finished).resolves.toBeUndefined();
		});
	});
});
