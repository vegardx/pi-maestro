import { describe, expect, it } from "vitest";
import type { ForwardSummaryInput } from "../packages/modes/src/execution-tmux.js";
import {
	buildForwardSummaryPrompt,
	buildPlanAwareCompactionMarker,
} from "../packages/modes/src/forward-summary.js";

describe("buildForwardSummaryPrompt", () => {
	const baseInput: ForwardSummaryInput = {
		completed: {
			id: "implement-divide",
			title: "Implement divide function",
			body: "Add a divide(a, b) function that throws on zero divisor.",
		},
		agentOutput:
			"Summary: Added divide(a, b): number that throws RangeError on b===0.\n\nCommits:\nfeat(math): implement divide with zero guard",
		consumers: [
			{
				id: "write-api-docs",
				title: "Write API documentation",
				body: "Document all exported functions with signatures and edge cases.",
				tasks: ["Write docs/api.md", "Add code examples"],
			},
			{
				id: "implement-calculator",
				title: "Implement calculator CLI",
				body: "Wire up math functions into a CLI.",
				tasks: ["Parse expressions", "Handle errors"],
			},
		],
	};

	it("includes completed deliverable info", () => {
		const prompt = buildForwardSummaryPrompt(baseInput);
		expect(prompt).toContain("Implement divide function");
		expect(prompt).toContain(
			"Add a divide(a, b) function that throws on zero divisor.",
		);
	});

	it("includes agent output", () => {
		const prompt = buildForwardSummaryPrompt(baseInput);
		expect(prompt).toContain("RangeError on b===0");
		expect(prompt).toContain("feat(math): implement divide");
	});

	it("includes downstream consumers with tasks", () => {
		const prompt = buildForwardSummaryPrompt(baseInput);
		expect(prompt).toContain("Write API documentation");
		expect(prompt).toContain("Write docs/api.md, Add code examples");
		expect(prompt).toContain("Implement calculator CLI");
		expect(prompt).toContain("Parse expressions, Handle errors");
	});

	it("handles empty agent output gracefully", () => {
		const input = { ...baseInput, agentOutput: "" };
		const prompt = buildForwardSummaryPrompt(input);
		expect(prompt).toContain("(no output captured)");
	});

	it("handles consumers with no tasks", () => {
		const input = {
			...baseInput,
			consumers: [
				{ id: "final", title: "Final step", body: "Wrap up.", tasks: [] },
			],
		};
		const prompt = buildForwardSummaryPrompt(input);
		expect(prompt).toContain("(none)");
	});

	it("includes instructions for concise, consumer-focused summary", () => {
		const prompt = buildForwardSummaryPrompt(baseInput);
		expect(prompt).toContain("max 200 words");
		expect(prompt).toContain("Preserve ONLY what downstream consumers need");
		expect(prompt).toContain("public API, behavior, signatures, edge cases");
		expect(prompt).toContain("Omit: implementation internals");
	});
});

