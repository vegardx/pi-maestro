import type {
	RunHandle,
	RunId,
	RunResult,
	SpawnProfile,
	SubagentsCapabilityV1,
} from "@vegardx/pi-contracts";
import { describe, expect, it } from "vitest";
import {
	panelGateSatisfied,
	requiredGateSatisfied,
	runReviewPanel,
} from "../packages/modes/src/panel.js";
import type { SubAgentSpec } from "../packages/modes/src/schema.js";

/** Fake subagents capability: each spawn resolves by the persona in its prompt. */
function fakeSubagents(byPersona: Record<string, RunResult>): {
	capability: SubagentsCapabilityV1;
	calls: SpawnProfile[];
} {
	const calls: SpawnProfile[] = [];
	let n = 0;
	const capability = {
		spawn(_prompt: string, profile: SpawnProfile): RunHandle {
			calls.push(profile);
			// The persona is carried by the profile (system prompt), not the
			// kickoff prompt — which is now a constant. Route on that.
			const persona = Object.keys(byPersona).find((p) =>
				profile.appendSystemPrompt?.includes(`"${p}"`),
			);
			const result = byPersona[persona ?? ""] ?? { status: "failed" as const };
			return {
				id: `run-${++n}` as RunId,
				status: () => "running" as const,
				steer: () => {},
				stop: () => {},
				result: async () => result,
			};
		},
		get: () => undefined,
		list: () => [],
		steer: () => {},
		stop: () => {},
	} as unknown as SubagentsCapabilityV1;
	return { capability, calls };
}

