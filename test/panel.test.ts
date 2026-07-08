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
		spawn(prompt: string, profile: SpawnProfile): RunHandle {
			calls.push(profile);
			const persona = Object.keys(byPersona).find((p) => prompt.includes(p));
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

	it("gate is satisfied only when every required review approves", async () => {
		const passing = [
			{
				name: "a",
				persona: "correctness-review",
				required: true,
				kind: "review" as const,
				verdict: "approve" as const,
				findings: [],
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

	it("marks a failed reviewer ok=false with no verdict", async () => {
		const { capability } = fakeSubagents({});
		const results = await runReviewPanel(
			[{ name: "x", persona: "performance" }],
			{ subagents: capability, cwd: "/wt" },
		);
		expect(results[0].ok).toBe(false);
		expect(results[0].verdict).toBe("none");
	});
});
