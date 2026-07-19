// The /maestro interactive EDITOR: select-driven pages over every config
// domain, with edits flowing through the validated domain writer (global
// scope → the isolated agent dir here). Scripted select/input sequences pin
// the flows deterministically; the notify summary stays the no-UI fallback.

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
	browseResidency,
	showConfigMenu,
} from "../packages/settings/src/menu.js";

let cwd: string;
let prevAgentDir: string | undefined;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "maestro-menu-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({
			models: {
				residency: {
					active: "EEA",
					lists: { EEA: ["prov/fast-model"] },
				},
				modelSets: {
					impl: {
						options: [
							{
								id: "fast",
								model: "prov/fast-model",
								effort: "low",
								summary: "Fast implementation",
							},
						],
					},
				},
				presets: {
					main: { targets: ["prov/main-model"], modelSets: { worker: "impl" } },
				},
			},
		}),
	);
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, ".agent");
	mkdirSync(join(cwd, ".agent"), { recursive: true });
});

afterEach(() => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	rmSync(cwd, { recursive: true, force: true });
});

function agentSettings(): Record<string, unknown> {
	try {
		return JSON.parse(
			readFileSync(join(cwd, ".agent", "settings.json"), "utf-8"),
		);
	} catch {
		return {};
	}
}

/** Script select answers; record every select's title and options. */
function menuCtx(
	script: Array<string | undefined>,
	inputs: Array<string | undefined> = [],
): {
	ctx: ExtensionContext;
	notes: string[];
	selects: { title: string; options: string[] }[];
} {
	const notes: string[] = [];
	const selects: { title: string; options: string[] }[] = [];
	const registryModels = [
		{ provider: "prov", id: "fast-model" },
		{ provider: "prov", id: "main-model" },
		{ provider: "other", id: "big-model" },
	];
	const ctx = {
		cwd,
		hasUI: true,
		model: { provider: "prov", id: "main-model" },
		modelRegistry: {
			getAll: () => registryModels,
			find: () => undefined,
		},
		ui: {
			select: async (title: string, options: string[]) => {
				selects.push({ title, options });
				return script.shift();
			},
			input: async () => inputs.shift(),
			confirm: async () => true,
			notify: (text: string) => {
				notes.push(text);
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, notes, selects };
}

describe("/maestro interactive editor", () => {
	it("opens a model set as an editable page listing its options", async () => {
		const { ctx, selects } = menuCtx([
			"Model sets (1)",
			"impl — 1 option(s) · used by main (1 role)",
			undefined, // Esc out of the set editor
			undefined, // Esc out of the set list
			undefined, // Esc out of the top level
		]);
		await showConfigMenu(ctx);
		const editor = selects.find((s) => s.title.startsWith("Model set impl"));
		expect(editor).toBeDefined();
		expect(editor?.options).toContain(
			"fast: prov/fast-model @low — Fast implementation",
		);
		expect(editor?.options).toContain("+ Add option…");
	});

	it("maps a preset role to a set and persists through the domain writer", async () => {
		const { ctx, selects } = menuCtx([
			"Presets (1)",
			"main (active) — 1 model(s), 1 role mapping(s)",
			"Role mappings (1) — role → model set",
			"verifier → none (session model)",
			"impl",
			undefined, // Esc role list
			undefined, // Esc preset page
			undefined, // Esc presets
			undefined, // Esc top
		]);
		await showConfigMenu(ctx);
		const roles = selects.find((s) => s.title.includes("role → model set"));
		expect(roles?.options).toContain("worker → impl");
		expect(roles?.options).toContain("verifier → none (session model)");
		const written = agentSettings() as {
			models?: { presets?: { main?: { modelSets?: Record<string, string> } } };
		};
		expect(written.models?.presets?.main?.modelSets?.verifier).toBe("impl");
	});

	it("switches the active residency to off", async () => {
		const { ctx, notes } = menuCtx([
			"Active: EEA — change…",
			"off — no filter",
			undefined, // Esc residency page
		]);
		await browseResidency(ctx);
		const written = agentSettings() as {
			models?: { residency?: { active?: string } };
		};
		expect(written.models?.residency?.active).toBe("off");
		expect(notes.some((n) => n.includes("Residency → off"))).toBe(true);
	});

	it("curates residency membership per model through the provider browser", async () => {
		const { ctx, selects } = menuCtx([
			"EEA — 1 model(s)",
			"Edit models by provider…",
			"prov — 1 of 2 in list",
			"✗ main-model", // toggle ON
			undefined, // Esc model toggles
			undefined, // Esc provider picker
			undefined, // Esc list editor
			undefined, // Esc residency page
		]);
		await browseResidency(ctx);
		const providerPage = selects.find((s) =>
			s.title.includes("which provider?"),
		);
		expect(providerPage?.options).toContain("prov — 1 of 2 in list");
		expect(providerPage?.options).toContain("other — 0 of 1 in list");
		const written = agentSettings() as {
			models?: { residency?: { lists?: Record<string, string[]> } };
		};
		expect(written.models?.residency?.lists?.EEA).toEqual([
			"prov/fast-model",
			"prov/main-model",
		]);
	});

	it("stale models.profiles config notifies instead of throwing", async () => {
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ models: { profiles: { Old: {} } } }),
		);
		const { default: extensionFactory } = await import(
			"../packages/settings/src/extension.js"
		);
		const handlers = new Map<
			string,
			(args: string, ctx: unknown) => Promise<void>
		>();
		const pi = {
			registerCommand: (
				name: string,
				spec: { handler: (args: string, ctx: unknown) => Promise<void> },
			) => handlers.set(name, spec.handler),
			on: () => {},
			events: { on: () => {}, emit: () => {} },
		};
		extensionFactory(pi as never);
		const maestroHandler = handlers.get("maestro");
		if (!maestroHandler) throw new Error("maestro command not registered");
		const notes: string[] = [];
		const ctx = {
			cwd,
			hasUI: true,
			model: { provider: "prov", id: "main-model" },
			ui: {
				notify: (text: string) => notes.push(text),
				select: async () => undefined,
			},
		};
		await maestroHandler("show", ctx);
		expect(
			notes.some((note) => note.includes("models.profiles was removed")),
		).toBe(true);
	});

	it("falls back to the notify summary without a select UI", async () => {
		const notes: string[] = [];
		const ctx = {
			cwd,
			hasUI: false,
			model: { provider: "prov", id: "main-model" },
			ui: { notify: (text: string) => notes.push(text) },
		} as unknown as ExtensionContext;
		await showConfigMenu(ctx);
		expect(notes[0]).toContain("Maestro configuration");
		expect(notes[0]).toContain("Exact model sets: 1");
	});
});
