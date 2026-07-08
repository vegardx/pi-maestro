// Self-tests for the fake-agent harness (test/fixtures/fake-agent.ts +
// fake-tmux.ts): each role is run against a real MaestroRpcServer with a
// minimal hand-rolled maestro stub, asserting the scripted message sequences.
// Wave 3 supervisor tests build on these fixtures.

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
import * as tmux from "@vegardx/pi-tmux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type FakeAgentHandle,
	type FakeAgentScript,
	runFakeAgent,
} from "./fixtures/fake-agent.js";
import {
	FakeTmux,
	parseEnvAssignments,
	type TmuxLike,
} from "./fixtures/fake-tmux.js";

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
	const fakeTmuxes: FakeTmux[] = [];

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "fake-agent-test-"));
		socketPath = join(tmpDir, "maestro.sock");
		server = new MaestroRpcServer();
		stub = new MaestroStub(server);
		await server.listen(socketPath);
	});

	afterEach(async () => {
		for (const handle of handles.splice(0)) handle.close();
		for (const ft of fakeTmuxes.splice(0)) await ft.destroy();
		await server.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function run(agentId: string, script: FakeAgentScript): FakeAgentHandle {
		const handle = runFakeAgent({ socketPath, agentId, token: TOKEN, script });
		handles.push(handle);
		return handle;
	}

	function createFakeTmux(): FakeTmux {
		const ft = new FakeTmux();
		fakeTmuxes.push(ft);
		return ft;
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

	describe("FakeTmux", () => {
		it("real tmux module satisfies TmuxLike", () => {
			const real: TmuxLike = tmux;
			expect(typeof real.spawn).toBe("function");
			expect(typeof real.hasSession).toBe("function");
			expect(typeof real.kill).toBe("function");
		});

		it("parses leading env assignments from adapter-style commands", () => {
			expect(
				parseEnvAssignments(
					"PI_MAESTRO_SOCK=/tmp/m.sock PI_MAESTRO_AGENT_ID=g1/worker pi --session x",
				),
			).toEqual({
				PI_MAESTRO_SOCK: "/tmp/m.sock",
				PI_MAESTRO_AGENT_ID: "g1/worker",
			});
			expect(parseEnvAssignments("pi --session x")).toEqual({});
		});

		it("spawn runs the fake-agent CLI out of process: alive → kill → dead", async () => {
			const ft = createFakeTmux();
			const script = JSON.stringify({
				kind: "happyWorker",
				taskIds: ["t1"],
			} satisfies FakeAgentScript);
			const command = [
				`FAKE_AGENT_SOCK=${socketPath}`,
				"FAKE_AGENT_ID=g1/worker",
				`FAKE_AGENT_TOKEN=${TOKEN}`,
				`FAKE_AGENT_SCRIPT=${script}`,
				"pi --session /dev/null",
			].join(" ");

			await ft.spawn("agent-g1-worker", process.cwd(), command);
			expect(await ft.hasSession("agent-g1-worker")).toBe(true);

			// The child connects over the real socket from its own process.
			await stub.until(() => stub.hellos.length === 1, 20_000);
			expect(stub.hellos[0].pid).not.toBe(process.pid);
			expect(stub.hellos[0].pid).toBe(ft.getSession("agent-g1-worker")?.pid);
			await stub.until(() => stub.toggled.includes("t1"), 10_000);

			await ft.kill("agent-g1-worker");
			expect(await ft.hasSession("agent-g1-worker")).toBe(false);
			await ft.waitForExit("agent-g1-worker");
			await stub.until(() => stub.disconnected.includes("g1/worker"));
		});

		it("shutdown lets the forked child exit cleanly (code 0)", async () => {
			const ft = createFakeTmux();
			const script = JSON.stringify({
				kind: "happyWorker",
				taskIds: [],
			} satisfies FakeAgentScript);
			const command = [
				`FAKE_AGENT_SOCK=${socketPath}`,
				"FAKE_AGENT_ID=g1/worker",
				`FAKE_AGENT_TOKEN=${TOKEN}`,
				`FAKE_AGENT_SCRIPT=${script}`,
				"pi",
			].join(" ");

			await ft.spawn("agent-g1-worker", process.cwd(), command);
			await stub.until(
				() =>
					stub
						.messagesFrom("g1/worker")
						.some((m) => m.type === "status" && m.status === "idle"),
				20_000,
			);

			server.send("g1/worker", { type: "shutdown", reason: "complete" });
			const exit = await ft.waitForExit("agent-g1-worker");
			expect(exit.code).toBe(0);
			expect(await ft.hasSession("agent-g1-worker")).toBe(false);
		});

		it("simulateCrash SIGKILLs the child without cleanup", async () => {
			const ft = createFakeTmux();
			const script = JSON.stringify({
				kind: "happyWorker",
				taskIds: [],
			} satisfies FakeAgentScript);
			const command = [
				`FAKE_AGENT_SOCK=${socketPath}`,
				"FAKE_AGENT_ID=g1/worker",
				`FAKE_AGENT_TOKEN=${TOKEN}`,
				`FAKE_AGENT_SCRIPT=${script}`,
				"pi",
			].join(" ");

			await ft.spawn("agent-g1-worker", process.cwd(), command);
			await stub.until(() => stub.hellos.length === 1, 20_000);
			expect(await ft.hasSession("agent-g1-worker")).toBe(true);

			ft.simulateCrash("agent-g1-worker");
			const exit = await ft.waitForExit("agent-g1-worker");
			expect(exit.signal).toBe("SIGKILL");
			expect(await ft.hasSession("agent-g1-worker")).toBe(false);
			// The maestro observes the drop, like a crashed pi.
			await stub.until(() => stub.disconnected.includes("g1/worker"));
		});

		it("rejects duplicate spawns and kills of unknown sessions", async () => {
			const ft = createFakeTmux();
			const command = `FAKE_AGENT_SOCK=${socketPath} FAKE_AGENT_ID=x FAKE_AGENT_TOKEN=${TOKEN} FAKE_AGENT_SCRIPT={"kind":"silent"} pi`;

			await expect(ft.kill("nope")).rejects.toThrow(/no such session/);
			expect(() => ft.simulateCrash("nope")).toThrow(/no such session/);
			expect(await ft.hasSession("nope")).toBe(false);

			await ft.spawn("dup", process.cwd(), command);
			await expect(ft.spawn("dup", process.cwd(), command)).rejects.toThrow(
				/duplicate session/,
			);
			expect(ft.list()).toEqual(["dup"]);
		});
	});
});
