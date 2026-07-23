// The /maestro takeover editor (maestro-app.ts) and the thin outer shell
// (menu.ts). The component is driven byte-by-byte through handleInput — the
// same input the TUI feeds it — and every edit must land through the validated
// domain writer (global scope → the isolated agent dir here).

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
import { createMaestroAppForTest } from "../packages/settings/src/maestro-app.js";
import { setRegionActive } from "../packages/settings/src/menu.js";

let cwd: string;
let prevAgentDir: string | undefined;

function ctx(): ExtensionContext {
	const notices: string[] = [];
	return {
		cwd,
		model: { provider: "prov", id: "seat" },
		ui: { notify: (m: string) => notices.push(m) },
	} as unknown as ExtensionContext;
}

function agentSettings(): Record<string, unknown> {
	const path = join(cwd, ".agent", "settings.json");
	return JSON.parse(readFileSync(path, "utf-8"));
}

function projectSettings(models: unknown): void {
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ models }));
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "maestro-app-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, ".agent");
	mkdirSync(join(cwd, ".agent"), { recursive: true });
});

afterEach(() => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	rmSync(cwd, { recursive: true, force: true });
});

describe("maestro takeover editor", () => {
	it("creates a family + a DOTTED alias name + attachment (dots must not break the key)", () => {
		const providers = new Map([["prov", ["m"]]]);
		const app = createMaestroAppForTest(
			ctx(),
			providers,
			new Set(["prov/m"]),
			"prov/seat",
			() => {},
		);
		const feed = (...keys: string[]) => {
			for (const key of keys) app.handleInput(key);
		};
		// Home → Families → New family → name → alias → provider → model.
		feed("\r"); // Home: open Families (row 0)
		feed("\r"); // Families: "+ New family…" (only row)
		feed("O", "p", "e", "n", "A", "I", "\r"); // family name
		// An alias name with spaces AND a dot — the case that broke the domain key.
		feed("G", "P", "T", " ", "5", ".", "6", " ", "S", "o", "l", "\r");
		feed("\r"); // ProviderPick: prov (row 0)
		feed("\r"); // ModelPick: m (row 0) → writes

		const written = agentSettings() as {
			models?: {
				families?: Record<
					string,
					{ aliases?: Record<string, { attach?: string[] }> }
				>;
			};
		};
		expect(
			written.models?.families?.OpenAI?.aliases?.["GPT 5.6 Sol"]?.attach,
		).toEqual(["prov/m"]);
	});

	it("adds a second alias (and attachments) to an existing dotted-name family", () => {
		// Seed a family whose alias name contains a dot; the whole-collection
		// write must round-trip it and let a second alias be added.
		writeFileSync(
			join(cwd, ".agent", "settings.json"),
			JSON.stringify({
				models: {
					families: {
						OpenAI: { aliases: { "GPT 5.6 Sol": { attach: ["prov/a"] } } },
					},
				},
			}),
		);
		const app = createMaestroAppForTest(
			ctx(),
			new Map([["prov", ["b"]]]),
			new Set(["prov/a", "prov/b"]),
			"prov/seat",
			() => {},
		);
		const feed = (...keys: string[]) => {
			for (const key of keys) app.handleInput(key);
		};
		// Home → Families → open OpenAI → New alias (row 1) → name → provider → model.
		feed("\r"); // Families
		feed("\r"); // open OpenAI (row 0)
		feed("j", "\r"); // "+ New alias…" (row 1)
		feed("M", "i", "n", "i", "\r"); // alias name
		feed("\r"); // provider prov
		feed("\r"); // model b → writes

		const aliases =
			(
				agentSettings() as {
					models?: {
						families?: Record<string, { aliases?: Record<string, unknown> }>;
					};
				}
			).models?.families?.OpenAI?.aliases ?? {};
		expect(Object.keys(aliases).sort()).toEqual(["GPT 5.6 Sol", "Mini"]);
	});

	it("renders the home screen with every section, including Rules", () => {
		const app = createMaestroAppForTest(
			ctx(),
			new Map(),
			new Set(),
			"prov/seat",
			() => {},
		);
		const lines = app.render(80).join("\n");
		expect(lines).toContain("Families");
		expect(lines).toContain("Rosters");
		expect(lines).toContain("Region");
		expect(lines).toContain("Rules");
	});

	function seedGlobal(models: unknown): void {
		writeFileSync(
			join(cwd, ".agent", "settings.json"),
			JSON.stringify({ models }),
		);
	}

	const DEL = String.fromCharCode(127);
	function clearAndType(text: string, current: string): string[] {
		return [...Array(current.length).fill(DEL), ...text.split(""), "\r"];
	}

	it("renames an alias and carries its roster refs along", () => {
		seedGlobal({
			families: {
				OpenAI: { aliases: { "GPT 5.6 Sol": { attach: ["prov/a"] } } },
			},
			rosters: { daily: { standard: ["OpenAI/GPT 5.6 Sol"] } },
			bindings: { main: { roster: "daily" } },
		});
		const app = createMaestroAppForTest(
			ctx(),
			new Map(),
			new Set(),
			"prov/seat",
			() => {},
		);
		const feed = (...keys: string[]) => {
			for (const key of keys) app.handleInput(key);
		};
		// Families → OpenAI → the alias → Rename (row 3) → clear + "Sol".
		feed("\r", "\r", "\r");
		feed("j", "j", "j", "\r");
		feed(...clearAndType("Sol", "GPT 5.6 Sol"));

		const models = (
			agentSettings() as {
				models?: {
					families?: Record<string, { aliases?: Record<string, unknown> }>;
					rosters?: Record<string, Record<string, string[]>>;
				};
			}
		).models;
		expect(Object.keys(models?.families?.OpenAI?.aliases ?? {})).toEqual([
			"Sol",
		]);
		expect(models?.rosters?.daily?.standard).toEqual(["OpenAI/Sol"]);
	});

	it("renames a family and carries its roster refs along", () => {
		seedGlobal({
			families: {
				OpenAI: { aliases: { "GPT 5.6 Sol": { attach: ["prov/a"] } } },
			},
			rosters: { daily: { standard: ["OpenAI/GPT 5.6 Sol"] } },
			bindings: { main: { roster: "daily" } },
		});
		const app = createMaestroAppForTest(
			ctx(),
			new Map(),
			new Set(),
			"prov/seat",
			() => {},
		);
		const feed = (...keys: string[]) => {
			for (const key of keys) app.handleInput(key);
		};
		// Families → OpenAI → Rename this family (row 2) → clear + "OAI".
		feed("\r", "\r");
		feed("j", "j", "\r");
		feed(...clearAndType("OAI", "OpenAI"));

		const models = (
			agentSettings() as {
				models?: {
					families?: Record<string, unknown>;
					rosters?: Record<string, Record<string, string[]>>;
				};
			}
		).models;
		expect(Object.keys(models?.families ?? {})).toEqual(["OAI"]);
		expect(models?.rosters?.daily?.standard).toEqual(["OAI/GPT 5.6 Sol"]);
	});

	it("blocks a seat already targeted by another binding (exclusivity)", () => {
		seedGlobal({
			families: { OpenAI: { aliases: { Sol: { attach: ["prov/y"] } } } },
			rosters: { daily: { standard: ["OpenAI/Sol"] } },
			bindings: {
				work: { roster: "daily", targets: ["prov/x"] },
				eu: { roster: "daily" },
			},
		});
		const app = createMaestroAppForTest(
			ctx(),
			new Map([["prov", ["x", "y"]]]),
			new Set(),
			"prov/seat",
			() => {},
		);
		const feed = (...keys: string[]) => {
			for (const key of keys) app.handleInput(key);
		};
		// Home → Bindings (row 2) → eu (row 1) → Targets (row 1) → Add → prov.
		feed("j", "j", "\r");
		feed("j", "\r");
		feed("j", "\r");
		feed("\r"); // + Add target
		feed("\r"); // provider prov → the model list

		// prov/x is claimed by "work" — it renders as blocked, not selectable.
		expect(app.render(80).join("\n")).toContain('already bound to "work"');

		// Trying to pick it writes nothing (eu keeps no targets).
		feed("\r"); // enter on prov/x (cursor 0) → notify, no pick
		const eu = (
			agentSettings() as {
				models?: { bindings?: Record<string, { targets?: string[] }> };
			}
		).models?.bindings?.eu;
		expect(eu?.targets).toBeUndefined();
	});

	it("edits a rule (the policy table) from inside the modal", () => {
		const app = createMaestroAppForTest(
			ctx(),
			new Map(),
			new Set(),
			"prov/seat",
			() => {},
		);
		const feed = (...keys: string[]) => {
			for (const key of keys) app.handleInput(key);
		};
		// Home → Rules (row 5) → first rule → Enabled (row 4) → toggle off.
		feed("j", "j", "j", "j", "j", "\r");
		feed("\r"); // open the first (default) rule
		feed("j", "j", "j", "j", "\r"); // move to "Enabled" and toggle

		const written = agentSettings() as {
			extensionConfig?: {
				modes?: { policies?: { run?: { enabled?: boolean } }[] };
			};
		};
		const policies = written.extensionConfig?.modes?.policies ?? [];
		expect(policies.some((row) => row.run?.enabled === false)).toBe(true);
	});

	it("exits (calls done) on esc at the home screen", () => {
		let exited = false;
		const app = createMaestroAppForTest(
			ctx(),
			new Map(),
			new Set(),
			"prov/seat",
			() => {
				exited = true;
			},
		);
		app.handleInput(String.fromCharCode(27));
		expect(exited).toBe(true);
	});
});

describe("setRegionActive (scripted /maestro region)", () => {
	it("sets a known region active and rejects an unknown one", () => {
		projectSettings({
			families: { OpenAI: { aliases: { A: { attach: ["prov/m"] } } } },
			region: { lists: { EEA: ["prov/*"] } },
		});
		setRegionActive(ctx(), "EEA");
		const written = agentSettings() as {
			models?: { region?: { active?: string } };
		};
		expect(written.models?.region?.active).toBe("EEA");

		// Unknown region: nothing written for active.
		setRegionActive(ctx(), "Nowhere");
		expect(
			(agentSettings() as { models?: { region?: { active?: string } } }).models
				?.region?.active,
		).toBe("EEA");
	});
});
