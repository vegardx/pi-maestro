import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getSettingsCompletions,
	handleSettingsCommand,
} from "../packages/settings/src/command.js";

function writeJson(path: string, data: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(data, null, 2));
}

function mockCtx(root: string): ExtensionContext & { messages: string[] } {
	const messages: string[] = [];
	return {
		cwd: root,
		model: undefined,
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: false }),
		},
		ui: {
			notify: (msg: string, _level?: string) => {
				messages.push(msg);
			},
		},
		messages,
	} as unknown as ExtensionContext & { messages: string[] };
}

describe("/settings command", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "settings-cmd-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	describe("show", () => {
		it("shows box with quick-start when no settings exist", () => {
			const ctx = mockCtx(root);
			handleSettingsCommand("show", ctx);
			expect(ctx.messages[0]).toContain("Maestro Configuration");
		});

		it("shows extension config with source", () => {
			writeJson(join(root, ".pi", "settings.json"), {
				extensionConfig: {
					modes: {
						maxWorkers: 4,
						models: { agent: { effort: "medium" } },
					},
				},
			});

			const ctx = mockCtx(root);
			handleSettingsCommand("show", ctx);
			expect(ctx.messages[0]).toContain("Maestro Configuration");
			expect(ctx.messages[0]).toContain("Extension: modes");
			expect(ctx.messages[0]).toContain("maxWorkers");
			expect(ctx.messages[0]).toContain("[project]");
		});

		it("shows model profiles section", () => {
			writeJson(join(root, ".pi", "settings.json"), {
				models: {
					profiles: {
						opus: {
							targets: ["anthropic/claude-sonnet-4-5"],
							roles: {
								reviewer: {
									models: ["openai/gpt-4o"],
									efforts: ["high"],
								},
							},
						},
					},
				},
			});

			const ctx = mockCtx(root);
			handleSettingsCommand("show", ctx);
			expect(ctx.messages[0]).toContain("Model profiles");
			expect(ctx.messages[0]).toContain("opus");
			expect(ctx.messages[0]).toContain("anthropic/claude-sonnet-4-5");
			expect(ctx.messages[0]).toContain("openai/gpt-4o");
		});
	});

	describe("get", () => {
		it("errors without key", () => {
			const ctx = mockCtx(root);
			handleSettingsCommand("get", ctx);
			expect(ctx.messages[0]).toContain("Usage");
		});

		it("returns value with source", () => {
			writeJson(join(root, ".pi", "settings.json"), {
				extensionConfig: { modes: { maxWorkers: 6 } },
			});

			const ctx = mockCtx(root);
			handleSettingsCommand("get modes.maxWorkers", ctx);
			expect(ctx.messages[0]).toContain("modes.maxWorkers = 6");
			expect(ctx.messages[0]).toContain("[project]");
		});

		it("reports not found for missing key", () => {
			const ctx = mockCtx(root);
			handleSettingsCommand("get modes.missing", ctx);
			expect(ctx.messages[0]).toMatch(/not found|No settings/);
		});
	});

	describe("set", () => {
		it("writes to project settings", () => {
			const ctx = mockCtx(root);
			handleSettingsCommand("set modes.models.agent.thinking high", ctx);
			expect(ctx.messages[0]).toContain("Set modes.models.agent.thinking");
			expect(ctx.messages[0]).toContain("high");
			expect(ctx.messages[0]).toContain("✓");

			const raw = JSON.parse(
				readFileSync(join(root, ".pi", "settings.json"), "utf8"),
			);
			expect(raw.extensionConfig.modes.models.agent.thinking).toBe("high");
		});

		it("parses JSON arrays", () => {
			const ctx = mockCtx(root);
			handleSettingsCommand('set modes.models.agent.fallback ["a","b"]', ctx);
			const raw = JSON.parse(
				readFileSync(join(root, ".pi", "settings.json"), "utf8"),
			);
			expect(raw.extensionConfig.modes.models.agent.fallback).toEqual([
				"a",
				"b",
			]);
		});

		it("writes to global with --global flag", () => {
			process.env.PI_CODING_AGENT_DIR = join(root, "global-agent");
			mkdirSync(join(root, "global-agent"), { recursive: true });

			const ctx = mockCtx(root);
			handleSettingsCommand("set --global modes.maxWorkers 8", ctx);
			expect(ctx.messages[0]).toContain("[global]");

			const raw = JSON.parse(
				readFileSync(join(root, "global-agent", "settings.json"), "utf8"),
			);
			expect(raw.extensionConfig.modes.maxWorkers).toBe(8);

			delete process.env.PI_CODING_AGENT_DIR;
		});
	});

	describe("reset", () => {
		it("removes a key from project settings", () => {
			writeJson(join(root, ".pi", "settings.json"), {
				extensionConfig: { modes: { maxWorkers: 4 } },
			});

			const ctx = mockCtx(root);
			handleSettingsCommand("reset modes.maxWorkers", ctx);
			expect(ctx.messages[0]).toContain("✓ Reset modes.maxWorkers");
			expect(ctx.messages[0]).toContain("was: 4");

			const raw = JSON.parse(
				readFileSync(join(root, ".pi", "settings.json"), "utf8"),
			);
			expect(raw.extensionConfig).toBeUndefined();
		});

		it("reports when key was not set", () => {
			const ctx = mockCtx(root);
			handleSettingsCommand("reset modes.nonexistent", ctx);
			expect(ctx.messages[0]).toContain("was not set");
		});
	});

	describe("profiles", () => {
		it("lists profiles and their tiers", () => {
			writeJson(join(root, ".pi", "settings.json"), {
				models: {
					profiles: {
						opus: {
							targets: ["anthropic/claude-sonnet-4-5"],
							review: { model: "openai/gpt-4o" },
						},
						gpt: { targets: ["openai/gpt-5.5"] },
					},
				},
			});

			const ctx = mockCtx(root);
			handleSettingsCommand("profiles", ctx);
			expect(ctx.messages[0]).toContain("opus");
			expect(ctx.messages[0]).toContain("gpt");
			expect(ctx.messages[0]).toContain("Switch profiles with /model");
		});

		it("reports when no profiles are configured", () => {
			const ctx = mockCtx(root);
			handleSettingsCommand("profiles", ctx);
			expect(ctx.messages[0]).toContain("No model profiles");
		});
	});

	describe("completions", () => {
		it("completes subcommands", () => {
			const ctx = mockCtx(root);
			const items = getSettingsCompletions("sh", ctx);
			expect(items).toContain("show");
		});

		it("completes extension keys", () => {
			writeJson(join(root, ".pi", "settings.json"), {
				extensionConfig: { modes: { maxWorkers: 4 } },
			});

			const ctx = mockCtx(root);
			const items = getSettingsCompletions("get modes", ctx);
			expect(items).toContain("modes.maxWorkers");
		});

		it("completes thinking levels for set", () => {
			writeJson(join(root, ".pi", "settings.json"), {
				extensionConfig: {
					modes: { models: { agent: { thinking: "medium" } } },
				},
			});

			const ctx = mockCtx(root);
			const items = getSettingsCompletions(
				"set modes.models.agent.thinking ",
				ctx,
			);
			expect(items).toContain("high");
			expect(items).toContain("off");
		});
	});
});
