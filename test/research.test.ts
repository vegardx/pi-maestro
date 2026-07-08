// The research fan-out and the readiness gate, against a fake subagents
// capability and a fake ask surface: parallel spawn shapes, report
// persistence with frontmatter, timeout stops, and the phase flip.

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
	createReadinessTool,
	createResearchTool,
	type ResearchDeps,
	renderPlanOutline,
	researchLabel,
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
) {
	const calls: SpawnCall[] = [];
	const stopped: string[] = [];
	return {
		calls,
		stopped,
		capability: {
			spawn(prompt: string, profile: SpawnProfile): RunHandle {
				const call = { prompt, profile };
				calls.push(call);
				const n = calls.length;
				const id = `run-${n}` as RunId;
				return {
					id,
					status: () => "running" as const,
					steer: () => {},
					stop: () => {
						stopped.push(id);
					},
					result: () => result(call, n),
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
): { deps: ResearchDeps; planDir: string; engine: PlanEngine } {
	const planDir = mkdtempSync(join(tmpdir(), "research-"));
	const engine = overrides.engine?.() ?? engineWithPlan();
	const deps: ResearchDeps = {
		engine: () => engine,
		ask: () => undefined,
		ensurePlanDir: () => planDir,
		researchToolsPath: () => "/maestro/packages/research-tools/src/index.ts",
		...overrides,
	};
	return { deps, planDir, engine };
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
	it("fans out one agent per question and persists reports", async () => {
		const { calls, capability } = fakeCapability(async (call) => ({
			status: "succeeded",
			summary: `Answer about: ${call.prompt.split("\n")[2]}`,
		}));
		const { deps, planDir } = makeDeps({ subagents: () => capability });
		const tool = createResearchTool(deps);

		const result = await run(tool, {
			questions: [
				{ question: "What TUI library does pi use?", kind: "codebase" },
				{ question: "How does Exa deep search work?", kind: "web" },
			],
		});

		expect(calls).toHaveLength(2);
		// Codebase agent: read-only tools, no web.
		expect(calls[0].profile.tools?.allow).not.toContain("websearch");
		// Web agent: read-only + web tools, research-tools loaded via -e.
		expect(calls[1].profile.tools?.allow).toContain("websearch");
		expect(calls[1].profile.profile).toBe("research");
		expect(calls[1].profile.extraExtensions).toEqual([
			"/maestro/packages/research-tools/src/index.ts",
		]);
		expect(calls[1].prompt).toContain("How does Exa deep search work?");

		// Reports persisted with frontmatter, numbered in order.
		const files = readdirSync(join(planDir, "research")).sort();
		expect(files).toHaveLength(2);
		expect(files[0]).toMatch(/^01-/);
		expect(files[1]).toMatch(/^02-/);
		const first = readFileSync(join(planDir, "research", files[0]), "utf8");
		expect(first).toContain("question:");
		expect(first).toContain("kind:");
		expect(first).toContain("Answer about:");

		const text = result.content[0].text;
		expect(text).toContain("What TUI library does pi use?");
		expect(text).toContain("Evaluate:");
	});

	it("reports failures without persisting and keeps other answers", async () => {
		const { capability } = fakeCapability(async (_call, n) =>
			n === 1
				? { status: "failed", error: "child exploded" }
				: { status: "succeeded", summary: "fine" },
		);
		const { deps, planDir } = makeDeps({ subagents: () => capability });
		const result = await run(createResearchTool(deps), {
			questions: [{ question: "will fail" }, { question: "will pass" }],
		});
		const text = result.content[0].text;
		expect(text).toContain("child exploded");
		expect(text).toContain("fine");
		const files = existsSync(join(planDir, "research"))
			? readdirSync(join(planDir, "research"))
			: [];
		expect(files).toHaveLength(1);
	});

	it("stops runs that exceed the timeout", async () => {
		const { capability, stopped } = fakeCapability(
			() => new Promise<never>(() => {}),
		);
		const { deps } = makeDeps({
			subagents: () => capability,
			timeoutMs: () => 20,
		});
		const result = await run(createResearchTool(deps), {
			questions: [{ question: "hangs forever" }],
		});
		expect(result.content[0].text).toContain("timed out");
		expect(stopped).toEqual(["run-1"]);
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
			resolveAdvisorModel: async () => "other/model-x",
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
			resolveAdvisorModel: async () => "other/model-x",
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
