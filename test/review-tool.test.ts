// The review episode state machine: panel-once, minted ids, resolution
// completeness, scoped verification as the gate, targeted repair, and
// rehydration from a persisted ledger.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	RunHandle,
	RunId,
	RunResult,
	SpawnProfile,
	SubagentsCapabilityV1,
} from "@vegardx/pi-contracts";
import { describe, expect, it } from "vitest";
import type { ReviewLedger } from "../packages/modes/src/exec/findings.js";
import type { PanelResult } from "../packages/modes/src/panel.js";
import {
	createReviewTool,
	type PanelState,
} from "../packages/modes/src/review-tool.js";
import type { SubAgentSpec } from "../packages/modes/src/schema.js";

/**
 * Fake subagents: personas matched by the identity line in their profile,
 * the verifier by its contract marker. Values are queues — one entry per
 * expected spawn, so panel-once and retry behavior are asserted by count.
 */
function fakeSubagents(config: {
	personas?: Record<string, RunResult[]>;
	verifier?: RunResult[];
}): { capability: SubagentsCapabilityV1; spawns: string[] } {
	const spawns: string[] = [];
	let n = 0;
	const capability = {
		spawn(_prompt: string, profile: SpawnProfile): RunHandle {
			const sys = profile.appendSystemPrompt ?? "";
			let key: string;
			let queue: RunResult[] | undefined;
			if (sys.includes("fix VERIFIER")) {
				key = "verifier";
				queue = config.verifier;
			} else {
				key =
					Object.keys(config.personas ?? {}).find((p) =>
						sys.includes(`"${p}"`),
					) ?? "?";
				queue = config.personas?.[key];
			}
			spawns.push(key);
			const result: RunResult =
				queue && queue.length > 0
					? (queue.shift() as RunResult)
					: ({ status: "failed", error: "no scripted result" } as RunResult);
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
	return { capability, spawns };
}

const pass = (): RunResult => ({
	status: "succeeded",
	summary: 'clean\nVERDICT: PASS\n```json\n{"findings": []}\n```',
});

const blockWithMajor = (actual: string): RunResult => ({
	status: "succeeded",
	summary: `bad\nVERDICT: BLOCK\n\`\`\`json\n{"findings": [{"severity": "major", "category": "correctness", "file": "a.ts", "line": 3, "actual": ${JSON.stringify(actual)}}]}\n\`\`\``,
});

const verifierSays = (
	checks: Array<{ id: string; result: string; note?: string }>,
	regressions: Array<Record<string, unknown>> = [],
): RunResult => ({
	status: "succeeded",
	summary: `checked\n\`\`\`json\n${JSON.stringify({ checks, regressions })}\n\`\`\``,
});

type Exec = {
	execute(
		id: string,
		params: unknown,
		signal?: undefined,
		onUpdate?: undefined,
		ctx?: ExtensionContext,
	): Promise<{
		content: [{ type: "text"; text: string }];
		details: { gate?: boolean };
	}>;
};
const run = (t: ReturnType<typeof createReviewTool>, params: unknown = {}) =>
	(t as unknown as Exec).execute(
		"c",
		params,
		undefined,
		undefined,
		{} as ExtensionContext,
	);

interface Reported {
	kind: "panel" | "verification";
	results: readonly PanelResult[];
	ledger: ReviewLedger;
}

function makeTool(
	capability: SubagentsCapabilityV1,
	panel: SubAgentSpec[],
	opts: { state?: Partial<PanelState>; reports?: Reported[] } = {},
) {
	return createReviewTool({
		subagents: () => capability,
		panelState: () => ({ panel, ...opts.state }),
		cwd: () => "/wt",
		report: (kind, results, ledger) => {
			opts.reports?.push({ kind, results, ledger });
		},
		now: () => "2026-07-12T00:00:00.000Z",
	});
}

const SEC: SubAgentSpec = {
	name: "security-audit",
	persona: "security-audit",
	required: true,
};
const SIMP: SubAgentSpec = {
	name: "simplification",
	persona: "simplification",
};

describe("review tool — panel round", () => {
	it("runs the panel once, mints ids, and blocks on a major finding", async () => {
		const { capability, spawns } = fakeSubagents({
			personas: {
				"security-audit": [blockWithMajor("injection in a.ts")],
				simplification: [pass()],
			},
		});
		const reports: Reported[] = [];
		const tool = makeTool(capability, [SEC, SIMP], { reports });
		const res = await run(tool);
		expect(res.details.gate).toBe(false);
		expect(res.content[0].text).toContain("security-audit.1");
		expect(res.content[0].text).toContain("review({resolutions");
		expect(spawns).toEqual(["security-audit", "simplification"]);
		expect(reports).toHaveLength(1);
		expect(reports[0].kind).toBe("panel");
		expect(reports[0].ledger.entries.map((e) => e.finding.id)).toEqual([
			"security-audit.1",
		]);
	});

	it("clean panel opens the gate", async () => {
		const { capability } = fakeSubagents({
			personas: { "security-audit": [pass()] },
		});
		const tool = makeTool(capability, [SEC]);
		const res = await run(tool);
		expect(res.details.gate).toBe(true);
		expect(res.content[0].text).toContain("Panel clean");
	});

	it("an empty panel does not block ship", async () => {
		const { capability } = fakeSubagents({});
		const tool = makeTool(capability, []);
		const res = await run(tool);
		expect(res.details.gate).toBe(true);
		expect(res.content[0].text).toContain("No review panel");
	});

	it("a second bare call does NOT re-run the panel (panel-once)", async () => {
		const { capability, spawns } = fakeSubagents({
			personas: { "security-audit": [blockWithMajor("flaw")] },
		});
		const tool = makeTool(capability, [SEC]);
		await run(tool);
		const spawnsAfterPanel = spawns.length;
		const res = await run(tool);
		expect(spawns.length).toBe(spawnsAfterPanel);
		expect(res.content[0].text).toContain("do not re-run it");
	});

	it("normalizes a stated BLOCK over minors to approve", async () => {
		const { capability } = fakeSubagents({
			personas: {
				"security-audit": [
					{
						status: "succeeded",
						summary:
							'nits\nVERDICT: BLOCK\n```json\n{"findings": [{"severity": "minor", "category": "style", "actual": "naming"}]}\n```',
					},
				],
			},
		});
		const tool = makeTool(capability, [SEC]);
		const res = await run(tool);
		// Minors never hold the gate, whatever the reviewer's mood said.
		expect(res.details.gate).toBe(true);
	});
});

describe("review tool — verification", () => {
	it("fixed claims spawn ONE scoped verifier; verified closes the gate", async () => {
		const { capability, spawns } = fakeSubagents({
			personas: { "security-audit": [blockWithMajor("flaw")] },
			verifier: [
				verifierSays([
					{ id: "security-audit.1", result: "verified", note: "test at x" },
				]),
			],
		});
		const reports: Reported[] = [];
		const tool = makeTool(capability, [SEC], { reports });
		await run(tool);
		const res = await run(tool, {
			resolutions: [
				{ id: "security-audit.1", status: "fixed", note: "commit abc" },
			],
		});
		expect(res.details.gate).toBe(true);
		expect(res.content[0].text).toContain("gate is clear");
		expect(spawns.filter((s) => s === "verifier")).toHaveLength(1);
		expect(spawns.filter((s) => s === "security-audit")).toHaveLength(1);
		const last = reports.at(-1);
		expect(last?.kind).toBe("verification");
		expect(last?.ledger.cycle).toBe(1);
	});

	it("rejects incomplete resolutions without spawning the verifier", async () => {
		const { capability, spawns } = fakeSubagents({
			personas: {
				"security-audit": [blockWithMajor("flaw one")],
				simplification: [blockWithMajor("flaw two")],
			},
		});
		const tool = makeTool(capability, [SEC, SIMP]);
		await run(tool);
		const res = await run(tool, {
			resolutions: [
				{ id: "security-audit.1", status: "fixed", note: "commit" },
			],
		});
		expect(res.content[0].text).toContain("unaccounted");
		expect(res.content[0].text).toContain("simplification.1");
		expect(spawns.filter((s) => s === "verifier")).toHaveLength(0);
	});

	it("still-open keeps the gate held", async () => {
		const { capability } = fakeSubagents({
			personas: { "security-audit": [blockWithMajor("flaw")] },
			verifier: [
				verifierSays([
					{
						id: "security-audit.1",
						result: "still-open",
						note: "path B remains",
					},
				]),
			],
		});
		const tool = makeTool(capability, [SEC]);
		await run(tool);
		const res = await run(tool, {
			resolutions: [
				{ id: "security-audit.1", status: "fixed", note: "commit" },
			],
		});
		expect(res.details.gate).toBe(false);
		expect(res.content[0].text).toContain("still open");
	});

	it("a verifier regression reopens the gate with a minted id", async () => {
		const { capability } = fakeSubagents({
			personas: { "security-audit": [blockWithMajor("flaw")] },
			verifier: [
				verifierSays(
					[{ id: "security-audit.1", result: "verified" }],
					[
						{
							severity: "major",
							category: "regression",
							file: "b.ts",
							actual: "fix broke caching",
						},
					],
				),
			],
		});
		const tool = makeTool(capability, [SEC]);
		await run(tool);
		const res = await run(tool, {
			resolutions: [
				{ id: "security-audit.1", status: "fixed", note: "commit" },
			],
		});
		expect(res.details.gate).toBe(false);
		expect(res.content[0].text).toContain("verifier-1.1");
	});

	it("disputes skip the verifier and point at triage", async () => {
		const { capability, spawns } = fakeSubagents({
			personas: { "security-audit": [blockWithMajor("flaw")] },
		});
		const tool = makeTool(capability, [SEC]);
		await run(tool);
		const res = await run(tool, {
			resolutions: [
				{
					id: "security-audit.1",
					status: "disputed",
					note: "unreachable — guarded at entry.ts:41",
				},
			],
		});
		expect(res.details.gate).toBe(false);
		expect(res.content[0].text).toContain("triage");
		expect(spawns.filter((s) => s === "verifier")).toHaveLength(0);
	});
});

describe("review tool — repair and rehydration", () => {
	it("a failed reviewer stays failed (ONE attempt), repair re-runs just it", async () => {
		const { capability, spawns } = fakeSubagents({
			personas: {
				// Fails once — the panel round runs each reviewer exactly once
				// (no inline re-run); the explicit repair then succeeds.
				"security-audit": [{ status: "failed", error: "spawn error" }, pass()],
				simplification: [pass()],
			},
		});
		const reports: Reported[] = [];
		const tool = makeTool(capability, [SEC, SIMP], { reports });
		const first = await run(tool);
		expect(first.details.gate).toBe(false);
		expect(first.content[0].text).toContain('review({action: "repair"})');
		expect(spawns.filter((s) => s === "security-audit")).toHaveLength(1);
		expect(spawns.filter((s) => s === "simplification")).toHaveLength(1);
		const failedParticipant = reports[0].ledger.participants?.find(
			(p) => p.name === "security-audit",
		);
		expect(failedParticipant).toMatchObject({
			ok: false,
			status: "failed",
			attempt: 1,
		});
		expect(failedParticipant?.error).toContain("spawn error");

		const repaired = await run(tool, { action: "repair" });
		expect(repaired.details.gate).toBe(true);
		expect(spawns.filter((s) => s === "security-audit")).toHaveLength(2);
		// simplification was fine — repair never touched it.
		expect(spawns.filter((s) => s === "simplification")).toHaveLength(1);
		const repairedParticipant = reports
			.at(-1)
			?.ledger.participants?.find((p) => p.name === "security-audit");
		expect(repairedParticipant).toMatchObject({
			ok: true,
			status: "approve",
			attempt: 2,
		});
		expect(repairedParticipant?.runId).toBeDefined();
	});

	it("a repair that fails again runs its reviewer exactly once more, no cascade", async () => {
		const { capability, spawns } = fakeSubagents({
			personas: {
				"security-audit": [
					{ status: "failed", error: "spawn error" },
					{ status: "failed", error: "still down" },
				],
			},
		});
		const reports: Reported[] = [];
		const tool = makeTool(capability, [SEC], { reports });
		await run(tool);
		const res = await run(tool, { action: "repair" });
		expect(res.details.gate).toBe(false);
		expect(spawns.filter((s) => s === "security-audit")).toHaveLength(2);
		expect(
			reports
				.at(-1)
				?.ledger.participants?.find((p) => p.name === "security-audit"),
		).toMatchObject({ ok: false, status: "failed", attempt: 2 });
	});

	it("a timed-out reviewer is terminal for the round and holds the gate", async () => {
		const { capability, spawns } = fakeSubagents({
			personas: {
				"security-audit": [
					{ status: "timed-out", error: "hard cap: still running after 480s" },
				],
			},
		});
		const reports: Reported[] = [];
		const tool = makeTool(capability, [SEC], { reports });
		const res = await run(tool);
		expect(res.details.gate).toBe(false);
		expect(spawns.filter((s) => s === "security-audit")).toHaveLength(1);
		expect(
			reports[0].ledger.participants?.find((p) => p.name === "security-audit"),
		).toMatchObject({ ok: false, status: "timed-out", attempt: 1 });
	});

	it("successful reviewers' findings survive another reviewer's failure and its repair", async () => {
		const { capability } = fakeSubagents({
			personas: {
				"security-audit": [blockWithMajor("injection in a.ts")],
				simplification: [{ status: "failed", error: "gateway down" }, pass()],
			},
		});
		const reports: Reported[] = [];
		const tool = makeTool(capability, [SEC, SIMP], { reports });
		await run(tool);
		expect(reports[0].ledger.entries.map((e) => e.finding.id)).toEqual([
			"security-audit.1",
		]);
		await run(tool, { action: "repair" });
		const merged = reports.at(-1)?.ledger;
		// The earlier actionable finding is still on the books after repair.
		expect(merged?.entries.map((e) => e.finding.id)).toEqual([
			"security-audit.1",
		]);
		expect(merged?.participants?.map((p) => [p.name, p.ok, p.attempt])).toEqual(
			[
				["security-audit", true, 1],
				["simplification", true, 2],
			],
		);
	});

	it("a failed verifier is reported back, never implicitly re-spawned", async () => {
		const { capability, spawns } = fakeSubagents({
			personas: { "security-audit": [blockWithMajor("flaw")] },
			verifier: [{ status: "failed", error: "gateway down" }],
		});
		const tool = makeTool(capability, [SEC]);
		await run(tool);
		const res = await run(tool, {
			resolutions: [
				{ id: "security-audit.1", status: "fixed", note: "commit" },
			],
		});
		expect(res.details.gate).toBe(false);
		expect(res.content[0].text).toContain("Verifier failed");
		expect(spawns.filter((s) => s === "verifier")).toHaveLength(1);
	});

	it("rehydrates a persisted ledger — resolutions work without re-running the panel", async () => {
		const ledger: ReviewLedger = {
			round: 1,
			cycle: 0,
			entries: [
				{
					finding: {
						id: "security-audit.1",
						severity: "major",
						category: "correctness",
						actual: "flaw",
					},
					reviewer: "security-audit",
				},
			],
			updatedAt: "2026-07-11T00:00:00.000Z",
		};
		const { capability, spawns } = fakeSubagents({
			verifier: [
				verifierSays([{ id: "security-audit.1", result: "verified" }]),
			],
		});
		const tool = makeTool(capability, [SEC], { state: { ledger } });
		const res = await run(tool, {
			resolutions: [
				{ id: "security-audit.1", status: "fixed", note: "commit" },
			],
		});
		expect(res.details.gate).toBe(true);
		expect(spawns).toEqual(["verifier"]);
	});

	it("waived findings are excluded from completeness and the gate", async () => {
		const { capability } = fakeSubagents({
			personas: { "security-audit": [blockWithMajor("flaw")] },
		});
		const tool = makeTool(capability, [SEC], {
			state: { waived: ["security-audit.1"] },
		});
		await run(tool);
		const res = await run(tool);
		expect(res.details.gate).toBe(true);
		expect(res.content[0].text).toContain("Nothing to verify");
	});
});
