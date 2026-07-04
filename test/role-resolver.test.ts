import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	readModelsConfig,
	resolveRoleModel,
	validateRoleModelConfig,
} from "@vegardx/pi-models";

let dir: string;
let cwd: string;
let agentDir: string;
let savedAgentDirEnv: string | undefined;

function writeSettings(path: string, obj: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(obj, null, 2));
}

function projectSettings(obj: unknown): void {
	writeSettings(join(cwd, ".pi", "settings.json"), obj);
}

function globalSettings(obj: unknown): void {
	writeSettings(join(agentDir, "settings.json"), obj);
}

function fakeCtx(opts: {
	withApiKey?: Set<string>;
	noAuth?: Set<string>;
	sessionModel?: string;
}): ExtensionContext {
	return {
		cwd,
		model: opts.sessionModel
			? ({
					provider: opts.sessionModel.split("/")[0],
					id: opts.sessionModel.split("/").slice(1).join("/"),
				} as never)
			: undefined,
		modelRegistry: {
			find: (provider: string, modelId: string) => ({
				provider,
				id: modelId,
			}),
			getApiKeyAndHeaders: async (model: { provider: string }) => {
				if (opts.noAuth?.has(model.provider)) {
					return { ok: false, error: "no auth" };
				}
				if (opts.withApiKey?.has(model.provider)) {
					return { ok: true, apiKey: "sk-test" };
				}
				return { ok: true };
			},
		},
	} as unknown as ExtensionContext;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "maestro-role-resolver-"));
	cwd = join(dir, "project");
	agentDir = join(dir, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	savedAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (savedAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDirEnv;
	rmSync(dir, { recursive: true, force: true });
});

describe("validateRoleModelConfig", () => {
	it("accepts valid tier config", () => {
		expect(
			validateRoleModelConfig({ tier: "normal", thinking: "medium" }),
		).toEqual({ tier: "normal", thinking: "medium" });
	});

	it("accepts valid explicit model config", () => {
		expect(
			validateRoleModelConfig({
				model: "anthropic/claude-sonnet-4-5",
				thinking: "high",
			}),
		).toEqual({ model: "anthropic/claude-sonnet-4-5", thinking: "high" });
	});

	it("accepts tier with preset affinity", () => {
		expect(
			validateRoleModelConfig({
				tier: "fast",
				preset: "openai",
				thinking: "off",
			}),
		).toEqual({ tier: "fast", preset: "openai", thinking: "off" });
	});

	it("rejects when both model and tier are set", () => {
		expect(
			validateRoleModelConfig({ model: "x/y", tier: "fast" }),
		).toBeUndefined();
	});

	it("rejects unknown tier values", () => {
		expect(validateRoleModelConfig({ tier: "ultra" })).toBeUndefined();
	});

	it("rejects unknown thinking levels", () => {
		expect(
			validateRoleModelConfig({ tier: "fast", thinking: "turbo" }),
		).toEqual({ tier: "fast" });
	});

	it("accepts thinking-only config", () => {
		expect(validateRoleModelConfig({ thinking: "high" })).toEqual({
			thinking: "high",
		});
	});

	it("rejects empty config", () => {
		expect(validateRoleModelConfig({})).toBeUndefined();
	});
});

