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
import {
	AskInbox,
	createRespondTool,
	type InboundQuestion,
	type SettleInbound,
} from "@vegardx/pi-ask";
import type { Questionnaire } from "@vegardx/pi-contracts";
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

describe("a question reaches the inbox, and is answered per question", () => {
	// The maestro no longer keeps its own registry of blocked workers, and no
	// longer builds `Answers` itself. Both belonged to `packages/ask`, which
	// owns what a question is — and while they lived here, answering a set of
	// three questions meant copying one string onto all three.

	function runtime(inbox?: AskInbox) {
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
			...(inbox
				? {
						inbox: () =>
							({
								deliver: (question: InboundQuestion, settleIt: SettleInbound) =>
									inbox.receive(question, settleIt),
								open: () => inbox.open(),
								drain: (value: string) => inbox.drain(value),
							}) as never,
					}
				: {}),
		});
		closers.push(made);
		return { runtime: made, said, asked, socketPath };
	}

	async function blocked(
		r: ReturnType<typeof runtime>,
		questions: Questionnaire = [
			{ id: "shape", question: "null or NaN?", context: "I chose null" },
		],
	) {
		await r.runtime.listen();
		const agent = new AgentLink();
		closers.push(agent);
		await agent.connect(r.socketPath, { agentId: "worker-api", token: TOKEN });
		const waiting = agent.ask(questions);
		await settle();
		return { agent, waiting };
	}

	it("puts the question to its own model, not to a dashboard", async () => {
		const inbox = new AskInbox();
		const r = runtime(inbox);
		await blocked(r);
		expect(r.asked[0]).toContain("A worker is blocked on a question");
		expect(r.asked[0]).toContain("null or NaN?");
		expect(r.asked[0]).toContain("I chose null");
		// The instruction that keeps this a rare interruption, not a queue.
		expect(r.asked[0]).toContain("only interrupt them when it matters");
		// And it names each question's id, because `respond` answers per id.
		expect(r.asked[0]).toContain("`shape`");
		expect(inbox.size).toBe(1);
	});

	it("ANSWERS EACH QUESTION SEPARATELY — the bug this move fixes", async () => {
		// The old path took one `answer: string` and stamped it onto every
		// question in the set. A worker asking three things got the same reply
		// three times, and the maestro had no way to say otherwise.
		const inbox = new AskInbox();
		const r = runtime(inbox);
		const { waiting } = await blocked(r, [
			{ id: "shape", question: "null or NaN?" },
			{ id: "name", question: "what should it be called?" },
			{ id: "tests", question: "unit or integration?" },
		]);
		const id = inbox.open()[0]?.id as string;
		await call(
			createRespondTool(() => inbox),
			{
				id,
				answers: [
					{ questionId: "shape", value: "null" },
					{ questionId: "name", value: "mean" },
					{ questionId: "tests", value: "unit" },
				],
			},
		);
		const answered = await waiting;
		expect(answered.answers.map((a) => a.value)).toEqual([
			"null",
			"mean",
			"unit",
		]);
		expect(inbox.size).toBe(0);
	});

	it("refuses a partial answer rather than unblocking with gaps", async () => {
		const inbox = new AskInbox();
		const r = runtime(inbox);
		await blocked(r, [
			{ id: "shape", question: "null or NaN?" },
			{ id: "name", question: "what should it be called?" },
		]);
		const id = inbox.open()[0]?.id as string;
		const said = await call(
			createRespondTool(() => inbox),
			{
				id,
				answers: [{ questionId: "shape", value: "null" }],
			},
		);
		expect(said.content[0].text).toContain("still waiting on: name");
		// Still blocked, so the maestro can try again.
		expect(inbox.size).toBe(1);
	});

	it("says what is waiting when asked about something that is not", async () => {
		const inbox = new AskInbox();
		const said = await call(
			createRespondTool(() => inbox),
			{
				id: "worker-api/ask-9",
				answers: [{ questionId: "x", value: "y" }],
			},
		);
		expect(said.content[0].text).toContain("nothing is waiting");
		expect(said.content[0].text).toContain("none");
	});

	it("tells a worker nobody can answer when there is no inbox at all", async () => {
		// Rather than leaving it blocked on a question no one will ever see.
		const r = runtime();
		const { waiting } = await blocked(r);
		const answered = await waiting;
		expect(answered.answers[0]?.value).toMatch(/nobody can answer/);
		expect(answered.from).toBe("maestro");
	});
});
