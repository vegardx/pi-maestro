// PlanEngineV2 + v2 storage (cutover PR-4): the append-only discipline,
// write-ahead child appends, generalized lifecycle injection, the unchanged
// transition table, record operations, and the legacy-archive machinery.

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanEngineV2 } from "../packages/modes/src/plan/engine.js";
import { findNodeV2 } from "../packages/modes/src/plan/schema.js";
import {
	archiveLegacyPlans,
	createPlanStoreV2,
	legacyPlanSlugs,
	type PlanStoreV2,
} from "../packages/modes/src/plan/storage.js";

let root: string;
let store: PlanStoreV2;
let saves: number;

function engine(): PlanEngineV2 {
	const inner = createPlanStoreV2(root);
	saves = 0;
	store = {
		...inner,
		save(plan) {
			saves++;
			inner.save(plan);
		},
	};
	return PlanEngineV2.create(store, {
		slug: "p",
		title: "P",
		repoPath: "/repo",
		profile: "fable",
	});
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "plan-v2-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("authoring vs per-node freeze (evolve-in-place)", () => {
	it("full CRUD before execution; the FROZEN node's own mutations refuse after it starts", () => {
		const eng = engine();
		eng.addNode(null, { agent: "worker", persona: "coder", title: "Build" });
		eng.addNode(null, { agent: "worker", persona: "coder", title: "Docs" });
		eng.removeNode("docs");
		expect(eng.get().nodes.map((n) => n.id)).toEqual(["build"]);

		eng.setNodeStatus("build", "active");
		// New nodes are ALWAYS appendable (evolve-in-place) — no longer refused.
		eng.addNode(null, { agent: "worker", persona: "coder", title: "X" });
		expect(eng.get().nodes.map((n) => n.id)).toContain("x");
		// But the running node itself is frozen: not removable, structure locked.
		expect(() => eng.removeNode("build")).toThrow("build is active");
		expect(() => eng.updateNode("build", { after: ["x"] })).toThrow(
			"build is active",
		);
	});

	it("a still-planned node stays fully editable while a sibling runs", () => {
		const eng = engine();
		eng.addNode(null, { agent: "worker", persona: "coder", title: "Build" });
		eng.addNode(null, { agent: "worker", persona: "coder", title: "Docs" });
		eng.setNodeStatus("build", "active");
		// Per-node, not global: `docs` is planned, so its structure + tasks + a
		// gating task are all still legal even though `build` is active.
		eng.updateNode("docs", { after: ["build"] });
		expect(eng.get().nodes.find((n) => n.id === "docs")?.after).toEqual([
			"build",
		]);
		const task = eng.addTask("docs", { title: "write the guide" });
		expect(task.kind ?? "task").toBe("task");
		eng.removeTask("docs", task.id);
		eng.removeNode("docs");
		expect(eng.get().nodes.map((n) => n.id)).toEqual(["build"]);
	});

	it("a running node still accepts followup/manual tasks, not gating tasks", () => {
		const eng = engine();
		eng.addNode(null, { agent: "worker", persona: "coder", title: "Build" });
		eng.setNodeStatus("build", "active");
		const followup = eng.addTask("build", { title: "note", kind: "followup" });
		expect(followup.kind).toBe("followup");
		// A defaulted (gating) task, or an explicit gate, is refused on a live node.
		const defaulted = eng.addTask("build", { title: "auto-followup" });
		expect(defaulted.kind).toBe("followup");
		expect(() => eng.addTask("build", { title: "gate", kind: "task" })).toThrow(
			"build is active",
		);
	});

	it("appendChild is write-ahead and stamps provenance", () => {
		const eng = engine();
		eng.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "Build",
			envelope: { maxChildren: 2 },
		});
		eng.setNodeStatus("build", "active");
		const before = saves;
		const child = eng.appendChild(
			"build",
			{ agent: "worker", persona: "coder", title: "Candidate A" },
			"build",
		);
		expect(saves).toBe(before + 1); // committed to disk before any spawn
		expect(child).toMatchObject({
			authoredBy: "build",
			status: "planned",
		});
		expect(child.appendedAt).toBeDefined();
		// Persisted, not just in memory:
		const onDisk = JSON.parse(
			readFileSync(join(root, "p", "plan.json"), "utf8"),
		);
		expect(onDisk.nodes[0].children).toHaveLength(1);
	});

	it("enforces depth and envelope at append with steering-shaped errors", () => {
		const eng = engine();
		eng.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "L1",
			envelope: { maxChildren: 1 },
		});
		eng.setNodeStatus("l1", "active");
		eng.appendChild(
			"l1",
			{ agent: "worker", persona: "coder", title: "L2" },
			"l1",
		);
		expect(() =>
			eng.appendChild(
				"l1",
				{ agent: "worker", persona: "coder", title: "X" },
				"l1",
			),
		).toThrow("envelope cap 1");
		eng.appendChild(
			"l2",
			{ agent: "worker", persona: "coder", title: "L3" },
			"l2",
		);
		expect(() =>
			eng.appendChild(
				"l3",
				{ agent: "worker", persona: "coder", title: "L4" },
				"l3",
			),
		).toThrow("maximum depth");
	});

	it("post-start task appends are followup/manual only", () => {
		const eng = engine();
		eng.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "Build",
			tasks: ["implement"],
		});
		eng.setNodeStatus("build", "active");
		const task = eng.addTask("build", { title: "note from the field" });
		expect(task.kind).toBe("followup"); // the post-start default
		expect(() =>
			eng.addTask("build", { title: "sneaky gate", kind: "task" }),
		).toThrow("followup/manual");
	});
});

