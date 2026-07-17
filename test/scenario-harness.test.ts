import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	runScenario,
	type ScenarioResult,
	scenarioAssertions,
} from "./fixtures/scenario-harness.js";

const results: ScenarioResult[] = [];
afterEach(() => {
	for (const result of results.splice(0)) result.cleanup();
});

describe("deterministic scenario harness", () => {
	it("runs scripted models in a temporary repository and writes complete artifacts", async () => {
		const result = await runScenario({
			name: "model and repository",
			models: {
				"provider/test": [
					{
						match: "review this",
						response: "approved",
						usage: { input: 12, output: 2, cacheRead: 8, cost: 0.01 },
					},
				],
			},
			steps: [
				{
					name: "commit deterministic change",
					run: (scenario) => {
						writeFileSync(
							join(scenario.repo, "feature.ts"),
							"export const value = 1;\n",
						);
						scenario.git("add", "feature.ts");
						scenario.git("commit", "-m", "feat: add scenario feature");
					},
				},
				{
					name: "invoke fake model and services",
					run: async (scenario) => {
						const call = await scenario.models.complete(
							"provider/test",
							"please review this change",
						);
						scenario.recordUsage(
							{ kind: "run", id: "review-1" as never },
							call.usage ?? {},
						);
						await scenario.tmux.spawn(
							"worker-one",
							scenario.repo,
							"pi --session worker.jsonl",
						);
						await scenario.tmux.kill("worker-one");
						scenario.github.upsert({
							branch: "main",
							title: "Scenario PR",
							body: "Generated body",
						});
						scenario.clock.advance(250);
						scenario.state.set("verdict", call.response);
					},
				},
			],
		});
		results.push(result);

		expect(result.finalState).toMatchObject({
			state: { verdict: "approved" },
			github: [{ number: 1, branch: "main" }],
			usage: { totals: { input: 12, output: 2, cacheRead: 8 } },
		});
		scenarioAssertions.hasEvent(result, "model.completed");
		scenarioAssertions.hasEvent(result, "usage.accepted");
		expect(scenarioAssertions.artifact(result, "final-state.json")).toEqual(
			result.finalState,
		);
		const lines = readFileSync(join(result.artifacts, "events.jsonl"), "utf8")
			.trim()
			.split("\n");
		expect(lines).toHaveLength(result.events.length);
		expect(result.events.map((event) => event.sequence)).toEqual(
			result.events.map((_event, index) => index + 1),
		);
	});

	it("fails on prompt drift and removes temporary output by default", async () => {
		await expect(
			runScenario({
				name: "prompt drift",
				models: {
					"provider/test": [{ match: "expected", response: "unused" }],
				},
				steps: [
					{
						name: "unexpected model call",
						run: async (scenario) => {
							await scenario.models.complete(
								"provider/test",
								"different prompt",
							);
						},
					},
				],
			}),
		).rejects.toThrow("rejected prompt");
	});
});
