import { describe, expect, it } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
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
		remove: () => {
			saved = null;
		},
		list: () => [],
	};
}

function engineWith(): PlanEngine {
	const engine = PlanEngine.create(memStore(), {
		slug: "p",
		title: "P",
		repoPath: "/repo",
	});
	engine.setPhase("structuring");
	engine.addDeliverable({ title: "OAuth", workerMode: "full" });
	return engine;
}

describe("sub-agent panel (engine)", () => {
	it("adds and lists a persona panel per deliverable", () => {
		const engine = engineWith();
		engine.addSubAgent("oauth", {
			name: "security-audit",
			persona: "security-audit",
			required: true,
		});
		engine.addSubAgent("oauth", {
			name: "correctness-review",
			persona: "correctness-review",
			required: true,
		});
		const d = engine.get().deliverables.find((x) => x.id === "oauth");
		expect(d?.subAgents?.map((s) => s.name)).toEqual([
			"security-audit",
			"correctness-review",
		]);
		expect(d?.subAgents?.every((s) => s.required)).toBe(true);
	});

	it("supports multiple instances of one persona (multi-model panel)", () => {
		const engine = engineWith();
		engine.addSubAgent("oauth", {
			name: "security-audit",
			persona: "security-audit",
			slot: "default",
		});
		engine.addSubAgent("oauth", {
			name: "security-audit-alt",
			persona: "security-audit",
			slot: "alternate",
		});
		const d = engine.get().deliverables.find((x) => x.id === "oauth");
		expect(d?.subAgents).toHaveLength(2);
		expect(d?.subAgents?.map((s) => s.slot)).toEqual(["default", "alternate"]);
		expect(new Set(d?.subAgents?.map((s) => s.persona)).size).toBe(1);
	});

	it("rejects a duplicate instance name and removes by name", () => {
		const engine = engineWith();
		engine.addSubAgent("oauth", { name: "docs", persona: "documentation" });
		expect(() =>
			engine.addSubAgent("oauth", { name: "docs", persona: "documentation" }),
		).toThrow(/already exists/);
		engine.removeSubAgent("oauth", "docs");
		expect(engine.get().deliverables[0].subAgents).toEqual([]);
	});
});
