// The `/models` routing-inspection command: a read-only surface that shows how
// every maestro role resolves to a model right now, and — per role — which
// candidate options were available and why the pick landed where it did. This
// is the observability the e2e oracle leans on ("judge whether the choice was
// sensible"), so it's pinned here without a live model or pi boot.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerRuntimeCommands } from "../packages/modes/src/runtime/commands.js";
import type { RuntimeContext } from "../packages/modes/src/runtime/context.js";

let cwd: string;
let agentDir: string;
let previousAgentDir: string | undefined;

function model(id: string) {
	const [provider, ...rest] = id.split("/");
	return {
		provider,
		id: rest.join("/"),
		name: id,
		api: "anthropic-messages",
		reasoning: true,
		thinkingLevelMap: {},
	};
}

/** A notify-capturing command ctx over a resolvable model registry. */
function commandCtx(session: string): {
	ctx: ExtensionCommandContext;
	notes: { text: string; level: string }[];
} {
	const entries = new Map(
		[model("anthropic/sonnet"), model("anthropic/haiku")].map((entry) => [
			`${entry.provider}/${entry.id}`,
			entry,
		]),
	);
	const notes: { text: string; level: string }[] = [];
	const ctx = {
		cwd,
		model: entries.get(session),
		modelRegistry: {
			find: (provider: string, id: string) => entries.get(`${provider}/${id}`),
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "test-key",
				headers: {},
			}),
		},
		ui: {
			notify: (text: string, level: string) => notes.push({ text, level }),
		},
	} as unknown as ExtensionContext & ExtensionCommandContext;
	return { ctx: ctx as ExtensionCommandContext, notes };
}

/** Register runtime commands with a spy pi and return the `/models` handler. */
function modelsHandler(): (
	args: string,
	ctx: ExtensionCommandContext,
) => Promise<void> {
	const handlers = new Map<
		string,
		(args: string, ctx: ExtensionCommandContext) => Promise<void>
	>();
	const rt = {
		pi: {
			registerCommand: (
				name: string,
				spec: {
					handler: (
						args: string,
						ctx: ExtensionCommandContext,
					) => Promise<void>;
				},
			) => handlers.set(name, spec.handler),
			registerShortcut: () => {},
			registerTool: () => {},
		},
		maestro: { capabilities: { get: () => undefined } },
	};
	registerRuntimeCommands(rt as unknown as RuntimeContext);
	const handler = handlers.get("models");
	if (!handler) throw new Error("`/models` command was not registered");
	return handler;
}

function settings(value: Record<string, unknown>) {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(value));
}

function configured() {
	return {
		models: {
			modelSets: {
				impl: {
					options: [
						{
							id: "fast",
							model: "anthropic/haiku",
							effort: "low",
							summary: "Fast implementation",
						},
					],
				},
			},
			presets: {
				main: {
					targets: ["anthropic/sonnet"],
					modelSets: { worker: "impl" },
				},
			},
		},
	};
}

beforeEach(() => {
	cwd = join(tmpdir(), `models-cmd-${process.pid}-${Math.random()}`);
	agentDir = join(cwd, ".agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
});

describe("/models routing-inspection command", () => {
	it("tables every role, routing the preset role and falling back the rest", async () => {
		settings(configured());
		const handler = modelsHandler();
		const { ctx, notes } = commandCtx("anthropic/sonnet");
		await handler("", ctx);

		expect(notes).toHaveLength(1);
		const out = notes[0].text;
		expect(out).toContain("preset: main");
		// The configured role resolves to its set; unconfigured roles fall back.
		expect(out).toMatch(/worker\s+→ anthropic\/haiku @low \[preset\]/);
		expect(out).toMatch(/classifier\s+→ anthropic\/sonnet @medium \[session\]/);
		// All 15 roles appear.
		expect(out).toContain("simplification-review");
	});

	it("details one role's candidates and marks the selected option", async () => {
		settings(configured());
		const handler = modelsHandler();
		const { ctx, notes } = commandCtx("anthropic/sonnet");
		await handler("worker", ctx);

		const out = notes[0].text;
		expect(out).toContain("worker — preset main / set impl");
		expect(out).toMatch(
			/▶ fast: anthropic\/haiku @low {2}\(Fast implementation\)/,
		);
	});

	it("rejects an unknown role", async () => {
		settings(configured());
		const handler = modelsHandler();
		const { ctx, notes } = commandCtx("anthropic/sonnet");
		await handler("bogus-role", ctx);

		expect(notes[0].level).toBe("warning");
		expect(notes[0].text).toContain('Unknown role "bogus-role"');
	});
});
