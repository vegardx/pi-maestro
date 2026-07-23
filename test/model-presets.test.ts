import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	activePreset,
	readModelsConfig,
	resolveAgentAssignment,
	resolveExactModelSelection,
} from "@vegardx/pi-models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let cwd: string;
let agentDir: string;
let previousAgentDir: string | undefined;

function writeSettings(path: string, value: Record<string, unknown>) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}
function projectSettings(value: Record<string, unknown>) {
	writeSettings(join(cwd, ".pi", "settings.json"), value);
}
function globalSettings(value: Record<string, unknown>) {
	writeSettings(join(agentDir, "settings.json"), value);
}

function model(
	id: string,
	options?: { reasoning?: boolean; unsupported?: string[] },
) {
	const [provider, ...rest] = id.split("/");
	return {
		provider,
		id: rest.join("/"),
		name: id,
		api: "anthropic-messages",
		reasoning: options?.reasoning ?? true,
		thinkingLevelMap: Object.fromEntries(
			(options?.unsupported ?? []).map((effort) => [effort, null]),
		),
	};
}

function fakeCtx(options: {
	session?: string;
	unavailable?: readonly string[];
	keyless?: readonly string[];
}): ExtensionContext {
	const entries = new Map(
		[
			model("anthropic/sonnet", { unsupported: ["xhigh"] }),
			model("anthropic/haiku", { unsupported: ["high", "xhigh"] }),
			model("openai/o3"),
		].map((entry) => [`${entry.provider}/${entry.id}`, entry]),
	);
	const unavailable = new Set(options.unavailable ?? []);
	const keyless = new Set(options.keyless ?? []);
	return {
		cwd,
		model: options.session ? entries.get(options.session) : undefined,
		modelRegistry: {
			find: (provider: string, id: string) => entries.get(`${provider}/${id}`),
			getApiKeyAndHeaders: async (entry: { provider: string; id: string }) => {
				const id = `${entry.provider}/${entry.id}`;
				if (unavailable.has(id)) return { ok: false, error: "missing auth" };
				return {
					ok: true,
					apiKey: keyless.has(id) ? undefined : "test-key",
					headers: {},
				};
			},
		},
	} as unknown as ExtensionContext;
}

function configuredSettings() {
	return {
		models: {
			modelSets: {
				workers: {
					options: [
						{
							id: "fast",
							model: "anthropic/haiku",
							effort: "low",
							summary: "Fast implementation",
						},
						{
							id: "deep",
							model: "openai/o3",
							effort: "high",
							summary: "Deep implementation",
						},
					],
				},
			},
			presets: {
				main: {
					targets: ["anthropic/sonnet"],
					modelSets: { worker: "workers" },
				},
			},
		},
	};
}

beforeEach(() => {
	cwd = join(tmpdir(), `model-presets-${Date.now()}-${Math.random()}`);
	agentDir = join(cwd, ".agent");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
});

describe("model preset activation", () => {
	it("activates exactly by live /model target membership", () => {
		projectSettings(configuredSettings());
		const config = readModelsConfig(cwd, agentDir);
		expect(activePreset(config, "anthropic/sonnet")?.id).toBe("main");
		expect(activePreset(config, "openai/o3")).toBeUndefined();
	});

	it("rejects target overlap after layering", () => {
		globalSettings({
			models: {
				presets: { one: { targets: ["anthropic/sonnet"] } },
			},
		});
		projectSettings({
			models: {
				presets: { two: { targets: ["anthropic/sonnet"] } },
			},
		});
		expect(() => readModelsConfig(cwd, agentDir)).toThrow(
			/overlaps between one and two/,
		);
	});
});

