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
import { upsertUserPolicyRow } from "../packages/settings/src/menu-policies.js";

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
			// Only prov/* models are "in the registry" for availability facts;
			// other/big-model exercises the "not in registry" word.
			find: (provider: string, id: string) =>
				provider === "prov"
					? registryModels.find(
							(model) => model.provider === provider && model.id === id,
						)
					: undefined,
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "key",
				headers: {},
			}),
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

	it("adds an option through the model selector, not free text", async () => {
		const { ctx, selects } = menuCtx(
			[
				"Model sets (1)",
				"impl — 1 option(s) · used by main (1 role)",
				"+ Add option…",
				"other — 1 model(s)",
				"big-model",
				"medium",
				undefined, // Esc set editor
				undefined, // Esc set list
				undefined, // Esc top level
			],
			["Big cross-family reviewer."], // summary input
		);
		await showConfigMenu(ctx);
		const modelPick = selects.find((s) => s.title === "Model for this option");
		expect(modelPick?.options).toContain("session — the live session model");
		expect(modelPick?.options).toContain("other — 1 model(s)");
		const written = agentSettings() as {
			models?: {
				modelSets?: { impl?: { options?: { id: string; model: string }[] } };
			};
		};
		const option = written.models?.modelSets?.impl?.options?.find(
			(o) => o.id === "big-model",
		);
		expect(option?.model).toBe("other/big-model");
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

	it("adds a preset target through the provider selector, without session", async () => {
		const { ctx, selects } = menuCtx([
			"Presets (1)",
			"main (active) — 1 model(s), 1 role mapping(s)",
			"Models (1) — session models that activate this preset",
			"+ Add model…",
			"other — 1 model(s)",
			"big-model",
			undefined, // Esc targets page
			undefined, // Esc preset page
			undefined, // Esc presets
			undefined, // Esc top
		]);
		await showConfigMenu(ctx);
		const providerPick = selects.find(
			(s) => s.title === "Model — which provider?",
		);
		expect(providerPick).toBeDefined();
		expect(providerPick?.options.some((o) => o.startsWith("session"))).toBe(
			false,
		);
		const written = agentSettings() as {
			models?: { presets?: { main?: { targets?: string[] } } };
		};
		expect(written.models?.presets?.main?.targets).toEqual([
			"prov/main-model",
			"other/big-model",
		]);
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

	it("add-all pulls a whole provider into the list at once", async () => {
		const { ctx } = menuCtx([
			"EEA — 1 model(s)",
			"Edit models by provider…",
			"prov — 1 of 2 in list",
			"+ Add all 2 prov model(s)",
			undefined, // Esc model toggles
			undefined, // Esc provider picker
			undefined, // Esc list editor
			undefined, // Esc residency page
		]);
		await browseResidency(ctx);
		const written = agentSettings() as {
			models?: { residency?: { lists?: Record<string, string[]> } };
		};
		expect(written.models?.residency?.lists?.EEA).toEqual([
			"prov/fast-model",
			"prov/main-model",
		]);
	});

	it("provider browser lists only configured providers", async () => {
		const { ctx, selects } = menuCtx([
			"EEA — 1 model(s)",
			"Edit models by provider…",
			undefined, // Esc provider picker
			undefined, // Esc list editor
			undefined, // Esc residency page
		]);
		// "other" is known to pi but has no credential configured.
		(
			ctx as unknown as {
				modelRegistry: {
					getProviderAuthStatus: (provider: string) => {
						configured: boolean;
					};
				};
			}
		).modelRegistry.getProviderAuthStatus = (provider) => ({
			configured: provider === "prov",
		});
		await browseResidency(ctx);
		const providerPage = selects.find((s) =>
			s.title.includes("which provider?"),
		);
		expect(providerPage?.options).toContain("prov — 1 of 2 in list");
		expect(providerPage?.options.some((o) => o.startsWith("other"))).toBe(
			false,
		);
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
			notes.some((note) => note.includes("pre-cutover models.profiles")),
		).toBe(true);
	});

	it("lists profiles and catalogs with the active marker and availability words", async () => {
		// v2 config lives in GLOBAL settings (where the menu writes); the
		// project file keeps no residency so both entries pass the filter.
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({}));
		writeFileSync(
			join(cwd, ".agent", "settings.json"),
			JSON.stringify({
				models: {
					catalogs: {
						daily: {
							fast: [
								{ model: "prov/fast-model" },
								{ model: "other/big-model" },
							],
						},
					},
					profiles: {
						main: { targets: ["prov/main-model"], catalog: "daily" },
					},
				},
			}),
		);
		const { ctx, selects } = menuCtx([
			"Profiles and catalogs (1 profile(s), 1 catalog(s))",
			"catalog daily — 2 entries",
			"fast — 2 entries: 1 available, 1 not in registry",
			undefined, // Esc tier page
			undefined, // Esc catalog page
			undefined, // Esc profiles/catalogs page
			undefined, // Esc top level
		]);
		await showConfigMenu(ctx);
		const top = selects.find((s) =>
			s.title.startsWith("Profiles and catalogs"),
		);
		expect(top?.title).toContain("active profile: main");
		expect(top?.options).toContain(
			"profile main (active) → daily · targets: prov/main-model",
		);
		expect(top?.options).toContain("catalog daily — 2 entries");
		const catalogPage = selects.find((s) =>
			s.title.startsWith("Catalog daily"),
		);
		expect(catalogPage?.title).toContain("bound by main");
		expect(catalogPage?.options).toContain(
			"fast — 2 entries: 1 available, 1 not in registry",
		);
		expect(catalogPage?.options).toContain("normal — empty");
		const tierPage = selects.find((s) =>
			s.title.startsWith("Catalog daily · fast"),
		);
		expect(tierPage?.options).toContain("prov/fast-model — available");
		expect(tierPage?.options).toContain("other/big-model — not in registry");
	});

	it("adds catalog entries through the residency- and auth-filtered browser", async () => {
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({
				models: {
					residency: {
						active: "EEA",
						lists: { EEA: ["prov/fast-model", "prov/main-model"] },
					},
				},
			}),
		);
		writeFileSync(
			join(cwd, ".agent", "settings.json"),
			JSON.stringify({
				models: {
					catalogs: { daily: { fast: [{ model: "prov/fast-model" }] } },
				},
			}),
		);
		const { ctx, selects } = menuCtx([
			"Profiles and catalogs (0 profile(s), 1 catalog(s))",
			"catalog daily — 1 entry",
			"fast — 1 entry: 1 available",
			"+ Add models…",
			"prov — 1 of 2 in fast",
			"✗ main-model", // toggle ON — one validated write
			undefined, // Esc model toggles
			undefined, // Esc provider picker
			undefined, // Esc tier page
			undefined, // Esc catalog page
			undefined, // Esc profiles/catalogs page
			undefined, // Esc top level
		]);
		await showConfigMenu(ctx);
		// other/* is outside the residency list — its provider is not offered.
		const providerPage = selects.find((s) =>
			s.title.includes("which provider?"),
		);
		expect(providerPage?.options).toEqual(["prov — 1 of 2 in fast"]);
		const written = agentSettings() as {
			models?: {
				catalogs?: { daily?: { fast?: { model: string }[] } };
			};
		};
		expect(written.models?.catalogs?.daily?.fast).toEqual([
			{ model: "prov/fast-model" },
			{ model: "prov/main-model" },
		]);
	});

	it("sets effort, family, and notes on a catalog entry", async () => {
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({}));
		writeFileSync(
			join(cwd, ".agent", "settings.json"),
			JSON.stringify({
				models: {
					catalogs: { daily: { fast: [{ model: "prov/fast-model" }] } },
				},
			}),
		);
		const { ctx } = menuCtx(
			[
				"Profiles and catalogs (0 profile(s), 1 catalog(s))",
				"catalog daily — 1 entry",
				"fast — 1 entry: 1 available",
				"prov/fast-model — available",
				"Effort: model default — change…",
				"low",
				"Family: not set — change…",
				"Notes: not set — change…",
				undefined, // Esc entry page
				undefined, // Esc tier page
				undefined, // Esc catalog page
				undefined, // Esc profiles/catalogs page
				undefined, // Esc top level
			],
			["anthropic", "fast sweeps"],
		);
		await showConfigMenu(ctx);
		const written = agentSettings() as {
			models?: { catalogs?: { daily?: { fast?: unknown[] } } };
		};
		expect(written.models?.catalogs?.daily?.fast?.[0]).toEqual({
			model: "prov/fast-model",
			effort: "low",
			family: "anthropic",
			notes: "fast sweeps",
		});
	});

	it("toggles an agent tier allowlist and resets it back to the defaults", async () => {
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({}));
		const { ctx, selects } = menuCtx([
			"Agent tiers (worker, explorer, reviewer)",
			"worker — normal, heavy (default)",
			"Toggle tiers…",
			"✗ fast", // toggle ON → override written
			undefined, // Esc toggle loop
			"Reset to defaults (normal, heavy) — remove the override",
			undefined, // Esc agent page
			undefined, // Esc agent tiers screen
			undefined, // Esc top level
		]);
		await showConfigMenu(ctx);
		const screen = selects.find((s) => s.title.startsWith("Agent tiers"));
		expect(screen?.options).toContain("worker — normal, heavy (default)");
		expect(screen?.options).toContain("explorer — fast, normal (default)");
		// After the toggle the agent page shows the override…
		const overridePage = selects.find((s) =>
			s.title.startsWith("Agent worker — allowed tiers: fast, normal, heavy"),
		);
		expect(overridePage?.title).toContain("(override)");
		// …and the reset removes it again, restoring the shipped default.
		const written = agentSettings() as {
			models?: { agents?: Record<string, unknown> };
		};
		expect(written.models?.agents).toBeUndefined();
	});

	it("warns in plain words when an allowed tier lacks catalog coverage", async () => {
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({}));
		writeFileSync(
			join(cwd, ".agent", "settings.json"),
			JSON.stringify({
				models: {
					catalogs: {
						daily: {
							normal: [
								{ model: "prov/fast-model" },
								{ model: "other/big-model" },
							],
						},
					},
					profiles: { main: { catalog: "daily" } },
				},
			}),
		);
		const { ctx, selects } = menuCtx([
			"Agent tiers (worker, explorer, reviewer)",
			undefined, // Esc agent tiers screen
			undefined, // Esc top level
		]);
		await showConfigMenu(ctx);
		const screen = selects.find((s) => s.title.startsWith("Agent tiers"));
		const worker = screen?.options.find((o) => o.startsWith("worker "));
		expect(worker).toContain("heavy is empty — requests fall back to the seat");
		expect(worker).toContain(
			"normal has 1 unavailable entry (other/big-model: not in registry)",
		);
		const explorer = screen?.options.find((o) => o.startsWith("explorer "));
		expect(explorer).toContain(
			"fast is empty — requests fall back to the seat",
		);
	});

	it("an invalid v2 state is unwriteable and shows the validator message", async () => {
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({}));
		writeFileSync(
			join(cwd, ".agent", "settings.json"),
			JSON.stringify({
				models: {
					catalogs: { daily: { fast: [{ model: "prov/fast-model" }] } },
					profiles: { main: { catalog: "daily" } },
				},
			}),
		);
		const { ctx, notes } = menuCtx([
			"Profiles and catalogs (1 profile(s), 1 catalog(s))",
			"catalog daily — 1 entry",
			"✕ Delete catalog daily…", // confirm answers true
			undefined, // Esc catalog page
			undefined, // Esc profiles/catalogs page
			undefined, // Esc top level
		]);
		await showConfigMenu(ctx);
		expect(
			notes.some((note) =>
				note.includes(
					"Not written: Profile main references unknown catalog daily",
				),
			),
		).toBe(true);
		const written = agentSettings() as {
			models?: { catalogs?: Record<string, unknown> };
		};
		expect(written.models?.catalogs?.daily).toBeDefined();
	});

	it("authors a policy row within the closed vocabularies", async () => {
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({}));
		const { ctx, selects, notes } = menuCtx([
			"Policies (6 rows)",
			"+ New row…",
			"duty:<name> — a harness duty",
			"classify",
			"fast",
			"Agent: not set — change…",
			"explorer",
			undefined, // Esc row editor
			undefined, // Esc table
			undefined, // Esc top level
		]);
		await showConfigMenu(ctx);
		// The effective table shows the shipped defaults with full run fields.
		const table = selects.find((s) => s.title.startsWith("Policies —"));
		expect(table?.options).toContain(
			"mode:plan->auto — models heavy · agent reviewer · persona plan-review · contract plan-gate-report (default)",
		);
		expect(table?.options).toContain(
			"tool:bash — models fast · contract verdict · scope depth >=1 (default)",
		);
		// Closed vocabularies: duties, tiers, agent types.
		expect(selects.find((s) => s.title === "Which duty?")?.options).toEqual([
			"classify",
			"plan-summarize",
			"compact-summarize",
			"verify-findings",
			"verify-delivery",
		]);
		expect(
			selects.find((s) => s.title.includes("a tier is required"))?.options,
		).toEqual(["fast", "normal", "heavy"]);
		expect(
			selects.find((s) => s.title === "duty:classify → agent")?.options,
		).toEqual(["not set", "worker", "explorer", "reviewer"]);
		// duty:classify has no consumer yet — the inert warning is spoken.
		expect(
			notes.some((note) =>
				note.includes(
					"duty:classify: no consumer reads this trigger yet — the row is inert",
				),
			),
		).toBe(true);
		const written = agentSettings() as {
			extensionConfig?: { modes?: { policies?: unknown[] } };
		};
		expect(written.extensionConfig?.modes?.policies).toEqual([
			{ on: "duty:classify", run: { models: "fast", agent: "explorer" } },
		]);
	});

	it("deleting a user policy row restores the shipped default", async () => {
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({}));
		writeFileSync(
			join(cwd, ".agent", "settings.json"),
			JSON.stringify({
				extensionConfig: {
					modes: {
						policies: [
							{
								on: "tool:bash",
								scope: { depth: ">=1" },
								run: { models: "normal", contract: "verdict" },
							},
						],
					},
				},
			}),
		);
		const { ctx, selects } = menuCtx([
			"Policies (6 rows)",
			"tool:bash — models normal · contract verdict · scope depth >=1 (user)",
			"✕ Delete user row — restore the shipped default…",
			undefined, // Esc row editor (now showing the default again)
			undefined, // Esc table
			undefined, // Esc top level
		]);
		await showConfigMenu(ctx);
		const restored = selects.filter((s) =>
			s.title.startsWith("Policy tool:bash"),
		);
		expect(restored[0]?.title).toBe("Policy tool:bash (user)");
		expect(restored[1]?.title).toBe("Policy tool:bash (default)");
		expect(restored[1]?.options).toContain("Models (tier): fast — change…");
		const written = agentSettings() as {
			extensionConfig?: unknown;
		};
		expect(written.extensionConfig).toBeUndefined();
	});

	it("an invalid policy row is rejected with the validator's message", () => {
		const { ctx } = menuCtx([]);
		const problems = upsertUserPolicyRow(ctx, {
			on: "duty:classify",
			run: { models: "turbo" },
		} as never);
		expect(problems.join(" ")).toContain(
			"a tier is required on every row (fast, normal, heavy)",
		);
		expect(agentSettings()).toEqual({});
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
