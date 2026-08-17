import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	loadWorkflowSpec,
	parseWorkflow,
	refreshRun,
	runWorkflowSpec,
	waitForRun,
} from "@agwab/pi-workflow";
import { afterEach, describe, expect, test } from "vitest";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const specPath = join(fixtureDir, "workflow-api.spec.json");
const temporaryProjects: string[] = [];

interface FakeRun {
	runId: string;
	attemptId: string;
	artifactDir: string;
}

async function loadInternalFakeBackendHook(): Promise<{
	setSubagentApiForTests(api: unknown | undefined): void;
}> {
	const packageJson = import.meta.resolve("@agwab/pi-workflow/package.json");
	const backendUrl = new URL("./dist/subagent-backend.js", packageJson);
	return import(backendUrl.href);
}

function outputFor(prompt: string): string {
	let control: Record<string, unknown>;
	if (prompt.includes("WORKFLOW_API_IMPLEMENT")) {
		control = {
			schema: "stage-control-v1",
			digest: "implementation",
			items: ["security", "correctness"],
		};
	} else if (prompt.includes("WORKFLOW_API_REVIEW")) {
		const lens = prompt.includes("security") ? "security" : "correctness";
		control = {
			schema: "stage-control-v1",
			digest: `${lens}-review`,
			findings: [{ id: lens, claim: `${lens} finding` }],
		};
	} else if (prompt.includes("WORKFLOW_API_DECIDE")) {
		control = {
			schema: "stage-control-v1",
			digest: "decisions",
			decisions: [
				{ findingId: "security", decision: "no_change" },
				{ findingId: "correctness", decision: "no_change" },
			],
		};
	} else {
		throw new Error(`unexpected fake subagent prompt: ${prompt.slice(0, 200)}`);
	}
	return [
		"<control>",
		JSON.stringify(control),
		"</control>",
		"<analysis>Fake model output for the workflow API probe.</analysis>",
		"<refs>[]</refs>",
	].join("\n");
}

async function makeFakeSubagentApi(
	cwd: string,
	launches: Array<{
		model?: string;
		prompt: string;
		skills: unknown;
		skillsPresent: boolean;
	}>,
) {
	const runs = new Map<string, FakeRun>();
	return {
		async runSubagent(options: Record<string, unknown>) {
			const index = launches.length + 1;
			const prompt = String(options.task ?? "");
			launches.push({
				model: typeof options.model === "string" ? options.model : undefined,
				prompt,
				skills: options.skills,
				skillsPresent: Object.hasOwn(options, "skills"),
			});
			const runId = `workflow_api_fake_${index}`;
			const attemptId = `attempt_${index}`;
			const runsDir = String(options.runsDir ?? ".pi/agent/runs");
			const artifactDir = resolve(cwd, runsDir, runId, "attempts", attemptId);
			await mkdir(artifactDir, { recursive: true });
			await Promise.all([
				writeFile(join(artifactDir, "output.log"), outputFor(prompt)),
				writeFile(join(artifactDir, "stderr.log"), ""),
				writeFile(
					join(artifactDir, "result.json"),
					JSON.stringify({
						status: "completed",
						startedAt: new Date(Date.now() - 10).toISOString(),
						completedAt: new Date().toISOString(),
						exitCode: 0,
						metadata: {
							provider: "probe",
							model:
								typeof options.model === "string"
									? options.model
									: "probe/unknown",
							usage: {
								inputTokens: index * 100,
								outputTokens: index * 10,
								totalTokens: index * 110,
								cachedInputTokens: index * 20,
								cacheRead: index * 20,
								cacheWrite: index * 5,
								reasoningTokens: index,
								costUsd: index / 100,
							},
						},
					}),
				),
			]);
			runs.set(runId, { runId, attemptId, artifactDir });
			return { runId, attemptId, status: "running" };
		},
		async getSubagentStatus({ runId }: { runId: string }) {
			const run = runs.get(runId);
			if (!run) return null;
			return {
				runId,
				attemptId: run.attemptId,
				backend: "headless",
				status: "completed",
				failureKind: null,
				startedAt: new Date(Date.now() - 10).toISOString(),
				completedAt: new Date().toISOString(),
				logs: [
					{ type: "output", path: "output.log", artifactCwd: run.artifactDir },
					{ type: "stderr", path: "stderr.log", artifactCwd: run.artifactDir },
					{ type: "result", path: "result.json", artifactCwd: run.artifactDir },
				],
				metadata: { contextLengthExceeded: false },
				attempts: [{ attemptId: run.attemptId, status: "completed" }],
			};
		},
		async reconcileSubagentRun() {
			return {};
		},
		async interruptSubagent() {
			return {};
		},
	};
}

async function makeProject(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-maestro-workflow-api-"));
	temporaryProjects.push(cwd);
	const agentDir = join(cwd, ".pi", "agents");
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(agentDir, "workflow-api-scout.md"),
		[
			"---",
			"name: workflow-api-scout",
			"description: Read-only fake agent for the workflow API spike",
			"tools: read",
			"---",
			"Follow the workflow stage prompt.",
		].join("\n"),
	);
	return cwd;
}

afterEach(async () => {
	const hook = await loadInternalFakeBackendHook();
	hook.setSubagentApiForTests(undefined);
	await Promise.all(
		temporaryProjects.splice(0).map((path) =>
			rm(path, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 20,
			}),
		),
	);
});

