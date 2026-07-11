// The ship-gate disagreement question: build, and the three answer routes.
// The override executes in EXTENSION code on the human's answer — no model
// tool can reach it.

import type { Answers } from "@vegardx/pi-contracts";
import { describe, expect, it } from "vitest";
import type { ExecutionHandle } from "../packages/modes/src/exec/index.js";
import {
	buildGateQuestion,
	GATE_OPTION_OVERRIDE,
	GATE_OPTION_PARK,
	GATE_OPTION_SEND_BACK,
	presentGateDecision,
} from "../packages/modes/src/runtime/gate-decision.js";

function fakes(opts: {
	answer?: (a: {
		value: string;
		note?: string;
		deferred?: boolean;
	}) => Answers[number] | undefined;
	failing?: string[];
	sendBackOk?: boolean;
	findings?: Array<{
		name: string;
		verdict: string;
		required: boolean;
		report?: string;
	}>;
}) {
	const overrides: Array<[string, string, string]> = [];
	const sendBacks: Array<[string, string]> = [];
	const messages: string[] = [];
	const notices: string[] = [];
	let ticks = 0;
	const execution = {
		failingRequiredReviewers: () => opts.failing ?? ["security-audit"],
		reviewerFindings: () => opts.findings ?? [],
		overrideReviewerVerdict: (d: string, r: string, why: string) => {
			overrides.push([d, r, why]);
		},
		sendBackToWorker: async (d: string, kickoff: string) => {
			sendBacks.push([d, kickoff]);
			return opts.sendBackOk ?? true;
		},
		tick: async () => {
			ticks++;
			return 0;
		},
	} as unknown as ExecutionHandle;
	const deps = {
		ask: () => ({
			ask: async (qs: { id: string }[]) => {
				const a = opts.answer?.({ value: "" });
				return a ? [{ ...a, questionId: qs[0].id }] : [];
			},
			queue: () => {},
			post: () => {},
			pending: () => [],
		}),
		execution: () => execution,
		pi: {
			sendUserMessage: (text: string) => {
				messages.push(text);
			},
		},
		notify: (m: string) => {
			notices.push(m);
		},
	};
	return {
		deps: deps as never,
		overrides,
		sendBacks,
		messages,
		notices,
		ticks: () => ticks,
	};
}

describe("buildGateQuestion", () => {
	it("names the holding reviewers and the three routes", () => {
		const q = buildGateQuestion(
			"auth",
			"ship gate: security-audit requested changes",
			["security-audit"],
		);
		expect(q.question).toContain("security-audit requested changes");
		expect(q.question).toContain('"auth" is parked');
		expect(q.options?.map((o) => o.label)).toEqual([
			GATE_OPTION_SEND_BACK,
			GATE_OPTION_OVERRIDE,
			GATE_OPTION_PARK,
		]);
		expect(q.options?.[1].description).toContain("security-audit");
	});

	it("carries the findings as question context — the human never decides blind", () => {
		const q = buildGateQuestion(
			"auth",
			"ship gate: security-audit requested changes",
			["security-audit"],
			[
				{
					name: "security-audit",
					verdict: "request-changes",
					required: true,
					report: "Critical: token is logged at src/auth.ts:42.",
				},
				{
					name: "docs",
					verdict: "approve",
					required: false,
				},
			],
		);
		expect(q.context).toContain(
			"security-audit [required] — ✗ request-changes",
		);
		expect(q.context).toContain("token is logged at src/auth.ts:42");
		// Passing reviewers without a report add noise, not signal.
		expect(q.context).not.toContain("docs");
	});

	it("omits context when no findings arrived (older workers)", () => {
		const q = buildGateQuestion("auth", "ship gate: …", ["security-audit"]);
		expect(q.context).toBeUndefined();
	});
});

