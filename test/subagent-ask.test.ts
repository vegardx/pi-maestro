// The persistent standby lifecycle: a child spawned with `standby` stays alive
// after its initial prompt and answers `ask` follow-ups on the SAME context,
// one turn per ask, until it is stopped. Exercised through the RpcLike seam
// (no real process) — the runner's intended test surface.

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RunId, SpawnProfile } from "@vegardx/pi-contracts";
import { describe, expect, it } from "vitest";
import { createRunBus } from "../packages/subagents/src/bus.js";
import {
	createAgentRunner,
	type RpcLike,
} from "../packages/subagents/src/runners.js";
import {
	createSemaphore,
	type Semaphore,
} from "../packages/subagents/src/semaphore.js";
import type { LaunchRequest } from "../packages/subagents/src/service.js";

/**
 * A deterministic standby child. Each prompt/follow-up "runs a turn": it records
 * the message, advances to the next scripted response, and emits `agent_settled`
 * on a microtask so the runner's idle wait resolves.
 */
class FakeStandbyClient implements RpcLike {
	private readonly listeners = new Set<(e: AgentSessionEvent) => void>();
	readonly prompts: string[] = [];
	readonly followUps: string[] = [];
	private turn = -1;
	private last: string | null = null;
	exitError: Error | null = null;

	constructor(private readonly responses: readonly string[]) {}

	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async abort(): Promise<void> {}
	async steer(): Promise<void> {}

	onEvent(listener: (e: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private settleTurn(message: string): void {
		this.turn += 1;
		this.last = this.responses[this.turn] ?? `echo:${message}`;
		queueMicrotask(() => {
			for (const l of [...this.listeners])
				l({ type: "agent_settled" } as AgentSessionEvent);
		});
	}

	async prompt(message: string): Promise<void> {
		this.prompts.push(message);
		this.settleTurn(message);
	}

	async followUp(message: string): Promise<void> {
		this.followUps.push(message);
		this.settleTurn(message);
	}

	async getLastAssistantText(): Promise<string | null> {
		return this.last;
	}
}

function launch(
	client: RpcLike,
	profile: SpawnProfile,
	semaphore: Semaphore = createSemaphore(4),
) {
	const runner = createAgentRunner({ factory: () => client, semaphore });
	const request: LaunchRequest = {
		runId: "run-standby" as RunId,
		prompt: "boot",
		profile,
		invocation: { cwd: "/tmp", args: [], env: {}, depth: 1 },
	};
	return runner.launch(request, createRunBus());
}

/** Poll a predicate to a deadline (the runner settles turns on microtasks). */
async function waitFor(predicate: () => boolean, ms = 1000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
}

describe("persistent standby ask", () => {
	it("answers repeated asks on the same live context, in order", async () => {
		const client = new FakeStandbyClient(["ready", "answer-1", "answer-2"]);
		const controller = launch(client, { profile: "advisor", standby: true });

		expect(controller.ask).toBeTypeOf("function");
		// The initial prompt ran turn 0; each ask drives one follow-up turn.
		const first = await controller.ask?.("question one");
		const second = await controller.ask?.("question two");

		expect(first).toBe("answer-1");
		expect(second).toBe("answer-2");
		expect(client.prompts).toEqual(["boot"]);
		expect(client.followUps).toEqual(["question one", "question two"]);

		controller.stop();
		const result = await controller.result();
		expect(result.status).toBe("stopped");
		// The last turn's text is salvaged as the settled summary.
		expect(result.summary).toBe("answer-2");
	});

	it("rejects asks once the run has settled", async () => {
		const client = new FakeStandbyClient(["ready"]);
		const controller = launch(client, { profile: "advisor", standby: true });
		await controller.ask?.("warm up"); // ensure it is live first
		controller.stop();
		await controller.result();
		await expect(controller.ask?.("too late")).rejects.toThrow("settled");
	});

	it("a non-standby run exposes no ask (one-shot lifecycle is unchanged)", () => {
		const client = new FakeStandbyClient(["done"]);
		const controller = launch(client, { profile: "general" });
		expect(controller.ask).toBeUndefined();
	});

	it("yields its semaphore slot while parked idle, re-acquiring to answer", async () => {
		const semaphore = createSemaphore(1); // one slot — a held slot would wedge
		const client = new FakeStandbyClient(["ready", "answer-1"]);
		const controller = launch(
			client,
			{ profile: "advisor", standby: true },
			semaphore,
		);

		// After the initial prompt the run parks; a parked standby holds no slot.
		await waitFor(() => semaphore.active === 0);

		// Proof it truly yielded: the sole slot is free to acquire elsewhere.
		const borrowed = await semaphore.acquire();
		expect(semaphore.active).toBe(1);
		borrowed();

		// It re-acquires to answer, then yields again.
		expect(await controller.ask?.("q")).toBe("answer-1");
		await waitFor(() => semaphore.active === 0);

		controller.stop();
		await controller.result();
	});
});
