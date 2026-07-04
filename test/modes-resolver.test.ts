import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getImplementOverrides,
	getModeRoleModel,
	type ImplementOverrides,
	setImplementOverrides,
} from "../packages/modes/src/settings.js";

function mockCtx(cwd: string): ExtensionContext {
	return {
		cwd,
		model: undefined,
		modelRegistry: {
			find: (provider: string, id: string) => ({
				provider,
				id,
				name: `${provider}/${id}`,
			}),
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "test-key",
				headers: {},
			}),
		},
	} as unknown as ExtensionContext;
}

describe("getModeRoleModel", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "modes-resolver-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		setImplementOverrides(undefined);
		delete process.env.MAESTRO_WORKER_MODEL;
		delete process.env.MAESTRO_WORKER_THINKING;
		delete process.env.MAESTRO_ANALYZE_MODEL;
		delete process.env.MAESTRO_ANALYZE_THINKING;
	});

	it("returns null when no env, no settings, no ctx.model", async () => {
		const result = await getModeRoleModel(mockCtx(root), "worker");
		expect(result).toBeNull();
	});

	it("resolves from MAESTRO_WORKER_MODEL env var", async () => {
		process.env.MAESTRO_WORKER_MODEL = "anthropic/claude-sonnet-4-20250514";
		const result = await getModeRoleModel(mockCtx(root), "worker");
		expect(result).not.toBeNull();
		expect(result!.modelId).toBe("anthropic/claude-sonnet-4-20250514");
		expect(result!.source).toBe("env");
	});

	it("includes thinking from env var", async () => {
		process.env.MAESTRO_WORKER_MODEL = "anthropic/claude-sonnet-4-20250514";
		process.env.MAESTRO_WORKER_THINKING = "high";
		const result = await getModeRoleModel(mockCtx(root), "worker");
		expect(result!.thinking).toBe("high");
	});

	it("ignores invalid thinking level from env", async () => {
		process.env.MAESTRO_WORKER_MODEL = "anthropic/claude-sonnet-4-20250514";
		process.env.MAESTRO_WORKER_THINKING = "extreme";
		const result = await getModeRoleModel(mockCtx(root), "worker");
		expect(result!.thinking).toBeUndefined();
	});

	it("CLI overrides take priority over env", async () => {
		process.env.MAESTRO_WORKER_MODEL = "anthropic/claude-sonnet-4-20250514";
		setImplementOverrides({
			workerModel: "openai/gpt-4o",
			workerThinking: "medium",
		});
		const result = await getModeRoleModel(mockCtx(root), "worker");
		expect(result!.modelId).toBe("openai/gpt-4o");
		expect(result!.thinking).toBe("medium");
		expect(result!.source).toBe("explicit");
	});

	it("resolves analyze role from env", async () => {
		process.env.MAESTRO_ANALYZE_MODEL = "anthropic/claude-sonnet-4-20250514";
		process.env.MAESTRO_ANALYZE_THINKING = "low";
		const result = await getModeRoleModel(mockCtx(root), "analyze");
		expect(result!.modelId).toBe("anthropic/claude-sonnet-4-20250514");
		expect(result!.thinking).toBe("low");
	});

	it("resolves from settings when no env", async () => {
		const piDir = join(root, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(
			join(piDir, "settings.json"),
			JSON.stringify({
				extensionConfig: {
					modes: {
						models: {
							worker: {
								model: "openai/gpt-4o",
								thinking: "minimal",
							},
						},
					},
				},
			}),
		);
		const result = await getModeRoleModel(mockCtx(root), "worker");
		expect(result).not.toBeNull();
		expect(result!.modelId).toBe("openai/gpt-4o");
		expect(result!.thinking).toBe("minimal");
		expect(result!.source).toBe("preset");
	});
});

describe("ImplementOverrides", () => {
	afterEach(() => {
		setImplementOverrides(undefined);
	});

	it("starts undefined", () => {
		expect(getImplementOverrides()).toBeUndefined();
	});

	it("set and get round-trips", () => {
		const o: ImplementOverrides = {
			workerModel: "openai/gpt-4o",
			workerThinking: "high",
		};
		setImplementOverrides(o);
		expect(getImplementOverrides()).toEqual(o);
	});

	it("can be cleared", () => {
		setImplementOverrides({ workerModel: "openai/gpt-4o" });
		setImplementOverrides(undefined);
		expect(getImplementOverrides()).toBeUndefined();
	});
});
