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

/** A contract-compliant reviewer report: VERDICT line + fenced findings JSON. */
function report(verdict: "PASS" | "BLOCK", findings: unknown[] = []): string {
	return `## Summary\nreviewed.\nVERDICT: ${verdict}\n\`\`\`json\n${JSON.stringify(
		{ findings },
	)}\n\`\`\``;
}

const CRITICAL = {
	severity: "critical",
	category: "security",
	file: "a.ts",
	line: 1,
	actual: "auth bypass",
};

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

/** Capability that counts spawns and returns the same result every time. */
function countingSubagents(
	result: RunResult | (() => Promise<RunResult>),
	onStop?: () => void,
): { capability: SubagentsCapabilityV1; spawns: () => number } {
	let spawns = 0;
	const capability = {
		spawn(): RunHandle {
			spawns += 1;
			return {
				id: `run-${spawns}` as RunId,
				status: () => "running" as const,
				steer: () => {},
				stop: () => onStop?.(),
				result: typeof result === "function" ? result : async () => result,
			};
		},
	} as unknown as SubagentsCapabilityV1;
	return { capability, spawns: () => spawns };
}

describe("runReviewPanel", () => {
	it("spawns each spec read-only in the worktree and parses PASS/BLOCK", async () => {
		const { capability, calls } = fakeSubagents({
			"security-audit": {
				status: "succeeded",
				summary: report("BLOCK", [CRITICAL]),
			},
			documentation: { status: "succeeded", summary: report("PASS") },
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
		expect(sec?.status).toBe("request-changes");
		expect(sec?.report).toContain("auth bypass"); // worker acts on the full report
		expect(sec?.required).toBe(true);
		expect(sec?.runId).toBeDefined();
		expect(results.find((r) => r.persona === "documentation")?.verdict).toBe(
			"approve",
		);
	});

	it("resolves duplicate personas independently on justified distinct models", async () => {
		const { capability, calls } = fakeSubagents({
			"security-audit": { status: "succeeded", summary: report("PASS") },
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

	it("isolates a reviewer model-resolution failure", async () => {
		const { capability } = fakeSubagents({
			documentation: { status: "succeeded", summary: report("PASS") },
		});
		const results = await runReviewPanel(
			[
				{ name: "bad", persona: "security-audit", model: "bad/model" },
				{ name: "good", persona: "documentation" },
			],
			{
				subagents: capability,
				cwd: "/wt",
				resolveModel: async (spec) => {
					if (spec.name === "bad") throw new Error("not in reviewer pool");
					return { model: "good/model", effort: "low" };
				},
			},
		);
		expect(results[0]).toMatchObject({
			ok: false,
			status: "failed",
			verdict: "none",
		});
		expect(results[0].report).toContain("not in reviewer pool");
		expect(results[1]).toMatchObject({ ok: true, verdict: "approve" });
	});

	it("gate is satisfied only when every required review approves", async () => {
		const passing = [
			{
				name: "a",
				persona: "correctness-review",
				required: true,
				kind: "review" as const,
				status: "approve" as const,
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
				{
					...passing[0],
					status: "request-changes" as const,
					verdict: "request-changes" as const,
				},
			]),
		).toBe(false);
		// Advisory (non-required) request-changes does not block.
		expect(
			panelGateSatisfied([
				{
					...passing[0],
					required: false,
					status: "request-changes" as const,
					verdict: "request-changes" as const,
				},
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
		expect(results[0].status).toBe("failed");
		expect(results[0].verdict).toBe("none");
	});

	it("runs each reviewer exactly ONCE — an empty report is malformed, never retried, never approve", async () => {
		// Inverse of the old behavior on both axes: the implicit retry stacked
		// with the review tool's rerun layer (one reviewer ran 4×), and a
		// silent success was counted as a clean approve (silent gateway
		// failures shipped deliverables).
		const { capability, spawns } = countingSubagents({
			status: "succeeded",
			summary: "   ",
		});
		const results = await runReviewPanel(
			[{ name: "sec", persona: "security-audit", required: true }],
			{ subagents: capability, cwd: "/wt" },
		);
		expect(spawns()).toBe(1);
		expect(results[0].ok).toBe(false);
		expect(results[0].status).toBe("malformed");
		expect(results[0].verdict).toBe("none");
		expect(panelGateSatisfied(results)).toBe(false);
	});

	it("a timeout is terminal for the attempt: timed-out, no retry", async () => {
		let stopped = 0;
		const { capability, spawns } = countingSubagents(
			() => new Promise<RunResult>(() => {}), // never settles
			() => {
				stopped += 1;
			},
		);
		const results = await runReviewPanel(
			[{ name: "sec", persona: "security-audit", required: true }],
			{ subagents: capability, cwd: "/wt", timeoutMs: 10 },
		);
		expect(spawns()).toBe(1);
		expect(stopped).toBe(1);
		expect(results[0].status).toBe("timed-out");
		expect(results[0].ok).toBe(false);
		expect(panelGateSatisfied(results)).toBe(false);
	});

	it("a user interrupt is terminal: interrupted, no retry", async () => {
		const { capability, spawns } = countingSubagents({
			status: "stopped",
			error: "aborted",
		});
		const results = await runReviewPanel(
			[{ name: "sec", persona: "security-audit", required: true }],
			{ subagents: capability, cwd: "/wt" },
		);
		expect(spawns()).toBe(1);
		expect(results[0].status).toBe("interrupted");
		expect(results[0].ok).toBe(false);
	});

	it("a runner-side timed-out result maps to timed-out", async () => {
		const { capability, spawns } = countingSubagents({
			status: "timed-out",
			error: "hard cap: still running after 480s",
			summary: "partial thoughts…", // salvage is diagnostic, not a report
		});
		const results = await runReviewPanel(
			[{ name: "sec", persona: "security-audit", required: true }],
			{ subagents: capability, cwd: "/wt" },
		);
		expect(spawns()).toBe(1);
		expect(results[0].status).toBe("timed-out");
		expect(results[0].ok).toBe(false);
		expect(results[0].verdict).toBe("none");
		// The partial text stays available diagnostically…
		expect(results[0].report).toContain("partial thoughts");
		// …but never becomes approval.
		expect(panelGateSatisfied(results)).toBe(false);
	});

	it("a verdict without the findings JSON block is malformed", async () => {
		const { capability } = countingSubagents({
			status: "succeeded",
			summary: "## Summary\nall good.\nVERDICT: PASS",
		});
		const results = await runReviewPanel(
			[{ name: "sec", persona: "security-audit", required: true }],
			{ subagents: capability, cwd: "/wt" },
		);
		expect(results[0].status).toBe("malformed");
		expect(results[0].ok).toBe(false);
		expect(results[0].verdict).toBe("none");
		expect(results[0].report).toContain("no valid fenced findings JSON block");
	});

	it("findings without a parseable verdict line are malformed — never 'panel clean'", async () => {
		const { capability } = countingSubagents({
			status: "succeeded",
			summary: `## Critical\n1. a.ts:1 — auth bypass\n\`\`\`json\n${JSON.stringify(
				{ findings: [CRITICAL] },
			)}\n\`\`\``,
		});
		const results = await runReviewPanel(
			[{ name: "sec", persona: "security-audit", required: true }],
			{ subagents: capability, cwd: "/wt" },
		);
		expect(results[0].status).toBe("malformed");
		expect(results[0].ok).toBe(false);
		expect(panelGateSatisfied(results)).toBe(false);
	});

	it("severity computes the verdict: stated line loses on mismatch", async () => {
		const { capability } = fakeSubagents({
			// Stated BLOCK over minors only → normalizes to approve.
			"security-audit": {
				status: "succeeded",
				summary: report("BLOCK", [
					{ severity: "minor", category: "style", actual: "nit" },
				]),
			},
			// Stated PASS over a critical → blocks.
			documentation: {
				status: "succeeded",
				summary: report("PASS", [CRITICAL]),
			},
		});
		const results = await runReviewPanel(
			[
				{ name: "security-audit", persona: "security-audit" },
				{ name: "documentation", persona: "documentation" },
			],
			{ subagents: capability, cwd: "/wt" },
		);
		expect(results[0].verdict).toBe("approve");
		expect(results[0].status).toBe("approve");
		expect(results[1].verdict).toBe("request-changes");
		expect(results[1].status).toBe("request-changes");
	});
});
