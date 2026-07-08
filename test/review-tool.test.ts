import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	RunHandle,
	RunId,
	RunResult,
	SpawnProfile,
	SubagentsCapabilityV1,
} from "@vegardx/pi-contracts";
import { describe, expect, it } from "vitest";
import type { PanelResult } from "../packages/modes/src/panel.js";
import { createReviewTool } from "../packages/modes/src/review-tool.js";
import type { SubAgentSpec } from "../packages/modes/src/schema.js";

function fakeSubagents(
	byPersona: Record<string, RunResult>,
): SubagentsCapabilityV1 {
	let n = 0;
	return {
		spawn(prompt: string, _profile: SpawnProfile): RunHandle {
			const persona = Object.keys(byPersona).find((p) => prompt.includes(p));
			const result = byPersona[persona ?? ""] ?? { status: "failed" as const };
			return {
				id: `run-${++n}` as RunId,
				status: () => "running" as const,
				steer: () => {},
				stop: () => {},
				result: async () => result,
			};
		},
		get: () => undefined,
		list: () => [],
		steer: () => {},
		stop: () => {},
	} as unknown as SubagentsCapabilityV1;
}

type Exec = {
	execute(
		id: string,
		params: unknown,
		signal?: undefined,
		onUpdate?: undefined,
		ctx?: ExtensionContext,
	): Promise<{
		content: [{ type: "text"; text: string }];
		details: { gate?: boolean };
	}>;
};
const run = (t: ReturnType<typeof createReviewTool>) =>
	(t as unknown as Exec).execute(
		"c",
		{},
		undefined,
		undefined,
		{} as ExtensionContext,
	);

describe("review tool", () => {
	it("runs the panel, reports verdicts, and blocks ship on a required BLOCK", async () => {
		const capability = fakeSubagents({
			"security-audit": {
				status: "succeeded",
				summary: "found an issue\nVERDICT: BLOCK",
			},
			simplification: {
				status: "succeeded",
				summary: "looks fine\nVERDICT: PASS",
			},
		});
		const panel: SubAgentSpec[] = [
			{ name: "security-audit", persona: "security-audit", required: true },
			{ name: "simplification", persona: "simplification" },
		];
		let reported: readonly PanelResult[] | undefined;
		const tool = createReviewTool({
			subagents: () => capability,
			panel: () => panel,
			cwd: () => "/wt",
			reportVerdicts: (r) => {
				reported = r;
			},
		});
		const res = await run(tool);
		expect(res.details.gate).toBe(false); // required security BLOCK
		expect(res.content[0].text).toContain("Ship is BLOCKED");
		expect(res.content[0].text).toContain("security-audit");
		expect(reported).toHaveLength(2);
	});

	it("passes the gate when required reviewers approve", async () => {
		const capability = fakeSubagents({
			"correctness-review": {
				status: "succeeded",
				summary: "no bugs\nVERDICT: PASS",
			},
		});
		const tool = createReviewTool({
			subagents: () => capability,
			panel: () => [
				{
					name: "correctness-review",
					persona: "correctness-review",
					required: true,
				},
			],
			cwd: () => "/wt",
		});
		const res = await run(tool);
		expect(res.details.gate).toBe(true);
		expect(res.content[0].text).toContain("can ship");
	});

	it("an empty panel does not block ship", async () => {
		const tool = createReviewTool({
			subagents: () => fakeSubagents({}),
			panel: () => [],
			cwd: () => "/wt",
		});
		const res = await run(tool);
		expect(res.details.gate).toBe(true);
		expect(res.content[0].text).toContain("No review panel");
	});
});
