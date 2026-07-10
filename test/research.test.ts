// The research fan-out and the readiness gate, against a fake subagents
// capability and a fake ask surface: parallel spawn shapes, digest delivery
// with full reports in session scratch, the dig tool, timeout stops, and the
// phase flip.

import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	Answers,
	Questionnaire,
	RunHandle,
	RunId,
	RunResult,
	SpawnProfile,
} from "@vegardx/pi-contracts";
import { describe, expect, it } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
import {
	createDigTool,
	createReadinessTool,
	createResearchTool,
	extractDigest,
	type ResearchDeps,
	renderPlanOutline,
	researchLabel,
	researchScratchDir,
} from "../packages/modes/src/research.js";
import type { Plan } from "../packages/modes/src/schema.js";
import { planPhase } from "../packages/modes/src/schema.js";
import type { PlanStore } from "../packages/modes/src/storage.js";

const ctx = {} as ExtensionContext;

function memStore(): PlanStore {
	let saved: Plan | null = null;
	return {
		root: "/tmp/plans",
		save(plan: Plan) {
			saved = plan;
		},
		load: () => saved,
		exists: () => saved !== null,
		remove: () => {
			saved = null;
		},
		list: () => [],
	};
}

function engineWithPlan(): PlanEngine {
	return PlanEngine.create(memStore(), {
		slug: "research-plan",
		title: "Research Plan",
		repoPath: "/repo",
	});
}

interface SpawnCall {
	prompt: string;
	profile: SpawnProfile;
}

function fakeCapability(
	result: (call: SpawnCall, n: number) => Promise<RunResult>,
	handleExtras: Partial<Pick<RunHandle, "lastEventAt" | "partialText">> = {},
) {
	const calls: SpawnCall[] = [];
	const stopped: string[] = [];
	const steers: string[] = [];
	return {
		calls,
		stopped,
		steers,
		capability: {
			spawn(prompt: string, profile: SpawnProfile): RunHandle {
				const call = { prompt, profile };
				calls.push(call);
				const n = calls.length;
				const id = `run-${n}` as RunId;
				return {
					id,
					status: () => "running" as const,
					steer: (guidance: string) => {
						steers.push(guidance);
					},
					stop: () => {
						stopped.push(id);
					},
					result: () => result(call, n),
					...handleExtras,
				};
			},
			get: () => undefined,
			list: () => [],
			steer: () => {},
			stop: () => {},
		},
	};
}

function makeDeps(
	overrides: Partial<ResearchDeps> & Pick<ResearchDeps, "subagents">,
): {
	deps: ResearchDeps;
	planDir: string;
	scratchDir: string;
	engine: PlanEngine;
} {
	const planDir = mkdtempSync(join(tmpdir(), "research-"));
	// Isolate the scratch dir per test by pinning the session dir env.
	process.env.PI_CODING_AGENT_SESSION_DIR = mkdtempSync(
		join(tmpdir(), "research-session-"),
	);
	const engine = overrides.engine?.() ?? engineWithPlan();
	const deps: ResearchDeps = {
		engine: () => engine,
		ask: () => undefined,
		ensurePlanDir: () => planDir,
		researchToolsPath: () => "/maestro/packages/research-tools/src/index.ts",
		...overrides,
	};
	return {
		deps,
		planDir,
		scratchDir: researchScratchDir(engine.get().slug),
		engine,
	};
}

type Executable = {
	execute(
		id: string,
		params: unknown,
		signal?: undefined,
		onUpdate?: undefined,
		ctx?: ExtensionContext,
	): Promise<{ content: [{ type: "text"; text: string }] }>;
};

async function run(
	tool: ReturnType<typeof createResearchTool>,
	params: unknown,
) {
	return (tool as unknown as Executable).execute(
		"call-1",
		params,
		undefined,
		undefined,
		ctx,
	);
}

