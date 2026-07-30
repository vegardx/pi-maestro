// A worker escalating a question, over real sockets.
//
// Until this existed a worker had exactly one way to handle an ambiguity: fail
// the deliverable and explain why. That is honest, and it costs a whole
// deliverable per ambiguity — so asking had to become cheaper than guessing,
// which means it had to be possible at all.
//
// The case worth reading is `from`. A maestro answers most questions itself and
// can be confidently wrong, so an agent must be able to tell its maestro's
// judgement from its human's. Collapsing the two would let "the user said so"
// mean "something upstream guessed".

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createEscalateTool } from "../packages/maestro/src/agent-runtime.js";
import { AgentLink, MaestroLink } from "../packages/maestro/src/link.js";
import type { Ask } from "../packages/maestro/src/protocol.js";
import {
	MaestroRuntime,
	type Narrator,
} from "../packages/maestro/src/runtime.js";

const TOKEN = "run-token";
const dirs: string[] = [];
const closers: { close(): unknown }[] = [];

afterEach(async () => {
	for (const closer of closers.splice(0)) await closer.close();
	while (dirs.length > 0)
		rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "maestro-esc-"));
	dirs.push(dir);
	return dir;
}

async function wired() {
	const link = new MaestroLink({ token: TOKEN });
	closers.push(link);
	const path = join(scratch(), "m.sock");
	await link.listen(path);
	const agent = new AgentLink();
	closers.push(agent);
	await agent.connect(path, { agentId: "worker-api", token: TOKEN });
	return { link, agent };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

const call = (tool: ToolDefinition, params: unknown) =>
	(
		tool.execute as unknown as (
			id: string,
			p: unknown,
		) => Promise<{ content: { text: string }[]; details: { from?: string } }>
	)("call-1", params);

describe("a question crosses the wire and comes back", () => {
	it("blocks the worker until it is answered", async () => {
		const { link, agent } = await wired();
		const asked = new Promise<[string, Ask]>((resolve) =>
			link.once("asked", (id, ask) => resolve([id, ask])),
		);

		let returned = false;
		const waiting = agent
			.ask(
				"Should `mean` return null or NaN for an empty array?",
				"I chose null",
			)
			.then((answered) => {
				returned = true;
				return answered;
			});

		const [agentId, question] = await asked;
		expect(agentId).toBe("worker-api");
		expect(question.question).toContain("empty array");
		expect(question.context).toBe("I chose null");

		await settle();
		expect(returned).toBe(false);

		link.answer(agentId, question.id, "null, and document it", "maestro");
		expect(await waiting).toEqual({
			answer: "null, and document it",
			from: "maestro",
		});
	});

	it("keeps two open questions apart", async () => {
		const { link, agent } = await wired();
		const seen: Ask[] = [];
		link.on("asked", (_id, ask) => seen.push(ask));

		const first = agent.ask("one?");
		const second = agent.ask("two?");
		await settle();
		expect(seen).toHaveLength(2);

		// Answered out of order on purpose: an id that only worked in sequence
		// would work in every test and fail the first time a worker asked twice.
		link.answer("worker-api", seen[1]?.id as string, "second answer", "human");
		link.answer("worker-api", seen[0]?.id as string, "first answer", "maestro");

		expect((await first).answer).toBe("first answer");
		expect((await second).answer).toBe("second answer");
	});

	it("tells a worker the truth when the maestro vanishes", async () => {
		// Resolving to nothing would read as "the maestro said the empty string".
		const { link, agent } = await wired();
		const waiting = agent.ask("anything?");
		await settle();
		await link.close();
		const answered = await waiting;
		expect(answered.answer).toMatch(/nobody answered/);
		expect(answered.answer).toMatch(/not treat silence as agreement/i);
	});

	it("refuses to ask when there is no maestro to ask", async () => {
		const orphan = new AgentLink();
		closers.push(orphan);
		await expect(orphan.ask("hello?")).rejects.toThrow(/not connected/);
	});
});

describe("the worker's tool passes the answer through as it came", () => {
	it("is called `escalate`, because `ask` asks the USER", () => {
		// `packages/ask` owns `ask` and it survives the flip. Two tools of one
		// name would have made one unreachable depending on load order.
		expect(
			createEscalateTool(() => ({
				ask: async () => ({ answer: "", from: "maestro" as const }),
			})).name,
		).toBe("escalate");
	});

	it("reports who decided, in the text the model reads", async () => {
		const tool = createEscalateTool(() => ({
			ask: async () => ({ answer: "use null", from: "human" as const }),
		}));
		const result = await call(tool, { question: "null or NaN?" });
		expect(result.content[0].text).toContain("use null");
		expect(result.content[0].text).toContain("answered by the human");
		expect(result.details.from).toBe("human");
	});
});

describe("the maestro answers, or admits it cannot", () => {
	function runtime(
		askHuman?: (
			q: string,
		) => Promise<{ answer: string; from: "maestro" | "human" }>,
	) {
		const said: string[] = [];
		const asked: string[] = [];
		const narrator: Narrator = {
			say: (line) => said.push(line),
			ask: (prompt) => asked.push(prompt),
		};
		const socketPath = join(scratch(), "m.sock");
		const made = new MaestroRuntime({
			narrator,
			socketPath,
			token: TOKEN,
			now: () => "2026-07-30T00:00:00.000Z",
			...(askHuman ? { askHuman } : {}),
		});
		closers.push(made);
		return { runtime: made, said, asked, socketPath };
	}

	async function blocked(r: ReturnType<typeof runtime>) {
		await r.runtime.listen();
		const agent = new AgentLink();
		closers.push(agent);
		await agent.connect(r.socketPath, {
			agentId: "worker-api",
			token: TOKEN,
		});
		const waiting = agent.ask("null or NaN?", "I chose null");
		await settle();
		return { agent, waiting };
	}

	it("puts the question to its own model, not to a dashboard", async () => {
		const r = runtime();
		await blocked(r);
		expect(r.asked[0]).toContain("A worker is blocked on a question");
		expect(r.asked[0]).toContain("null or NaN?");
		expect(r.asked[0]).toContain("I chose null");
		// The instruction that keeps this a rare interruption, not a queue.
		expect(r.asked[0]).toContain("Only put it to the user when you genuinely");
		expect(r.runtime.openQuestions()).toHaveLength(1);
	});

	it("answers from its own knowledge, attributed to itself", async () => {
		const r = runtime();
		const { waiting } = await blocked(r);
		const key = `worker-api/${r.runtime.openQuestions()[0]?.id}`;
		await call(r.runtime.respondTool(), { id: key, answer: "null" });
		expect(await waiting).toEqual({ answer: "null", from: "maestro" });
		expect(r.runtime.openQuestions()).toEqual([]);
	});

	it("escalates, and what reaches the worker is attributed to the human", async () => {
		const put: string[] = [];
		const r = runtime(async (question) => {
			put.push(question);
			return { answer: "return null", from: "human" as const };
		});
		const { waiting } = await blocked(r);
		const key = `worker-api/${r.runtime.openQuestions()[0]?.id}`;
		await call(r.runtime.respondTool(), {
			id: key,
			answer: "Should an empty array give null or NaN?",
			askTheHuman: true,
		});
		// Escalating still means saying what to ask — the part the maestro is
		// better placed to write than the worker was.
		expect(put).toEqual(["Should an empty array give null or NaN?"]);
		expect(await waiting).toEqual({ answer: "return null", from: "human" });
	});

	it("never claims a human answered when none could be reached", async () => {
		// An agent told a human decided when nobody did is worse off than one
		// told nobody could be reached.
		const r = runtime();
		const { waiting } = await blocked(r);
		const key = `worker-api/${r.runtime.openQuestions()[0]?.id}`;
		const said = await call(r.runtime.respondTool(), {
			id: key,
			answer: "ask them this",
			askTheHuman: true,
		});
		const answered = await waiting;
		expect(answered.from).toBe("maestro");
		expect(answered.answer).toMatch(/decide for yourself/i);
		expect(said.content[0].text).toContain("no user reachable");
	});

	it("does not call an autopilot answer a human ruling", async () => {
		// `ask.v1` has an idle autopilot (`source: "maestro-auto"`) and a
		// deferred question answers nothing. Reporting either as the user's
		// decision is the exact lie `from` exists to prevent.
		const r = runtime(async () => ({
			answer: "whatever the autopilot said",
			from: "maestro" as const,
		}));
		const { waiting } = await blocked(r);
		const key = `worker-api/${r.runtime.openQuestions()[0]?.id}`;
		const said = await call(r.runtime.respondTool(), {
			id: key,
			answer: "ask them",
			askTheHuman: true,
		});
		expect((await waiting).from).toBe("maestro");
		expect(said.content[0].text).toContain("Nobody answered");
	});

	it("says what is open when asked about a question that is not", async () => {
		const r = runtime();
		const said = await call(r.runtime.respondTool(), {
			id: "worker-api/ask-9",
			answer: "x",
		});
		expect(said.content[0].text).toContain("Nothing is blocked");
		expect(said.content[0].text).toContain("none");
	});
});
