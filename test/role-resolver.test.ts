import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	readModelsConfig,
	resolveRoleModel,
	validateRoleModelConfig,
} from "@vegardx/pi-models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ─── Test setup ──────────────────────────────────────────────────────────────

let cwd: string;
let agentDir: string;

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
});
afterEach(() => {
	if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
});

// ─── validateRoleModelConfig ─────────────────────────────────────────────────

describe("validateRoleModelConfig", () => {
	it("accepts valid slot config", () => {
		const cfg = validateRoleModelConfig({ slot: "alternate", effort: "high" });
		expect(cfg).toEqual({ slot: "alternate", effort: "high" });
	});

	it("accepts valid explicit model config", () => {
		const cfg = validateRoleModelConfig({
			model: "anthropic/sonnet",
			effort: "medium",
		});
		expect(cfg).toEqual({ model: "anthropic/sonnet", effort: "medium" });
	});

	it("accepts slot with preset affinity", () => {
		const cfg = validateRoleModelConfig({
			slot: "alternate",
			preset: "openai",
			effort: "low",
		});
		expect(cfg).toEqual({ slot: "alternate", preset: "openai", effort: "low" });
	});

	it("rejects when both model and slot are set", () => {
		const cfg = validateRoleModelConfig({
			model: "x/y",
			slot: "alternate",
		});
		expect(cfg).toBeUndefined();
	});

	it("rejects unknown slot values", () => {
		const cfg = validateRoleModelConfig({ slot: "tertiary" });
		expect(cfg).toBeUndefined();
	});

	it("rejects unknown effort levels", () => {
		const cfg = validateRoleModelConfig({
			slot: "default",
			effort: "ultra",
		});
		expect(cfg).toEqual({ slot: "default" });
	});

	it("accepts effort-only config", () => {
		const cfg = validateRoleModelConfig({ effort: "xhigh" });
		expect(cfg).toEqual({ effort: "xhigh" });
	});

	it("rejects empty config", () => {
		expect(validateRoleModelConfig({})).toBeUndefined();
	});
});

// ─── readModelsConfig ────────────────────────────────────────────────────────

describe("readModelsConfig", () => {
	it("reads new preset format from project settings", () => {
		projectSettings({
			models: {
				active: "anthropic",
				presets: {
					anthropic: { default: "anthropic/sonnet", alternate: "openai/o3" },
				},
			},
		});
		const config = readModelsConfig(cwd, agentDir);
		expect(config?.active).toBe("anthropic");
		expect(config?.presets.anthropic.default.model).toBe("anthropic/sonnet");
		expect(config?.presets.anthropic.alternate?.model).toBe("openai/o3");
	});

	it("merges global and project — project wins per slot", () => {
		globalSettings({
			models: {
				active: "anthropic",
				presets: {
					anthropic: { default: "anthropic/haiku", alternate: "openai/mini" },
				},
			},
		});
		projectSettings({
			models: {
				active: "anthropic",
				presets: {
					anthropic: { default: "anthropic/sonnet" },
				},
			},
		});
		const config = readModelsConfig(cwd, agentDir);
		expect(config?.presets.anthropic.default.model).toBe("anthropic/sonnet");
		expect(config?.presets.anthropic.alternate?.model).toBe("openai/mini");
	});

	it("returns undefined when nothing is configured", () => {
		expect(readModelsConfig(cwd, agentDir)).toBeUndefined();
	});
});

// ─── resolveRoleModel ────────────────────────────────────────────────────────

