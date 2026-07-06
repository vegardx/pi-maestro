import { describe, expect, it } from "vitest";
import {
	buildForwardSummaryPrompt,
	buildPlanAwareCompactionMarker,
	type ForwardSummaryInput,
} from "../packages/modes/src/forward-summary.js";

describe("buildForwardSummaryPrompt", () => {
	it("includes completed group info", () => {
		const input: ForwardSummaryInput = {
			completed: { title: "Auth System", body: "Implement OAuth2 login" },
			agentOutput: "Implemented refresh tokens",
			consumers: [
				{ title: "API Layer", body: "Needs auth", tasks: ["Add middleware"] },
			],
		};
		const prompt = buildForwardSummaryPrompt(input);
		expect(prompt).toContain("Auth System");
		expect(prompt).toContain("Implement OAuth2 login");
		expect(prompt).toContain("Implemented refresh tokens");
	});

	it("includes consumer info", () => {
		const input: ForwardSummaryInput = {
			completed: { title: "Core", body: "Core lib" },
			agentOutput: "Done",
			consumers: [
				{
					title: "Frontend",
					body: "Needs core API",
					tasks: ["Use UserService"],
				},
				{
					title: "Backend",
					body: "Needs core types",
					tasks: ["Import schema"],
				},
			],
		};
		const prompt = buildForwardSummaryPrompt(input);
		expect(prompt).toContain("Frontend");
		expect(prompt).toContain("Use UserService");
		expect(prompt).toContain("Backend");
		expect(prompt).toContain("Import schema");
	});

	it("handles empty agent output", () => {
		const input: ForwardSummaryInput = {
			completed: { title: "X", body: "Y" },
			agentOutput: "",
			consumers: [],
		};
		const prompt = buildForwardSummaryPrompt(input);
		expect(prompt).toContain("(no output captured)");
	});
});

describe("buildPlanAwareCompactionMarker", () => {
	it("includes remaining tasks", () => {
		const marker = buildPlanAwareCompactionMarker({
			groupId: "auth",
			groupTitle: "Auth System",
			remainingTasks: [
				{ title: "Add refresh", body: "In src/auth/refresh.ts" },
				{ title: "Add revoke" },
			],
			completedTasks: [{ title: "Add login" }],
			depSummaryIds: ["core"],
		});
		expect(marker).toContain("auth — Auth System");
		expect(marker).toContain("Add refresh");
		expect(marker).toContain("src/auth/refresh.ts");
		expect(marker).toContain("Add login ✓");
		expect(marker).toContain("core: available in plan");
	});

	it("handles no remaining tasks", () => {
		const marker = buildPlanAwareCompactionMarker({
			groupId: "done",
			groupTitle: "Done",
			remainingTasks: [],
			completedTasks: [{ title: "Everything" }],
			depSummaryIds: [],
		});
		expect(marker).toContain("(all done)");
		expect(marker).toContain("(none)");
	});
});
