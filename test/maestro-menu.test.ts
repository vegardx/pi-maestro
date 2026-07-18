// The restored interactive /maestro menu: select-driven browsing wherever a
// select dialog exists (TUI overlay or extension_ui_request over RPC), with
// the plain notify summary as the no-UI fallback. Scripted subcommands are
// untouched — this pins the interactive layer deterministically.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { showConfigMenu } from "../packages/settings/src/menu.js";

let cwd: string;
let prevAgentDir: string | undefined;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "maestro-menu-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({
			models: {
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

function menuCtx(script: Array<string | undefined>): {
	ctx: ExtensionContext;
	notes: string[];
	selects: string[];
} {
	const notes: string[] = [];
	const selects: string[] = [];
	const ctx = {
		cwd,
		hasUI: true,
		model: { provider: "prov", id: "main-model" },
		ui: {
			select: async (title: string, _options: string[]) => {
				selects.push(title);
				return script.shift();
			},
			notify: (text: string) => {
				notes.push(text);
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, notes, selects };
}

describe("/maestro interactive menu", () => {
	it("browses model sets down to option detail, Esc backs out", async () => {
		const { ctx, notes } = menuCtx([
			"Model sets (1)",
			"impl — 1 option(s)",
			undefined, // Esc out of the set list
			undefined, // Esc out of the top level
		]);
		await showConfigMenu(ctx);
		const detail = notes.find((n) => n.includes("Model set impl"));
		expect(detail).toContain(
			"fast: prov/fast-model @low — Fast implementation",
		);
	});

	it("shows preset detail with role mappings", async () => {
		const { ctx, notes } = menuCtx([
			"Presets (1)",
			"main (active) — targets: prov/main-model",
			undefined,
			undefined,
		]);
		await showConfigMenu(ctx);
		const detail = notes.find((n) => n.includes("Preset main"));
		expect(detail).toContain("worker → impl");
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
