import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	resetSessionRoleOverrides,
	setSessionRoleOverride,
} from "@vegardx/pi-contracts";
import {
	activeProfile,
	effectiveRolePool,
	readModelsConfig,
	resolveRolePool,
	supportedEfforts,
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

function model(id: string, options?: { reasoning?: boolean; unsupported?: string[] }) {
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
	requireKeyless?: readonly string[];
}): ExtensionContext {
	const entries = new Map(
		[
			model("anthropic/sonnet", { unsupported: ["xhigh"] }),
			model("anthropic/haiku", { unsupported: ["high", "xhigh"] }),
			model("openai/o3"),
			model("openai/mini", { unsupported: ["high", "xhigh"] }),
			model("plain/basic", { reasoning: false }),
			model("global/one"),
			model("global/two"),
			model("project/one"),
		].map((entry) => [`${entry.provider}/${entry.id}`, entry]),
	);
	const unavailable = new Set(options.unavailable ?? []);
	const keyless = new Set(options.requireKeyless ?? []);
	const session = options.session ? entries.get(options.session) : undefined;
	return {
		cwd,
		model: session,
		modelRegistry: {
			find: (provider: string, id: string) => entries.get(`${provider}/${id}`),
			getApiKeyAndHeaders: async (entry: { provider: string; id: string }) => {
				const id = `${entry.provider}/${entry.id}`;
				if (unavailable.has(id)) return { ok: false };
				return {
					ok: true,
					apiKey: keyless.has(id) ? undefined : "test-key",
					headers: {},
				};
			},
		},
	} as unknown as ExtensionContext;
}

beforeEach(() => {
	cwd = join(tmpdir(), `role-pool-${Date.now()}-${Math.random()}`);
	agentDir = join(cwd, ".agent");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	resetSessionRoleOverrides();
});

afterEach(() => {
	resetSessionRoleOverrides();
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
});

describe("role profile parsing", () => {
	it("replaces arrays leaf-wise while retaining the other global leaf", () => {
		globalSettings({
			models: { profiles: { main: {
				targets: ["anthropic/sonnet"],
				roles: { worker: {
					models: ["global/one", "global/two"],
					efforts: ["medium", "low"],
				} },
			} } },
		});
		projectSettings({
			models: { profiles: { main: {
				roles: { worker: { models: ["project/one"] } },
			} } },
		});
		const cfg = readModelsConfig(cwd, agentDir)!;
		expect(cfg.profiles.main.roles.worker).toEqual({
			models: ["project/one"],
			efforts: ["medium", "low"],
		});
		const pool = effectiveRolePool(cfg, "worker", "anthropic/sonnet")!;
		expect(pool.provenance.models?.scope).toBe("project");
		expect(pool.provenance.efforts?.scope).toBe("global");
	});

	it("rejects malformed IDs, empty/duplicate arrays, efforts, and unknown roles", () => {
		projectSettings({ models: { profiles: { main: {
			targets: ["anthropic/sonnet"],
			roles: {
				worker: { models: ["bad"], efforts: ["ultra"] },
				reviewer: { models: ["openai/o3", "openai/o3"] },
				advisor: { models: [] },
				unknown: { models: ["openai/o3"] },
			},
		} } } });
		const roles = readModelsConfig(cwd, agentDir)!.profiles.main.roles;
		expect(roles).toEqual({});
	});

	it("fans legacy tiers out while direct role leaves win", () => {
		projectSettings({ models: { profiles: { main: {
			targets: ["anthropic/sonnet"],
			work: { model: "global/one", effort: "medium" },
			review: { model: "openai/o3", effort: "high" },
			fast: { model: "anthropic/haiku", effort: "low" },
			roles: { advisor: { models: ["project/one"] } },
		} } } });
		const profile = readModelsConfig(cwd, agentDir)!.profiles.main;
		for (const role of ["worker", "delegate"] as const) {
			expect(profile.roles[role]?.models).toEqual(["global/one"]);
		}
		for (const role of ["reviewer", "verifier"] as const) {
			expect(profile.roles[role]?.models).toEqual(["openai/o3"]);
		}
		expect(profile.roles.advisor).toEqual({
			models: ["project/one"], efforts: ["high"],
		});
		for (const role of [
			"research", "classifier", "plan-summarizer", "compact-summarizer",
		] as const) {
			expect(profile.roles[role]?.models).toEqual(["anthropic/haiku"]);
		}
		expect(effectiveRolePool(readModelsConfig(cwd, agentDir), "reviewer", "anthropic/sonnet")
			?.provenance.models).toMatchObject({ scope: "project", legacyTier: "review" });
	});

	it("derives active profiles only from exact target membership", () => {
		projectSettings({ models: { profiles: {
			a: { targets: ["anthropic/sonnet"] },
			b: { targets: ["openai/o3"] },
		} } });
		const cfg = readModelsConfig(cwd, agentDir);
		expect(activeProfile(cfg, "openai/o3")?.name).toBe("b");
		expect(activeProfile(cfg, "anthropic/haiku")).toBeUndefined();
	});
});