describe("lifecycle injection (generalized)", () => {
	it("worker with sibling deps gets preflight; consumed workers get postflight", () => {
		const eng = engine();
		eng.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "A",
			branch: "feat/a",
		});
		eng.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "B",
			after: ["a"],
			branch: "feat/b",
		});
		eng.setNodeStatus("a", "active");
		const a = findNodeV2(eng.get(), "a");
		// No sibling deps → no preflight; branch owner → postflight.
		expect(a?.tasks.map((t) => t.kind)).toEqual(["postflight"]);

		eng.setNodeStatus("a", "complete");
		eng.setNodeStatus("b", "active");
		const b = findNodeV2(eng.get(), "b");
		expect(b?.tasks.map((t) => t.kind)).toEqual(["preflight", "postflight"]);
	});

	it("explorer/reviewer nodes get neither — their contract IS the handoff", () => {
		const eng = engine();
		eng.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "P",
			branch: "feat/p",
		});
		eng.setNodeStatus("p", "active");
		eng.appendChild(
			"p",
			{
				agent: "reviewer",
				persona: "reviewer",
				title: "Rev",
				after: ["parent"],
			},
			"p",
		);
		eng.setNodeStatus("rev", "active");
		expect(findNodeV2(eng.get(), "rev")?.tasks).toEqual([]);
	});

	it("the postflight toggle persists the handoff (v1 behavior)", () => {
		const eng = engine();
		eng.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "A",
			branch: "feat/a",
		});
		eng.setNodeStatus("a", "active");
		eng.toggleTask("a", "lifecycle-postflight", "## Handoff\nBuilt the thing.");
		expect(findNodeV2(eng.get(), "a")?.handoff).toContain("Built the thing");
	});
});

describe("status + records", () => {
	it("enforces the unchanged transition table", () => {
		const eng = engine();
		eng.addNode(null, { agent: "worker", persona: "coder", title: "A" });
		expect(() => eng.setNodeStatus("a", "shipped")).toThrow(
			"illegal status transition",
		);
		expect(() => eng.setNodeStatus("a", "failed")).toThrow(
			"illegal status transition",
		);
		eng.setNodeStatus("a", "active");
		expect(() => eng.setNodeStatus("a", "failed")).toThrow("failure detail");
	});

	it("records resolutions append-only with runtime patches bounded", () => {
		const eng = engine();
		eng.addNode(null, { agent: "worker", persona: "coder", title: "A" });
		eng.recordResolution("a", {
			model: "prov/sol",
			family: "openai",
			tier: "standard",
			source: "persona-tier",
			resolvedAt: "t",
			generation: 0,
		});
		eng.recordResolution("a", {
			model: "prov/seat",
			family: "",
			source: "session-fallback",
			fallbackReason: "tier empty",
			resolvedAt: "t2",
			generation: 1,
		});
		const node = findNodeV2(eng.get(), "a");
		expect(node?.resolutions?.map((r) => r.source)).toEqual([
			"persona-tier",
			"session-fallback",
		]);
		eng.setNodeRuntime("a", {
			sessionPath: "/tmp/s.jsonl",
			previousSessionPaths: ["1", "2", "3", "4", "5", "6", "7"],
		});
		expect(findNodeV2(eng.get(), "a")?.previousSessionPaths?.length).toBe(5);
	});
});

describe("v2 storage + legacy archive", () => {
	it("gates on schemaVersion 6 and skips _legacy in list()", () => {
		engine(); // writes p/plan.json at v6
		const s = createPlanStoreV2(root);
		expect(s.list().map((p) => p.slug)).toEqual(["p"]);

		mkdirSync(join(root, "old-plan"), { recursive: true });
		writeFileSync(
			join(root, "old-plan", "plan.json"),
			JSON.stringify({ schemaVersion: 5, slug: "old-plan" }),
		);
		expect(() => s.load("old-plan")).toThrow("Unsupported Maestro plan state");
		// list() skips legacy dirs rather than crashing (the #238 lesson).
		expect(s.list().map((p) => p.slug)).toEqual(["p"]);
	});

	it("archives legacy dirs wholesale into _legacy, keeping v6 plans", () => {
		engine();
		mkdirSync(join(root, "old-plan", "crashes"), { recursive: true });
		writeFileSync(
			join(root, "old-plan", "plan.json"),
			JSON.stringify({ schemaVersion: 5, slug: "old-plan" }),
		);
		writeFileSync(join(root, "old-plan", "events.jsonl"), "{}\n");
		writeFileSync(
			join(root, "broken", "plan.json").replace("/plan.json", ""),
			"",
		);
		// ^ not a dir — ignored. Also an unreadable plan.json counts as legacy:
		mkdirSync(join(root, "corrupt"), { recursive: true });
		writeFileSync(join(root, "corrupt", "plan.json"), "not json");

		expect(legacyPlanSlugs(root)).toEqual(["corrupt", "old-plan"]);
		const result = archiveLegacyPlans(root);
		expect(result.archived).toEqual(["corrupt", "old-plan"]);
		// Moved wholesale — events.jsonl and crashes/ travel along.
		expect(
			readFileSync(join(root, "_legacy", "old-plan", "events.jsonl"), "utf8"),
		).toBe("{}\n");
		expect(legacyPlanSlugs(root)).toEqual([]);
		expect(
			createPlanStoreV2(root)
				.list()
				.map((p) => p.slug),
		).toEqual(["p"]);
	});
});