describe("presentGateDecision", () => {
	it("override: records a human verdict per holding reviewer and re-ticks", async () => {
		const { deps, overrides, ticks } = fakes({
			failing: ["security-audit", "correctness"],
			answer: () => ({
				questionId: "x",
				value: GATE_OPTION_OVERRIDE,
				note: "false positive — token already scoped",
			}),
		});
		await presentGateDecision(deps, "auth", "ship gate: …");
		expect(overrides).toEqual([
			["auth", "security-audit", "false positive — token already scoped"],
			["auth", "correctness", "false positive — token already scoped"],
		]);
		expect(ticks()).toBe(1);
	});

	it("send back: reopens + respawns the worker in extension code, no override", async () => {
		const { deps, overrides, sendBacks, messages } = fakes({
			answer: () => ({
				questionId: "x",
				value: GATE_OPTION_SEND_BACK,
				note: "narrow the scope but keep repo read",
			}),
		});
		await presentGateDecision(deps, "auth", "ship gate: …");
		expect(overrides).toHaveLength(0);
		// The send-back EXECUTES — telling the model to respawn dead-ended
		// (complete → active was illegal; no model tool respawns workers).
		expect(sendBacks).toHaveLength(1);
		expect(sendBacks[0][0]).toBe("auth");
		expect(sendBacks[0][1]).toContain("narrow the scope but keep repo read");
		expect(sendBacks[0][1]).toContain("re-run the review panel");
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("respawned");
	});

	it("send back carries the holding reviewers' findings in the kickoff", async () => {
		const { deps, sendBacks } = fakes({
			failing: ["security-audit"],
			findings: [
				{
					name: "security-audit",
					verdict: "request-changes",
					required: true,
					report: "Critical: token is logged at src/auth.ts:42.",
				},
			],
			answer: () => ({
				questionId: "x",
				value: GATE_OPTION_SEND_BACK,
				note: "scrub the log line",
			}),
		});
		await presentGateDecision(deps, "auth", "ship gate: …");
		expect(sendBacks[0][1]).toContain("token is logged at src/auth.ts:42");
		expect(sendBacks[0][1]).toContain("scrub the log line");
	});

	it("send back falls back to informing the model when respawn is impossible", async () => {
		const { deps, sendBacks, messages } = fakes({
			sendBackOk: false,
			answer: () => ({
				questionId: "x",
				value: GATE_OPTION_SEND_BACK,
				note: "fix the leak",
			}),
		});
		await presentGateDecision(deps, "auth", "ship gate: …");
		expect(sendBacks).toHaveLength(1);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("respawn or steer the worker yourself");
		expect(messages[0]).toContain("fix the leak");
	});

	it("park / deferred: does nothing", async () => {
		for (const answer of [
			{ questionId: "x", value: GATE_OPTION_PARK },
			{ questionId: "x", value: GATE_OPTION_OVERRIDE, deferred: true },
		]) {
			const { deps, overrides, messages } = fakes({
				answer: () => answer as Answers[number],
			});
			await presentGateDecision(deps, "auth", "ship gate: …");
			expect(overrides).toHaveLength(0);
			expect(messages).toHaveLength(0);
		}
	});

	it("override without a reason re-asks until a note arrives", async () => {
		// The five blind dogfood overrides ("no reason given") are the exact
		// anti-pattern this closes: no note, no override.
		let asks = 0;
		const { deps, overrides, notices } = fakes({
			answer: () => {
				asks += 1;
				return asks === 1
					? { questionId: "x", value: GATE_OPTION_OVERRIDE }
					: {
							questionId: "x",
							value: GATE_OPTION_OVERRIDE,
							note: "reviewer misread the diff",
						};
			},
		});
		await presentGateDecision(deps, "auth", "ship gate: …");
		expect(asks).toBe(2);
		expect(notices.some((n) => n.includes("requires a reason"))).toBe(true);
		expect(overrides).toEqual([
			["auth", "security-audit", "reviewer misread the diff"],
		]);
	});

	it("override with no reason after repeated asks stays parked", async () => {
		let asks = 0;
		const { deps, overrides, notices } = fakes({
			answer: () => {
				asks += 1;
				return { questionId: "x", value: GATE_OPTION_OVERRIDE };
			},
		});
		await presentGateDecision(deps, "auth", "ship gate: …");
		expect(asks).toBe(3);
		expect(overrides).toHaveLength(0);
		expect(notices.some((n) => n.includes("leaving auth parked"))).toBe(true);
	});

	it("context leads with a scoreboard and top findings before the reports", () => {
		const q = buildGateQuestion(
			"auth",
			"ship gate: …",
			["security-audit"],
			[
				{
					name: "security-audit",
					verdict: "request-changes",
					required: true,
					report:
						"bad stuff\nVERDICT: request-changes\n- src/auth.ts:42 — token logged\n- src/auth.ts:50 — token reused",
				},
			],
		);
		const ctx = q.context ?? "";
		expect(ctx).toContain(
			"✗ security-audit [required] — request-changes (2 findings)",
		);
		expect(ctx).toContain("1. (security-audit) src/auth.ts:42 — token logged");
		expect(ctx.indexOf("Top findings")).toBeLessThan(
			ctx.indexOf("── Full reports ──"),
		);
	});
});
