// The maestro triage tier: gate blocks go to the maestro model first (one
// send-back with guidance per deliverable, or escalate with a MANDATORY
// recommendation); the human is the final authority, never the first stop.
// The gate tool has no override action — that boundary is the point.

import type { Answers, Question } from "@vegardx/pi-contracts";
import { describe, expect, it } from "vitest";
import type { ExecutionHandle } from "../packages/modes/src/exec/index.js";
import {
	createGateTool,
	GateTriage,
} from "../packages/modes/src/runtime/gate-triage.js";

function fakes(opts: { sendBackOk?: boolean; timeoutMs?: number } = {}) {
	const sendBacks: Array<[string, string]> = [];
	const messages: string[] = [];
	const notices: string[] = [];
	const asked: Question[] = [];
	const execution = {
		failingRequiredReviewers: () => ["security-audit"],
		reviewerFindings: () => [
			{
				name: "security-audit",
				verdict: "request-changes",
				required: true,
				report: "Critical: token is logged at src/auth.ts:42.\nVERDICT: BLOCK",
			},
		],
		overrideReviewerVerdict: () => {
			throw new Error("triage must never override");
		},
		sendBackToWorker: async (d: string, kickoff: string) => {
			sendBacks.push([d, kickoff]);
			return opts.sendBackOk ?? true;
		},
		tick: async () => 0,
	} as unknown as ExecutionHandle;
	const askCapability = {
		ask: async (qs: Question[]) => {
			asked.push(...qs);
			return [] as Answers;
		},
		queue: () => {},
		post: () => {},
		pending: () => [],
	};
	const triage = new GateTriage({
		ask: () => askCapability as never,
		execution: () => execution,
		pi: {
			sendUserMessage: (text: string) => {
				messages.push(text);
			},
		} as never,
		notify: (m: string) => {
			notices.push(m);
		},
		...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
	});
	return { triage, sendBacks, messages, notices, asked };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("GateTriage", () => {
	it("first block asks the MAESTRO, not the human", () => {
		const { triage, messages, asked } = fakes();
		triage.handleBlock("auth", "ship gate: 1 blocking finding open");
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("TRIAGE THIS NOW");
		expect(messages[0]).toContain("token is logged");
		expect(messages[0]).toContain("cannot open the gate");
		expect(asked).toHaveLength(0);
	});

	it("send-back composes the shared kickoff and burns the one-shot budget", async () => {
		const { triage, sendBacks, asked } = fakes();
		triage.handleBlock("auth", "ship gate: 1 blocking finding open");
		const first = await triage.sendBack(
			"auth",
			"scrub the log line at auth.ts:42",
		);
		expect(first.ok).toBe(true);
		expect(sendBacks).toHaveLength(1);
		expect(sendBacks[0][1]).toContain("maestro sent it back");
		expect(sendBacks[0][1]).toContain("scrub the log line");
		expect(sendBacks[0][1]).toContain("token is logged");

		const second = await triage.sendBack("auth", "more guidance");
		expect(second.ok).toBe(false);
		expect(second.error).toContain("budget");
		expect(asked).toHaveLength(0); // still nothing to the human
	});

	it("a repeat block after the maestro's send-back goes straight to the human", async () => {
		const { triage, asked } = fakes();
		triage.handleBlock("auth", "ship gate: 1 blocking finding open");
		await triage.sendBack("auth", "fix it like this");
		triage.handleBlock("auth", "ship gate: 1 blocking finding open");
		expect(asked).toHaveLength(1);
		expect(asked[0].context).toContain("already sent this back once");
	});

	it("escalate REQUIRES recommendation + why, then leads the question with them", () => {
		const { triage, asked } = fakes();
		triage.handleBlock("auth", "ship gate: 1 blocking finding open");
		expect(triage.escalate("auth", "", "").ok).toBe(false);
		expect(asked).toHaveLength(0);

		const ok = triage.escalate(
			"auth",
			"waive security-audit.1",
			"the token is redacted upstream at logger.ts:12",
			"override",
		);
		expect(ok.ok).toBe(true);
		expect(asked).toHaveLength(1);
		expect(asked[0].context).toContain(
			"Maestro recommends: waive security-audit.1",
		);
		expect(asked[0].context).toContain("redacted upstream");
		expect(asked[0].options?.[0].label).toBe("Override and ship");
	});

	it("triage timeout falls through to the human without a recommendation", async () => {
		const { triage, asked } = fakes({ timeoutMs: 20 });
		triage.handleBlock("auth", "ship gate: 1 blocking finding open");
		expect(asked).toHaveLength(0);
		await wait(60);
		expect(asked).toHaveLength(1);
		expect(asked[0].context).toContain("did not triage");
	});

	it("escalate cancels the fallback timer (no duplicate question)", async () => {
		const { triage, asked } = fakes({ timeoutMs: 20 });
		triage.handleBlock("auth", "ship gate: 1 blocking finding open");
		triage.escalate(
			"auth",
			"send it back",
			"the fix is mechanical",
			"send-back",
		);
		await wait(60);
		expect(asked).toHaveLength(1);
	});
});

describe("gate tool", () => {
	type Exec = {
		execute(
			id: string,
			params: unknown,
		): Promise<{ content: [{ type: "text"; text: string }] }>;
	};

	it("has no override action and degrades without execution", async () => {
		const tool = createGateTool(() => undefined) as unknown as Exec;
		const res = await tool.execute("c", {
			action: "sendback",
			deliverableId: "auth",
			guidance: "x",
		});
		expect(res.content[0].text).toContain("gate unavailable");
	});

	it("routes sendback and escalate through the triage controller", async () => {
		const { triage, sendBacks, asked } = fakes();
		triage.handleBlock("auth", "ship gate: 1 blocking finding open");
		const tool = createGateTool(() => triage) as unknown as Exec;

		const sb = await tool.execute("c", {
			action: "sendback",
			deliverableId: "auth",
			guidance: "redact the token",
		});
		expect(sb.content[0].text).toContain("Sent auth back");
		expect(sendBacks).toHaveLength(1);

		triage.handleBlock("other", "ship gate: 2 blocking findings open");
		const esc = await tool.execute("c", {
			action: "escalate",
			deliverableId: "other",
			recommendation: "send back with guidance",
			why: "the findings are real but mechanical",
			recommendedAction: "send-back",
		});
		expect(esc.content[0].text).toContain("Escalated other");
		expect(asked.length).toBeGreaterThan(0);
	});

	it("escalate without a recommendation is refused", async () => {
		const { triage } = fakes();
		triage.handleBlock("auth", "ship gate: 1 blocking finding open");
		const tool = createGateTool(() => triage) as unknown as Exec;
		const res = await tool.execute("c", {
			action: "escalate",
			deliverableId: "auth",
		});
		expect(res.content[0].text).toContain("escalate failed");
		expect(res.content[0].text).toContain("required");
	});
});
