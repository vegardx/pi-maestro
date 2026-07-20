// The carry-forward curation engine: mechanical inventory, document assembly,
// the transcript digest, and the episode tool's propose → curate → write →
// sink state machine (with the same completeness discipline as the review
// ledger: selected ids must be covered, unselected degrade to radar).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Answers, Question } from "@vegardx/pi-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
	assembleCarryDocument,
	buildTranscriptDigest,
	type CarryEpisode,
	CarryForwardController,
	createCarryForwardTool,
	harvestInventory,
	writeCarryDocument,
} from "../packages/modes/src/carry-forward.js";
import type { PlanV2 } from "../packages/modes/src/plan/schema.js";

const NOW = "2026-07-12T12:00:00.000Z";

function planFixture(): PlanV2 {
	return {
		schemaVersion: 6,
		slug: "arc-one",
		title: "Arc One",
		repoPath: "/repo",
		phase: "structuring",
		nodes: [
			{
				type: "node",
				id: "auth",
				agent: "worker",
				persona: "coder",
				title: "Auth",
				status: "active",
				branch: "feat/auth",
				authoredBy: "plan",
				tasks: [
					{
						id: "t1",
						title: "impl",
						body: "",
						done: true,
						createdAt: NOW,
						updatedAt: NOW,
					},
					{
						id: "t2",
						title: "test",
						body: "",
						done: false,
						createdAt: NOW,
						updatedAt: NOW,
					},
				],
				createdAt: NOW,
				updatedAt: NOW,
			},
		],
		createdAt: NOW,
		updatedAt: NOW,
	};
}

describe("harvestInventory", () => {
	it("carries plan state, gates, workers, questions, and disk refs", () => {
		const text = harvestInventory({
			plan: planFixture(),
			mode: "auto",
			workers: [{ agent: "auth", status: "working" }],
			blocked: [{ id: "auth", reason: "ship gate: 1 blocking finding open" }],
			pendingAsks: [{ question: "Which auth scheme?" }],
			planDir: "/plans/arc-one",
			listDir: (p) =>
				p.endsWith("research") ? ["01-oauth.md", "02-sessions.md"] : [],
		});
		expect(text).toContain("arc-one — Arc One");
		expect(text).toContain("auth [active] · tasks 1/2");
		expect(text).toContain("BLOCKED: ship gate");
		expect(text).toContain("Live workers: auth");
		expect(text).toContain("Which auth scheme?");
		expect(text).toContain("01-oauth, 02-sessions");
	});

	it("handles the no-plan case (handoff from a bare session)", () => {
		const text = harvestInventory({ mode: "plan" });
		expect(text).toContain("No active plan");
	});
});

describe("assembleCarryDocument", () => {
	const threads = [{ id: "a", title: "Thread A", body: "decisions…" }];
	const radar = [
		{
			id: "b",
			title: "Thread B",
			oneLiner: "parked",
			source: "transcript" as const,
		},
	];

	it("distill framing: the summary replaces the conversation", () => {
		const doc = assembleCarryDocument({
			kind: "distill",
			inventory: "Plan: x",
			threads,
			radar,
			now: NOW,
		});
		expect(doc).toContain("REPLACES the earlier conversation");
		expect(doc).toContain("dig(ref)");
		expect(doc).toContain("### Thread A");
		expect(doc).toContain("- Thread B — parked");
	});

	it("handoff framing: CONTEXT ONLY, next plan, old plan loadable", () => {
		const doc = assembleCarryDocument({
			kind: "handoff",
			inventory: "Plan: x",
			threads,
			radar: [],
			now: NOW,
			planSlug: "arc-one",
			divergenceNote: "drifted from X to Y",
		});
		expect(doc).toContain("CONTEXT ONLY");
		expect(doc).toContain("/plan arc-one");
		expect(doc).toContain("## Divergence note");
	});
});

describe("writeCarryDocument", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("numbers documents sequentially on disk", () => {
		dir = mkdtempSync(join(tmpdir(), "carry-test-"));
		const p1 = writeCarryDocument(dir, "distill", "one");
		const p2 = writeCarryDocument(dir, "handoff", "two");
		expect(p1).toContain("01-distill.md");
		expect(p2).toContain("02-handoff.md");
		expect(readFileSync(p2, "utf8")).toBe("two");
	});
});

describe("buildTranscriptDigest", () => {
	it("keeps user messages, assistant heads, and tool names", () => {
		const digest = buildTranscriptDigest([
			{ message: { role: "user", content: "Please fix the auth bug" } },
			{
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Working on it." },
						{ type: "toolCall", name: "edit" },
					],
				},
			},
			{ message: { role: "toolResult", content: "ignored wall of text" } },
		]);
		expect(digest).toContain("USER: Please fix the auth bug");
		expect(digest).toContain("ASSISTANT: Working on it. [tool:edit]");
		expect(digest).not.toContain("ignored wall");
	});

	it("caps the digest keeping both ends", () => {
		const entries = Array.from({ length: 400 }, (_, i) => ({
			message: {
				role: "user" as const,
				content: `msg ${i} ${"x".repeat(200)}`,
			},
		}));
		const digest = buildTranscriptDigest(entries);
		expect(digest.length).toBeLessThan(41_000);
		expect(digest).toContain("msg 0 ");
		expect(digest).toContain("msg 399 ");
		expect(digest).toContain("[… middle elided …]");
	});
});

