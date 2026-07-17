import type { AgentsCapabilityV1 } from "@vegardx/pi-contracts";
import { expect, it, vi } from "vitest";
import { executeWorkflowStage } from "../packages/modes/src/exec/stage-runtime.js";

const SHA = "a".repeat(40);
const assignment = (id: string) => ({
	agentId: id,
	kind: "correctness-review" as const,
	presetId: "review",
	modelSetId: "models",
	optionId: "one",
	modelId: "provider/model",
	runtime: {
		mode: "read-only" as const,
		transport: "headless" as const,
		tools: {},
		session: "ephemeral" as const,
		isolation: "strong" as const,
	},
	focus: `Review ${id}`,
	rationale: "independent inspection",
	inputContracts: ["implementation"],
	outputContracts: ["structured-review"],
	provenance: {
		source: "explicit" as const,
		presetId: "review",
		modelSetId: "models",
		optionId: "one",
		resolvedAt: "2026-01-01T00:00:00Z",
	},
	resolvedAt: "2026-01-01T00:00:00Z",
	source: "explicit" as const,
});

it("starts a parallel stage at one revision and delivers once after the barrier", async () => {
	const assignments = [assignment("a"), assignment("b")];
	const calls: string[] = [];
	const agents = {
		batch: vi.fn(async (requests: readonly { prompt: string }[]) => {
			calls.push("batch");
			expect(requests.every((request) => request.prompt.includes(SHA))).toBe(
				true,
			);
			return assignments.map((item) => ({
				runId: item.agentId,
				assignment: item,
				handle: {},
			}));
		}),
		result: vi.fn(async (id: string) => {
			calls.push(`result:${id}`);
			return { status: "succeeded" as const, summary: `report ${id}` };
		}),
	} as unknown as AgentsCapabilityV1;
	const deliver = vi.fn(() => {
		calls.push("deliver");
	});
	const report = await executeWorkflowStage({
		stage: {
			id: "review",
			after: [],
			assignmentIds: ["a", "b"],
			inputRevision: SHA,
			inputContracts: ["implementation"],
			barrier: "all",
		},
		assignments,
		agents,
		cwd: "/repo",
		base: SHA,
		validate: (_assignment, result) => ({ valid: Boolean(result?.summary) }),
		reduce: (_stage, _target, members) =>
			members.map((m) => m.result?.summary).join("\n"),
		deliver,
		checkpoint: { clean: () => true, head: () => SHA },
	});
	expect(report.valid).toBe(true);
	expect(report.members).toHaveLength(2);
	expect(deliver).toHaveBeenCalledTimes(1);
	expect(calls.at(-1)).toBe("deliver");
});
