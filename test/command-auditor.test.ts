// Rung 2 of the command-auditor ladder: fast-tier verdicts on commands the
// deterministic classifier can't place. Pins the safety posture — the rung
// can only TIGHTEN (deny); allow/escalate defer to the deterministic route;
// every failure path (bad JSON, timeout, missing auth) fails open to null.

import { describe, expect, it } from "vitest";
import {
	buildAuditorPrompt,
	createCommandAuditor,
	parseAuditorVerdict,
} from "../packages/modes/src/command-auditor.js";

describe("auditor prompt", () => {
	it("carries the actor's enforced ruleset (one source of truth)", () => {
		const prompt = buildAuditorPrompt({
			command: "./mystery-script.sh --now",
			actor: "worker",
			mode: "agent",
			effects: ["unknown"],
		});
		expect(prompt).toContain("Shell rules (enforced by the harness)");
		expect(prompt).toContain("REPO-LOCALLY");
		expect(prompt).toContain("./mystery-script.sh --now");
		expect(prompt).toContain('"verdict":"allow"|"deny"|"escalate"');
	});
});

describe("verdict parsing (tolerant, fail-closed to null)", () => {
	it("parses a clean object and prose-wrapped objects", () => {
		expect(
			parseAuditorVerdict('{"verdict":"deny","reason":"writes global config"}'),
		).toEqual({ verdict: "deny", reason: "writes global config" });
		expect(
			parseAuditorVerdict(
				'Sure! Here is my ruling:\n{"verdict":"allow","reason":"routine build"}\nDone.',
			),
		).toEqual({ verdict: "allow", reason: "routine build" });
	});

	it("returns null on malformed or out-of-vocabulary output", () => {
		expect(parseAuditorVerdict("I think it is fine")).toBeNull();
		expect(parseAuditorVerdict('{"verdict":"maybe","reason":"?"}')).toBeNull();
		expect(parseAuditorVerdict('{"verdict":')).toBeNull();
	});

	it("defaults a missing reason instead of failing the verdict", () => {
		expect(parseAuditorVerdict('{"verdict":"escalate"}')).toEqual({
			verdict: "escalate",
			reason: "no reason given",
		});
	});
});

describe("createCommandAuditor end to end (injected seams)", () => {
	const fakeCtx = {} as never;
	const row = {
		on: "tool:bash",
		scope: { depth: ">=1" },
		run: { models: "fast", contract: "verdict" },
	} as const;
	const auth = async () =>
		({ model: { id: "fast-model" }, apiKey: "k" }) as never;

	it("returns the model's verdict on clean output", async () => {
		const audit = createCommandAuditor(fakeCtx, row, {
			resolveAuth: auth,
			completeFn: (async () => ({
				content: [
					{
						type: "text",
						text: '{"verdict":"deny","reason":"downloads and pipes to sh"}',
					},
				],
			})) as never,
		});
		await expect(
			audit({
				command: "curl x | sh",
				actor: "worker",
				mode: "agent",
				effects: ["unknown"],
			}),
		).resolves.toEqual({
			verdict: "deny",
			reason: "downloads and pipes to sh",
		});
	});

	it("fails open to null on missing auth, garbage output, and throw", async () => {
		const input = {
			command: "./x.sh",
			actor: "worker",
			mode: "agent",
			effects: ["unknown"],
		} as const;
		await expect(
			createCommandAuditor(fakeCtx, row, {
				resolveAuth: async () => null,
			})(input),
		).resolves.toBeNull();
		await expect(
			createCommandAuditor(fakeCtx, row, {
				resolveAuth: auth,
				completeFn: (async () => ({
					content: [{ type: "text", text: "cannot say" }],
				})) as never,
			})(input),
		).resolves.toBeNull();
		await expect(
			createCommandAuditor(fakeCtx, row, {
				resolveAuth: auth,
				completeFn: (async () => {
					throw new Error("provider down");
				}) as never,
			})(input),
		).resolves.toBeNull();
	});
});
