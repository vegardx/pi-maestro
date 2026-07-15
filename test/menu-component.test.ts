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
import { initTheme } from "@earendil-works/pi-coding-agent";
import { SettingsList } from "@earendil-works/pi-tui";
import {
	getSessionRoleOverride,
	resetSessionRoleOverrides,
	resetSessionSettingOverrides,
	setSessionSettingOverride,
} from "@vegardx/pi-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	childExtensionCandidates,
	createMaestroSettingsList,
	modelOptions,
} from "../packages/settings/src/menu.js";
import { readRoleLeaf, writeRoleLeaf } from "../packages/settings/src/model.js";
import { readLayeredExtensionConfig } from "../packages/settings/src/reader.js";

let root: string;
let prevAgentDir: string | undefined;

function fakeCtx(): ExtensionContext {
	return {
		cwd: root,
		model: { provider: "anthropic", id: "sonnet", name: "Sonnet" },
		modelRegistry: {
			find: (provider: string, id: string) => ({
				provider,
				id,
				name: `${provider}/${id}`,
				reasoning: true,
				thinkingLevelMap: id === "o3" ? { minimal: null } : {},
			}),
			getAll: () => [
				{
					provider: "anthropic",
					id: "sonnet",
					name: "Sonnet",
					reasoning: true,
					thinkingLevelMap: {},
				},
				{
					provider: "openai",
					id: "o3",
					name: "o3",
					reasoning: true,
					thinkingLevelMap: { minimal: null },
				},
			],
			hasConfiguredAuth: () => true,
		},
		ui: {
			theme: {
				fg: (_name: string, value: string) => value,
				bold: (value: string) => value,
			},
			notify: () => {},
		},
	} as unknown as ExtensionContext;
}

function writeSettings(data: unknown): void {
	mkdirSync(join(root, "agent"), { recursive: true });
	writeFileSync(join(root, "agent", "settings.json"), JSON.stringify(data));
}

beforeEach(() => {
	initTheme("dark");
	root = mkdtempSync(join(tmpdir(), "maestro-hierarchy-"));
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	writeSettings({
		models: {
			profiles: {
				opus: {
					targets: ["anthropic/sonnet"],
					roles: {
						worker: {
							models: ["anthropic/sonnet", "openai/o3"],
							efforts: ["high", "medium"],
						},
					},
				},
			},
		},
	});
	resetSessionRoleOverrides();
	resetSessionSettingOverrides();
});

afterEach(() => {
	resetSessionRoleOverrides();
	resetSessionSettingOverrides();
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	rmSync(root, { recursive: true, force: true });
});