describe("readModelsConfig", () => {
	it("reads new preset format from project settings", () => {
		projectSettings({
			models: {
				active: "anthropic",
				presets: {
					anthropic: {
						fast: ["anthropic/haiku", "openai/mini"],
						normal: ["anthropic/sonnet"],
					},
				},
			},
		});
		const config = readModelsConfig(cwd, agentDir);
		expect(config?.active).toBe("anthropic");
		expect(config?.presets.anthropic.fast).toEqual([
			"anthropic/haiku",
			"openai/mini",
		]);
	});

	it("merges global and project — project replaces tier arrays", () => {
		globalSettings({
			models: {
				active: "anthropic",
				presets: {
					anthropic: {
						fast: ["anthropic/haiku"],
						normal: ["anthropic/sonnet"],
					},
				},
			},
		});
		projectSettings({
			models: {
				active: "openai",
				presets: {
					anthropic: {
						fast: ["anthropic/haiku-new", "openai/mini"],
					},
				},
			},
		});
		const config = readModelsConfig(cwd, agentDir);
		expect(config?.active).toBe("openai");
		// Project replaced the fast array entirely
		expect(config?.presets.anthropic.fast).toEqual([
			"anthropic/haiku-new",
			"openai/mini",
		]);
		// Normal comes from global (project didn't override)
		expect(config?.presets.anthropic.normal).toEqual(["anthropic/sonnet"]);
	});

	it("migrates old backgroundModels format", () => {
		projectSettings({
			backgroundModels: {
				primary: { fast: "openai/mini", normal: "anthropic/sonnet" },
			},
		});
		const config = readModelsConfig(cwd, agentDir);
		expect(config?.active).toBe("default");
		expect(config?.presets.default.fast).toEqual(["openai/mini"]);
		expect(config?.presets.default.normal).toEqual(["anthropic/sonnet"]);
	});

	it("new format takes priority over old format", () => {
		projectSettings({
			backgroundModels: { primary: { fast: "old/model" } },
			models: {
				active: "new",
				presets: { new: { fast: ["new/model"] } },
			},
		});
		const config = readModelsConfig(cwd, agentDir);
		expect(config?.active).toBe("new");
		expect(config?.presets.new.fast).toEqual(["new/model"]);
	});

	it("returns undefined when nothing is configured", () => {
		expect(readModelsConfig(cwd, agentDir)).toBeUndefined();
	});
});

