// Option efforts v2: "auto" (the planner/assignment chooses; mechanical
// picks fall back to the session thinking level clamped into the allowed
// set), the optional per-option `efforts` allowlist bounding that choice,
// and the "max" level. Resolution stays concrete — a selection always
// carries a real ThinkingLevel.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	readModelsConfig,
	resolveExactModelSelection,
} from "../packages/models/src/index.js";

let cwd: string;
let prevAgentDir: string | undefined;

const SESSION = "prov/planner";

function writeSettings(options: Record<string, unknown>[]): void {
	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({
			models: {
				modelSets: { pool: { options } },
				presets: {
					main: { targets: [SESSION], modelSets: { worker: "pool" } },
				},
			},
		}),
	);
}

function fakeCtx(sessionLevel = "high"): ExtensionContext {
	const entries = new Map(
		[SESSION, "prov/coder"].map((ref) => {
			const slash = ref.indexOf("/");
			return [
				ref,
				{
					provider: ref.slice(0, slash),
					id: ref.slice(slash + 1),
					name: ref,
					api: "openai-completions",
					reasoning: true,
					thinkingLevelMap: {},
				},
			];
		}),
	);
	return {
		cwd,
		model: entries.get(SESSION),
		getThinkingLevel: () => sessionLevel,
		modelRegistry: {
			find: (provider: string, id: string) => entries.get(`${provider}/${id}`),
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "key",
				headers: {},
			}),
		},
	} as unknown as ExtensionContext;
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "effort-auto-"));
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

const AUTO_OPTION = {
	id: "coder",
	model: "prov/coder",
	effort: "auto",
	summary: "Auto-effort coder.",
};

describe("auto effort and allowlists", () => {
	it("auto resolves to the session thinking level mechanically", async () => {
		writeSettings([AUTO_OPTION]);
		const res = await resolveExactModelSelection(fakeCtx("high"), {
			role: "worker",
		});
		expect(res.selected?.effort).toBe("high");
		const fact = res.candidates.find((c) => c.optionId === "coder");
		expect(fact?.effort).toBe("auto");
	});

	it("auto clamps into the efforts allowlist (nearest below, else above)", async () => {
		writeSettings([{ ...AUTO_OPTION, efforts: ["low", "medium"] }]);
		const clampedDown = await resolveExactModelSelection(fakeCtx("xhigh"), {
			role: "worker",
		});
		expect(clampedDown.selected?.effort).toBe("medium");
		const clampedUp = await resolveExactModelSelection(fakeCtx("off"), {
			role: "worker",
		});
		expect(clampedUp.selected?.effort).toBe("low");
	});

	it("a persisted assignment overrides auto within the allowlist", async () => {
		writeSettings([{ ...AUTO_OPTION, efforts: ["low", "medium", "high"] }]);
		const res = await resolveExactModelSelection(fakeCtx("off"), {
			role: "worker",
			assignment: {
				presetId: "main",
				modelSetId: "pool",
				optionId: "coder",
				modelId: "prov/coder",
				effort: "high",
			},
		});
		expect(res.selected?.effort).toBe("high");
		// Outside the allowlist → refused, never silently substituted.
		const outside = await resolveExactModelSelection(fakeCtx("off"), {
			role: "worker",
			assignment: {
				presetId: "main",
				modelSetId: "pool",
				optionId: "coder",
				modelId: "prov/coder",
				effort: "xhigh",
			},
		});
		expect(outside.selected).toBeNull();
		expect(outside.errors[0]?.code).toBe("explicit-assignment-mismatch");
	});

	it("accepts max as a concrete level", async () => {
		writeSettings([{ ...AUTO_OPTION, effort: "max" }]);
		const res = await resolveExactModelSelection(fakeCtx(), {
			role: "worker",
		});
		expect(res.selected?.effort).toBe("max");
	});

	it("rejects a fixed effort outside its own allowlist at parse", () => {
		writeSettings([{ ...AUTO_OPTION, effort: "high", efforts: ["low"] }]);
		expect(() => readModelsConfig(cwd)).toThrow(/Invalid exact model set/);
	});
});