describe("hierarchical Maestro settings", () => {
	it("uses core SettingsList with search and standard cancellation", () => {
		let cancelled = false;
		const list = createMaestroSettingsList(fakeCtx(), () => {
			cancelled = true;
		});
		expect(list).toBeInstanceOf(SettingsList);
		expect(list.render(100).join("\n")).toContain("Session model");
		list.handleInput("Profiles");
		expect(list.render(100).join("\n")).toContain("Profiles");
		list.handleInput("\x1b");
		expect(cancelled).toBe(true);
	});

	it("shows active profile and ordered default/alternate summaries", () => {
		const rendered = createMaestroSettingsList(fakeCtx(), () => {})
			.render(120)
			.join("\n");
		expect(rendered).toContain("Active profile");
		expect(rendered).toContain("opus");
		expect(rendered).toContain("anthropic/sonnet +1");
		expect(rendered).toContain("high +1");
	});

	it("replaces project arrays leaf-wise and preserves global siblings", () => {
		const ctx = fakeCtx();
		writeRoleLeaf(ctx, "opus", "worker", "models", "project", ["openai/o3"]);
		const pool = readRoleLeaf(ctx, "opus", "worker", "models");
		expect(pool.global).toEqual(["anthropic/sonnet", "openai/o3"]);
		expect(pool.project).toEqual(["openai/o3"]);
		expect(pool.effective).toEqual(["openai/o3"]);
		expect(readRoleLeaf(ctx, "opus", "worker", "efforts").effective).toEqual([
			"high",
			"medium",
		]);
	});

	it("writes session role arrays into the runtime-consumed typed store", () => {
		const ctx = fakeCtx();
		writeRoleLeaf(ctx, "opus", "worker", "models", "session", ["openai/o3"]);
		expect(getSessionRoleOverride("opus", "worker")?.models).toEqual([
			"openai/o3",
		]);
		expect(readRoleLeaf(ctx, "opus", "worker", "models").source).toBe(
			"session",
		);
	});

	it("rejects empty explicit arrays and resets scopes with undefined", () => {
		const ctx = fakeCtx();
		expect(() =>
			writeRoleLeaf(ctx, "opus", "worker", "models", "project", []),
		).toThrow(/cannot be empty/i);
		writeRoleLeaf(ctx, "opus", "worker", "models", "project", ["openai/o3"]);
		writeRoleLeaf(ctx, "opus", "worker", "models", "project", undefined);
		expect(
			readRoleLeaf(ctx, "opus", "worker", "models").project,
		).toBeUndefined();
	});

	it("filters effort options through model-supported levels", () => {
		const o3 = modelOptions(fakeCtx()).find(
			(model) => model.id === "openai/o3",
		);
		expect(o3?.supported).not.toContain("minimal");
		expect(o3?.supported).toContain("xhigh");
	});

	it("lists the FULL catalog — unauthenticated providers stay selectable", () => {
		// Regression: one authenticated provider (e.g. a gateway) used to hide
		// every other provider's models from profile selection entirely —
		// profile targets are configuration; the runtime role resolver filters
		// to authenticated models at spawn time.
		const ctx = fakeCtx();
		const registry = (
			ctx as unknown as {
				modelRegistry: {
					getAll: () => Array<{ provider: string; id: string; name: string }>;
					hasConfiguredAuth: (m: { provider: string }) => boolean;
				};
			}
		).modelRegistry;
		registry.getAll = () => [
			{ provider: "radicalai", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
			{ provider: "anthropic", id: "claude-fable-5", name: "Claude Fable 5" },
			{ provider: "grok", id: "grok-4.1", name: "Grok 4.1" },
		];
		registry.hasConfiguredAuth = (m) => m.provider === "radicalai";

		const options = modelOptions(ctx);
		expect(options.map((o) => o.id)).toEqual([
			"radicalai/gpt-5.6-sol",
			"anthropic/claude-fable-5",
			"grok/grok-4.1",
		]);
		expect(
			options.find((o) => o.id === "radicalai/gpt-5.6-sol")?.description,
		).toBe("available");
		expect(
			options.find((o) => o.id === "anthropic/claude-fable-5")?.description,
		).toBe("needs authentication");
		expect(options.find((o) => o.id === "grok/grok-4.1")?.description).toBe(
			"needs authentication",
		);
	});

	it("discovers child extensions, excludes Maestro, and leaves exact paths", () => {
		writeSettings({ packages: [root, "/ext/provider", "/ext/tools"] });
		expect(childExtensionCandidates(join(root, "agent"))).toEqual([
			root,
			"/ext/provider",
			"/ext/tools",
		]);
	});

	it("applies typed advanced session overrides to runtime readers", () => {
		setSessionSettingOverride("modes", "research.softMs", 1234);
		const { merged } = readLayeredExtensionConfig(root);
		expect((merged.modes.research as Record<string, unknown>).softMs).toBe(
			1234,
		);
	});

	it("persists exact ordered values rather than indexes", () => {
		const ctx = fakeCtx();
		writeRoleLeaf(ctx, "opus", "reviewer", "models", "project", [
			"openai/o3",
			"anthropic/sonnet",
		]);
		const raw = JSON.parse(
			readFileSync(join(root, ".pi", "settings.json"), "utf8"),
		);
		expect(raw.models.profiles.opus.roles.reviewer.models).toEqual([
			"openai/o3",
			"anthropic/sonnet",
		]);
	});
});
