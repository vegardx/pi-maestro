// Theme-leaders remediation: leader election, follower edges, and reopening
// failed deliverables with their findings as gating tasks.

import { describe, expect, it } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
import {
	applyRemediation,
	planRemediationWaves,
	renderRemediation,
} from "../packages/modes/src/exec/remediate.js";
import type {
	StructuredFinding,
	VerifyEntry,
} from "../packages/modes/src/exec/verify.js";
import type { Plan } from "../packages/modes/src/schema.js";
import type { PlanStore } from "../packages/modes/src/storage.js";

function memStore(): PlanStore {
	let saved: Plan | null = null;
	return {
		root: "/tmp/plans",
		save(plan: Plan) {
			saved = plan;
		},
		load: () => saved,
		exists: () => saved !== null,
		remove() {
			saved = null;
		},
		list: () => [],
	};
}

function finding(
	category: string,
	overrides: Partial<StructuredFinding> = {},
): StructuredFinding {
	return {
		id: "F1",
		severity: "major",
		category,
		actual: `${category} is broken`,
		...overrides,
	};
}

function failEntry(id: string, findings: StructuredFinding[]): VerifyEntry {
	return {
		id,
		title: id,
		status: "shipped",
		verdict: "fail",
		findings: [],
		structured: findings,
		problems: [],
		facts: [],
	};
}

describe("planRemediationWaves", () => {
	it("elects the most-affected deliverable per theme; followers get edges", () => {
		const plan = planRemediationWaves([
			failEntry("ask-slice", [
				finding("packaging"),
				finding("packaging", { id: "F2" }),
			]),
			failEntry("review-plugin", [finding("packaging")]),
			failEntry("ui-plugin", [finding("packaging")]),
		]);
		expect(plan.leaders.get("packaging")).toBe("ask-slice");
		expect(plan.edges.get("review-plugin")).toEqual(["ask-slice"]);
		expect(plan.edges.get("ui-plugin")).toEqual(["ask-slice"]);
		expect(plan.edges.has("ask-slice")).toBe(false);
	});

	it("a single-deliverable category is not a theme; uncategorized never is", () => {
		const plan = planRemediationWaves([
			failEntry("a", [finding("correctness-bug")]),
			failEntry("b", [finding("uncategorized")]),
			failEntry("c", [finding("uncategorized")]),
		]);
		expect(plan.leaders.size).toBe(0);
		expect(plan.edges.size).toBe(0);
	});

	it("a deliverable that leads one theme never follows another", () => {
		const plan = planRemediationWaves([
			failEntry("parity", [
				finding("fake-verification"),
				finding("fake-verification", { id: "F2" }),
				finding("packaging"),
			]),
			failEntry("release", [finding("fake-verification")]),
			failEntry("ask", [
				finding("packaging"),
				finding("packaging", { id: "F2" }),
				finding("packaging", { id: "F3" }),
			]),
		]);
		expect(plan.leaders.get("fake-verification")).toBe("parity");
		expect(plan.leaders.get("packaging")).toBe("ask");
		// parity leads fake-verification → wave 1, despite its packaging finding.
		expect(plan.edges.has("parity")).toBe(false);
		expect(plan.edges.get("release")).toEqual(["parity"]);
	});
});

function engineWithShipped(ids: string[]): PlanEngine {
	const engine = PlanEngine.create(memStore(), {
		slug: "remediate",
		title: "Remediate",
		repoPath: "/repo",
	});
	for (const id of ids) {
		engine.addDeliverable({ title: id, workerMode: "full" });
		const task = engine.addWorkItem(id, { title: "original work" });
		engine.toggleWorkItem(id, task.id);
		engine.updateDeliverable(id, { prNumber: 1, prUrl: `https://x/pr/1` });
		engine.setDeliverableStatus(id, "active");
		engine.setDeliverableStatus(id, "complete");
		engine.setDeliverableStatus(id, "shipped");
	}
	return engine;
}

