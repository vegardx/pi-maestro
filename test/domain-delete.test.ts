// Deleting one domain entry must delete ONLY that entry. Regression
// (2026-07-19): a null write stored a literal null in settings.json;
// extractModels then threw on the poisoned entry and EVERY preset and
// model set vanished from view at once.

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
import { readModelsConfig } from "../packages/models/src/index.js";
import { writeDomainValue } from "../packages/settings/src/domain.js";

let cwd: string;
let prevAgentDir: string | undefined;

const MODELS = {
	modelSets: {
		alpha: {
			options: [{ id: "a", model: "prov/a", effort: "low", summary: "A." }],
		},
		beta: {
			options: [{ id: "b", model: "prov/b", effort: "low", summary: "B." }],
		},
	},
	presets: {
		one: { targets: ["prov/one"], modelSets: { worker: "alpha" } },
		two: { targets: ["prov/two"], modelSets: { worker: "beta" } },
	},
	residency: { active: "EEA", lists: { EEA: ["prov/a"], Extra: ["prov/b"] } },
};

function ctx(): ExtensionContext {
	return { cwd, ui: { notify: () => {} } } as unknown as ExtensionContext;
}

function globalSettings(): Record<string, unknown> {
	return JSON.parse(
		readFileSync(join(cwd, ".agent", "settings.json"), "utf-8"),
	);
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "domain-delete-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, ".agent");
	mkdirSync(join(cwd, ".agent"), { recursive: true });
	// The config lives in the GLOBAL scope — where menu deletes write.
	writeFileSync(
		join(cwd, ".agent", "settings.json"),
		JSON.stringify({ models: MODELS }),
	);
});

afterEach(() => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	rmSync(cwd, { recursive: true, force: true });
});

describe("domain deletes", () => {
	it("deleting one preset removes only that key from the file", () => {
		const errors = writeDomainValue(
			ctx(),
			"models.presets.one",
			"global",
			"null",
		);
		expect(errors).toEqual([]);
		const written = globalSettings() as {
			models: { presets: Record<string, unknown> };
		};
		expect(Object.keys(written.models.presets)).toEqual(["two"]);
		expect(written.models.presets.one).toBeUndefined();
		const config = readModelsConfig(cwd);
		expect(Object.keys(config?.presets ?? {})).toEqual(["two"]);
		expect(Object.keys(config?.modelSets ?? {})).toEqual(["alpha", "beta"]);
	});

	it("deleting one model set leaves the others readable", () => {
		writeDomainValue(ctx(), "models.modelSets.alpha", "global", "null");
		const config = readModelsConfig(cwd);
		expect(Object.keys(config?.modelSets ?? {})).toEqual(["beta"]);
		expect(Object.keys(config?.presets ?? {})).toEqual(["one", "two"]);
	});

	it("deleting a residency list leaves the rest of residency intact", () => {
		writeDomainValue(ctx(), "models.residency.lists.Extra", "global", "null");
		const config = readModelsConfig(cwd);
		expect(Object.keys(config?.residency?.lists ?? {})).toEqual(["EEA"]);
		expect(config?.residency?.active).toBe("EEA");
	});

	it("a poisoned null entry from the old writer no longer nukes the config", () => {
		writeFileSync(
			join(cwd, ".agent", "settings.json"),
			JSON.stringify({
				models: {
					...MODELS,
					presets: { ...MODELS.presets, ghost: null },
					modelSets: { ...MODELS.modelSets, husk: null },
				},
			}),
		);
		const config = readModelsConfig(cwd);
		expect(Object.keys(config?.presets ?? {})).toEqual(["one", "two"]);
		expect(Object.keys(config?.modelSets ?? {})).toEqual(["alpha", "beta"]);
	});

	it("deleting the last entry prunes the empty parent object", () => {
		writeDomainValue(ctx(), "models.presets.one", "global", "null");
		writeDomainValue(ctx(), "models.presets.two", "global", "null");
		const written = globalSettings() as { models: Record<string, unknown> };
		expect(written.models.presets).toBeUndefined();
	});
});
