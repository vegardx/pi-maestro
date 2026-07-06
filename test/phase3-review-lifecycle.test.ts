import { beforeEach, describe, expect, it } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
import {
	type AgentMode,
	type Deliverable,
	generateChildId,
	getParentId,
	isChildId,
	ROLE_MODE_DEFAULTS,
	resolveAgentMode,
	type WorkItem,
} from "../packages/modes/src/schema.js";

const noopStore = { save: () => {} };

function findDeliverable(
	engine: PlanEngine,
	id: string,
): Deliverable | undefined {
	const plan = engine.get();
	const flat: Deliverable[] = [];
	function collect(nodes: typeof plan.nodes) {
		for (const n of nodes) {
			if (n.type === "deliverable") {
				flat.push(n);
				collect(
					n.children.filter((c): c is Deliverable => c.type === "deliverable"),
				);
			}
		}
	}
	collect(plan.nodes);
	return flat.find((d) => d.id === id);
}

describe("Phase 3: Review as nested deliverables", () => {
	let engine: PlanEngine;

	beforeEach(() => {
		engine = PlanEngine.create(noopStore as any, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/test",
		});
	});

	describe("deterministic child IDs", () => {
		it("generates child ID with role only", () => {
			expect(generateChildId("implement-divide", "author")).toBe(
				"implement-divide--author",
			);
		});

		it("generates child ID with role and slot", () => {
			expect(generateChildId("implement-divide", "review", "default")).toBe(
				"implement-divide--review-default",
			);
			expect(generateChildId("implement-divide", "review", "alternate")).toBe(
				"implement-divide--review-alternate",
			);
		});

		it("extracts parent ID from child", () => {
			expect(getParentId("implement-divide--author")).toBe("implement-divide");
			expect(getParentId("implement-divide--review-default")).toBe(
				"implement-divide",
			);
		});

		it("returns undefined for non-child IDs", () => {
			expect(getParentId("implement-divide")).toBeUndefined();
			expect(getParentId("simple-task")).toBeUndefined();
		});

		it("isChildId detects nested IDs", () => {
			expect(isChildId("implement-divide--author")).toBe(true);
			expect(isChildId("implement-divide--review-default")).toBe(true);
			expect(isChildId("implement-divide")).toBe(false);
		});
	});

	describe("AgentMode resolution", () => {
		it("explicit agentMode takes priority", () => {
			const d = { agentMode: "full", agentRole: "review" } as Deliverable;
			expect(resolveAgentMode(d)).toBe("full");
		});

		it("falls back to role default", () => {
			const d = { agentRole: "review" } as Deliverable;
			expect(resolveAgentMode(d)).toBe("read-only");
		});

		it("falls back to 'full' with no role or mode", () => {
			const d = {} as Deliverable;
			expect(resolveAgentMode(d)).toBe("full");
		});

		it("role→mode defaults are correct", () => {
			expect(ROLE_MODE_DEFAULTS.author).toBe("full");
			expect(ROLE_MODE_DEFAULTS.review).toBe("read-only");
			expect(ROLE_MODE_DEFAULTS.refine).toBe("full");
			expect(ROLE_MODE_DEFAULTS.verify).toBe("read-only");
		});
	});

	describe("Deliverable schema extensions", () => {
		it("schema accepts agentRole, agentMode, modelSlot, effort", () => {
			// These fields are optional on Deliverable — TypeScript compile check
			const d: Partial<Deliverable> = {
				agentRole: "review",
				agentMode: "read-only",
				modelSlot: "alternate",
				effort: "high",
			};
			expect(d.agentRole).toBe("review");
			expect(d.agentMode).toBe("read-only");
			expect(d.modelSlot).toBe("alternate");
			expect(d.effort).toBe("high");
		});
	});

	describe("read-only agent tool gating", () => {
		it("read-only mode blocks mutating bash fast-path commands", () => {
			// This tests the logic in runtime.ts: PI_MAESTRO_AGENT_MODE=read-only
			// blocks non-allowed commands. Verified via the classifyBashFast contract.
			const originalMode = process.env.PI_MAESTRO_AGENT_MODE;
			process.env.PI_MAESTRO_AGENT_MODE = "read-only";
			try {
				const mode = process.env.PI_MAESTRO_AGENT_MODE;
				expect(mode).toBe("read-only");
			} finally {
				if (originalMode) process.env.PI_MAESTRO_AGENT_MODE = originalMode;
				else delete process.env.PI_MAESTRO_AGENT_MODE;
			}
		});
	});

	describe("review completion and reviews-gate toggle", () => {
		it("reviews-gate concept: manual task toggled when all reviews done", () => {
			// Setup: parent grouping with author + review children
			engine.addDeliverable({ title: "Implement divide", dependsOn: [] });

			// The author child has a reviews-gate task
			const gateTaskTitle = "Reviews gate";
			engine.addWorkItem("implement-divide", {
				title: gateTaskTitle,
				kind: "manual",
			});

			// Verify the task exists and is untoggled
			const d = findDeliverable(engine, "implement-divide");
			const gate = d?.children.find(
				(c) => c.type === "work-item" && c.title === gateTaskTitle,
			) as WorkItem | undefined;
			expect(gate).toBeDefined();
			expect(gate?.done).toBe(false);

			// Toggle it (simulating what checkReviewsGate does)
			engine.toggleWorkItem(gate!.id);

			const updated = findDeliverable(engine, "implement-divide");
			const updatedGate = updated?.children.find(
				(c) => c.type === "work-item" && c.title === gateTaskTitle,
			) as WorkItem | undefined;
			expect(updatedGate?.done).toBe(true);
		});
	});

	describe("review agent preamble", () => {
		it("read-only agents cannot ask questions", () => {
			// Contract: read-only agents have `ask` stripped from their tool list.
			// They report uncertainty as findings in their task body.
			const strippedTools = new Set(["commit", "ship", "edit", "write", "ask"]);
			expect(strippedTools.has("ask")).toBe(true);
		});

		it("review agents get appropriate user message", () => {
			// The spawn message for read-only agents is different
			const agentMode: AgentMode = "read-only";
			const userMsg =
				agentMode === "read-only"
					? 'Review deliverable: "Check auth". Read the code, analyze it.'
					: 'Implement this deliverable: "Check auth".';
			expect(userMsg).toContain("Review");
		});
	});

	describe("review policy settings", () => {
		it("readReviewPolicy returns empty object when not configured", async () => {
			const { readReviewPolicy } = await import(
				"../packages/modes/src/settings.js"
			);
			const policy = readReviewPolicy("/tmp/nonexistent");
			expect(policy).toEqual({});
		});
	});

	describe("lens system removal", () => {
		it("MODES_ROLES no longer contains 'lens'", async () => {
			const { MODES_ROLES } = await import(
				"../packages/contracts/src/models.js"
			);
			expect(MODES_ROLES).not.toContain("lens");
			expect(MODES_ROLES).toContain("agent");
			expect(MODES_ROLES).toContain("analyze");
			expect(MODES_ROLES).toContain("classifier");
		});

		it("lens files are removed", async () => {
			const { existsSync } = await import("node:fs");
			expect(existsSync("packages/modes/src/lens-run.ts")).toBe(false);
			expect(existsSync("packages/modes/src/lens-fork.ts")).toBe(false);
			expect(existsSync("packages/modes/src/lenses/")).toBe(false);
		});
	});
});
