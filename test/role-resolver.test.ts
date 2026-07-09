import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	activeProfile,
	readModelsConfig,
	resolveRoleModel,
	resolveTierModel,
	validateRoleModelConfig,
} from "@vegardx/pi-models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ─── Test setup ──────────────────────────────────────────────────────────────

let cwd: string;
let agentDir: string;
let prevAgentDir: string | undefined;

function writeSettings(path: string, obj: Record<string, unknown>) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(obj));
}
function projectSettings(obj: Record<string, unknown>) {
	writeSettings(join(cwd, ".pi", "settings.json"), obj);
}
function globalSettings(obj: Record<string, unknown>) {
	writeSettings(join(agentDir, "settings.json"), obj);
}

function fakeCtx(opts: {
	withApiKey?: Set<string>;
	sessionModel?: string;
}): ExtensionContext {
	const models = new Map<string, { provider: string; id: string }>();
	models.set("anthropic/sonnet", { provider: "anthropic", id: "sonnet" });
	models.set("anthropic/haiku", { provider: "anthropic", id: "haiku" });
	models.set("openai/o3", { provider: "openai", id: "o3" });
	models.set("openai/mini", { provider: "openai", id: "mini" });
	models.set("good/model", { provider: "good", id: "model" });
	models.set("noauth/model", { provider: "noauth", id: "model" });
	models.set("keyless/model", { provider: "keyless", id: "model" });
	models.set("global/fast", { provider: "global", id: "fast" });
	models.set("project/fast", { provider: "project", id: "fast" });

	const withApiKey =
		opts.withApiKey ??
		new Set(["anthropic", "openai", "good", "global", "project"]);

	const sessionModel = opts.sessionModel
		? {
				provider: opts.sessionModel.split("/")[0],
				id: opts.sessionModel.split("/").slice(1).join("/"),
			}
		: undefined;

	return {
		cwd,
		model: sessionModel as any,
		modelRegistry: {
			find: (provider: string, id: string) => {
				const key = `${provider}/${id}`;
				const m = models.get(key);
				return m ? { ...m, api: "anthropic-messages" } : undefined;
			},
			getApiKeyAndHeaders: (model: any) => {
				const hasKey = withApiKey.has(model.provider);
				if (model.provider === "noauth") return Promise.resolve({ ok: false });
				if (model.provider === "keyless")
					return Promise.resolve({ ok: true, apiKey: undefined, headers: {} });
				return Promise.resolve({
					ok: true,
					apiKey: hasKey ? "sk-test" : undefined,
					headers: {},
				});
			},
			getAvailable: () => [],
		},
	} as unknown as ExtensionContext;
}

