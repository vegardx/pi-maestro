// The review episode state machine under the ASYNC contract: a spawning call
// acknowledges immediately (names + run ids, no gate claim) and the report is
// injected as a message when the round settles. Panel-once, minted ids,
// resolution completeness, scoped verification as the gate, targeted repair,
// the in-flight guard, and rehydration from a persisted ledger.

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
 * A queued Promise keeps that run pending until the test resolves it.
 */
type Scripted = RunResult | Promise<RunResult>;

function fakeSubagents(config: {
	personas?: Record<string, Scripted[]>;
	verifier?: Scripted[];
}): { capability: SubagentsCapabilityV1; spawns: string[] } {
	const spawns: string[] = [];
	let n = 0;
	const capability = {
		spawn(_prompt: string, profile: SpawnProfile): RunHandle {
			const sys = profile.appendSystemPrompt ?? "";
			let key: string;
			let queue: Scripted[] | undefined;
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
			const result: Scripted =
				queue && queue.length > 0
					? (queue.shift() as Scripted)
					: ({ status: "failed", error: "no scripted result" } as RunResult);
			return {
				id: `run-${++n}` as RunId,
				status: () => "running" as const,
				steer: () => {},
				stop: () => {},
				result: async () => await result,
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

/** A run the test settles by hand — keeps its round in flight until then. */
function deferred(): {
	promise: Promise<RunResult>;
	resolve: (r: RunResult) => void;
} {
	let resolve!: (r: RunResult) => void;
	const promise = new Promise<RunResult>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

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
	kind: "panel" | "verification" | "round-started";
	results: readonly PanelResult[];
	ledger: ReviewLedger;
}

function makeTool(
	capability: SubagentsCapabilityV1,
	panel: SubAgentSpec[],
	opts: {
		state?: Partial<PanelState>;
		reports?: Reported[];
		/** Shared persisted-ledger store — pass the same object to two tools
		 *  to model a crashed worker racing its respawned successor. */
		store?: { ledger?: ReviewLedger };
	} = {},
) {
	const delivered: string[] = [];
	// Model the executor: every reported ledger (round-started markers
	// included) is persisted and served back through panelState — the settle
	// path re-reads it as the delivery latch.
	const store: { ledger?: ReviewLedger } = opts.store ?? {
		...(opts.state?.ledger ? { ledger: opts.state.ledger } : {}),
	};
	const tool = createReviewTool({
		subagents: () => capability,
		panelState: () => ({
			panel,
			...opts.state,
			...(store.ledger ? { ledger: structuredClone(store.ledger) } : {}),
		}),
		cwd: () => "/wt",
		deliver: (text) => {
			delivered.push(text);
		},
		report: (kind, results, ledger) => {
			store.ledger = structuredClone(ledger);
			opts.reports?.push({ kind, results, ledger });
		},
		now: () => "2026-07-12T00:00:00.000Z",
	});
	// The background settle runs behind the tool result — poll for the nth
	// injected message instead of racing its microtask chain.
	const delivery = async (n = 0): Promise<string> => {
		for (let i = 0; i < 200 && delivered.length <= n; i++) {
			await new Promise<void>((r) => setImmediate(r));
		}
		if (delivered.length <= n) throw new Error("no report was delivered");
		return delivered[n];
	};
	return { tool, delivered, delivery };
}

/** The settled-round reports only — round-started crash markers filtered. */
const settled = (reports: readonly Reported[]) =>
	reports.filter((r) => r.kind !== "round-started");

const SEC: SubAgentSpec = {
	name: "security-audit",
	persona: "security-audit",
	required: true,
};
const SIMP: SubAgentSpec = {
	name: "simplification",
	persona: "simplification",
};

describe("review tool — async panel round", () => {
	it("acknowledges immediately without a gate claim; the findings report arrives as a message", async () => {
		const { capability, spawns } = fakeSubagents({
			personas: {
				"security-audit": [blockWithMajor("injection in a.ts")],
				simplification: [pass()],
			},
		});
		const reports: Reported[] = [];
		const { tool, delivery } = makeTool(capability, [SEC, SIMP], { reports });

		const res = await run(tool);
		// The tool result is only the acknowledgment: run ids, wait pointer,
		// and NO gate verdict (the round has not settled).
		expect(res.details.gate).toBeUndefined();
		expect(res.content[0].text).toContain("Review panel running:");
		expect(res.content[0].text).toContain("security-audit (run-1)");
		expect(res.content[0].text).toContain("simplification (run-2)");
		expect(res.content[0].text).toContain("Do not re-run review()");
		expect(res.content[0].text).not.toContain("security-audit.1");
		expect(spawns).toEqual(["security-audit", "simplification"]);

		// The settled report — minted ids, ledger, resolution pointer — is
		// delivered as an injected message, not a tool result.
		const report = await delivery();
		expect(report).toContain("Panel found 1 blocking finding(s)");
		expect(report).toContain("security-audit.1");
		expect(report).toContain("review({resolutions");
		expect(report).not.toContain("Panel clean");

		// The upward report flow: the round-started crash marker first (with
		// the pending runs), then exactly one settled panel report.
		expect(reports.map((r) => r.kind)).toEqual(["round-started", "panel"]);
		expect(settled(reports)[0].ledger.entries.map((e) => e.finding.id)).toEqual(
			["security-audit.1"],
		);
	});

	it("delivers 'Panel clean' only when the panel is clean", async () => {
		const { capability } = fakeSubagents({
			personas: { "security-audit": [pass()] },
		});
		const { tool, delivery } = makeTool(capability, [SEC]);
		const res = await run(tool);
		expect(res.details.gate).toBeUndefined();
		expect(res.content[0].text).not.toContain("Panel clean");
		expect(await delivery()).toContain("Panel clean");
	});

	it("an empty panel resolves synchronously and does not block ship", async () => {
		const { capability } = fakeSubagents({});
		const { tool, delivered } = makeTool(capability, []);
		const res = await run(tool);
		expect(res.details.gate).toBe(true);
		expect(res.content[0].text).toContain("No review panel");
		expect(delivered).toHaveLength(0);
	});

	it("a second review() while the round is in flight spawns NOTHING", async () => {
		const pending = deferred();
		const { capability, spawns } = fakeSubagents({
			personas: { "security-audit": [pending.promise] },
		});
		const { tool, delivered, delivery } = makeTool(capability, [SEC]);
		await run(tool);
		expect(spawns).toHaveLength(1);

		const second = await run(tool);
		expect(spawns).toHaveLength(1);
		expect(delivered).toHaveLength(0);
		expect(second.details.gate).toBeUndefined();
		expect(second.content[0].text).toContain("already running");
		expect(second.content[0].text).toContain("wait for its report");

		pending.resolve(pass());
		expect(await delivery()).toContain("Panel clean");
		expect(delivered).toHaveLength(1);
	});

	it("a second bare call after the report does NOT re-run the panel (panel-once)", async () => {
		const { capability, spawns } = fakeSubagents({
			personas: { "security-audit": [blockWithMajor("flaw")] },
		});
		const { tool, delivery } = makeTool(capability, [SEC]);
		await run(tool);
		await delivery();
		const spawnsAfterPanel = spawns.length;
		const res = await run(tool);
		expect(spawns.length).toBe(spawnsAfterPanel);
		expect(res.content[0].text).toContain("do not re-run it");
	});

	it("normalizes a stated BLOCK over minors to a clean report", async () => {
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
		const { tool, delivery } = makeTool(capability, [SEC]);
		await run(tool);
		// Minors never hold the gate, whatever the reviewer's mood said.
		expect(await delivery()).toContain("Panel clean");
	});
});

describe("review tool — verification", () => {
	it("fixed claims spawn ONE scoped verifier; the verified report arrives as a message", async () => {
		const { capability, spawns } = fakeSubagents({
			personas: { "security-audit": [blockWithMajor("flaw")] },
			verifier: [
				verifierSays([
					{ id: "security-audit.1", result: "verified", note: "test at x" },
				]),
			],
		});
		const reports: Reported[] = [];
		const { tool, delivery } = makeTool(capability, [SEC], { reports });
		await run(tool);
		await delivery();

		const res = await run(tool, {
			resolutions: [
				{ id: "security-audit.1", status: "fixed", note: "commit abc" },
			],
		});
		expect(res.details.gate).toBeUndefined();
		expect(res.content[0].text).toContain("Verifier running:");
		expect(res.content[0].text).toContain("verifier-1 (run-2)");
		expect(res.content[0].text).toContain("Do not re-run review()");

		const report = await delivery(1);
		expect(report).toContain("gate is clear");
		expect(spawns.filter((s) => s === "verifier")).toHaveLength(1);
		expect(spawns.filter((s) => s === "security-audit")).toHaveLength(1);
		const last = reports.at(-1);
		expect(last?.kind).toBe("verification");
		expect(last?.ledger.cycle).toBe(1);
	});

	it("rejects incomplete resolutions synchronously, without spawning the verifier", async () => {
		const { capability, spawns } = fakeSubagents({
			personas: {
				"security-audit": [blockWithMajor("flaw one")],
				simplification: [blockWithMajor("flaw two")],
			},
		});
		const { tool, delivered, delivery } = makeTool(capability, [SEC, SIMP]);
		await run(tool);
		await delivery();
		const res = await run(tool, {
			resolutions: [
				{ id: "security-audit.1", status: "fixed", note: "commit" },
			],
		});
		expect(res.content[0].text).toContain("unaccounted");
		expect(res.content[0].text).toContain("simplification.1");
		expect(spawns.filter((s) => s === "verifier")).toHaveLength(0);
		expect(delivered).toHaveLength(1); // only the panel report
	});

	it("still-open keeps the gate held in the delivered report", async () => {
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
		const { tool, delivery } = makeTool(capability, [SEC]);
		await run(tool);
		await delivery();
		await run(tool, {
			resolutions: [
				{ id: "security-audit.1", status: "fixed", note: "commit" },
			],
		});
		const report = await delivery(1);
		expect(report).toContain("still open");
		expect(report).not.toContain("gate is clear");
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
		const { tool, delivery } = makeTool(capability, [SEC]);
		await run(tool);
		await delivery();
		await run(tool, {
			resolutions: [
				{ id: "security-audit.1", status: "fixed", note: "commit" },
			],
		});
		expect(await delivery(1)).toContain("verifier-1.1");
	});

	it("disputes skip the verifier and resolve synchronously at triage", async () => {
		const { capability, spawns } = fakeSubagents({
			personas: { "security-audit": [blockWithMajor("flaw")] },
		});
		const { tool, delivery } = makeTool(capability, [SEC]);
		await run(tool);
		await delivery();
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

	it("a second review() while the verifier is in flight spawns nothing", async () => {
		const pending = deferred();
		const { capability, spawns } = fakeSubagents({
			personas: { "security-audit": [blockWithMajor("flaw")] },
			verifier: [pending.promise],
		});
		const { tool, delivery } = makeTool(capability, [SEC]);
		await run(tool);
		await delivery();
		await run(tool, {
			resolutions: [
				{ id: "security-audit.1", status: "fixed", note: "commit" },
			],
		});
		const during = await run(tool);
		expect(during.content[0].text).toContain("already running");
		expect(spawns.filter((s) => s === "verifier")).toHaveLength(1);
		pending.resolve(
			verifierSays([{ id: "security-audit.1", result: "verified" }]),
		);
		expect(await delivery(1)).toContain("gate is clear");
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
		const { tool, delivery } = makeTool(capability, [SEC, SIMP], { reports });
		await run(tool);
		const first = await delivery();
		expect(first).toContain('review({action: "repair"})');
		expect(spawns.filter((s) => s === "security-audit")).toHaveLength(1);
		expect(spawns.filter((s) => s === "simplification")).toHaveLength(1);
		const failedParticipant = settled(reports)[0].ledger.participants?.find(
			(p) => p.name === "security-audit",
		);
		expect(failedParticipant).toMatchObject({
			ok: false,
			status: "failed",
			attempt: 1,
		});
		expect(failedParticipant?.error).toContain("spawn error");

		const ack = await run(tool, { action: "repair" });
		expect(ack.details.gate).toBeUndefined();
		expect(ack.content[0].text).toContain("Repair round running:");
		expect(ack.content[0].text).toContain("security-audit");
		expect(ack.content[0].text).not.toContain("simplification");

		const repaired = await delivery(1);
		expect(repaired).toContain("Panel clean");
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
		const { tool, delivery } = makeTool(capability, [SEC], { reports });
		await run(tool);
		await delivery();
		await run(tool, { action: "repair" });
		const report = await delivery(1);
		expect(report).toContain('review({action: "repair"})');
		expect(spawns.filter((s) => s === "security-audit")).toHaveLength(2);
		expect(
			reports
				.at(-1)
				?.ledger.participants?.find((p) => p.name === "security-audit"),
		).toMatchObject({ ok: false, status: "failed", attempt: 2 });
	});

	it("a timed-out reviewer is terminal for the round and named in the report", async () => {
		const { capability, spawns } = fakeSubagents({
			personas: {
				"security-audit": [
					{ status: "timed-out", error: "hard cap: still running after 480s" },
				],
			},
		});
		const reports: Reported[] = [];
		const { tool, delivery } = makeTool(capability, [SEC], { reports });
		await run(tool);
		const report = await delivery();
		expect(report).toContain("security-audit (timed-out)");
		expect(spawns.filter((s) => s === "security-audit")).toHaveLength(1);
		expect(
			settled(reports)[0].ledger.participants?.find(
				(p) => p.name === "security-audit",
			),
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
		const { tool, delivery } = makeTool(capability, [SEC, SIMP], { reports });
		await run(tool);
		await delivery();
		expect(settled(reports)[0].ledger.entries.map((e) => e.finding.id)).toEqual(
			["security-audit.1"],
		);
		await run(tool, { action: "repair" });
		await delivery(1);
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

	it("a failed verifier delivers a retry pointer, never an implicit re-spawn", async () => {
		const { capability, spawns } = fakeSubagents({
			personas: { "security-audit": [blockWithMajor("flaw")] },
			verifier: [{ status: "failed", error: "gateway down" }],
		});
		const { tool, delivery } = makeTool(capability, [SEC]);
		await run(tool);
		await delivery();
		await run(tool, {
			resolutions: [
				{ id: "security-audit.1", status: "fixed", note: "commit" },
			],
		});
		const report = await delivery(1);
		expect(report).toContain("Verifier failed");
		expect(report).toContain('review({action: "verify"');
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
		const { tool, delivery } = makeTool(capability, [SEC], {
			state: { ledger },
		});
		const res = await run(tool, {
			resolutions: [
				{ id: "security-audit.1", status: "fixed", note: "commit" },
			],
		});
		expect(res.details.gate).toBeUndefined();
		expect(res.content[0].text).toContain("Verifier running:");
		expect(await delivery()).toContain("gate is clear");
		expect(spawns).toEqual(["verifier"]);
	});

	it("waived findings are excluded from completeness and the gate", async () => {
		const { capability } = fakeSubagents({
			personas: { "security-audit": [blockWithMajor("flaw")] },
		});
		const { tool, delivery } = makeTool(capability, [SEC], {
			state: { waived: ["security-audit.1"] },
		});
		await run(tool);
		await delivery();
		const res = await run(tool);
		expect(res.details.gate).toBe(true);
		expect(res.content[0].text).toContain("Nothing to verify");
	});
});