// ─── The episode tool ────────────────────────────────────────────────────────

type Exec = {
	execute(
		id: string,
		params: unknown,
		signal?: undefined,
		onUpdate?: undefined,
		ctx?: ExtensionContext,
	): Promise<{ content: [{ type: "text"; text: string }] }>;
};

function toolFakes(opts: {
	episode?: Partial<CarryEpisode> & { kind: "distill" | "handoff" };
	selections?: string[];
	planDir?: string;
}) {
	const controller = new CarryForwardController();
	const sunk: Array<{ doc: string; path: string }> = [];
	const askedQuestions: Question[] = [];
	if (opts.episode) {
		controller.begin({
			selfCurate: false,
			sink: async (doc, path) => {
				sunk.push({ doc, path });
				return "sink ran";
			},
			...opts.episode,
		});
	}
	const tool = createCarryForwardTool({
		controller: () => controller,
		ask: () =>
			({
				ask: async (qs: readonly Question[]) => {
					askedQuestions.push(...qs);
					return (opts.selections ?? []).map((value) => ({
						questionId: qs[0].id,
						value,
					})) as Answers;
				},
				queue: () => {},
				post: () => {},
				pending: () => [],
			}) as never,
		inventory: () => "Plan: inventory-block",
		planDir: () => opts.planDir,
		planSlug: () => "arc-one",
		now: () => NOW,
	}) as unknown as Exec;
	const run = (params: unknown) =>
		tool.execute("c", params, undefined, undefined, {} as ExtensionContext);
	return { controller, tool, run, sunk, askedQuestions };
}

const TOPICS = [
	{
		id: "review-dogfood",
		title: "Reviewer dogfood",
		oneLiner: "needs a run",
		rec: true,
	},
	{ id: "crash-cause", title: "Crash cause", oneLiner: "trap armed" },
	{
		id: "option-c",
		title: "Verbosity C",
		oneLiner: "parked",
		source: "transcript",
	},
];

describe("carryforward tool", () => {
	let tmp: string | undefined;
	afterEach(() => {
		if (tmp) rmSync(tmp, { recursive: true, force: true });
		tmp = undefined;
	});

	it("refuses outside an episode", async () => {
		const { run } = toolFakes({});
		const res = await run({ action: "propose", topics: TOPICS });
		expect(res.content[0].text).toContain("No carry-forward episode");
	});

	it("interactive: multi-select ask, then write with completeness", async () => {
		tmp = mkdtempSync(join(tmpdir(), "carry-test-"));
		const { run, sunk, askedQuestions, controller } = toolFakes({
			episode: { kind: "distill" },
			selections: ["review-dogfood", "option-c"],
			planDir: tmp,
		});
		const proposed = await run({ action: "propose", topics: TOPICS });
		expect(askedQuestions[0].multiple).toBe(true);
		expect(askedQuestions[0].blocking).toBe(true);
		expect(proposed.content[0].text).toContain(
			"Selected: review-dogfood, option-c",
		);

		// Missing a selected id → rejected, nothing sunk.
		const incomplete = await run({
			action: "write",
			threads: [{ id: "review-dogfood", title: "t", body: "b" }],
		});
		expect(incomplete.content[0].text).toContain(
			"missing threads for: option-c",
		);
		expect(sunk).toHaveLength(0);

		const done = await run({
			action: "write",
			threads: [
				{ id: "review-dogfood", title: "Reviewer dogfood", body: "state…" },
				{ id: "option-c", title: "Verbosity C", body: "parked…" },
			],
		});
		expect(done.content[0].text).toBe("sink ran");
		expect(sunk).toHaveLength(1);
		// Unselected topic degraded to radar; inventory always carried.
		expect(sunk[0].doc).toContain("- Crash cause — trap armed");
		expect(sunk[0].doc).toContain("Plan: inventory-block");
		expect(sunk[0].path).toContain("01-distill.md");
		// Episode ended before the sink ran.
		expect(controller.get()).toBeUndefined();
	});

	it("self-curated (forced): rec topics carry without asking", async () => {
		tmp = mkdtempSync(join(tmpdir(), "carry-test-"));
		const { run, askedQuestions } = toolFakes({
			episode: { kind: "distill", selfCurate: true },
			planDir: tmp,
		});
		const res = await run({ action: "propose", topics: TOPICS });
		expect(askedQuestions).toHaveLength(0);
		expect(res.content[0].text).toContain(
			"your recommendations carry: review-dogfood",
		);
	});

	it("deferred/empty selection defaults to the recommendations", async () => {
		tmp = mkdtempSync(join(tmpdir(), "carry-test-"));
		const { run } = toolFakes({
			episode: { kind: "handoff" },
			selections: [],
			planDir: tmp,
		});
		const res = await run({ action: "propose", topics: TOPICS });
		expect(res.content[0].text).toContain("defaulting to: review-dogfood");
	});

	it("write before propose is rejected", async () => {
		const { run } = toolFakes({ episode: { kind: "distill" } });
		const res = await run({
			action: "write",
			threads: [{ id: "x", title: "t", body: "b" }],
		});
		expect(res.content[0].text).toContain("Propose first");
	});
});
