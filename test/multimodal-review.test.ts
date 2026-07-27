// Multi-modal review: the plan asks, the reviewer fans out, the worker judges.
//
// The load-bearing property is NEUTRALITY. Severity, which family found a thing,
// and how many found it all anchor the worker before it has read the code — so
// none of them travel. That in turn forces real merging: passing three copies of
// one defect through would smuggle a frequency vote in by repetition.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const executor = source("packages/modes/src/plan/node-executor.ts");
const context = source("packages/modes/src/runtime/context.ts");
const preambles = source("packages/modes/src/runtime/preambles.ts");

/** The brief handed to a multi-modal reviewer. */
const brief = (() => {
	const from = executor.indexOf("function panelBrief(");
	expect(from).toBeGreaterThan(-1);
	return executor.slice(from);
})();

describe("the reviewer fans out, not the executor", () => {
	it("hands the reviewer a panel rather than spawning N sessions", () => {
		// One authored node stays one node. The reviewer spawns read-only
		// subagents itself, which the depth gate already permits.
		expect(executor).toContain("resolveReviewPanel");
		expect(brief).toContain('subagent(action="spawn"');
	});

	it("only fans out when the PLAN asked for it", () => {
		expect(executor).toContain(
			"node.multiModal && this.deps.resolveReviewPanel",
		);
	});

	it("needs more than one model to be a panel at all", () => {
		// A single slot is an ordinary review; saying so beats pretending three
		// models looked at it.
		expect(executor).toContain("panel.models.length > 1");
	});

	it("degrades to one honest review when the panel cannot resolve", () => {
		// A failed panel must not park the node — the review still happens.
		const guard = executor.slice(
			executor.indexOf("resolveReviewPanel(node)"),
			executor.indexOf("const spawned = await this.deps.spawnAgent"),
		);
		expect(guard).toContain("catch");
	});
});

describe("the panel is genuinely distinct families", () => {
	it("drops fallback and inherited slots", () => {
		// resolveModels returns a seat-fallback slot when every alias is struck.
		// Three copies of the seat is a fan-out that looks diverse and is not.
		const wiring = context.slice(context.indexOf("resolveReviewPanel: async"));
		expect(wiring.slice(0, 1400)).toContain('slot.source === "tier"');
	});

	it("is bounded by the agent's spread", () => {
		const wiring = context.slice(context.indexOf("resolveReviewPanel: async"));
		expect(wiring.slice(0, 1400)).toContain("spreadForAgent(ctx, node.agent)");
	});
});

describe("findings reach the worker neutral", () => {
	it("forbids severity", () => {
		expect(brief).toContain("No severity");
	});

	it("forbids attribution and counts", () => {
		// Knowing two models agreed would anchor the worker as surely as a
		// severity label would.
		expect(brief).toContain("No attribution, no counts");
	});

	it("requires merging, and biases against over-merging", () => {
		// Neutrality makes dedupe mandatory: repetition IS a count. But the
		// asymmetry matters — a near-duplicate is noise, a merged-away finding
		// is a defect that escapes.
		expect(brief).toContain("Merge duplicates");
		expect(brief).toContain("when unsure, keep both");
	});

	it("tolerates a dead slot without losing the round", () => {
		expect(brief).toContain("fails or times out");
	});

	it("warns off the node's agent type, which is not a subagent kind", () => {
		// Live drive: the reviewer passed kind:"reviewer" — the node's agent type,
		// not a registry kind — and got "Unknown agent registry entry". Opus
		// recovered by listing kinds; a weaker model would have stalled there.
		expect(brief).toContain("Unknown agent registry entry");
	});

	it("lists the kinds the registry actually publishes, not a copy", () => {
		// A list copied into a prompt drifts the moment the registry changes and
		// nothing catches it. These are injected, so they cannot.
		expect(brief).toContain("kinds.map");
		const wiring = context.slice(context.indexOf("resolveReviewPanel: async"));
		expect(wiring.slice(0, 1200)).toContain("CAPABILITIES.agents");
		expect(wiring.slice(0, 1200)).toContain(".kinds()");
	});
});

describe("the worker contract matches what it receives", () => {
	const start = preambles.indexOf("## Reviewing your own work");
	const episode = preambles.slice(
		start,
		preambles.indexOf("## Research reports", start),
	);

	it("tells the worker findings arrive neutral and it judges them", () => {
		expect(episode).toContain("no severity");
		expect(episode).toContain("Decide yourself which are real");
	});

	it("no longer gates resolutions on a severity the worker never gets", () => {
		// These read as instructions to sort by a label nobody attached.
		expect(episode).not.toContain("minors ONLY");
		expect(episode).not.toContain("blocking findings only");
	});

	it("still refuses silent omission, without the retired ledger", () => {
		// The completeness check lived in the gate that was retired; the
		// obligation it encoded does not need machinery to survive.
		expect(episode).toContain("say why not");
		expect(episode).toContain('Silence reads as "missed it"');
	});
});

describe("a support agent authored without tasks still gets a focus", () => {
	it("falls back to the title rather than opening on an empty section", () => {
		// Seen live: the reviewer was authored with its whole brief in the title
		// and zero tasks — legal, since only WORKER nodes need gating work — and
		// its "## Focus" rendered empty.
		const executorSrc = source("packages/modes/src/plan/node-executor.ts");
		const seed = executorSrc.slice(
			executorSrc.indexOf("private buildSeed("),
			executorSrc.indexOf("private nextConsumer("),
		);
		expect(seed).toContain("node.tasks.length === 0");
		expect(seed).toContain("node.title ?? node.id");
	});
});

describe("the review surface has no phantoms", () => {
	const policy = source("packages/modes/src/policy.ts");
	const hooks = source("packages/modes/src/runtime/hooks.ts");
	const registry = source("packages/subagents/src/registry.ts");

	it("stops granting `review`, a tool that does not exist", () => {
		// It was in AGENT_TOOL_NAMES and FULL_MODE_ENSURED_TOOLS, and the worker
		// preamble taught it in four places — but no tool named `review` is
		// defined anywhere. Its runtime went with PR #200. A live worker session
		// shows the result: it never called it, no error, review simply never
		// happened. Granting a name that resolves to nothing is how that hid.
		expect(policy).not.toContain('"review"');
		expect(hooks).not.toContain('\t"review",');
	});

	it("points the worker at the surface that does exist", () => {
		expect(preambles).toContain('subagent(action="spawn"');
		expect(preambles).not.toContain("review({resolutions");
	});

	it("keeps reviewing part of finishing", () => {
		// The machinery changed; the discipline did not.
		expect(preambles).toContain("PART of finishing");
	});

	it("reviewers report observations, not severities or verdicts", () => {
		// A label from the reviewer would anchor the owning agent before it has
		// looked — the same reason attribution and counts do not travel.
		expect(registry).toContain("Do NOT rate, rank or label importance");
		expect(registry).not.toContain("VERDICT: PASS or VERDICT: BLOCK; block");
	});
});
