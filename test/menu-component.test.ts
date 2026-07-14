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
} from "@vegardx/pi-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	childExtensionCandidates,
	createMaestroSettingsList,
	modelOptions,
} from "../packages/settings/src/menu.js";
import { readRoleLeaf, writeRoleLeaf } from "../packages/settings/src/model.js";

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
			getAvailable: () => [
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
			getAll: () => [],
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
});

afterEach(() => {
	resetSessionRoleOverrides();
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

	it("discovers child extensions, excludes Maestro, and leaves exact paths", () => {
		writeSettings({ packages: [root, "/ext/provider", "/ext/tools"] });
		expect(childExtensionCandidates(join(root, "agent"))).toEqual([
			root,
			"/ext/provider",
			"/ext/tools",
		]);
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
