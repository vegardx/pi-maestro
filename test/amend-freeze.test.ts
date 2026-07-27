// Amending a plan that has already started.
//
// The engine's freeze is per-node and status-based, but it had holes: persona,
// skills and ALL of updateTask were ungated, so you could silently change what a
// running worker was going to do — invisible until it behaved unexpectedly.
//
// The exempt case is deliberate: answering a question task is how a RUNNING
// worker's blocking question gets resolved.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlanEngine } from "../packages/modes/src/plan/engine.js";
import { planFingerprint } from "../packages/modes/src/plan/schema.js";
import { createPlanStore } from "../packages/modes/src/plan/storage.js";

const now = () => "2026-07-27T00:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

/** A saved plan with one worker deliverable holding one gating task. */
function planWith(status: "planned" | "active") {
	const root = mkdtempSync(join(tmpdir(), "amend-freeze-"));
	roots.push(root);
	const engine = PlanEngine.create(
		createPlanStore(root),
		{ slug: "demo", title: "Demo", repoPath: root },
		now,
	);
	const node = engine.addNode(null, {
		agent: "worker",
		persona: "coder",
		title: "Build it",
		tasks: ["do the thing"],
	});
	if (status === "active") engine.setNodeStatus(node.id, "active");
	return { engine, node };
}

describe("execution-shaping fields freeze once a node starts", () => {
	it("allows persona and skills while planned", () => {
		const { engine, node } = planWith("planned");
		expect(() =>
			engine.updateNode(node.id, { persona: "integrator" }),
		).not.toThrow();
		expect(() => engine.updateNode(node.id, { skills: ["x"] })).not.toThrow();
	});

	it("refuses persona on a started node", () => {
		// This is the hole: persona picks the role and preamble the NEXT spawn
		// runs with, so changing it mid-flight rewrites the worker's job silently.
		const { engine, node } = planWith("active");
		expect(() => engine.updateNode(node.id, { persona: "integrator" })).toThrow(
			/how a node runs/,
		);
	});

	it("refuses skills on a started node", () => {
		const { engine, node } = planWith("active");
		expect(() => engine.updateNode(node.id, { skills: ["x"] })).toThrow(
			/how a node runs/,
		);
	});

	it("still allows title and body on a started node", () => {
		// Deliberate: these do not change execution semantics for a running
		// agent's plan view.
		const { engine, node } = planWith("active");
		expect(() =>
			engine.updateNode(node.id, { title: "Renamed", body: "context" }),
		).not.toThrow();
	});
});

describe("task text freezes once a node starts", () => {
	it("refuses a title or body rewrite on a started node", () => {
		// Rewriting the spec behind a worker's back. The sanctioned channel is
		// applyTaskRepair — fingerprint-pinned, stopped-asserted, audited.
		const { engine, node } = planWith("active");
		const taskId = engine.get().nodes[0].tasks[0].id;
		expect(() => engine.updateTask(node.id, taskId, { title: "new" })).toThrow(
			/title or body/,
		);
		expect(() => engine.updateTask(node.id, taskId, { body: "new" })).toThrow(
			/title or body/,
		);
	});

	it("still accepts an answer on a started node", () => {
		// The exemption that matters: this is how a live worker's blocking
		// question gets resolved. Gating it would break the ask flow.
		const { engine, node } = planWith("active");
		const taskId = engine.get().nodes[0].tasks[0].id;
		expect(() =>
			engine.updateTask(node.id, taskId, { answer: "use postgres" }),
		).not.toThrow();
		const task = engine.get().nodes[0].tasks[0];
		expect(task.answer).toBe("use postgres");
		expect(task.done).toBe(true);
	});

	it("allows text edits while planned", () => {
		const { engine, node } = planWith("planned");
		const taskId = engine.get().nodes[0].tasks[0].id;
		expect(() =>
			engine.updateTask(node.id, taskId, { title: "new" }),
		).not.toThrow();
	});
});