describe("role pool resolution", () => {
	function configure(role: string, models: string[], efforts = ["low", "high"]) {
		projectSettings({ models: { profiles: { main: {
			targets: ["anthropic/sonnet"],
			roles: { [role]: { models, efforts } },
		} } } });
	}

	it("walks ordered unavailable models before selecting the default", async () => {
		configure("research", ["openai/mini", "anthropic/haiku"]);
		const result = await resolveRolePool(
			fakeCtx({ session: "anthropic/sonnet", unavailable: ["openai/mini"] }),
			{ role: "research" },
		);
		expect(result.selected?.modelId).toBe("anthropic/haiku");
		expect(result.candidates.map((entry) => entry.modelId)).toEqual(["anthropic/haiku"]);
	});

	it("does not substitute an unavailable explicit model", async () => {
		configure("research", ["openai/mini", "anthropic/haiku"]);
		const result = await resolveRolePool(
			fakeCtx({ session: "anthropic/sonnet", unavailable: ["openai/mini"] }),
			{ role: "research", choice: { model: "openai/mini" } },
		);
		expect(result.selected).toBeNull();
		expect(result.errors[0]?.code).toBe("explicit-model-unavailable");
	});

	it("rejects an explicit model outside the effective pool", async () => {
		configure("reviewer", ["openai/o3"]);
		const result = await resolveRolePool(fakeCtx({ session: "anthropic/sonnet" }), {
			role: "reviewer", choice: { model: "anthropic/haiku" },
		});
		expect(result.errors[0]).toMatchObject({
			code: "explicit-model-not-allowed", modelId: "anthropic/haiku",
		});
	});

	it("intersects configured efforts with each model's support", async () => {
		configure("research", ["anthropic/haiku"], ["high", "low"]);
		const result = await resolveRolePool(fakeCtx({ session: "anthropic/sonnet" }), {
			role: "research",
		});
		expect(result.candidates[0]?.supportedEfforts).toEqual(["low"]);
		expect(result.selected?.effort).toBe("low");
	});

	it("rejects explicit disallowed and unsupported effort without clamping", async () => {
		configure("research", ["anthropic/haiku"], ["xhigh", "low"]);
		const unsupported = await resolveRolePool(fakeCtx({ session: "anthropic/sonnet" }), {
			role: "research", choice: { effort: "xhigh" },
		});
		expect(unsupported.selected).toBeNull();
		expect(unsupported.errors[0]?.code).toBe("explicit-effort-unsupported");
		const disallowed = await resolveRolePool(fakeCtx({ session: "anthropic/sonnet" }), {
			role: "research", choice: { effort: "medium" },
		});
		expect(disallowed.errors[0]?.code).toBe("explicit-effort-not-allowed");
	});

	it("falls back to the authenticated live session model only for omitted choice", async () => {
		configure("worker", ["global/one"]);
		const result = await resolveRolePool(
			fakeCtx({ session: "anthropic/sonnet", unavailable: ["global/one"] }),
			{ role: "worker" },
		);
		expect(result.selected).toMatchObject({
			modelId: "anthropic/sonnet", source: "session", profile: "main",
		});
	});

	it("uses session leaves above project/global and reports provenance", async () => {
		configure("reviewer", ["openai/o3"], ["high"]);
		setSessionRoleOverride("main", "reviewer", {
			models: ["anthropic/haiku"], efforts: ["low"],
		});
		const result = await resolveRolePool(fakeCtx({ session: "anthropic/sonnet" }), {
			role: "reviewer",
		});
		expect(result.selected?.modelId).toBe("anthropic/haiku");
		expect(result.provenance.models?.scope).toBe("session");
		expect(result.provenance.efforts?.scope).toBe("session");
		resetSessionRoleOverrides();
		expect((await resolveRolePool(fakeCtx({ session: "anthropic/sonnet" }), {
			role: "reviewer",
		})).selected?.modelId).toBe("openai/o3");
	});

	it("requires an API key when requested", async () => {
		configure("worker", ["global/one"]);
		const result = await resolveRolePool(
			fakeCtx({ requireKeyless: ["global/one", "anthropic/sonnet"], session: "anthropic/sonnet" }),
			{ role: "worker", requireApiKey: true },
		);
		expect(result.selected).toBeNull();
		expect(result.errors[0]?.code).toBe("no-model-available");
	});

	it("treats non-reasoning models as supporting only off", () => {
		expect(supportedEfforts(model("plain/basic", { reasoning: false }) as any)).toEqual(["off"]);
	});
});