describe("runReviewPanel", () => {
	it("spawns each spec read-only in the worktree and parses PASS/BLOCK", async () => {
		const { capability, calls } = fakeSubagents({
			"security-audit": {
				status: "succeeded",
				summary: "## Critical\n- 1. auth bypass\nVERDICT: BLOCK",
			},
			documentation: {
				status: "succeeded",
				summary: "## Summary\nfine.\nVERDICT: PASS",
			},
		});
		const specs: SubAgentSpec[] = [
			{ name: "security-audit", persona: "security-audit", required: true },
			{ name: "documentation", persona: "documentation" },
		];
		const results = await runReviewPanel(specs, {
			subagents: capability,
			cwd: "/wt",
		});

		expect(calls.every((p) => p.cwd === "/wt")).toBe(true);
		expect(calls.every((p) => !p.tools?.allow?.includes("write"))).toBe(true);

		const sec = results.find((r) => r.persona === "security-audit");
		expect(sec?.verdict).toBe("request-changes");
		expect(sec?.report).toContain("auth bypass"); // worker acts on the full report
		expect(sec?.required).toBe(true);
		expect(results.find((r) => r.persona === "documentation")?.verdict).toBe(
			"approve",
		);
	});

	it("resolves duplicate personas independently on justified distinct models", async () => {
		const { capability, calls } = fakeSubagents({
			"security-audit": { status: "succeeded", summary: "VERDICT: PASS" },
		});
		const specs: SubAgentSpec[] = [
			{ name: "security-a", persona: "security-audit", model: "openai/a" },
			{
				name: "security-b",
				persona: "security-audit",
				model: "anthropic/b",
				modelJustification: "Independent provider audit for auth changes",
			},
		];
		const selected: string[] = [];
		const results = await runReviewPanel(specs, {
			subagents: capability,
			cwd: "/wt",
			resolveModel: async (spec) => {
				selected.push(spec.model ?? "default/model");
				return { model: spec.model ?? "default/model", effort: "high" };
			},
		});
		expect(selected).toEqual(["openai/a", "anthropic/b"]);
		expect(calls.map((profile) => profile.model)).toEqual([
			"openai/a",
			"anthropic/b",
		]);
		expect(
			results.map((result) => [result.name, result.model, result.effort]),
		).toEqual([
			["security-a", "openai/a", "high"],
			["security-b", "anthropic/b", "high"],
		]);
	});

	it("gate is satisfied only when every required review approves", async () => {
		const passing = [
			{
				name: "a",
				persona: "correctness-review",
				required: true,
				kind: "review" as const,
				verdict: "approve" as const,
				findings: [],
				structured: [],
				report: "",
				ok: true,
			},
		];
		expect(panelGateSatisfied(passing)).toBe(true);
		expect(
			panelGateSatisfied([
				{ ...passing[0], verdict: "request-changes" as const },
			]),
		).toBe(false);
		// Advisory (non-required) request-changes does not block.
		expect(
			panelGateSatisfied([
				{ ...passing[0], required: false, verdict: "request-changes" as const },
			]),
		).toBe(true);
	});

	it("executor gate: required names must all approve in the latest round", () => {
		// No required reviewers → always open.
		expect(requiredGateSatisfied([], undefined)).toBe(true);
		// Required but no verdicts reported yet → blocked.
		expect(requiredGateSatisfied(["security-audit"], undefined)).toBe(false);
		// Required present but only advisory approved → blocked.
		expect(
			requiredGateSatisfied(
				["security-audit"],
				[{ name: "documentation", verdict: "approve" }],
			),
		).toBe(false);
		// Required approved → open.
		expect(
			requiredGateSatisfied(
				["security-audit"],
				[
					{ name: "security-audit", verdict: "approve" },
					{ name: "correctness-review", verdict: "request-changes" },
				],
			),
		).toBe(true);
		// One of two required still requesting changes → blocked.
		expect(
			requiredGateSatisfied(
				["security-audit", "correctness-review"],
				[
					{ name: "security-audit", verdict: "approve" },
					{ name: "correctness-review", verdict: "request-changes" },
				],
			),
		).toBe(false);
	});

	it("marks a failed reviewer ok=false with no verdict", async () => {
		const { capability } = fakeSubagents({});
		const results = await runReviewPanel(
			[{ name: "x", persona: "performance" }],
			{ subagents: capability, cwd: "/wt" },
		);
		expect(results[0].ok).toBe(false);
		expect(results[0].verdict).toBe("none");
	});

	it("retries once when a reviewer succeeds with an empty report", async () => {
		// Gateway models occasionally end a run with no final text; a silent
		// required reviewer would hold the ship gate with nothing to show.
		let spawns = 0;
		const capability = {
			spawn(): RunHandle {
				spawns += 1;
				const result: RunResult =
					spawns === 1
						? { status: "succeeded", summary: "   " }
						: { status: "succeeded", summary: "fine\nVERDICT: approve" };
				return {
					id: `run-${spawns}` as RunId,
					status: () => "running" as const,
					steer: () => {},
					stop: () => {},
					result: async () => result,
				};
			},
		} as unknown as SubagentsCapabilityV1;
		const results = await runReviewPanel(
			[{ name: "sec", persona: "security-audit", required: true }],
			{ subagents: capability, cwd: "/wt" },
		);
		expect(spawns).toBe(2);
		expect(results[0].ok).toBe(true);
		expect(results[0].verdict).toBe("approve");
	});

	it("a reviewer that succeeds empty twice is a CLEAN APPROVE (participant)", async () => {
		// Live dogfood regression: clean required reviewers with no findings and
		// no report were treated as "never reported" — the gate held forever and
		// send-back just reproduced the same clean run. A double-clean success
		// is an approve; only failures/timeouts stay ok=false.
		let spawns = 0;
		const capability = {
			spawn(): RunHandle {
				spawns += 1;
				return {
					id: `run-${spawns}` as RunId,
					status: () => "running" as const,
					steer: () => {},
					stop: () => {},
					result: async () => ({ status: "succeeded" as const, summary: "" }),
				};
			},
		} as unknown as SubagentsCapabilityV1;
		const results = await runReviewPanel(
			[{ name: "sec", persona: "security-audit", required: true }],
			{ subagents: capability, cwd: "/wt" },
		);
		expect(spawns).toBe(2); // still retried once before concluding clean
		expect(results[0].ok).toBe(true);
		expect(results[0].verdict).toBe("approve");
		expect(results[0].structured).toEqual([]);
		expect(results[0].report).toContain("clean run");
		expect(panelGateSatisfied(results)).toBe(true);
	});
});
