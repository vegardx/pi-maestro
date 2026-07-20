// The watcher (design §The watcher): compile-once → deterministic probe +
// TS canonicalizer; LLM judged only on canonical-state change. Pins the
// safety posture: read-only probes (policy-gated), refine capped +
// replay-checked, silence never success (probe failure and expiry raise,
// expiry carries refinement history), one-shot ends on first raise.

import type { WatchRaise } from "@vegardx/pi-contracts";
import { describe, expect, it } from "vitest";
import {
	buildCompilePrompt,
	defaultCanonicalizerRunner,
	parseCompileResult,
	parseJudgeVerdict,
	probePolicyProblem,
	WatchManager,
} from "../packages/modes/src/watcher.js";

const fakeCtx = { cwd: process.cwd() } as never;

/** A manager with scripted model replies and a scripted probe. */
function harness(opts: {
	compile?: string;
	judgeReplies?: string[];
	probeOutputs?: Array<{ ok: boolean; output: string; error?: string }>;
	canon?: (source: string, raw: string) => string;
}) {
	const raises: WatchRaise[] = [];
	const judgeReplies = [...(opts.judgeReplies ?? [])];
	const probeOutputs = [...(opts.probeOutputs ?? [])];
	let modelCalls = 0;
	const manager = new WatchManager({
		manualTicks: true,
		raise: (raise) => raises.push(raise),
		skills: "(test skills)",
		modelCall: async (_ctx, prompt) => {
			modelCalls += 1;
			if (prompt.includes("Compile this monitoring goal"))
				return (
					opts.compile ??
					JSON.stringify({
						command: "git status --short",
						intervalMs: 1_000,
						canonicalizer: "noop",
					})
				);
			return judgeReplies.shift() ?? null;
		},
		probeRunner: async () =>
			probeOutputs.shift() ?? { ok: true, output: "same" },
		canonicalizerRunner: async (source, raw) => ({
			ok: true,
			state: opts.canon ? opts.canon(source, raw) : raw.trim(),
		}),
	});
	return { manager, raises, stats: () => ({ modelCalls }) };
}

