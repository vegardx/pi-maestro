// Scripted fake agent for supervisor/lifecycle tests. Connects a real
// MaestroRpcClient (protocol v2) and plays a declarative role. Usable both
// in-process (returns a controllable handle) and as a forked child via the
// CLI entry at the bottom (env: FAKE_AGENT_SOCK/ID/TOKEN/SCRIPT), which is
// what FakeTmux "spawns".

import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import {
	type AgentMessage,
	type HelloAckMessage,
	type MaestroMessage,
	MaestroRpcClient,
} from "@vegardx/pi-rpc";

export type FakeAgentScript =
	| { readonly kind: "happyWorker"; readonly taskIds: readonly string[] }
	| {
			readonly kind: "asker";
			readonly question: string;
			/** Task toggled after answers arrive (the "remaining" task). */
			readonly taskId?: string;
	  }
	| { readonly kind: "crasher" }
	| { readonly kind: "silent" }
	| { readonly kind: "summarizer"; readonly taskIds: readonly string[] };

export type FakeAgentState =
	| "connecting"
	| "connected"
	| "helloed"
	| "working"
	| "blocked"
	| "idle"
	| "done"
	| "exited";

export interface RunFakeAgentOpts {
	readonly socketPath: string;
	readonly agentId: string;
	readonly token: string;
	readonly script: FakeAgentScript;
	/**
	 * Crash exit. The forked CLI passes process.exit; the in-process default
	 * hard-drops the connection without any goodbye.
	 */
	readonly exit?: (code: number) => void;
}

export interface FakeAgentHandle {
	readonly state: FakeAgentState;
	/** Every message the maestro sent this agent. */
	readonly received: readonly MaestroMessage[];
	/** Resolves when the script finishes; rejects on script failure. */
	readonly finished: Promise<void>;
	/** Resolves once the given state has been entered (now or later). */
	waitFor(state: FakeAgentState, timeoutMs?: number): Promise<void>;
	/** Abort the script and drop the connection. */
	close(): void;
}

interface MessageWaiter {
	readonly pred: (msg: MaestroMessage) => boolean;
	readonly resolve: (msg: MaestroMessage) => void;
	readonly reject: (err: Error) => void;
}

class FakeAgentRunner implements FakeAgentHandle {
	state: FakeAgentState = "connecting";
	readonly received: MaestroMessage[] = [];
	readonly finished: Promise<void>;

	private readonly opts: RunFakeAgentOpts;
	private readonly client = new MaestroRpcClient({ reconnect: false });
	private rawSocket: Socket | undefined;
	private readonly inbox: MaestroMessage[] = [];
	private readonly waiters: MessageWaiter[] = [];
	private readonly visited = new Set<FakeAgentState>();
	private readonly stateWaiters = new Map<FakeAgentState, (() => void)[]>();
	private closed = false;

	constructor(opts: RunFakeAgentOpts) {
		this.opts = opts;
		this.finished = this.run().catch((err) => {
			if (!this.closed) throw err;
		});
		// Rejections surface to callers awaiting `finished`, never as unhandled.
		this.finished.catch(() => {});
	}

