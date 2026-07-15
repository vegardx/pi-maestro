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
	rolePoolEditor,
	targetsEditor,
} from "../packages/settings/src/menu.js";
import {
	readProfileTargets,
	readRoleLeaf,
	writeRoleLeaf,
} from "../packages/settings/src/model.js";
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
				{
					provider: "google",
					id: "gemini",
					name: "Gemini",
					reasoning: true,
					thinkingLevelMap: {},
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

	it("shows active profile and an aligned full-pool models · effort table", () => {
		const rendered = createMaestroSettingsList(fakeCtx(), () => {})
			.render(160)
			.join("\n");
		expect(rendered).toContain("Active profile");
		expect(rendered).toContain("opus");
		// Full ordered pool joined with ›, no +N counts, default effort only.
		expect(rendered).toContain("anthropic/sonnet › openai/o3");
		expect(rendered).toContain("· high");
		expect(rendered).not.toContain("+1");
		expect(rendered).not.toContain("medium");
		// Unconfigured roles resolve the live session model and auto effort.
		expect(rendered).toContain("session → anthropic/sonnet");
		expect(rendered).toContain("· auto");
	});

	it("summarizes profiles by configured role names, not counts", () => {
		const ctx = fakeCtx();
		const list = createMaestroSettingsList(ctx, () => {});
		list.handleInput("Profiles");
		list.handleInput("\r");
		expect(list.render(160).join("\n")).toContain("active · worker");
	});

	it("refreshes profile rows after nested edits on every exit path", () => {
		const ctx = fakeCtx();
		const list = createMaestroSettingsList(ctx, () => {});
		list.handleInput("Profiles");
		list.handleInput("\r"); // open profiles menu
		list.handleInput("opus");
		list.handleInput("\r"); // open profile detail
		list.handleInput("reviewer");
		list.handleInput("\r"); // open the reviewer pool editor
		list.handleInput(" "); // toggle first candidate into the pool
		list.handleInput("\x1b"); // close editor → fresh role summary
		list.handleInput("\x1b"); // cancel profile detail (previously stale)
		expect(list.render(160).join("\n")).toContain("active · worker, reviewer");
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

	it("lists authenticated + referenced models, hiding the idle catalog", () => {
		// Candidate rule: authenticated registry models plus any id referenced
		// anywhere in config (targets or role models leaves, both scopes).
		// Unauthenticated + unreferenced models are hidden;
		// unauthenticated-but-referenced ones stay visible and selectable.
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
		// Referencing a known-but-unauthenticated model keeps it selectable.
		writeRoleLeaf(ctx, "opus", "reviewer", "models", "project", [
			"anthropic/claude-fable-5",
		]);

		const options = modelOptions(ctx);
		// Registry order first; referenced ids the registry does not know
		// (the fixture's anthropic/sonnet and openai/o3) trail with raw labels.
		expect(options.map((o) => o.id)).toEqual([
			"radicalai/gpt-5.6-sol",
			"anthropic/claude-fable-5",
			"anthropic/sonnet",
			"openai/o3",
		]);
		expect(
			options.find((o) => o.id === "radicalai/gpt-5.6-sol")?.description,
		).toBe("available");
		expect(
			options.find((o) => o.id === "anthropic/claude-fable-5")?.description,
		).toBe("needs authentication");
		expect(options.find((o) => o.id === "anthropic/sonnet")?.label).toBe(
			"anthropic/sonnet",
		);
		expect(options.some((o) => o.id === "grok/grok-4.1")).toBe(false);
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

	it("renders the pool first, ordered, checked, with the default marker", () => {
		const editor = rolePoolEditor(fakeCtx(), "opus", "worker", () => {});
		const out = editor.render(120).join("\n");
		expect(out).toContain("worker · opus · scope: global · effort: high");
		expect(out).toContain("[x] 1. Sonnet (anthropic) · default");
		expect(out).toContain("[x] 2. o3 (openai)");
		expect(out).toContain("[ ]    Gemini (google)");
		expect(out).toContain("space toggle");
	});

	it("space toggles membership through writeRoleLeaf at the active scope", () => {
		const ctx = fakeCtx();
		const editor = rolePoolEditor(ctx, "opus", "worker", () => {});
		editor.handleInput?.("\x1b[B"); // row 2 (o3)
		editor.handleInput?.("\x1b[B"); // candidate row (session sentinel)
		editor.handleInput?.("\x1b[B"); // candidate row (gemini)
		editor.handleInput?.(" ");
		expect(readRoleLeaf(ctx, "opus", "worker", "models").global).toEqual([
			"anthropic/sonnet",
			"openai/o3",
			"google/gemini",
		]);
		expect(editor.render(120).join("\n")).toContain("[x] 3. Gemini (google)");
		// The cursor followed the toggled row; a second space removes it again.
		editor.handleInput?.(" ");
		expect(readRoleLeaf(ctx, "opus", "worker", "models").global).toEqual([
			"anthropic/sonnet",
			"openai/o3",
		]);
	});

	it("+/- reorders checked rows and persists the exact order", () => {
		const ctx = fakeCtx();
		const editor = rolePoolEditor(ctx, "opus", "worker", () => {});
		editor.handleInput?.("-"); // default moves down
		expect(readRoleLeaf(ctx, "opus", "worker", "models").global).toEqual([
			"openai/o3",
			"anthropic/sonnet",
		]);
		expect(editor.render(120).join("\n")).toContain(
			"[x] 1. o3 (openai) · default",
		);
		editor.handleInput?.("+"); // cursor followed the row; move it back up
		expect(readRoleLeaf(ctx, "opus", "worker", "models").global).toEqual([
			"anthropic/sonnet",
			"openai/o3",
		]);
	});

	it("g switches the write scope between global and project", () => {
		const ctx = fakeCtx();
		const editor = rolePoolEditor(ctx, "opus", "worker", () => {});
		editor.handleInput?.("g");
		expect(editor.render(120).join("\n")).toContain("scope: project");
		editor.handleInput?.("\x1b[B");
		editor.handleInput?.("\x1b[B");
		editor.handleInput?.("\x1b[B");
		editor.handleInput?.(" ");
		const pool = readRoleLeaf(ctx, "opus", "worker", "models");
		expect(pool.project).toEqual([
			"anthropic/sonnet",
			"openai/o3",
			"google/gemini",
		]);
		expect(pool.global).toEqual(["anthropic/sonnet", "openai/o3"]);
	});

	it("e cycles the default effort and wraps to auto by clearing the leaf", () => {
		const ctx = fakeCtx();
		const editor = rolePoolEditor(ctx, "opus", "worker", () => {});
		editor.handleInput?.("e"); // high → xhigh (Sonnet supports all levels)
		expect(readRoleLeaf(ctx, "opus", "worker", "efforts").global).toEqual([
			"xhigh",
			"high",
			"medium",
		]);
		editor.handleInput?.("e"); // past the last level: auto — leaf deleted
		expect(
			readRoleLeaf(ctx, "opus", "worker", "efforts").global,
		).toBeUndefined();
		expect(editor.render(120).join("\n")).toContain("effort: auto");
		editor.handleInput?.("e"); // auto → first supported level
		expect(readRoleLeaf(ctx, "opus", "worker", "efforts").global).toEqual([
			"off",
		]);
		expect(editor.render(120).join("\n")).toContain("effort: off");
	});

	it("e stays within the default model's supported efforts", () => {
		const ctx = fakeCtx();
		writeRoleLeaf(ctx, "opus", "research", "models", "project", ["openai/o3"]);
		writeRoleLeaf(ctx, "opus", "research", "efforts", "project", ["high"]);
		const editor = rolePoolEditor(ctx, "opus", "research", () => {});
		const seen = new Set<string>();
		for (let press = 0; press < 6; press++) {
			editor.handleInput?.("e");
			seen.add(
				readRoleLeaf(ctx, "opus", "research", "efforts").project?.[0] ?? "",
			);
		}
		expect(seen.has("minimal")).toBe(false); // o3 maps minimal to null
		expect(seen.has("xhigh")).toBe(true);
	});

	it("enter and escape finish with a role summary", () => {
		let entered: string | undefined;
		let escaped: string | undefined;
		const byEnter = rolePoolEditor(fakeCtx(), "opus", "worker", (value) => {
			entered = value;
		});
		byEnter.handleInput?.("\r");
		expect(entered).toContain("anthropic/sonnet › openai/o3 · high");
		const byEscape = rolePoolEditor(fakeCtx(), "opus", "worker", (value) => {
			escaped = value;
		});
		byEscape.handleInput?.("\x1b");
		expect(escaped).toContain("anthropic/sonnet › openai/o3 · high");
	});

	it("opens the one-screen editor from the top-level active role rows", () => {
		const list = createMaestroSettingsList(fakeCtx(), () => {});
		list.handleInput("worker"); // search narrows to the worker role row
		list.handleInput("\r");
		expect(list.render(120).join("\n")).toContain(
			"worker · opus · scope: global",
		);
	});

	it("offers the session sentinel as an orderable pool entry", () => {
		const ctx = fakeCtx();
		const editor = rolePoolEditor(ctx, "opus", "worker", () => {});
		// Synthetic first candidate with a live resolved label.
		expect(editor.render(140).join("\n")).toContain(
			"[ ]    session → anthropic/sonnet",
		);
		editor.handleInput?.("\x1b[B"); // o3
		editor.handleInput?.("\x1b[B"); // session sentinel
		editor.handleInput?.(" "); // toggle it into the pool
		expect(readRoleLeaf(ctx, "opus", "worker", "models").global).toEqual([
			"anthropic/sonnet",
			"openai/o3",
			"session",
		]);
		expect(editor.render(140).join("\n")).toContain(
			"[x] 3. session → anthropic/sonnet",
		);
	});

	it("mounts the targets multi-select from a scope row and toggles write", () => {
		const ctx = fakeCtx();
		const editor = targetsEditor(ctx, "opus", () => {});
		let out = editor.render(120).join("\n");
		// Scope rows with counts; the fixture authors one global target.
		expect(out).toContain("project");
		expect(out).toContain("global");
		expect(out).toContain("1 target(s)");
		editor.handleInput?.("\x1b[B"); // project → global row
		editor.handleInput?.("\r"); // Enter mounts the multi-select
		out = editor.render(120).join("\n");
		expect(out).toContain("[x] Sonnet (anthropic)");
		expect(out).toContain("[ ] Gemini (google)");
		editor.handleInput?.("\x1b[B"); // o3
		editor.handleInput?.("\x1b[B"); // gemini
		editor.handleInput?.("\r"); // toggle writes through immediately
		expect(readProfileTargets(ctx, "opus").global).toEqual([
			"anthropic/sonnet",
			"google/gemini",
		]);
		editor.handleInput?.("\x1b"); // close the multi-select
		out = editor.render(120).join("\n");
		// The scope row refreshed from the fresh summary passed to done().
		expect(out).toContain("2 target(s)");
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