describe("compile + probe gate", () => {
	it("prompt carries the skills and the TS/CLI discipline", () => {
		const prompt = buildCompilePrompt("watch PR 1 CI", "RECIPES");
		expect(prompt).toContain("RECIPES");
		expect(prompt).toContain("TypeScript");
		expect(prompt).toContain("READ-ONLY");
	});

	it("parses compile output and rejects malformed shapes", () => {
		expect(
			parseCompileResult(
				'{"command":"gh run view 1 --json status","intervalMs":30000,"canonicalizer":"x"}',
			),
		).toMatchObject({ command: "gh run view 1 --json status" });
		expect(parseCompileResult('{"command":"x"}')).toBeNull();
	});

	it("rejects probes that are not clearly read-only", () => {
		// Delivery, writes, and unknown all refuse to run unattended.
		expect(
			probePolicyProblem("git push origin main", process.cwd()),
		).toBeTruthy();
		expect(probePolicyProblem("rm -rf /tmp/x", process.cwd())).toBeTruthy();
		expect(probePolicyProblem("./mystery.sh", process.cwd())).toBeTruthy();
		expect(probePolicyProblem("git status --short", process.cwd())).toBeNull();
	});

	it("create fails visibly when the probe is rejected", async () => {
		const { manager } = harness({
			compile: JSON.stringify({
				command: "git push origin main",
				intervalMs: 1000,
				canonicalizer: "x",
			}),
		});
		const result = await manager.create(fakeCtx, { goal: "watch pushes" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("policy");
	});
});

describe("the deterministic tick loop", () => {
	it("baseline is silent; unchanged states never wake the model", async () => {
		const { manager, raises, stats } = harness({
			probeOutputs: [
				{ ok: true, output: "state-a" },
				{ ok: true, output: "state-a" },
				{ ok: true, output: "state-a" },
			],
		});
		const created = await manager.create(fakeCtx, { goal: "g" });
		expect(created.ok).toBe(true);
		const id = created.ok ? created.record.id : "";
		await manager.tick(fakeCtx, id);
		await manager.tick(fakeCtx, id);
		await manager.tick(fakeCtx, id);
		expect(raises).toHaveLength(0);
		// One model call total: the compile. No judging happened.
		expect(stats().modelCalls).toBe(1);
	});

	it("a goal-relevant change raises and one-shot ends the watch", async () => {
		const { manager, raises } = harness({
			probeOutputs: [
				{ ok: true, output: "running" },
				{ ok: true, output: "success" },
			],
			judgeReplies: ['{"action":"raise","summary":"CI finished: success"}'],
		});
		const created = await manager.create(fakeCtx, { goal: "g" });
		const id = created.ok ? created.record.id : "";
		await manager.tick(fakeCtx, id);
		await manager.tick(fakeCtx, id);
		expect(raises).toEqual([
			expect.objectContaining({
				kind: "triggered",
				summary: "CI finished: success",
			}),
		]);
		expect(manager.get(id)?.status).toBe("triggered");
		// Ended: further ticks are inert.
		await manager.tick(fakeCtx, id);
		expect(raises).toHaveLength(1);
	});

	it("until-condition keeps raising and respects maxRaises", async () => {
		const { manager, raises } = harness({
			probeOutputs: [
				{ ok: true, output: "s1" },
				{ ok: true, output: "s2" },
				{ ok: true, output: "s3" },
			],
			judgeReplies: [
				'{"action":"raise","summary":"stage one done"}',
				'{"action":"raise","summary":"stage two done"}',
			],
		});
		const created = await manager.create(fakeCtx, {
			goal: "g",
			lifetime: "until-condition",
			caps: { maxRaises: 2 },
		});
		const id = created.ok ? created.record.id : "";
		await manager.tick(fakeCtx, id);
		await manager.tick(fakeCtx, id);
		await manager.tick(fakeCtx, id);
		expect(raises).toHaveLength(2);
		expect(manager.get(id)?.status).toBe("triggered");
	});
});

describe("self-refinement", () => {
	it("noise refines the canonicalizer (logged) and the collapse is replay-proven", async () => {
		// Canonicalizer "v1" passes raw through; "v2" collapses the flap.
		const { manager, raises } = harness({
			compile: JSON.stringify({
				command: "git status --short",
				intervalMs: 1000,
				canonicalizer: "v1",
			}),
			canon: (source, raw) =>
				source === "v2" ? raw.replace(/flap-\d+/, "flap") : raw,
			probeOutputs: [
				{ ok: true, output: "queued flap-1" },
				{ ok: true, output: "queued flap-2" },
				{ ok: true, output: "queued flap-3" },
			],
			judgeReplies: [
				'{"action":"refine","rationale":"the flap counter is not the goal","canonicalizer":"v2"}',
			],
		});
		const created = await manager.create(fakeCtx, { goal: "g" });
		const id = created.ok ? created.record.id : "";
		await manager.tick(fakeCtx, id); // baseline flap-1
		await manager.tick(fakeCtx, id); // flap-2 wakes judge → refine to v2
		const record = manager.get(id);
		expect(record?.refinements).toHaveLength(1);
		expect(record?.refinements[0]?.rationale).toContain("flap counter");
		expect(record?.probe.canonicalizer).toBe("v2");
		await manager.tick(fakeCtx, id); // flap-3 now collapses: no wake
		expect(raises).toHaveLength(0);
	});

	it("the refinement cap raises instead of narrowing further", async () => {
		const { manager, raises } = harness({
			probeOutputs: [
				{ ok: true, output: "a" },
				{ ok: true, output: "b" },
			],
			judgeReplies: [
				'{"action":"refine","rationale":"noise","canonicalizer":"v2"}',
			],
		});
		const created = await manager.create(fakeCtx, {
			goal: "g",
			caps: { maxRefinements: 0 },
		});
		const id = created.ok ? created.record.id : "";
		await manager.tick(fakeCtx, id);
		await manager.tick(fakeCtx, id);
		expect(raises).toEqual([
			expect.objectContaining({ kind: "refinement-cap" }),
		]);
		expect(manager.get(id)?.status).toBe("failed");
	});
});

describe("silence is never success", () => {
	it("probe failure with an unreachable judge still raises", async () => {
		const { manager, raises } = harness({
			probeOutputs: [{ ok: false, output: "", error: "gh: command not found" }],
			judgeReplies: [], // judge returns null
		});
		const created = await manager.create(fakeCtx, { goal: "g" });
		const id = created.ok ? created.record.id : "";
		await manager.tick(fakeCtx, id);
		expect(raises).toEqual([expect.objectContaining({ kind: "probe-failed" })]);
		expect(manager.get(id)?.status).toBe("failed");
	});

	it("expiry raises with the refinement history attached", async () => {
		const { manager, raises } = harness({
			probeOutputs: [
				{ ok: true, output: "a" },
				{ ok: true, output: "b" },
			],
			judgeReplies: [
				'{"action":"refine","rationale":"ignored the b-flap","canonicalizer":"v2"}',
			],
		});
		const created = await manager.create(fakeCtx, { goal: "g" });
		const id = created.ok ? created.record.id : "";
		await manager.tick(fakeCtx, id);
		await manager.tick(fakeCtx, id); // refine happens
		await manager.forceExpire(id);
		expect(raises).toEqual([
			expect.objectContaining({
				kind: "expired",
				refinementHistory: ["ignored the b-flap"],
			}),
		]);
		expect(manager.get(id)?.status).toBe("expired");
	});
});

describe("verdict parsing", () => {
	it("accepts the four actions and rejects out-of-vocabulary shapes", () => {
		expect(
			parseJudgeVerdict('{"action":"raise","summary":"done"}'),
		).toMatchObject({ action: "raise" });
		expect(parseJudgeVerdict('{"action":"continue"}')).toMatchObject({
			action: "continue",
		});
		expect(
			parseJudgeVerdict(
				'{"action":"refine","rationale":"r","canonicalizer":"c"}',
			),
		).toMatchObject({ action: "refine" });
		expect(
			parseJudgeVerdict('{"action":"repair","canonicalizer":"c"}'),
		).toMatchObject({ action: "repair" });
		expect(parseJudgeVerdict('{"action":"panic"}')).toBeNull();
		expect(parseJudgeVerdict('{"action":"raise"}')).toBeNull();
	});
});

describe("the real canonicalizer child (node --experimental-strip-types)", () => {
	it("runs an LLM-shaped TS program: stdin in, canonical state out", async () => {
		// biome-ignore-start lint/suspicious/noTemplateCurlyInString: the template literal belongs to the CHILD program under test
		const source = [
			"const chunks: Buffer[] = [];",
			"process.stdin.on('data', (c: Buffer) => chunks.push(c));",
			"process.stdin.on('end', () => {",
			"  const parsed = JSON.parse(Buffer.concat(chunks).toString());",
			"  console.log(`${parsed.status}:${parsed.conclusion ?? 'none'}`);",
			"});",
		].join("\n");
		// biome-ignore-end lint/suspicious/noTemplateCurlyInString: child program ends
		const result = await defaultCanonicalizerRunner(
			source,
			'{"status":"completed","conclusion":"success","updatedAt":"2026-07-20T20:00:00Z"}',
		);
		expect(result).toEqual({ ok: true, state: "completed:success" });
	});

	it("surfaces a broken program as an error, not silence", async () => {
		const result = await defaultCanonicalizerRunner(
			"throw new Error('boom')",
			"raw",
		);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("boom");
	});
});