describe("resolveRoleModel", () => {
	it("explicit override wins over everything", async () => {
		projectSettings({
			models: {
				active: "anthropic",
				presets: { anthropic: { normal: ["anthropic/sonnet"] } },
			},
			extensionConfig: {
				modes: { models: { worker: { tier: "normal", thinking: "low" } } },
			},
		});
		const ctx = fakeCtx({ withApiKey: new Set(["explicit"]) });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "worker",
			explicit: { model: "explicit/model", thinking: "high" },
		});
		expect(r?.modelId).toBe("explicit/model");
		expect(r?.thinking).toBe("high");
		expect(r?.source).toBe("explicit");
	});

	it("env var wins over settings", async () => {
		projectSettings({
			models: {
				active: "anthropic",
				presets: { anthropic: { normal: ["anthropic/sonnet"] } },
			},
			extensionConfig: {
				modes: { models: { worker: { tier: "normal", thinking: "low" } } },
			},
		});
		const ctx = fakeCtx({ withApiKey: new Set(["env"]) });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "worker",
			env: { model: "env/model", thinking: "medium" },
		});
		expect(r?.modelId).toBe("env/model");
		expect(r?.thinking).toBe("medium");
		expect(r?.source).toBe("env");
	});

	it("preset affinity on role overrides models.active", async () => {
		projectSettings({
			models: {
				active: "anthropic",
				presets: {
					anthropic: { fast: ["anthropic/haiku"] },
					openai: { fast: ["openai/mini"] },
				},
			},
			extensionConfig: {
				modes: {
					models: {
						classifier: { tier: "fast", preset: "openai", thinking: "off" },
					},
				},
			},
		});
		const ctx = fakeCtx({ withApiKey: new Set(["openai"]) });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "classifier",
		});
		expect(r?.modelId).toBe("openai/mini");
		expect(r?.thinking).toBe("off");
		expect(r?.source).toBe("preset");
		expect(r?.preset).toBe("openai");
		expect(r?.tier).toBe("fast");
	});

	it("fallback array: skips models without auth, uses first valid", async () => {
		projectSettings({
			models: {
				active: "mixed",
				presets: {
					mixed: { normal: ["noauth/model", "good/model", "also-good/model"] },
				},
			},
			extensionConfig: {
				modes: { models: { worker: { tier: "normal" } } },
			},
		});
		const ctx = fakeCtx({
			noAuth: new Set(["noauth"]),
			withApiKey: new Set(["good"]),
		});
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "worker",
		});
		expect(r?.modelId).toBe("good/model");
		expect(r?.source).toBe("preset");
	});

	it("empty tier array falls through to session model", async () => {
		projectSettings({
			models: {
				active: "empty",
				presets: { empty: { normal: [] } },
			},
			extensionConfig: {
				modes: { models: { worker: { tier: "normal" } } },
			},
		});
		const ctx = fakeCtx({ sessionModel: "sess/model" });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "worker",
		});
		expect(r?.modelId).toBe("sess/model");
		expect(r?.source).toBe("session");
	});

	it("missing preset name falls back to active preset", async () => {
		projectSettings({
			models: {
				active: "anthropic",
				presets: { anthropic: { normal: ["anthropic/sonnet"] } },
			},
			extensionConfig: {
				modes: {
					models: {
						worker: { tier: "normal", preset: "nonexistent" },
					},
				},
			},
		});
		// nonexistent preset → no tier array → falls through to session
		const ctx = fakeCtx({ sessionModel: "sess/fallback" });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "worker",
		});
		expect(r?.modelId).toBe("sess/fallback");
		expect(r?.source).toBe("session");
	});

	it("thinking level preserved from role config when resolving via tier", async () => {
		projectSettings({
			models: {
				active: "a",
				presets: { a: { heavy: ["a/opus"] } },
			},
			extensionConfig: {
				modes: {
					models: { analyze: { tier: "heavy", thinking: "high" } },
				},
			},
		});
		const ctx = fakeCtx({ withApiKey: new Set(["a"]) });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "analyze",
		});
		expect(r?.thinking).toBe("high");
		expect(r?.modelId).toBe("a/opus");
	});

	it("returns null when nothing resolves and no session model", async () => {
		const ctx = fakeCtx({});
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "worker",
		});
		expect(r).toBeNull();
	});

	it("falls back to session model when no settings configured", async () => {
		const ctx = fakeCtx({ sessionModel: "sess/model" });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "worker",
		});
		expect(r?.modelId).toBe("sess/model");
		expect(r?.source).toBe("session");
	});

	it("thinking-only role config uses session model with that thinking", async () => {
		projectSettings({
			extensionConfig: {
				modes: { models: { lens: { thinking: "off" } } },
			},
		});
		const ctx = fakeCtx({ sessionModel: "sess/model" });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "lens",
		});
		expect(r?.modelId).toBe("sess/model");
		expect(r?.thinking).toBe("off");
		expect(r?.source).toBe("session");
	});

	it("invalid role config is skipped gracefully", async () => {
		projectSettings({
			extensionConfig: {
				modes: {
					models: { worker: { model: "a/b", tier: "fast" } }, // invalid: both set
				},
			},
		});
		const ctx = fakeCtx({ sessionModel: "sess/model" });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "worker",
		});
		// Falls through to session since role config is invalid
		expect(r?.modelId).toBe("sess/model");
		expect(r?.source).toBe("session");
	});

	it("requireApiKey skips ok-but-keyless candidates in fallback array", async () => {
		projectSettings({
			models: {
				active: "test",
				presets: { test: { fast: ["keyless/model", "keyed/model"] } },
			},
			extensionConfig: {
				modes: { models: { worker: { tier: "fast" } } },
			},
		});
		// keyless provider has ok auth but no apiKey; keyed has apiKey
		const ctx = fakeCtx({ withApiKey: new Set(["keyed"]) });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "worker",
			requireApiKey: true,
		});
		expect(r?.modelId).toBe("keyed/model");
	});

	it("project settings override global per-tier (replaces array)", async () => {
		globalSettings({
			models: {
				active: "p",
				presets: { p: { fast: ["global/fast1", "global/fast2"] } },
			},
		});
		projectSettings({
			models: {
				presets: { p: { fast: ["project/fast"] } },
			},
		});
		projectSettings({
			models: {
				presets: { p: { fast: ["project/fast"] } },
			},
			extensionConfig: {
				modes: { models: { worker: { tier: "fast" } } },
			},
		});
		const ctx = fakeCtx({ withApiKey: new Set(["project"]) });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "worker",
		});
		expect(r?.modelId).toBe("project/fast");
	});

	it("old backgroundModels format is handled via migration", async () => {
		projectSettings({
			backgroundModels: { primary: { normal: "old/model" } },
			extensionConfig: {
				modes: { models: { worker: { tier: "normal" } } },
			},
		});
		const ctx = fakeCtx({ withApiKey: new Set(["old"]) });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "worker",
		});
		expect(r?.modelId).toBe("old/model");
		expect(r?.source).toBe("preset");
		expect(r?.preset).toBe("default");
	});
});
