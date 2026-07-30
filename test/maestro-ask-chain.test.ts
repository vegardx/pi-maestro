// A question travelling up the chain, over real sockets.
//
// There is ONE `ask`, owned by `packages/ask`. What differs between a maestro
// and a worker is not the tool but the TRANSPORT that is registered: a worker's
// routes to its maestro, and a maestro with none falls back to its local UI —
// which is its human. Position, not variant.
//
// A read-only agent registers nothing. Its caller is blocked on it, so there is
// no channel back; a reader that cannot answer says so in its report. Readers
// answer, they do not ask.
//
// The case worth reading is `from`. A maestro answers most questions itself and
// can be confidently wrong, so an agent must be able to tell its maestro's
// judgement from its human's — and that provenance travels with the answers.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createAskTransport } from "../packages/maestro/src/agent-runtime.js";
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
			.ask([
				{
					id: "empty",
					question: "Should `mean` return null or NaN for an empty array?",
					context: "I chose null",
				},
			])
			.then((answered) => {
				returned = true;
				return answered;
			});

		const [agentId, question] = await asked;
		expect(agentId).toBe("worker-api");
		expect(question.questions[0]?.question).toContain("empty array");
		expect(question.questions[0]?.context).toBe("I chose null");

		await settle();
		expect(returned).toBe(false);

		link.answer(
			agentId,
			question.id,
			[{ questionId: "empty", value: "null, and document it" }],
			"maestro",
		);
		const answered = await waiting;
		expect(answered.from).toBe("maestro");
		expect(answered.answers[0]?.value).toBe("null, and document it");
	});

	it("keeps two open questions apart", async () => {
		const { link, agent } = await wired();
		const seen: Ask[] = [];
		link.on("asked", (_id, ask) => seen.push(ask));

		const first = agent.ask([{ id: "a", question: "one?" }]);
		const second = agent.ask([{ id: "b", question: "two?" }]);
		await settle();
		expect(seen).toHaveLength(2);

		// Answered out of order on purpose: an id that only worked in sequence
		// would work in every test and fail the first time a worker asked twice.
		link.answer(
			"worker-api",
			seen[1]?.id as string,
			[{ questionId: "b", value: "second answer" }],
			"human",
		);
		link.answer(
			"worker-api",
			seen[0]?.id as string,
			[{ questionId: "a", value: "first answer" }],
			"maestro",
		);

		expect((await first).answers[0]?.value).toBe("first answer");
		expect((await second).answers[0]?.value).toBe("second answer");
	});

	it("tells a worker the truth when the maestro vanishes", async () => {
		// Resolving to nothing would read as "the maestro said the empty string".
		const { link, agent } = await wired();
		const waiting = agent.ask([{ id: "x", question: "anything?" }]);
		await settle();
		await link.close();
		const answered = await waiting;
		expect(answered.answers[0]?.value).toMatch(/nobody answered/);
		expect(answered.answers[0]?.value).toMatch(
			/not treat silence as agreement/i,
		);
	});

	it("refuses to ask when there is no maestro to ask", async () => {
		const orphan = new AgentLink();
		closers.push(orphan);
		await expect(orphan.ask([{ id: "x", question: "hello?" }])).rejects.toThrow(
			/not connected/,
		);
	});
});

describe("the transport carries provenance into the answers themselves", () => {
	it("marks a human answer as one, in a form ask.v1 passes through", async () => {
		// `ask.v1` hands its caller plain answers, so an agent that cannot see who
		// decided will read a maestro's guess as a ruling. The attribution rides
		// in the value AND in `source`, which is the field the contract already
		// has for exactly this.
		const transport = createAskTransport(() => ({
			ask: async () => ({
				answers: [{ questionId: "q", value: "use null" }],
				from: "human" as const,
			}),
		}));
		const answers = await transport.present([{ id: "q", question: "null?" }]);
		expect(answers[0]?.value).toContain("use null");
		expect(answers[0]?.value).toContain("answered by the human");
		expect(answers[0]?.source).toBe("human");
	});

	it("does not mark a maestro answer as a human one", async () => {
		const transport = createAskTransport(() => ({
			ask: async () => ({
				answers: [{ questionId: "q", value: "null" }],
				from: "maestro" as const,
			}),
		}));
		const answers = await transport.present([{ id: "q", question: "null?" }]);
		expect(answers[0]?.source).toBeUndefined();
		expect(answers[0]?.value).toContain("answered by the maestro");
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
		const waiting = agent.ask([
			{ id: "shape", question: "null or NaN?", context: "I chose null" },
		]);
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
		const answered = await waiting;
		expect(answered.from).toBe("maestro");
		expect(answered.answers[0]?.value).toBe("null");
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
		const answered = await waiting;
		expect(answered.from).toBe("human");
		expect(answered.answers[0]?.value).toBe("return null");
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
		expect(answered.answers[0]?.value).toMatch(/decide for yourself/i);
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