describe("research tool", () => {
	it("fans out one agent per question, writes full reports to scratch, delivers digests", async () => {
		const { calls, capability } = fakeCapability(async (call) => {
			const q = call.prompt.split("\n")[2];
			return {
				status: "succeeded",
				summary: `Full detail about ${q}, lots of it.\n\n## Digest\nDIGEST for ${q}`,
			};
		});
		const { deps, scratchDir } = makeDeps({ subagents: () => capability });
		const tool = createResearchTool(deps);

		const result = await run(tool, {
			questions: [
				{ question: "What TUI library does pi use?", kind: "codebase" },
				{ question: "How does Exa deep search work?", kind: "web" },
			],
		});

		expect(calls).toHaveLength(2);
		expect(calls[0].profile.tools?.allow).not.toContain("websearch");
		expect(calls[1].profile.tools?.allow).toContain("websearch");
		expect(calls[1].profile.profile).toBe("research");
		expect(calls[1].prompt).toContain("How does Exa deep search work?");

		// FULL reports land in the session scratch (by ref), with frontmatter.
		const files = readdirSync(scratchDir).sort();
		expect(files).toHaveLength(2);
		const first = readFileSync(join(scratchDir, files[0]), "utf8");
		expect(first).toContain("ref:");
		expect(first).toContain("Full detail about");

		// The DELIVERY carries only digests + refs + the dig hint — never the
		// full report text.
		const text = result.content[0].text;
		expect(text).toContain("DIGEST for");
		expect(text).toContain("[ref:");
		expect(text).toContain("dig(");
		expect(text).not.toContain("lots of it");
	});

	it("reports failures without persisting and keeps the passing digest", async () => {
		const { capability } = fakeCapability(async (_call, n) =>
			n === 1
				? { status: "failed", error: "child exploded" }
				: { status: "succeeded", summary: "ok\n\n## Digest\nfine" },
		);
		const { deps, scratchDir } = makeDeps({ subagents: () => capability });
		const result = await run(createResearchTool(deps), {
			questions: [{ question: "will fail" }, { question: "will pass" }],
		});
		const text = result.content[0].text;
		expect(text).toContain("child exploded");
		expect(text).toContain("fine");
		const files = existsSync(scratchDir) ? readdirSync(scratchDir) : [];
		expect(files).toHaveLength(1); // only the passing report persisted
	});

	it("dig returns the full report for a ref, and errors on an unknown ref", async () => {
		const { capability } = fakeCapability(async () => ({
			status: "succeeded",
			summary: "The whole detailed analysis.\n\n## Digest\nshort answer",
		}));
		const { deps } = makeDeps({ subagents: () => capability });
		await run(createResearchTool(deps), {
			questions: [{ question: "What storage does pi use?" }],
		});
		const dig = createDigTool(deps);
		const good = await run(dig, { ref: "what-storage-does-pi-use" });
		expect(good.content[0].text).toContain("The whole detailed analysis.");
		const bad = await run(dig, { ref: "no-such-ref" });
		expect(bad.content[0].text).toContain("no research report");
		expect(bad.content[0].text).toContain("what-storage-does-pi-use"); // lists available
	});

	it("watchdog: kills a stalled run (event silence) and salvages partial text", async () => {
		// No lastEventAt override → the handle looks silent since spawn, so the
		// stall threshold fires. partialText is what the child had written.
		const { capability, stopped } = fakeCapability(
			() => new Promise<never>(() => {}),
			{ partialText: async () => "Found half the answer so far." },
		);
		const { deps } = makeDeps({
			subagents: () => capability,
			watchdog: () => ({
				stallMs: 30,
				softMs: 5_000,
				hardMs: 10_000,
				pollMs: 5,
			}),
		});
		const result = await run(createResearchTool(deps), {
			questions: [{ question: "hangs forever" }],
		});
		const text = result.content[0].text;
		expect(stopped).toEqual(["run-1"]);
		expect(text).toContain("stalled");
		expect(text).toContain("partial findings salvaged");
		expect(text).toContain("Found half the answer so far.");
	});

	it("watchdog: steers a slow-but-active run to wrap up instead of killing it", async () => {
		// lastEventAt: now → always active, so no stall. The run finishes on its
		// own after the soft deadline steered it.
		let resolveRun: (r: RunResult) => void = () => {};
		const settled = new Promise<RunResult>((r) => {
			resolveRun = r;
		});
		const { capability, stopped, steers } = fakeCapability(() => settled, {
			lastEventAt: () => Date.now(),
		});
		const { deps } = makeDeps({
			subagents: () => capability,
			watchdog: () => ({
				stallMs: 5_000,
				softMs: 20,
				hardMs: 10_000,
				pollMs: 5,
			}),
		});
		const pending = run(createResearchTool(deps), {
			questions: [{ question: "slow but productive" }],
		});
		// Give the watchdog time to fire the wrap-up steer, then finish the run.
		await new Promise((r) => setTimeout(r, 60));
		expect(steers.length).toBe(1);
		expect(steers[0]).toContain("Stop researching NOW");
		resolveRun({
			status: "succeeded",
			summary: "Full findings.\n\n## Digest\nwrapped up in time",
		});
		const result = await pending;
		expect(result.content[0].text).toContain("wrapped up in time");
		expect(stopped).toEqual([]); // never killed
	});

	it("watchdog: hard cap stops a run that stays active but never converges", async () => {
		const { capability, stopped, steers } = fakeCapability(
			() => new Promise<never>(() => {}),
			{
				lastEventAt: () => Date.now(), // always active → stall never fires
				partialText: async () => "Kept looping over the same ground.",
			},
		);
		const { deps } = makeDeps({
			subagents: () => capability,
			watchdog: () => ({ stallMs: 10_000, softMs: 20, hardMs: 60, pollMs: 5 }),
		});
		const result = await run(createResearchTool(deps), {
			questions: [{ question: "loops forever" }],
		});
		const text = result.content[0].text;
		expect(steers.length).toBe(1); // wrap-up steer came first
		expect(stopped).toEqual(["run-1"]);
		expect(text).toContain("hard cap");
		expect(text).toContain("Kept looping over the same ground.");
	});

	it("advisor gets the plan outline, high thinking, and the alternate model", async () => {
		const { calls, capability } = fakeCapability(async () => ({
			status: "succeeded",
			summary: "looks risky",
		}));
		const engine = engineWithPlan();
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		engine.addWorkItem("auth", { title: "add login", body: "src/auth.ts" });
		const { deps } = makeDeps({
			subagents: () => capability,
			engine: () => engine,
			resolveTierModel: async () => "other/model-x",
		});
		await run(createResearchTool(deps), {
			questions: [{ question: "poke holes in this plan", kind: "advisor" }],
		});
		expect(calls[0].profile.model).toBe("other/model-x");
		expect(calls[0].profile.thinking).toBe("high");
		expect(calls[0].prompt).toContain("Draft Plan Under Review");
		expect(calls[0].prompt).toContain("add login");
	});

	it("consult runs unbiased on the alternate model with plan context", async () => {
		const { calls, capability } = fakeCapability(async () => ({
			status: "succeeded",
			summary: "go with option B\nRECOMMENDATION: B",
		}));
		const engine = engineWithPlan();
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		engine.addWorkItem("auth", { title: "add login", body: "src/auth.ts" });
		const { deps } = makeDeps({
			subagents: () => capability,
			engine: () => engine,
			resolveTierModel: async () => "other/model-x",
		});
		await run(createResearchTool(deps), {
			questions: [
				{ question: "A: cookie vs B: JWT — which?", kind: "consult" },
			],
		});
		expect(calls[0].profile.model).toBe("other/model-x");
		expect(calls[0].profile.thinking).toBe("high");
		// Gets whole-plan context but is told the preference was withheld.
		expect(calls[0].prompt).toContain("Plan Context");
		expect(calls[0].profile.appendSystemPrompt).toContain("WITHHELD");
	});

	it("non-blocking: returns immediately, delivers the whole round as a follow-up", async () => {
		const { capability } = fakeCapability(async () => ({
			status: "succeeded",
			summary: "the answer",
		}));
		const delivered: string[] = [];
		const { deps } = makeDeps({
			subagents: () => capability,
			deliver: (t) => delivered.push(t),
		});
		const result = await run(createResearchTool(deps), {
			questions: [{ question: "q1" }, { question: "q2" }],
		});
		// Returns immediately with a "started" ack — not the reports.
		expect(result.content[0].text).toContain("Started 2 research agent");
		expect(result.content[0].text).not.toContain("the answer");
		// The whole round is delivered together, once, after settlement.
		await new Promise((r) => setImmediate(r));
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toContain("Research round complete");
		expect(delivered[0]).toContain("the answer");
		expect(delivered[0]).toContain("Evaluate:");
	});

	it("serializes: refuses a second round while one is in flight", async () => {
		const { capability } = fakeCapability(
			() => new Promise<never>(() => {}), // never settles
		);
		const { deps } = makeDeps({
			subagents: () => capability,
			deliver: () => {},
		});
		const tool = createResearchTool(deps);
		await run(tool, { questions: [{ question: "q1" }] });
		const second = await run(tool, { questions: [{ question: "q2" }] });
		expect(second.content[0].text).toContain("already running");
	});
});