describe("applyRemediation", () => {
	it("reopens failed deliverables to planned with findings as gating tasks", async () => {
		const engine = engineWithShipped(["ask", "review"]);
		const result = await applyRemediation(
			[
				failEntry("ask", [
					finding("packaging", {
						file: "package.json",
						line: 43,
						claim: "installable",
						actual: "file: dep on sibling repo",
					}),
					finding("packaging", { id: "F2" }),
				]),
				failEntry("review", [finding("packaging")]),
			],
			{ engine, prState: async () => "OPEN", round: 1, waves: true },
		);

		const wave1 = result.reopened.find((r) => r.id === "ask");
		const wave2 = result.reopened.find((r) => r.id === "review");
		expect(wave1?.wave).toBe(1);
		expect(wave2?.wave).toBe(2);
		expect(wave2?.leaders).toEqual(["ask"]);

		const plan = engine.get();
		const ask = plan.deliverables.find((g) => g.id === "ask");
		const review = plan.deliverables.find((g) => g.id === "review");
		// Both reopened to planned; the follower waits on its leader via the DAG.
		expect(ask?.status).toBe("planned");
		expect(review?.status).toBe("planned");
		expect(review?.dependsOn).toContain("ask");
		// Findings became gating tasks with the claim/actual in the body.
		const askTasks = ask?.tasks.filter((t) => !t.done) ?? [];
		expect(askTasks).toHaveLength(2);
		expect(askTasks[0].title).toContain("fix F1:");
		expect(askTasks[0].body).toContain("claimed: installable");
		expect(askTasks[0].body).toContain("package.json:43");
		expect(askTasks[0].body).toContain(
			"you establish the canonical packaging fix",
		);
		const reviewTask = review?.tasks.find((t) => !t.done);
		expect(reviewTask?.body).toContain('theme leader: "ask"');
		// Branch/PR fields survive for reuse.
		expect(ask?.prNumber).toBe(1);
		expect(ask?.branch).toBeTruthy();
	});

	it("skips non-fail verdicts and unknown deliverables", async () => {
		const engine = engineWithShipped(["open"]);
		const result = await applyRemediation(
			[
				failEntry("open", [finding("packaging")]),
				failEntry("ghost", [finding("packaging")]),
				{ ...failEntry("errored", []), verdict: "error" },
			],
			{ engine, prState: async () => "OPEN", waves: true },
		);
		expect(result.reopened.map((r) => r.id)).toEqual(["open"]);
		expect(result.skipped.map((s) => s.id)).toContain("ghost");
		expect(result.skipped.find((s) => s.id === "errored")?.reason).toContain(
			"verification error",
		);
	});

	it("a MERGED PR is skipped — same-branch rework cannot reach it", async () => {
		const engine = engineWithShipped(["merged"]);
		const result = await applyRemediation(
			[failEntry("merged", [finding("packaging")])],
			{ engine, prState: async () => "MERGED", waves: true },
		);
		expect(result.reopened).toHaveLength(0);
		expect(result.skipped[0].reason).toContain("PR #1 is MERGED");
		expect(engine.get().deliverables[0].status).toBe("shipped");
	});

	it("drops a leader edge that would cycle against the existing DAG", async () => {
		const engine = PlanEngine.create(memStore(), {
			slug: "cycles",
			title: "Cycles",
			repoPath: "/repo",
		});
		// leader already depends on follower: follower → leader edge would cycle.
		engine.addDeliverable({ title: "base", workerMode: "full" });
		engine.addDeliverable({
			title: "leader",
			workerMode: "full",
			dependsOn: ["base"],
		});
		for (const id of ["base", "leader"]) {
			const task = engine.addWorkItem(id, { title: "original work" });
			engine.toggleWorkItem(id, task.id);
			engine.setDeliverableStatus(id, "active");
			engine.setDeliverableStatus(id, "complete");
			engine.setDeliverableStatus(id, "shipped");
		}
		const result = await applyRemediation(
			[
				failEntry("leader", [
					finding("packaging"),
					finding("packaging", { id: "F2" }),
				]),
				failEntry("base", [finding("packaging")]),
			],
			{ engine, prState: async () => "OPEN", waves: true },
		);
		const base = result.reopened.find((r) => r.id === "base");
		expect(base?.wave).toBe(1); // edge base → leader dropped (cycle)
		expect(
			engine.get().deliverables.find((g) => g.id === "base")?.dependsOn ?? [],
		).not.toContain("leader");
	});

	it("waves: false reopens everything immediately with no edges", async () => {
		const engine = engineWithShipped(["a", "b"]);
		const result = await applyRemediation(
			[
				failEntry("a", [
					finding("packaging"),
					finding("packaging", { id: "F2" }),
				]),
				failEntry("b", [finding("packaging")]),
			],
			{ engine, prState: async () => "OPEN", waves: false },
		);
		expect(result.reopened.every((r) => r.wave === 1)).toBe(true);
		expect(
			engine.get().deliverables.find((g) => g.id === "b")?.dependsOn ?? [],
		).toEqual([]);
	});

	it("renderRemediation summarizes waves and skips", () => {
		const text = renderRemediation({
			reopened: [
				{ id: "ask", wave: 1, leaders: [], tasks: 2 },
				{ id: "review", wave: 2, leaders: ["ask"], tasks: 1 },
			],
			skipped: [{ id: "merged", reason: "PR #1 is MERGED" }],
		});
		expect(text).toContain("Wave 1 (now): ask (2 tasks)");
		expect(text).toContain("Wave 2 (auto, after ask): review (1 tasks)");
		expect(text).toContain("Skipped merged: PR #1 is MERGED");
	});
});
