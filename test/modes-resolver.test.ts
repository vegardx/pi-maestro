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

	let prevAgentDir: string | undefined;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "modes-resolver-"));
		// Isolate the GLOBAL config too: readModelsConfig reads global+project,
		// and unset roles now resolve through the active preset — so without
		// this the dev's real ~/.config/pi preset leaks in and "no settings"
		// isn't. Point the agent dir at an empty temp.
		prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(root, "empty-agent");
	});

	afterEach(() => {
		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		rmSync(root, { recursive: true, force: true });
		setImplementOverrides(undefined);
		delete process.env.MAESTRO_AGENT_MODEL;
		delete process.env.MAESTRO_AGENT_THINKING;
		delete process.env.MAESTRO_ANALYZE_MODEL;
		delete process.env.MAESTRO_ANALYZE_THINKING;
	});

	it("returns null when no env, no settings, no ctx.model", async () => {
		const result = await getModeRoleModel(mockCtx(root), "agent");
		expect(result).toBeNull();
	});

	it("resolves from MAESTRO_AGENT_MODEL env var", async () => {
		process.env.MAESTRO_AGENT_MODEL = "anthropic/claude-sonnet-4-20250514";
		const result = await getModeRoleModel(mockCtx(root), "agent");
		expect(result).not.toBeNull();
		expect(result!.modelId).toBe("anthropic/claude-sonnet-4-20250514");
		expect(result!.source).toBe("env");
	});

	it("includes thinking from env var", async () => {
		process.env.MAESTRO_AGENT_MODEL = "anthropic/claude-sonnet-4-20250514";
		process.env.MAESTRO_AGENT_THINKING = "high";
		const result = await getModeRoleModel(mockCtx(root), "agent");
		expect(result!.effort).toBe("high");
	});

	it("ignores invalid thinking level from env", async () => {
		process.env.MAESTRO_AGENT_MODEL = "anthropic/claude-sonnet-4-20250514";
		process.env.MAESTRO_AGENT_THINKING = "extreme";
		const result = await getModeRoleModel(mockCtx(root), "agent");
		expect(result!.effort).toBeUndefined();
	});

	it("CLI overrides take priority over env", async () => {
		process.env.MAESTRO_AGENT_MODEL = "anthropic/claude-sonnet-4-20250514";
		setImplementOverrides({
			agentModel: "openai/gpt-4o",
			agentThinking: "medium",
		});
		const result = await getModeRoleModel(mockCtx(root), "agent");
		expect(result!.modelId).toBe("openai/gpt-4o");
		expect(result!.effort).toBe("medium");
		expect(result!.source).toBe("explicit");
	});

	it("resolves analyze role from env", async () => {
		process.env.MAESTRO_ANALYZE_MODEL = "anthropic/claude-sonnet-4-20250514";
		process.env.MAESTRO_ANALYZE_THINKING = "low";
		const result = await getModeRoleModel(mockCtx(root), "analyze");
		expect(result!.modelId).toBe("anthropic/claude-sonnet-4-20250514");
		expect(result!.effort).toBe("low");
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
							agent: {
								model: "openai/gpt-4o",
								effort: "minimal",
							},
						},
					},
				},
			}),
		);
		const result = await getModeRoleModel(mockCtx(root), "agent");
		expect(result).not.toBeNull();
		expect(result!.modelId).toBe("openai/gpt-4o");
		expect(result!.effort).toBe("minimal");
		expect(result!.source).toBe("profile");
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
			agentModel: "openai/gpt-4o",
			agentThinking: "high",
		};
		setImplementOverrides(o);
		expect(getImplementOverrides()).toEqual(o);
	});

	it("can be cleared", () => {
		setImplementOverrides({ agentModel: "openai/gpt-4o" });
		setImplementOverrides(undefined);
		expect(getImplementOverrides()).toBeUndefined();
	});
});
