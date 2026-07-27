// /resume is ONE verb over two disjoint populations. The merge is not a union:
// PARKED work is active-but-stopped and resumes from its own session, READY work
// is still planned and activates fresh. tick() cannot do the former — advanceNode
// early-returns on any blocked node, and parked nodes are always blocked — so
// each population needs its own primitive.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const context = source("packages/modes/src/runtime/context.ts");
const commands = source("packages/modes/src/runtime/commands.ts");

/** The runResume member body, bounded by the next member at the same indent. */
const runResume = (() => {
	const from = context.indexOf("async runResume(");
	expect(from).toBeGreaterThan(-1);
	const rest = context.slice(from);
	const end = rest.indexOf("\n\t\t},");
	return end === -1 ? rest : rest.slice(0, end);
})();

describe("/resume covers both populations", () => {
	it("resumes parked workers with the per-node resume primitive", () => {
		expect(runResume).toContain("restartWorkerResume");
	});

	it("activates newly ready planned work with a tick", () => {
		expect(runResume).toContain("readyChildren");
		expect(runResume).toContain("execution.tick(");
	});

	it("rebuilds the adapter before resuming — a stopped one is terminal", () => {
		expect(runResume).toContain("rt.execution?.destroy()");
		expect(runResume).toContain("ensureExecution");
	});
});

describe("/resume preconditions", () => {
	it("requires a formed plan and names the verb that forms one", () => {
		// Running is not authoring: /resume must not silently form a plan the
		// user never saw. This is the ruling that split /form out in the first
		// place, so it is worth pinning.
		expect(runResume).toContain("No plan has been formed");
		expect(runResume).toContain("/form");
	});

	it("refuses an unproven stop and routes to /recover", () => {
		// Ported from runRestart: an un-ACKed worker means we do not know what it
		// was doing, so resuming blind would build on that uncertainty.
		expect(runResume).toContain('stop.kind === "failed"');
		expect(runResume).toContain('stop.outcome === "timed-out"');
		expect(runResume).toContain("/recover");
	});

	it("refuses to launch execution from inside a subagent", () => {
		expect(runResume).toContain("isAgentMode()");
	});

	it("asks about an unreviewed plan", () => {
		expect(runResume).toContain("confirmUnreviewedPlan");
	});
});

describe("the review-skip ask", () => {
	const confirm = (() => {
		const from = context.indexOf("async function confirmUnreviewedPlan(");
		expect(from).toBeGreaterThan(-1);
		const rest = context.slice(from);
		const end = rest.search(/\n\t\}[,\n]/);
		return end === -1 ? rest : rest.slice(0, end);
	})();

	it("compares the live plan against the last reviewed fingerprint", () => {
		expect(confirm).toContain("lastReviewedFingerprint(plan)");
		expect(confirm).toContain("planFingerprint(plan)");
	});

	it("proceeds silently when the reviewed plan is what will run", () => {
		expect(confirm).toContain(
			"if (reviewed === planFingerprint(plan)) return true",
		);
	});

	it("never blocks execution just because no ask surface exists", () => {
		// Opt-in review must not become a hard dependency on the ask capability.
		expect(confirm).toContain("starting anyway");
	});

	it("stops after reviewing, leaving the run decision to the next /resume", () => {
		expect(confirm).toContain("await runReview(ctx)");
		expect(confirm).toContain("Nothing started");
	});
});

describe("/resume honors a repaired node's restart mode", () => {
	it("restarts fresh instead of resuming a superseded session", () => {
		// A clarifyTask repair rewrote the brief, so the worker's transcript is
		// wrong. Resuming it would continue from a spec that no longer exists.
		expect(runResume).toContain('node.restartMode === "fresh"');
		expect(runResume).toContain("restartWorkerFresh");
	});

	it("consumes the flag so later resumes keep their context", () => {
		expect(runResume).toContain("clearRestartMode");
	});
});

describe("the command surface", () => {
	it("registers /resume and keeps /start as an alias", () => {
		expect(commands).toContain('pi.registerCommand("resume"');
		expect(commands).toContain('pi.registerCommand("start"');
	});

	it("registers both as literals so check-docs can see them", () => {
		// A loop variable is invisible to the docs scanner — that is exactly how
		// /auto and /hack stayed undocumented for so long.
		expect(commands).not.toContain('for (const name of ["resume", "start"]');
	});

	it("no longer registers /restart — /resume folds it in", () => {
		expect(commands).not.toContain('pi.registerCommand("restart"');
	});

	it("leaves /stop and /recover alone", () => {
		expect(commands).toContain('pi.registerCommand("stop"');
		expect(commands).toContain('pi.registerCommand("recover"');
	});
});