describe("a repaired worker restarts fresh", () => {
	/** Stop-assert + repair one task's text on an active node. */
	function repairClarify() {
		const { engine, node } = planWith("active");
		const taskId = engine.get().nodes[0].tasks[0].id;
		engine.applyTaskRepair({
			baseFingerprint: planFingerprint(engine.get()),
			reason: "the task was ambiguous",
			operations: [
				{
					type: "clarifyTask",
					deliverableId: node.id,
					taskId,
					title: "do the thing, precisely",
				},
			],
			stoppedDeliverableIds: [node.id],
		});
		return { engine, node };
	}

	it("marks a clarified node for a fresh restart", () => {
		// Its transcript holds the OLD text, so resuming that session would
		// continue from a brief that no longer exists.
		const { engine, node } = repairClarify();
		expect(engine.get().nodes[0].restartMode).toBe("fresh");
		expect(node.id).toBeTruthy();
	});

	it("does NOT force fresh for an added corrective task", () => {
		// Adding work does not contradict the transcript, and a resume's kickoff
		// already tells the worker to re-read its tasks — so it keeps its context.
		const { engine, node } = planWith("active");
		engine.applyTaskRepair({
			baseFingerprint: planFingerprint(engine.get()),
			reason: "needs one more step",
			operations: [
				{
					type: "addCorrectiveTask",
					deliverableId: node.id,
					task: { id: "fix-1", title: "also handle NaN" },
				},
			],
			stoppedDeliverableIds: [node.id],
		});
		expect(engine.get().nodes[0].restartMode).toBeUndefined();
	});

	it("keeps the flag out of the fingerprint", () => {
		// restartMode is runtime bookkeeping. If it counted, a repair would look
		// like a plan change to the review-drift check.
		const { engine } = repairClarify();
		const withFlag = planFingerprint(engine.get());
		engine.clearRestartMode(engine.get().nodes[0].id);
		expect(planFingerprint(engine.get())).toBe(withFlag);
	});

	it("consumes the flag so only ONE restart is fresh", () => {
		const { engine } = repairClarify();
		const id = engine.get().nodes[0].id;
		engine.clearRestartMode(id);
		expect(engine.get().nodes[0].restartMode).toBeUndefined();
	});
});

describe("multiModal is authored intent, frozen once started", () => {
	it("is authorable and persisted", () => {
		const root = mkdtempSync(join(tmpdir(), "multimodal-"));
		roots.push(root);
		const engine = PlanEngine.create(
			createPlanStore(root),
			{ slug: "demo", title: "Demo", repoPath: root },
			now,
		);
		const node = engine.addNode(null, {
			agent: "reviewer",
			persona: "reviewer",
			title: "Security review",
			multiModal: true,
		});
		expect(engine.get().nodes[0].multiModal).toBe(true);
		expect(node.id).toBeTruthy();
	});

	it("is absent — not false — when not asked for", () => {
		// A plan that never mentions multi-modal should not carry the key at all;
		// it keeps plan.json honest about what the author actually said.
		const { engine } = planWith("planned");
		expect(engine.get().nodes[0].multiModal).toBeUndefined();
	});

	it("counts as a plan change for the review-drift check", () => {
		// It is authored content that changes what runs, so flipping it must NOT
		// look identical to the plan a reviewer already approved.
		const { engine, node } = planWith("planned");
		const before = planFingerprint(engine.get());
		engine.updateNode(node.id, { multiModal: true });
		expect(planFingerprint(engine.get())).not.toBe(before);
	});

	it("freezes once the node starts", () => {
		// It decides what the next spawn IS — one reviewer or several — so it
		// belongs with persona/skills, not with the freely-editable title/body.
		const { engine, node } = planWith("active");
		expect(() => engine.updateNode(node.id, { multiModal: true })).toThrow(
			/how a node runs/,
		);
	});
});
