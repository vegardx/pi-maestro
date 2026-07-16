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
	EXECUTION_POLICY_SETTINGS,
	WORKER_POLICY_SETTINGS,
	WORKTREE_SETTINGS,
} from "../packages/modes/src/setting-declarations.js";
import { readExecutionPolicySettings } from "../packages/modes/src/settings.js";
import {
	getSettingsCompletions,
	handleSettingsCommand,
} from "../packages/settings/src/command.js";
import { settingsRegistry } from "../packages/settings/src/registry.js";

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
		settingsRegistry.set("modes", [
			...EXECUTION_POLICY_SETTINGS,
			...WORKER_POLICY_SETTINGS,
		]);
		settingsRegistry.set("maestro", [...WORKTREE_SETTINGS]);
	});

	afterEach(() => {
		settingsRegistry.clear();
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

	describe("declared policy settings", () => {
		it("completes choices and round-trips string lists", () => {
			const ctx = mockCtx(root);
			expect(
				getSettingsCompletions("set modes.execution.isolation ", ctx),
			).toEqual(["lightweight", "strong", "none"]);
			handleSettingsCommand(
				'set maestro.worktree.copy [".env.local","fixtures/cache"]',
				ctx,
			);
			handleSettingsCommand("get maestro.worktree.copy", ctx);
			expect(ctx.messages.at(-1)).toContain(".env.local → fixtures/cache");
			expect(getSettingsCompletions("set maestro.worktree.copy ", ctx)).toEqual(
				['["path"]'],
			);
		});

		it("rejects invalid choices without persisting them", () => {
			const ctx = mockCtx(root);
			handleSettingsCommand("set modes.execution.isolation magical", ctx);
			expect(ctx.messages.at(-1)).toContain("Invalid value");
			expect(readExecutionPolicySettings(root).isolation).toBe("lightweight");
		});

		it("applies preset defaults and marks individual overrides custom", () => {
			const ctx = mockCtx(root);
			handleSettingsCommand("set modes.execution.preset strict", ctx);
			let policy = readExecutionPolicySettings(root);
			expect(policy).toMatchObject({
				preset: "strict",
				isolation: "strong",
				consequential: "confirm-mutations",
			});
			handleSettingsCommand("set modes.execution.isolation lightweight", ctx);
			policy = readExecutionPolicySettings(root);
			expect(policy.preset).toBe("custom");
			expect(policy.isolation).toBe("lightweight");
		});

		it("falls back to Guided when persisted values are invalid", () => {
			writeJson(join(root, ".pi", "settings.json"), {
				extensionConfig: {
					modes: {
						execution: { preset: "unsafe", isolation: "magic" },
					},
				},
			});
			expect(readExecutionPolicySettings(root)).toMatchObject({
				preset: "guided",
				isolation: "lightweight",
				fallback: "fail-closed",
			});
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

	describe("profile role arrays", () => {
		it("sets, gets, completes, and resets a project role leaf", () => {
			writeJson(join(root, ".pi", "settings.json"), {
				models: { profiles: { opus: { targets: ["anthropic/sonnet"] } } },
			});
			const ctx = mockCtx(root);
			const key = "models.profiles.opus.roles.reviewer.models";
			handleSettingsCommand(`set ${key} ["openai/o3","anthropic/sonnet"]`, ctx);
			let raw = JSON.parse(
				readFileSync(join(root, ".pi", "settings.json"), "utf8"),
			);
			expect(raw.models.profiles.opus.roles.reviewer.models).toEqual([
				"openai/o3",
				"anthropic/sonnet",
			]);
			handleSettingsCommand(`get ${key}`, ctx);
			expect(ctx.messages.at(-1)).toContain("openai/o3 → anthropic/sonnet");
			expect(
				getSettingsCompletions("get models.profiles.opus.roles.rev", ctx),
			).toContain(key);
			handleSettingsCommand(`reset ${key}`, ctx);
			raw = JSON.parse(
				readFileSync(join(root, ".pi", "settings.json"), "utf8"),
			);
			expect(raw.models.profiles.opus.roles?.reviewer).toBeUndefined();
		});

		it("supports typed session arrays without writing a file", () => {
			writeJson(join(root, ".pi", "settings.json"), {
				models: { profiles: { opus: { targets: ["anthropic/sonnet"] } } },
			});
			const ctx = mockCtx(root);
			const key = "models.profiles.opus.roles.worker.efforts";
			handleSettingsCommand(`set --session ${key} ["xhigh","high"]`, ctx);
			expect(ctx.messages.at(-1)).toContain("[session]");
			handleSettingsCommand(`get ${key}`, ctx);
			expect(ctx.messages.at(-1)).toContain("xhigh → high");
			handleSettingsCommand(`reset --session ${key}`, ctx);
			expect(ctx.messages.at(-1)).toContain("Reset");
		});

		it("rejects empty or non-array role policies", () => {
			const ctx = mockCtx(root);
			handleSettingsCommand(
				"set models.profiles.opus.roles.worker.models []",
				ctx,
			);
			expect(ctx.messages.at(-1)).toContain("non-empty JSON string array");
		});
	});

	describe("role one-liners", () => {
		let prevAgentDir: string | undefined;

		function roleCtx(
			overrides: { model?: unknown } = {},
		): ExtensionContext & { messages: string[] } {
			const messages: string[] = [];
			const entry = (provider: string, id: string, name: string) => ({
				provider,
				id,
				name,
				reasoning: true,
				thinkingLevelMap: id === "o3" ? { minimal: null } : {},
			});
			return {
				cwd: root,
				model:
					"model" in overrides
						? overrides.model
						: { provider: "anthropic", id: "sonnet", name: "Sonnet" },
				modelRegistry: {
					find: (provider: string, id: string) =>
						entry(provider, id, `${provider}/${id}`),
					getAll: () => [
						entry("anthropic", "sonnet", "Sonnet"),
						entry("openai", "o3", "o3"),
						entry("google", "gemini", "Gemini"),
					],
					hasConfiguredAuth: () => true,
				},
				ui: {
					notify: (msg: string) => {
						messages.push(msg);
					},
				},
				messages,
			} as unknown as ExtensionContext & { messages: string[] };
		}

		function readProject(): Record<string, unknown> {
			return JSON.parse(
				readFileSync(join(root, ".pi", "settings.json"), "utf8"),
			);
		}

		function workerModels(): unknown {
			const raw = readProject() as {
				models?: {
					profiles?: Record<
						string,
						{ roles?: Record<string, { models?: string[] }> }
					>;
				};
			};
			return raw.models?.profiles?.opus?.roles?.worker?.models;
		}

		beforeEach(() => {
			// Isolate global scope: role verbs read layered leaves, and the real
			// user-global settings must not leak into candidate/scope resolution.
			prevAgentDir = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = join(root, "agent");
			mkdirSync(join(root, "agent"), { recursive: true });
			writeJson(join(root, ".pi", "settings.json"), {
				models: {
					profiles: {
						opus: {
							targets: ["anthropic/sonnet"],
							roles: {
								worker: {
									models: ["anthropic/sonnet", "openai/o3"],
									efforts: ["high"],
								},
							},
						},
					},
				},
			});
		});

		afterEach(() => {
			if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		});

		it("errors clearly when no profile is active", () => {
			const ctx = roleCtx({ model: undefined });
			handleSettingsCommand("worker list", ctx);
			expect(ctx.messages[0]).toContain("No active profile");
		});

		it("lists the pool with default marker, effort, and scope source", () => {
			const ctx = roleCtx();
			handleSettingsCommand("worker", ctx);
			expect(ctx.messages[0]).toContain("worker · opus · scope: project");
			expect(ctx.messages[0]).toContain("1. anthropic/sonnet");
			expect(ctx.messages[0]).toContain("(default)");
			expect(ctx.messages[0]).toContain("2. openai/o3");
			expect(ctx.messages[0]).toContain("default effort: high");
			// `<role>` and `<role> list` are the same verb
			handleSettingsCommand("worker list", ctx);
			expect(ctx.messages[1]).toBe(ctx.messages[0]);
		});

		it("add appends without duplicates at the effective-source scope", () => {
			const ctx = roleCtx();
			handleSettingsCommand("worker add google/gemini", ctx);
			expect(workerModels()).toEqual([
				"anthropic/sonnet",
				"openai/o3",
				"google/gemini",
			]);
			handleSettingsCommand("worker add google/gemini", ctx);
			expect(ctx.messages.at(-1)).toContain("already in the worker pool");
			expect(workerModels()).toEqual([
				"anthropic/sonnet",
				"openai/o3",
				"google/gemini",
			]);
		});

		it("add rejects unknown models with a did-you-mean suggestion", () => {
			const ctx = roleCtx();
			handleSettingsCommand("worker add google/gemni", ctx);
			expect(ctx.messages[0]).toContain('Unknown model "google/gemni"');
			expect(ctx.messages[0]).toContain("Did you mean");
			expect(ctx.messages[0]).toContain("google/gemini");
			expect(workerModels()).toEqual(["anthropic/sonnet", "openai/o3"]);
		});

		it("remove drops a model and resets the leaf when it empties", () => {
			const ctx = roleCtx();
			handleSettingsCommand("worker remove openai/o3", ctx);
			expect(workerModels()).toEqual(["anthropic/sonnet"]);
			handleSettingsCommand("worker remove openai/o3", ctx);
			expect(ctx.messages.at(-1)).toContain("not in the worker pool");
			handleSettingsCommand("worker remove anthropic/sonnet", ctx);
			expect(ctx.messages.at(-1)).toContain("role follows session →");
			expect(workerModels()).toBeUndefined();
		});

		it("adds the session sentinel and lists it resolved", () => {
			const ctx = roleCtx();
			handleSettingsCommand("worker add session", ctx);
			expect(workerModels()).toEqual([
				"anthropic/sonnet",
				"openai/o3",
				"session",
			]);
			handleSettingsCommand("worker list", ctx);
			expect(ctx.messages.at(-1)).toContain(
				"3. session → anthropic/sonnet — session",
			);
			expect(getSettingsCompletions("worker add ses", ctx)).toEqual([
				"session",
			]);
		});

		it("default moves an existing model to the front and adds absent ones", () => {
			const ctx = roleCtx();
			handleSettingsCommand("worker default openai/o3", ctx);
			expect(workerModels()).toEqual(["openai/o3", "anthropic/sonnet"]);
			handleSettingsCommand("worker default google/gemini", ctx);
			expect(workerModels()).toEqual([
				"google/gemini",
				"openai/o3",
				"anthropic/sonnet",
			]);
		});

		it("effort sets the default level, keeping alternates after it", () => {
			const ctx = roleCtx();
			handleSettingsCommand("worker effort xhigh", ctx);
			const raw = readProject() as {
				models: {
					profiles: {
						opus: { roles: { worker: { efforts: string[] } } };
					};
				};
			};
			expect(raw.models.profiles.opus.roles.worker.efforts).toEqual([
				"xhigh",
				"high",
			]);
		});

		it("effort auto clears the leaf so the spawner picks per task", () => {
			const ctx = roleCtx();
			handleSettingsCommand("worker effort auto", ctx);
			expect(ctx.messages.at(-1)).toContain("worker.efforts = auto");
			const raw = readProject() as {
				models: {
					profiles: {
						opus: { roles: { worker: { efforts?: string[] } } };
					};
				};
			};
			expect(raw.models.profiles.opus.roles.worker.efforts).toBeUndefined();
			handleSettingsCommand("worker list", ctx);
			expect(ctx.messages.at(-1)).toContain("default effort: auto");
		});

		it("effort validates against the default model's supported set", () => {
			const ctx = roleCtx();
			// o3 becomes default; it does not support minimal
			handleSettingsCommand("worker default openai/o3", ctx);
			handleSettingsCommand("worker effort minimal", ctx);
			expect(ctx.messages.at(-1)).toContain("not supported by openai/o3");
			handleSettingsCommand("worker effort banana", ctx);
			expect(ctx.messages.at(-1)).toContain("not supported");
			expect(ctx.messages.at(-1)).toContain("Supported:");
		});

		it("rejects unknown verbs with the verb list", () => {
			const ctx = roleCtx();
			handleSettingsCommand("worker frobnicate", ctx);
			expect(ctx.messages[0]).toContain('Unknown verb "frobnicate"');
			expect(ctx.messages[0]).toContain("list, add, remove, default, effort");
		});

		it("completes roles, verbs, candidate models, and supported efforts", () => {
			const ctx = roleCtx();
			expect(getSettingsCompletions("wor", ctx)).toContain("worker");
			expect(getSettingsCompletions("worker ", ctx)).toEqual([
				"list",
				"add",
				"remove",
				"default",
				"effort",
			]);
			expect(getSettingsCompletions("worker ad", ctx)).toEqual(["add"]);
			expect(getSettingsCompletions("worker add ", ctx)).toContain(
				"google/gemini",
			);
			expect(getSettingsCompletions("worker add anthropic/", ctx)).toEqual([
				"anthropic/sonnet",
			]);
			// worker's default model is Sonnet — every level is supported
			expect(getSettingsCompletions("worker effort ", ctx)).toContain("xhigh");
			expect(getSettingsCompletions("worker effort x", ctx)).toEqual(["xhigh"]);
			expect(getSettingsCompletions("worker effort a", ctx)).toEqual(["auto"]);
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