describe("pi-workflow 0.11 programmatic API spike", () => {
	test("public parsing and loading validate the flat workflow topology", async () => {
		const raw = JSON.parse(await readFile(specPath, "utf8"));
		const parsed = parseWorkflow(raw);
		const loaded = await loadWorkflowSpec(specPath, fixtureDir);

		expect(parsed.artifactGraph.stages.map((stage) => stage.id)).toEqual([
			"implement",
			"reviewers-opus",
			"reviewers-fable",
			"reviewers-grok",
			"normalize-findings",
			"implement-decisions",
			"decision-coverage",
		]);
		expect(loaded.spec.name).toBe("workflow-api-spike");
		expect(() =>
			parseWorkflow({
				...raw,
				executionProfiles: {
					broken: { missingStage: { model: "probe/nope" } },
				},
			}),
		).toThrow(/missingStage/);
	});

	test("public launch runs single/foreach/support/single/support with profiled models", async () => {
		const cwd = await makeProject();
		const launches: Array<{
			model?: string;
			prompt: string;
			skills: unknown;
			skillsPresent: boolean;
		}> = [];
		const hook = await loadInternalFakeBackendHook();
		hook.setSubagentApiForTests(await makeFakeSubagentApi(cwd, launches));

		const started = await runWorkflowSpec(specPath, cwd, {
			task: "Exercise the workflow cutover API without real models.",
			runId: "workflow_api_spike",
			executionProfile: "three-model-review",
			availableModels: [
				{ provider: "probe", id: "implementer", fullId: "probe/implementer" },
				{ provider: "probe", id: "opus", fullId: "probe/opus" },
				{ provider: "probe", id: "fable", fullId: "probe/fable" },
				{ provider: "probe", id: "grok", fullId: "probe/grok" },
				{ provider: "probe", id: "decider", fullId: "probe/decider" },
			],
		});
		const completed = await waitForRun(cwd, started.runId, 20_000);
		const compiledText = await readFile(
			join(cwd, ".pi", "workflows", started.runId, "compiled.json"),
			"utf8",
		);
		const compiled = JSON.parse(compiledText) as {
			tasks: Array<{ stageId: string; runtime: { model?: string } }>;
		};

		expect(completed.status).toBe("completed");
		expect(completed.executionProfile?.name).toBe("three-model-review");
		expect(completed.tasks.map((task) => task.stageId)).toEqual(
			expect.arrayContaining([
				"implement",
				"reviewers-opus",
				"reviewers-fable",
				"reviewers-grok",
				"normalize-findings",
				"implement-decisions",
				"decision-coverage",
			]),
		);
		expect(launches.map((launch) => launch.model)).toEqual([
			"probe/implementer",
			"probe/opus",
			"probe/opus",
			"probe/fable",
			"probe/fable",
			"probe/grok",
			"probe/grok",
			"probe/decider",
		]);
		expect(launches.every((launch) => launch.skills === undefined)).toBe(true);
		expect(launches.every((launch) => !launch.skillsPresent)).toBe(true);
		expect(
			compiled.tasks
				.filter((task) => task.runtime.model)
				.map((task) => [task.stageId, task.runtime.model]),
		).toEqual(
			expect.arrayContaining([
				["implement", "probe/implementer"],
				["reviewers-opus", "probe/opus"],
				["reviewers-fable", "probe/fable"],
				["reviewers-grok", "probe/grok"],
				["implement-decisions", "probe/decider"],
			]),
		);
		// This is a negative capability proof: resolved reviewer identities are
		// persisted in the shared workflow cwd. Artifact projection alone cannot
		// keep them confidential from a later child with ordinary read access.
		expect(compiledText).toContain("probe/opus");
		expect(compiledText).toContain("probe/fable");
		expect(compiledText).toContain("probe/grok");

		const modelTasks = completed.tasks.filter((task) => task.usage);
		expect(modelTasks).toHaveLength(8);
		expect(
			modelTasks.map((task) => ({
				model: task.usage?.model,
				cacheRead: task.usage?.cacheReadInputTokens,
				cacheWrite: task.usage?.cacheCreationInputTokens,
			})),
		).toEqual([
			{ model: "probe/implementer", cacheRead: 20, cacheWrite: 5 },
			{ model: "probe/opus", cacheRead: 40, cacheWrite: 10 },
			{ model: "probe/opus", cacheRead: 60, cacheWrite: 15 },
			{ model: "probe/fable", cacheRead: 80, cacheWrite: 20 },
			{ model: "probe/fable", cacheRead: 100, cacheWrite: 25 },
			{ model: "probe/grok", cacheRead: 120, cacheWrite: 30 },
			{ model: "probe/grok", cacheRead: 140, cacheWrite: 35 },
			{ model: "probe/decider", cacheRead: 160, cacheWrite: 40 },
		]);
		expect(completed.usage).toMatchObject({
			source: "task-rollup",
			tasksReporting: 8,
			inputTokens: 3_600,
			outputTokens: 360,
			totalTokens: 3_960,
			cachedInputTokens: 720,
			cacheReadInputTokens: 720,
			cacheCreationInputTokens: 180,
			reasoningTokens: 36,
		});
		expect(completed.usage?.costUsd).toBeCloseTo(0.36);

		const firstReread = await refreshRun(cwd, completed.runId);
		const secondReread = await refreshRun(cwd, completed.runId);
		expect(firstReread.usage).toEqual(completed.usage);
		expect(secondReread.usage).toEqual(completed.usage);
		expect(
			secondReread.tasks
				.filter((task) => task.usage)
				.map((task) => task.usage?.attempts?.length),
		).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
	});

	test("documents the missing public prepare and fake-backend surfaces", async () => {
		const publicApi = await import("@agwab/pi-workflow");
		expect(publicApi.runWorkflowSpec).toBeTypeOf("function");
		expect("compileWorkflow" in publicApi).toBe(false);
		expect("applyWorkflowExecutionProfile" in publicApi).toBe(false);
		expect("setSubagentApiForTests" in publicApi).toBe(false);
	});
});