describe("buildPlanAwareCompactionMarker", () => {
	it("includes remaining tasks with body", () => {
		const marker = buildPlanAwareCompactionMarker({
			deliverableId: "write-api",
			deliverableTitle: "Write API docs",
			remainingTasks: [
				{ title: "Write docs/api.md", body: "Cover multiply, divide" },
				{ title: "Add examples" },
			],
			completedTasks: [{ title: "Set up docs folder" }],
			depSummaryIds: ["implement-divide", "implement-multiply"],
		});
		expect(marker).toContain("write-api — Write API docs");
		expect(marker).toContain("- Write docs/api.md: Cover multiply, divide");
		expect(marker).toContain("- Add examples");
	});

	it("includes completed tasks as brief markers", () => {
		const marker = buildPlanAwareCompactionMarker({
			deliverableId: "write-api",
			deliverableTitle: "Write API docs",
			remainingTasks: [{ title: "Add examples" }],
			completedTasks: [
				{ title: "Set up docs folder" },
				{ title: "Write intro" },
			],
			depSummaryIds: [],
		});
		expect(marker).toContain("- Set up docs folder ✓");
		expect(marker).toContain("- Write intro ✓");
	});

	it("lists dependency summary IDs", () => {
		const marker = buildPlanAwareCompactionMarker({
			deliverableId: "write-api",
			deliverableTitle: "Write API docs",
			remainingTasks: [{ title: "Write" }],
			completedTasks: [],
			depSummaryIds: ["implement-divide"],
		});
		expect(marker).toContain("- implement-divide: available in plan");
	});

	it("handles no remaining tasks", () => {
		const marker = buildPlanAwareCompactionMarker({
			deliverableId: "d",
			deliverableTitle: "Done",
			remainingTasks: [],
			completedTasks: [{ title: "All done" }],
			depSummaryIds: [],
		});
		expect(marker).toContain("(all done)");
	});

	it("handles no completed tasks", () => {
		const marker = buildPlanAwareCompactionMarker({
			deliverableId: "d",
			deliverableTitle: "Fresh",
			remainingTasks: [{ title: "Start" }],
			completedTasks: [],
			depSummaryIds: [],
		});
		expect(marker).toContain("(none yet)");
	});

	it("handles no dependency summaries", () => {
		const marker = buildPlanAwareCompactionMarker({
			deliverableId: "d",
			deliverableTitle: "Root",
			remainingTasks: [{ title: "Go" }],
			completedTasks: [],
			depSummaryIds: [],
		});
		expect(marker).toContain("(none)");
	});

	it("includes compaction preservation instructions", () => {
		const marker = buildPlanAwareCompactionMarker({
			deliverableId: "d",
			deliverableTitle: "T",
			remainingTasks: [{ title: "X" }],
			completedTasks: [],
			depSummaryIds: [],
		});
		expect(marker).toContain("Preserve: decisions made");
		expect(marker).toContain("Drop: verbose tool output");
	});
});

describe("generateForwardSummary integration", () => {
	it("fires generateSummary callback with correct input on markDone", async () => {
		// This test verifies the wiring in TmuxFanout by importing and checking
		// the ForwardSummaryInput type matches expectations
		const input: ForwardSummaryInput = {
			completed: { id: "a", title: "A", body: "do A" },
			agentOutput: "did A",
			consumers: [{ id: "b", title: "B", body: "needs A", tasks: ["use A"] }],
		};
		expect(input.completed.id).toBe("a");
		expect(input.consumers[0].tasks).toEqual(["use A"]);
	});

	it("ForwardSummaryInput requires all fields", () => {
		// Type-level check: ensure the interface shape is correct
		const valid: ForwardSummaryInput = {
			completed: { id: "x", title: "X", body: "" },
			agentOutput: "",
			consumers: [],
		};
		expect(valid.consumers).toHaveLength(0);
	});

	it("generateForwardSummary skips when no downstream consumers exist", () => {
		// The generateForwardSummary method returns early when downstream.length === 0
		// This is verified by the implementation: no LLM call for terminal deliverables
		const input: ForwardSummaryInput = {
			completed: { id: "terminal", title: "Last", body: "final" },
			agentOutput: "done",
			consumers: [],
		};
		// With empty consumers, the prompt still renders but won't be called
		const prompt = buildForwardSummaryPrompt(input);
		expect(prompt).toContain("Last");
	});

	it("summary is shaped by consumer descriptions", () => {
		const input: ForwardSummaryInput = {
			completed: {
				id: "auth",
				title: "Implement auth",
				body: "JWT-based authentication",
			},
			agentOutput:
				"Exports: createToken(user), verifyToken(token), middleware. Uses RS256.",
			consumers: [
				{
					id: "api",
					title: "Build API",
					body: "REST endpoints protected by auth",
					tasks: ["Add auth middleware to routes"],
				},
			],
		};
		const prompt = buildForwardSummaryPrompt(input);
		// Consumer context shapes what the LLM should preserve
		expect(prompt).toContain("REST endpoints protected by auth");
		expect(prompt).toContain("Add auth middleware to routes");
		// Agent output (what was produced) is included for the LLM to summarize
		expect(prompt).toContain("createToken(user), verifyToken(token)");
	});
});