describe("resolveRoleModel", () => {
	it("explicit override wins over everything", async () => {
		projectSettings({
			models: {
				active: "anthropic",
				presets: { anthropic: { default: "anthropic/sonnet" } },
			},
			extensionConfig: {
				modes: { models: { agent: { effort: "medium" } } },
			},
		});
		const ctx = fakeCtx({});
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "agent",
			explicit: { model: "openai/o3", effort: "xhigh" },
		});
		expect(r?.modelId).toBe("openai/o3");
		expect(r?.effort).toBe("xhigh");
		expect(r?.source).toBe("explicit");
	});

	it("env var wins over settings", async () => {
		projectSettings({
			models: {
				active: "anthropic",
				presets: { anthropic: { default: "anthropic/sonnet" } },
			},
			extensionConfig: {
				modes: { models: { agent: { effort: "low" } } },
			},
		});
		const ctx = fakeCtx({});
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "agent",
			env: { model: "openai/o3", effort: "high" },
		});
		expect(r?.modelId).toBe("openai/o3");
		expect(r?.effort).toBe("high");
		expect(r?.source).toBe("env");
	});

	it("preset affinity on role overrides models.active", async () => {
		projectSettings({
			models: {
				active: "anthropic",
				presets: {
					anthropic: { default: "anthropic/haiku" },
					openai: { default: "openai/mini" },
				},
			},
			extensionConfig: {
				modes: {
					models: {
						classifier: { preset: "openai", effort: "off" },
					},
				},
			},
		});
		const ctx = fakeCtx({});
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "classifier",
		});
		expect(r?.modelId).toBe("openai/mini");
		expect(r?.effort).toBe("off");
		expect(r?.preset).toBe("openai");
		expect(r?.slot).toBe("default");
	});

	it("slot resolves model from preset", async () => {
		projectSettings({
			models: {
				active: "test",
				presets: { test: { default: "good/model", alternate: "openai/o3" } },
			},
			extensionConfig: {
				modes: { models: { analyze: { slot: "alternate", effort: "xhigh" } } },
			},
		});
		const ctx = fakeCtx({});
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "analyze",
		});
		expect(r?.modelId).toBe("openai/o3");
		expect(r?.effort).toBe("xhigh");
		expect(r?.slot).toBe("alternate");
	});

	it("slot with no auth fails through to session model", async () => {
		projectSettings({
			models: {
				active: "bad",
				presets: { bad: { default: "noauth/model" } },
			},
			extensionConfig: {
				modes: { models: { agent: { effort: "high" } } },
			},
		});
		const ctx = fakeCtx({ sessionModel: "good/model" });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "agent",
		});
		expect(r?.modelId).toBe("good/model");
		expect(r?.source).toBe("session");
	});

	it("falls back to session model when no settings configured", async () => {
		const ctx = fakeCtx({ sessionModel: "anthropic/sonnet" });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "agent",
		});
		expect(r?.modelId).toBe("anthropic/sonnet");
		expect(r?.source).toBe("session");
	});

	it("effort from role config preserved when resolving via preset", async () => {
		projectSettings({
			models: {
				active: "a",
				presets: { a: { default: "good/model" } },
			},
			extensionConfig: {
				modes: { models: { analyze: { effort: "xhigh" } } },
			},
		});
		const ctx = fakeCtx({});
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "analyze",
		});
		expect(r?.effort).toBe("xhigh");
		expect(r?.modelId).toBe("good/model");
	});

	it("returns null when nothing resolves and no session model", async () => {
		const ctx = fakeCtx({});
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "agent",
		});
		expect(r).toBeNull();
	});

	it("effort-only role config uses session model with that effort", async () => {
		projectSettings({
			extensionConfig: {
				modes: { models: { agent: { effort: "low" } } },
			},
		});
		const ctx = fakeCtx({ sessionModel: "anthropic/sonnet" });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "agent",
		});
		expect(r?.modelId).toBe("anthropic/sonnet");
		expect(r?.effort).toBe("low");
		expect(r?.source).toBe("session");
	});

	it("requireApiKey: model without key fails through to session", async () => {
		projectSettings({
			models: {
				active: "test",
				presets: { test: { default: "keyless/model" } },
			},
			extensionConfig: {
				modes: { models: { agent: {} } },
			},
		});
		const ctx = fakeCtx({ sessionModel: "good/model" });
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "agent",
			requireApiKey: true,
		});
		expect(r?.modelId).toBe("good/model");
		expect(r?.source).toBe("session");
	});

	it("project settings override global per-slot", async () => {
		globalSettings({
			models: {
				active: "p",
				presets: { p: { default: "global/fast" } },
			},
		});
		projectSettings({
			models: {
				active: "p",
				presets: { p: { default: "project/fast" } },
			},
			extensionConfig: {
				modes: { models: { agent: { effort: "high" } } },
			},
		});
		const ctx = fakeCtx({});
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "agent",
		});
		expect(r?.modelId).toBe("project/fast");
		expect(r?.source).toBe("preset");
	});

	it("env effort used when role config has no effort", async () => {
		projectSettings({
			models: {
				active: "test",
				presets: { test: { default: "good/model" } },
			},
			extensionConfig: {
				modes: { models: { agent: { slot: "default" } } },
			},
		});
		const ctx = fakeCtx({});
		const r = await resolveRoleModel(ctx, {
			extension: "modes",
			role: "agent",
			env: { effort: "high" },
		});
		expect(r?.modelId).toBe("good/model");
		expect(r?.effort).toBe("high");
	});
});