describe("readiness tool", () => {
	function askReturning(value: string) {
		const asked: Questionnaire[] = [];
		return {
			asked,
			ask: {
				ask: async (q: Questionnaire): Promise<Answers> => {
					asked.push(q);
					return [{ questionId: q[0].id, value }];
				},
				queue: () => {},
				post: () => {},
				pending: () => [],
			},
		};
	}

	it("flips to structuring when the user confirms", async () => {
		const { capability } = fakeCapability(async () => ({
			status: "succeeded" as const,
		}));
		const { asked, ask } = askReturning("form");
		let phaseChanged = 0;
		const { deps, engine } = makeDeps({
			subagents: () => capability,
			ask: () => ask,
			onPhaseChanged: () => {
				phaseChanged++;
			},
		});
		const result = await run(createReadinessTool(deps) as never, {
			understanding: "We build a clamp helper with tests.",
			open_risks: "None worth noting.",
		});
		expect(asked[0][0].question).toMatch(/Ready to form the plan/);
		expect(asked[0][0].context).toContain("clamp helper");
		expect(asked[0][0].context).toContain("Open risks");
		expect(planPhase(engine.get())).toBe("structuring");
		expect(engine.get().understanding).toBe(
			"We build a clamp helper with tests.",
		);
		expect(phaseChanged).toBe(1);
		expect(result.content[0].text).toContain("unlocked");
	});

	it("stays exploring when the user declines, relaying guidance", async () => {
		const { capability } = fakeCapability(async () => ({
			status: "succeeded" as const,
		}));
		const { ask } = askReturning("also check the auth flow");
		const { deps, engine } = makeDeps({
			subagents: () => capability,
			ask: () => ask,
		});
		const result = await run(createReadinessTool(deps) as never, {
			understanding: "half-baked",
		});
		expect(planPhase(engine.get())).toBe("exploring");
		expect(result.content[0].text).toContain("also check the auth flow");
	});
});

