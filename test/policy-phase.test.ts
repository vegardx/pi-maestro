// The readiness gate at the tool-policy layer: exploring blocks the
// structure tools (deliverable/task/agent/knowledge) while keeping the research
// loop available; structuring restores the full plan tool set.

import { describe, expect, it } from "vitest";
import {
	computeActiveTools,
	toolBlockedInPlanMode,
} from "../packages/modes/src/policy.js";

const ALL_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"edit",
	"write",
	"ask",
	"websearch",
	"webfetch",
	"deliverable",
	"task",
	"agent",
	"plan",
	"knowledge",
	"research",
	"readiness",
];

describe("phase-gated tool policy", () => {
	it("exploring blocks structure tools, keeps the research loop", () => {
		const active = computeActiveTools({
			mode: "plan",
			availableTools: ALL_TOOLS,
			phase: "exploring",
		});
		for (const locked of ["deliverable", "task", "agent", "knowledge"]) {
			expect(active).not.toContain(locked);
		}
		for (const open of ["research", "readiness", "ask", "plan", "read"]) {
			expect(active).toContain(open);
		}
	});

	it("structuring restores the structure tools and keeps research", () => {
		const active = computeActiveTools({
			mode: "plan",
			availableTools: ALL_TOOLS,
			phase: "structuring",
		});
		for (const tool of [
			"deliverable",
			"task",
			"agent",
			"knowledge",
			"research",
		]) {
			expect(active).toContain(tool);
		}
	});

	it("no phase behaves like structuring (older sessions)", () => {
		const active = computeActiveTools({
			mode: "plan",
			availableTools: ALL_TOOLS,
		});
		expect(active).toContain("deliverable");
	});

	it("auto mode ignores the phase gate", () => {
		const active = computeActiveTools({
			mode: "auto",
			availableTools: ALL_TOOLS,
			phase: "exploring",
		});
		expect(active).toContain("deliverable");
		expect(active).toContain("task");
	});

	it("toolBlockedInPlanMode explains the readiness gate while exploring", () => {
		expect(toolBlockedInPlanMode("deliverable", "exploring")).toMatch(
			/readiness/,
		);
		expect(toolBlockedInPlanMode("knowledge", "exploring")).toMatch(
			/exploring/,
		);
		expect(toolBlockedInPlanMode("research", "exploring")).toBeNull();
		expect(toolBlockedInPlanMode("readiness", "exploring")).toBeNull();
		expect(toolBlockedInPlanMode("deliverable", "structuring")).toBeNull();
		// Non-plan tools stay blocked in either phase.
		expect(toolBlockedInPlanMode("edit", "structuring")).toMatch(/disabled/);
	});
});