	waitFor(state: FakeAgentState, timeoutMs = 5000): Promise<void> {
		if (this.visited.has(state)) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(
					new Error(
						`fake agent ${this.opts.agentId}: timed out waiting for "${state}" (current: ${this.state})`,
					),
				);
			}, timeoutMs);
			const list = this.stateWaiters.get(state) ?? [];
			list.push(() => {
				clearTimeout(timer);
				resolve();
			});
			this.stateWaiters.set(state, list);
		});
	}

	close(): void {
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) {
			waiter.reject(new Error("fake agent closed"));
		}
		this.client.close();
		this.rawSocket?.destroy();
		this.setState("exited");
	}

	// ─── script execution ────────────────────────────────────────────────

	private async run(): Promise<void> {
		const { script } = this.opts;
		if (script.kind === "silent") {
			await this.runSilent();
			return;
		}

		this.client.on("error", () => {});
		this.client.on("message", (msg) => this.onMessage(msg));
		this.client.on("connected", () => this.setState("connected"));
		this.client.connect(this.opts.socketPath, {
			agentId: this.opts.agentId,
			role: "agent",
			token: this.opts.token,
			pid: process.pid,
		});

		const ack = (await this.take(
			(m) => m.type === "helloAck",
		)) as HelloAckMessage;
		if (!ack.ok) {
			throw new Error(`hello rejected: ${ack.error ?? "unknown reason"}`);
		}
		this.setState("helloed");

		switch (script.kind) {
			case "happyWorker":
			case "summarizer":
				// summarizer differs only via the summarize reflex in onMessage
				await this.workTasks(script.taskIds);
				await this.idleUntilShutdown();
				break;
			case "asker": {
				this.send({ type: "status", status: "working" });
				this.setState("working");
				const qid = randomUUID();
				this.send({
					type: "questions",
					id: qid,
					questions: [{ id: "q1", question: script.question }],
				});
				this.setState("blocked");
				// Blocks indefinitely — questions have a human in the loop.
				await this.take((m) => m.type === "answers" && m.id === qid);
				if (script.taskId) await this.toggleTask(script.taskId);
				await this.idleUntilShutdown();
				break;
			}
			case "crasher": {
				this.send({ type: "status", status: "working" });
				this.setState("working");
				// Let the status write flush before dying mid-work.
				await new Promise((r) => setTimeout(r, 25));
				this.exit(1);
				break;
			}
		}
	}

	private async workTasks(taskIds: readonly string[]): Promise<void> {
		this.send({ type: "status", status: "working" });
		this.setState("working");
		for (const taskId of taskIds) {
			await this.toggleTask(taskId);
		}
	}

	private async toggleTask(taskId: string): Promise<void> {
		const id = randomUUID();
		this.send({
			type: "planMutate",
			id,
			action: "toggleTask",
			groupId: this.groupId,
			params: { taskId },
		});
		const result = await this.take((m) => "id" in m && m.id === id);
		if (result.type !== "planMutateResult" || !result.success) {
			throw new Error(`toggleTask ${taskId} failed`);
		}
	}

	private async idleUntilShutdown(): Promise<void> {
		this.send({ type: "status", status: "idle" });
		this.setState("idle");
		await this.take((m) => m.type === "shutdown");
		this.client.close();
		this.setState("done");
		this.setState("exited");
	}

	/** Connect raw TCP and never speak — not even hello. */
	private runSilent(): Promise<void> {
		return new Promise((resolve, reject) => {
			const socket = connect(this.opts.socketPath);
			this.rawSocket = socket;
			socket.on("connect", () => this.setState("connected"));
			socket.on("close", () => {
				this.setState("exited");
				resolve();
			});
			socket.on("error", (err) => {
				if (this.closed) resolve();
				else reject(err);
			});
		});
	}

	// ─── plumbing ────────────────────────────────────────────────────────

	private onMessage(msg: MaestroMessage): void {
		this.received.push(msg);
		// Reflexes that apply wherever the script currently is.
		if (msg.type === "ping") {
			this.send({ type: "pong", id: msg.id });
			return;
		}
		if (msg.type === "summarize" && this.opts.script.kind === "summarizer") {
			this.send({
				type: "summary",
				id: msg.id,
				content: "## Summary\nFake forward-looking notes for the next group.",
			});
			return;
		}
		const idx = this.waiters.findIndex((w) => w.pred(msg));
		if (idx !== -1) {
			const [waiter] = this.waiters.splice(idx, 1);
			waiter.resolve(msg);
			return;
		}
		this.inbox.push(msg);
	}

	private take(pred: (m: MaestroMessage) => boolean): Promise<MaestroMessage> {
		const idx = this.inbox.findIndex(pred);
		if (idx !== -1) {
			return Promise.resolve(this.inbox.splice(idx, 1)[0]);
		}
		return new Promise((resolve, reject) => {
			this.waiters.push({ pred, resolve, reject });
		});
	}

	private send(msg: AgentMessage): void {
		this.client.send(msg);
	}

	private exit(code: number): void {
		if (this.opts.exit) {
			this.opts.exit(code);
			return;
		}
		// In-process "crash": drop the connection without cleanup.
		this.client.close();
		this.setState("exited");
	}

	private setState(state: FakeAgentState): void {
		this.state = state;
		this.visited.add(state);
		const waiters = this.stateWaiters.get(state);
		if (!waiters) return;
		this.stateWaiters.delete(state);
		for (const resolve of waiters) resolve();
	}

	private get groupId(): string {
		// agentId follows the adapter's "groupId/agentName" convention.
		return this.opts.agentId.split("/")[0] || this.opts.agentId;
	}
}

export function runFakeAgent(opts: RunFakeAgentOpts): FakeAgentHandle {
	return new FakeAgentRunner(opts);
}

// ─── CLI entry (forked by FakeTmux) ──────────────────────────────────────────

function runCliFromEnv(scriptJson: string): void {
	const script = JSON.parse(scriptJson) as FakeAgentScript;
	const handle = runFakeAgent({
		socketPath:
			process.env.FAKE_AGENT_SOCK ?? process.env.PI_MAESTRO_SOCK ?? "",
		agentId:
			process.env.FAKE_AGENT_ID ??
			process.env.PI_MAESTRO_AGENT_ID ??
			"fake-agent",
		token: process.env.FAKE_AGENT_TOKEN ?? process.env.PI_MAESTRO_TOKEN ?? "",
		script,
		exit: (code) => process.exit(code),
	});
	// silent never finishes — the open socket keeps the process alive until
	// it is killed, matching a wedged pi.
	handle.finished.then(
		() => process.exit(0),
		() => process.exit(1),
	);
}

if (process.env.FAKE_AGENT_SCRIPT) {
	runCliFromEnv(process.env.FAKE_AGENT_SCRIPT);
}
