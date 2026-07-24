// The plan→execution seed's pure pieces: the mechanical fallback, the document
// wrapper, the on-disk numbering, and the backward-return note. The model turn
// and the session fork are exercised by the live drive, not here.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanEngineV2 } from "../packages/modes/src/plan/engine.js";
import type { PlanV2 } from "../packages/modes/src/plan/schema.js";
import type { PlanStoreV2 } from "../packages/modes/src/plan/storage.js";
import {
	backToPlanNote,
	formatTransitionSeedDoc,
	mechanicalTransitionSeed,
	writeTransitionSeed,
} from "../packages/modes/src/runtime/transition-seed.js";

function memStore(): PlanStoreV2 {
	let saved: PlanV2 | null = null;
	return {
		root: "/tmp/plans",
		save(plan) {
			saved = plan;
		},
		load() {
			return saved;
		},
		exists() {
			return saved !== null;
		},
		remove() {
			saved = null;
		},
		list() {
			return [];
		},
	};
}

function planWith(nodes: Array<{ id: string; status: string }>): PlanV2 {
	const engine = PlanEngineV2.create(memStore(), {
		slug: "auth-revamp",
		title: "Auth revamp",
		repoPath: "/tmp",
	});
	for (const n of nodes) {
		engine.addNode(null, { agent: "worker", persona: "coder", title: n.id });
	}
	const plan = engine.get();
	// Force the requested statuses directly for the note's counting.
	return {
		...plan,
		nodes: plan.nodes.map((node, i) => ({
			...node,
			status: nodes[i]!.status as PlanV2["nodes"][number]["status"],
		})),
	};
}

describe("mechanicalTransitionSeed", () => {
	it("names the plan and includes understanding when present", () => {
		const plan = { ...planWith([]), understanding: "Move auth to OIDC." };
		const seed = mechanicalTransitionSeed(plan);
		expect(seed).toContain("auth-revamp");
		expect(seed).toContain("Move auth to OIDC.");
		expect(seed).toContain("plan.json");
	});
});

describe("formatTransitionSeedDoc", () => {
	it("wraps the body and states plan.json carries the structure", () => {
		const doc = formatTransitionSeedDoc(
			planWith([]),
			"  decided X because Y  ",
		);
		expect(doc).toContain("# Execution seed — plan `auth-revamp`");
		expect(doc).toContain("decided X because Y");
		expect(doc).toContain("loaded from plan.json");
		// Body is trimmed.
		expect(doc).not.toContain("  decided");
	});
});

describe("writeTransitionSeed", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "seed-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes NN-execution.md and continues the numbering", () => {
		const p1 = writeTransitionSeed(dir, "one");
		const p2 = writeTransitionSeed(dir, "two");
		expect(p1).toMatch(/transitions\/01-execution\.md$/);
		expect(p2).toMatch(/transitions\/02-execution\.md$/);
		expect(readFileSync(p2, "utf8")).toBe("two");
	});
});

describe("backToPlanNote", () => {
	it("summarizes node statuses and warns against restarting live work", () => {
		const plan = planWith([
			{ id: "a", status: "shipped" },
			{ id: "b", status: "active" },
			{ id: "c", status: "planned" },
		]);
		const note = backToPlanNote(plan);
		expect(note).toContain("1 shipped");
		expect(note).toContain("1 active");
		expect(note).toContain("1 planned");
		expect(note).toContain("auth-revamp");
		expect(note).toContain("Do not");
	});

	it("has a plan-less fallback", () => {
		expect(backToPlanNote(undefined)).toContain("Returned to plan mode");
	});
});