beforeEach(() => {
	cwd = join(
		tmpdir(),
		`pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	agentDir = join(cwd, ".pi-agent");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	// The resolver reads the global layer from PI_CODING_AGENT_DIR (it calls
	// readModelsConfig(ctx.cwd) with no explicit agentDir). Point it at our temp
	// so global settings are our fixtures — and the dev's real profile can't leak.
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(() => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
});

// ─── validateRoleModelConfig ─────────────────────────────────────────────────

describe("validateRoleModelConfig", () => {
	it("accepts explicit model config", () => {
		expect(
			validateRoleModelConfig({ model: "anthropic/sonnet", effort: "medium" }),
		).toEqual({ model: "anthropic/sonnet", effort: "medium" });
	});

	it("accepts effort-only config", () => {
		expect(validateRoleModelConfig({ effort: "xhigh" })).toEqual({
			effort: "xhigh",
		});
	});

	it("drops unknown effort levels", () => {
		expect(validateRoleModelConfig({ model: "x/y", effort: "ultra" })).toEqual({
			model: "x/y",
		});
	});

	it("rejects empty config", () => {
		expect(validateRoleModelConfig({})).toBeUndefined();
	});
});

// ─── readModelsConfig ────────────────────────────────────────────────────────

describe("readModelsConfig", () => {
	it("reads profiles from project settings", () => {
		projectSettings({
			models: {
				profiles: {
					opus: {
						targets: ["anthropic/sonnet"],
						review: { model: "openai/o3", effort: "high" },
					},
				},
			},
		});
		const config = readModelsConfig(cwd, agentDir);
		expect(config?.profiles.opus.targets).toEqual(["anthropic/sonnet"]);
		expect(config?.profiles.opus.review?.model).toBe("openai/o3");
	});

	it("merges global and project — project wins per tier, globals survive", () => {
		globalSettings({
			models: {
				profiles: {
					opus: {
						targets: ["anthropic/haiku"],
						fast: { model: "openai/mini" },
						review: { model: "global/fast" },
					},
				},
			},
		});
		projectSettings({
			models: {
				profiles: {
					opus: {
						targets: ["anthropic/sonnet"],
						review: { model: "openai/o3" },
					},
				},
			},
		});
		const config = readModelsConfig(cwd, agentDir);
		expect(config?.profiles.opus.targets).toEqual(["anthropic/sonnet"]);
		expect(config?.profiles.opus.review?.model).toBe("openai/o3");
		expect(config?.profiles.opus.fast?.model).toBe("openai/mini");
	});

	it("returns undefined when nothing is configured", () => {
		expect(readModelsConfig(cwd, agentDir)).toBeUndefined();
	});
});

// ─── activeProfile ───────────────────────────────────────────────────────────

describe("activeProfile", () => {
	it("matches the profile whose targets include the session model", () => {
		projectSettings({
			models: {
				profiles: {
					a: { targets: ["anthropic/sonnet", "anthropic/haiku"] },
					b: { targets: ["openai/o3"] },
				},
			},
		});
		const cfg = readModelsConfig(cwd, agentDir);
		expect(activeProfile(cfg, "anthropic/haiku")?.name).toBe("a");
		expect(activeProfile(cfg, "openai/o3")?.name).toBe("b");
		expect(activeProfile(cfg, "good/model")).toBeUndefined();
	});
});

// ─── resolveRoleModel ────────────────────────────────────────────────────────

describe("resolveRoleModel", () => {
	it("explicit override wins over everything", async () => {
		projectSettings({
			models: {
				profiles: {
					a: { targets: ["anthropic/sonnet"], work: { model: "good/model" } },
				},
			},
		});
		const ctx = fakeCtx({ sessionModel: "anthropic/sonnet" });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "agent",
			tier: "work",
			explicit: { model: "openai/o3", effort: "xhigh" },
		});
		expect(r?.modelId).toBe("openai/o3");
		expect(r?.effort).toBe("xhigh");
		expect(r?.source).toBe("explicit");
	});

	it("env var wins over profile/session", async () => {
		projectSettings({
			models: {
				profiles: {
					a: { targets: ["anthropic/sonnet"], work: { model: "good/model" } },
				},
			},
		});
		const ctx = fakeCtx({ sessionModel: "anthropic/sonnet" });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "agent",
			tier: "work",
			env: { model: "openai/o3", effort: "high" },
		});
		expect(r?.modelId).toBe("openai/o3");
		expect(r?.source).toBe("env");
	});

	it("per-role model escape hatch overrides the tier", async () => {
		projectSettings({
			models: {
				profiles: {
					a: { targets: ["anthropic/sonnet"], work: { model: "good/model" } },
				},
			},
			extensionConfig: {
				modes: { models: { agent: { model: "openai/o3", effort: "low" } } },
			},
		});
		const ctx = fakeCtx({ sessionModel: "anthropic/sonnet" });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "agent",
			tier: "work",
		});
		expect(r?.modelId).toBe("openai/o3");
		expect(r?.effort).toBe("low");
		expect(r?.source).toBe("profile");
	});

	it("resolves the tier's pinned model via the active profile", async () => {
		projectSettings({
			models: {
				profiles: {
					a: {
						targets: ["anthropic/sonnet"],
						review: { model: "openai/o3", effort: "high" },
					},
				},
			},
		});
		const ctx = fakeCtx({ sessionModel: "anthropic/sonnet" });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "reviewer",
			tier: "review",
		});
		expect(r?.modelId).toBe("openai/o3");
		expect(r?.effort).toBe("high");
		expect(r?.source).toBe("profile");
		expect(r?.tier).toBe("review");
		expect(r?.profile).toBe("a");
	});

	it("an unset tier tracks plan (the session model)", async () => {
		projectSettings({
			models: { profiles: { a: { targets: ["anthropic/sonnet"] } } },
		});
		const ctx = fakeCtx({ sessionModel: "anthropic/sonnet" });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "agent",
			tier: "work",
		});
		expect(r?.modelId).toBe("anthropic/sonnet");
		expect(r?.source).toBe("session");
	});

	it("falls back to the session model when no profile claims it", async () => {
		projectSettings({
			models: {
				profiles: {
					a: { targets: ["openai/o3"], work: { model: "good/model" } },
				},
			},
		});
		const ctx = fakeCtx({ sessionModel: "anthropic/sonnet" });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "agent",
			tier: "work",
		});
		expect(r?.modelId).toBe("anthropic/sonnet");
		expect(r?.source).toBe("session");
	});

	it("a pinned tier model without auth fails through to session", async () => {
		projectSettings({
			models: {
				profiles: {
					a: { targets: ["good/model"], work: { model: "noauth/model" } },
				},
			},
		});
		const ctx = fakeCtx({ sessionModel: "good/model" });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "agent",
			tier: "work",
		});
		expect(r?.modelId).toBe("good/model");
		expect(r?.source).toBe("session");
	});

	it("returns null when no session model and nothing resolves", async () => {
		const ctx = fakeCtx({});
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "agent",
			tier: "work",
		});
		expect(r).toBeNull();
	});

	it("effort from role config is preserved over the tier effort", async () => {
		projectSettings({
			models: {
				profiles: {
					a: {
						targets: ["good/model"],
						work: { model: "good/model", effort: "low" },
					},
				},
			},
			extensionConfig: {
				modes: { models: { agent: { effort: "xhigh" } } },
			},
		});
		const ctx = fakeCtx({ sessionModel: "good/model" });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "agent",
			tier: "work",
		});
		expect(r?.modelId).toBe("good/model");
		expect(r?.effort).toBe("xhigh");
	});

	it("effort-only role config uses the session model with that effort", async () => {
		projectSettings({
			extensionConfig: {
				modes: { models: { agent: { effort: "low" } } },
			},
		});
		const ctx = fakeCtx({ sessionModel: "anthropic/sonnet" });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "agent",
			tier: "work",
		});
		expect(r?.modelId).toBe("anthropic/sonnet");
		expect(r?.effort).toBe("low");
		expect(r?.source).toBe("session");
	});

	it("requireApiKey: a keyless tier model fails through to session", async () => {
		projectSettings({
			models: {
				profiles: {
					a: { targets: ["good/model"], work: { model: "keyless/model" } },
				},
			},
		});
		const ctx = fakeCtx({ sessionModel: "good/model" });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "agent",
			tier: "work",
			requireApiKey: true,
		});
		expect(r?.modelId).toBe("good/model");
		expect(r?.source).toBe("session");
	});

	it("project profile config overrides global", async () => {
		globalSettings({
			models: {
				profiles: {
					p: { targets: ["good/model"], work: { model: "global/fast" } },
				},
			},
		});
		projectSettings({
			models: {
				profiles: {
					p: { targets: ["good/model"], work: { model: "project/fast" } },
				},
			},
		});
		const ctx = fakeCtx({ sessionModel: "good/model" });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "agent",
			tier: "work",
		});
		expect(r?.modelId).toBe("project/fast");
		expect(r?.source).toBe("profile");
	});
});

// ─── resolveTierModel ────────────────────────────────────────────────────────

describe("resolveTierModel", () => {
	it("resolves the review tier's pinned model directly", async () => {
		projectSettings({
			models: {
				profiles: {
					a: {
						targets: ["anthropic/sonnet"],
						review: { model: "openai/o3", effort: "high" },
					},
				},
			},
		});
		const res = await resolveTierModel(
			fakeCtx({ sessionModel: "anthropic/sonnet" }),
			"review",
			{ effort: "high" },
		);
		expect(res?.modelId).toBe("openai/o3");
		expect(res?.effort).toBe("high");
		expect(res?.source).toBe("profile");
		expect(res?.tier).toBe("review");
	});

	it("returns the session model when the tier tracks plan", async () => {
		projectSettings({
			models: { profiles: { a: { targets: ["anthropic/sonnet"] } } },
		});
		const res = await resolveTierModel(
			fakeCtx({ sessionModel: "anthropic/sonnet" }),
			"review",
		);
		expect(res?.modelId).toBe("anthropic/sonnet");
		expect(res?.source).toBe("session");
	});

	it("returns null with no session model", async () => {
		expect(await resolveTierModel(fakeCtx({}), "review")).toBeNull();
	});
});
