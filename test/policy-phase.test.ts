// Plan-mode tool policy: plan mode is CONVERSATION-ONLY — the research loop and
// read/navigation tools are available, but the plan-AUTHORING tools
// (deliverable/task/agent/repo) are NOT. They open in exactly two windows: the
// form-at-transition step (the `forming` flag) and auto mode (evolve-in-place).
// Non-plan implementer tools stay blocked in plan mode throughout.

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
	it("plan conversation exposes research + navigation, NOT the structure tools", () => {
		const active = computeActiveTools({
			mode: "plan",
			availableTools: ALL_TOOLS,
		});
		for (const tool of ["research", "ask", "plan", "read"]) {
			expect(active).toContain(tool);
		}
		// Authoring tools are conversation-blocked.
		for (const tool of ["deliverable", "task", "agent"]) {
			expect(active).not.toContain(tool);
		}
	});

	it("the forming turn opens the structure tools in plan mode", () => {
		const active = computeActiveTools({
			mode: "plan",
			availableTools: ALL_TOOLS,
			forming: true,
		});
		expect(active).toContain("deliverable");
		expect(active).toContain("task");
		expect(active).toContain("agent");
	});

	it("auto mode exposes the structure tools (evolve-in-place)", () => {
		const active = computeActiveTools({
			mode: "auto",
			availableTools: ALL_TOOLS,
		});
		expect(active).toContain("deliverable");
		expect(active).toContain("task");
	});

	it("toolBlockedInPlanMode blocks structure tools in conversation, allows them while forming", () => {
		// Conversation: research allowed, authoring blocked.
		expect(toolBlockedInPlanMode("research")).toBeNull();
		expect(toolBlockedInPlanMode("plan")).toBeNull();
		expect(toolBlockedInPlanMode("deliverable")).toMatch(
			/cross into execution/,
		);
		expect(toolBlockedInPlanMode("task")).toMatch(/cross into execution/);
		// Forming window: authoring allowed.
		expect(toolBlockedInPlanMode("deliverable", true)).toBeNull();
		expect(toolBlockedInPlanMode("task", true)).toBeNull();
		// Non-plan implementer tools stay disabled in plan mode regardless.
		expect(toolBlockedInPlanMode("edit")).toMatch(/disabled/);
		expect(toolBlockedInPlanMode("write", true)).toMatch(/disabled/);
	});
});
