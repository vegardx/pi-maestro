// Plan-mode tool policy: the structure tools (deliverable/task/agent) and the
// research loop are available throughout plan mode — there is no exploring-phase
// lock (the old `readiness` gate is retired). Non-plan implementer tools stay
// blocked in plan mode; auto mode exposes the same plan/structure set.

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
	"research",
];

describe("plan-mode tool policy", () => {
	it("plan mode exposes the structure tools and the research loop", () => {
		const active = computeActiveTools({
			mode: "plan",
			availableTools: ALL_TOOLS,
		});
		for (const tool of [
			"deliverable",
			"task",
			"agent",
			"research",
			"ask",
			"plan",
			"read",
		]) {
			expect(active).toContain(tool);
		}
	});

	it("auto mode exposes the same structure tools", () => {
		const active = computeActiveTools({
			mode: "auto",
			availableTools: ALL_TOOLS,
		});
		expect(active).toContain("deliverable");
		expect(active).toContain("task");
	});

	it("toolBlockedInPlanMode allows plan/research tools, blocks implementer tools", () => {
		expect(toolBlockedInPlanMode("deliverable")).toBeNull();
		expect(toolBlockedInPlanMode("task")).toBeNull();
		expect(toolBlockedInPlanMode("research")).toBeNull();
		// Non-plan implementer tools stay disabled in plan mode.
		expect(toolBlockedInPlanMode("edit")).toMatch(/disabled/);
		expect(toolBlockedInPlanMode("write")).toMatch(/disabled/);
	});
});
