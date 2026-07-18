// The worker (agent-mode) tool policy: workers get a focused implementer set —
// read/run/commit, toggle their own tasks, review, escalate — and NOT the
// planner's surface (plan/deliverable/research) or the web/dig tools. Research
// and plan-navigation are upstream; the deliverable's preflight seed hands over
// context. Pins the trim so it can't silently regrow.

import { describe, expect, it } from "vitest";
import {
	AGENT_TOOL_NAMES,
	computeActiveTools,
} from "../packages/modes/src/policy.js";

// A superset of everything a worker's pi might register.
const ALL_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"websearch",
	"webfetch",
	"plan",
	"ask",
	"suggest_next_prompt",
	"bash",
	"edit",
	"write",
	"commit",
	"task",
	"review",
	"dig",
	"deliverable",
	"agent",
	"panel",
	"repo",
	"knowledge",
	"research",
	"readiness",
];

describe("worker (agent-mode) tool policy", () => {
	it("exposes exactly the focused implementer set", () => {
		const tools = computeActiveTools({
			mode: "auto",
			isAgent: true,
			availableTools: ALL_TOOLS,
		});
		expect(new Set(tools)).toEqual(new Set(AGENT_TOOL_NAMES));
	});

	it("excludes plan, dig, web, and every planner/structure tool", () => {
		const tools = computeActiveTools({
			mode: "auto",
			isAgent: true,
			availableTools: ALL_TOOLS,
		});
		for (const excluded of [
			"plan",
			"dig",
			"websearch",
			"webfetch",
			"deliverable",
			"agent",
			"panel",
			"repo",
			"knowledge",
			"research",
			"readiness",
		]) {
			expect(tools).not.toContain(excluded);
		}
	});

	it("keeps the implement/commit/task/review/ask core", () => {
		const tools = computeActiveTools({
			mode: "auto",
			isAgent: true,
			availableTools: ALL_TOOLS,
		});
		for (const kept of [
			"read",
			"bash",
			"edit",
			"write",
			"commit",
			"task",
			"review",
			"ask",
		]) {
			expect(tools).toContain(kept);
		}
	});

	it("filters to tools the worker actually registered", () => {
		const tools = computeActiveTools({
			mode: "auto",
			isAgent: true,
			availableTools: ["read", "bash", "task", "deliverable"],
		});
		// deliverable is dropped even though registered; the rest pass through.
		expect(new Set(tools)).toEqual(new Set(["read", "bash", "task"]));
	});
});