describe("helpers", () => {
	it("researchLabel slugs to at most four words", () => {
		expect(researchLabel("How do competing TUI libs handle resize?")).toBe(
			"how-do-competing-tui",
		);
		expect(researchLabel("!!!")).toBe("research");
	});

	it("extractDigest prefers the ## Digest block, falls back to first para, caps length", () => {
		expect(extractDigest("Full working here.\n\n## Digest\nThe answer.")).toBe(
			"The answer.",
		);
		// No Digest block → first paragraph.
		expect(extractDigest("First para.\n\nSecond para.")).toBe("First para.");
		// Over-long digest is hard-capped with an ellipsis.
		const long = extractDigest(`## Digest\n${"x".repeat(800)}`);
		expect(long.length).toBeLessThanOrEqual(500);
		expect(long.endsWith("…")).toBe(true);
	});

	it("renderPlanOutline includes deliverables, tasks, and understanding", () => {
		const engine = engineWithPlan();
		engine.setPhase("exploring", "Build clamp.");
		engine.addDeliverable({ title: "Clamp", workerMode: "full" });
		engine.addWorkItem("clamp", { title: "implement", body: "src/clamp.ts" });
		const outline = renderPlanOutline(engine.get());
		expect(outline).toContain("Build clamp.");
		expect(outline).toContain("deliverable clamp");
		expect(outline).toContain("implement — src/clamp.ts");
	});
});