describe("exact model-set selection", () => {
	it("returns the first authenticated exact pair with provenance and facts", async () => {
		projectSettings(configuredSettings());
		const result = await resolveExactModelSelection(
			fakeCtx({ session: "anthropic/sonnet" }),
			{ role: "worker" },
		);
		expect(result.selected).toMatchObject({
			presetId: "main",
			modelSetId: "workers",
			optionId: "fast",
			modelId: "anthropic/haiku",
			effort: "low",
			summary: "Fast implementation",
			source: "preset",
		});
		expect(result.candidates).toEqual([
			expect.objectContaining({ optionId: "fast", available: true }),
			expect.objectContaining({ optionId: "deep", available: true }),
		]);
	});

	it("resolves session in place and deduplicates concrete model/effort pairs", async () => {
		const settings = configuredSettings();
		settings.models.modelSets.workers.options = [
			{
				id: "live",
				model: "session",
				effort: "low",
				summary: "Live",
			},
			{
				id: "duplicate",
				model: "anthropic/sonnet",
				effort: "low",
				summary: "Duplicate",
			},
		] as typeof settings.models.modelSets.workers.options;
		projectSettings(settings);
		const result = await resolveExactModelSelection(
			fakeCtx({ session: "anthropic/sonnet" }),
			{ role: "worker" },
		);
		expect(result.candidates).toHaveLength(1);
		expect(result.selected?.modelId).toBe("anthropic/sonnet");
	});

	it("reports registry, auth, and effort compatibility without substitution", async () => {
		projectSettings(configuredSettings());
		const result = await resolveExactModelSelection(
			fakeCtx({
				session: "anthropic/sonnet",
				unavailable: ["anthropic/haiku"],
			}),
			{
				role: "worker",
				assignment: {
					presetId: "main",
					modelSetId: "workers",
					optionId: "fast",
					modelId: "anthropic/haiku",
					effort: "low",
				},
			},
		);
		expect(result.selected).toBeNull();
		expect(result.errors[0]?.code).toBe("explicit-option-unavailable");
		expect(result.candidates[0]).toMatchObject({
			registered: true,
			authenticated: false,
			available: false,
		});
	});

	it("rejects a persisted assignment from another preset/set", async () => {
		projectSettings(configuredSettings());
		const result = await resolveExactModelSelection(
			fakeCtx({ session: "anthropic/sonnet" }),
			{
				role: "worker",
				assignment: {
					presetId: "old",
					modelSetId: "old-workers",
					optionId: "fast",
					modelId: "anthropic/haiku",
				},
			},
		);
		expect(result.errors[0]?.code).toBe("explicit-assignment-mismatch");
	});

	it("builds an immutable planning assignment", async () => {
		projectSettings(configuredSettings());
		const result = await resolveAgentAssignment(
			fakeCtx({ session: "anthropic/sonnet" }),
			{
				agentId: "delivery/worker",
				kind: "worker",
				role: "worker",
				runtime: {
					mode: "full",
					transport: "headless",
					tools: {},
					session: "persistent",
					isolation: "strong",
				},
				focus: "Implement the delivery.",
				rationale: "Primary delivery worker.",
				inputContracts: [],
				outputContracts: ["bounded-report"],
				now: () => new Date("2026-01-01T00:00:00.000Z"),
			},
		);
		expect(result.assignment).toMatchObject({
			agentId: "delivery/worker",
			presetId: "main",
			modelSetId: "workers",
			optionId: "fast",
			resolvedAt: "2026-01-01T00:00:00.000Z",
		});
	});
});

describe("session is the fallback within a set", () => {
	function reviewPool(options: unknown[]) {
		return {
			models: {
				modelSets: { reviewers: { options } },
				presets: {
					main: {
						targets: ["anthropic/sonnet"],
						modelSets: { "correctness-review": "reviewers" },
					},
				},
			},
		};
	}

	it("prefers a concrete option over the session sentinel authored ahead of it", async () => {
		projectSettings(
			reviewPool([
				{ id: "own", model: "session", effort: "medium", summary: "Session" },
				{ id: "other", model: "openai/o3", effort: "high", summary: "Other" },
			]),
		);
		const result = await resolveExactModelSelection(
			fakeCtx({ session: "anthropic/sonnet" }),
			{ role: "correctness-review" },
		);
		// `own` is authored first, but session sorts to the back of the default pick.
		expect(result.selected).toMatchObject({
			optionId: "other",
			modelId: "openai/o3",
		});
		// Reported candidates keep authored order for /maestro explain.
		expect(result.candidates.map((c) => c.optionId)).toEqual(["own", "other"]);
	});

	it("lands on session only when no concrete option is available", async () => {
		projectSettings(
			reviewPool([
				{ id: "own", model: "session", effort: "medium", summary: "Session" },
				{ id: "other", model: "openai/o3", effort: "high", summary: "Other" },
			]),
		);
		const result = await resolveExactModelSelection(
			fakeCtx({ session: "anthropic/sonnet", unavailable: ["openai/o3"] }),
			{ role: "correctness-review" },
		);
		expect(result.selected).toMatchObject({
			optionId: "own",
			modelId: "anthropic/sonnet",
		});
	});

	it("keeps first-available among concretes, session untouched at the back", async () => {
		projectSettings(
			reviewPool([
				{ id: "own", model: "session", effort: "medium", summary: "Session" },
				{
					id: "fast",
					model: "anthropic/haiku",
					effort: "low",
					summary: "Fast",
				},
				{ id: "deep", model: "openai/o3", effort: "high", summary: "Deep" },
			]),
		);
		const result = await resolveExactModelSelection(
			fakeCtx({
				session: "anthropic/sonnet",
				unavailable: ["anthropic/haiku"],
			}),
			{ role: "correctness-review" },
		);
		expect(result.selected).toMatchObject({ optionId: "deep" });
	});
});

describe("unconfigured model fallback", () => {
	it("resolves every built-in role to one sensible session option", async () => {
		const result = await resolveExactModelSelection(
			fakeCtx({ session: "anthropic/sonnet" }),
			{ role: "correctness-review" },
		);
		expect(result.selected).toMatchObject({
			presetId: "session",
			modelSetId: "session",
			optionId: "session",
			modelId: "anthropic/sonnet",
			effort: "medium",
			source: "session",
		});
		expect(result.candidates).toHaveLength(1);
	});

	it("fails clearly when no live session model exists", async () => {
		const result = await resolveExactModelSelection(fakeCtx({}), {
			role: "worker",
		});
		expect(result.selected).toBeNull();
		expect(result.errors[0]?.code).toBe("no-session-model");
	});
});
