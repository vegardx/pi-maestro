// The `/models` routing-inspection command: a read-only surface that shows how
// every maestro AGENT TYPE (worker/explorer/reviewer/advisor) resolves to a
// model right now under the v2 config (families/rosters/bindings/allowances),
// and — per agent — the tier candidate walk with availability. This is the
// observability the e2e oracle leans on ("judge whether the choice was
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
		getThinkingLevel: () => "medium",
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

/**
 * A v2 config: two Anthropic aliases, a `daily` roster, a default (targetless)
 * binding, and allowances that leave `worker` out (so it inherits the session
 * model) while `reviewer`/`explorer` route through tiers.
 */
function configured() {
	return {
		models: {
			families: {
				Anthropic: {
					aliases: {
						Sonnet: { attach: ["anthropic/sonnet"], effort: "medium" },
						Haiku: { attach: ["anthropic/haiku"], effort: "low" },
					},
				},
			},
			rosters: {
				daily: {
					light: ["Anthropic/Haiku"],
					standard: ["Anthropic/Sonnet"],
					heavy: ["Anthropic/Sonnet"],
				},
			},
			bindings: { main: { roster: "daily" } },
			allowances: {
				reviewer: { tiers: ["standard"] },
				explorer: { tiers: ["light"] },
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

describe("/models routing-inspection command (v2)", () => {
	it("tables the agent types: worker inherits the seat, tiered agents route through the roster", async () => {
		settings(configured());
		const handler = modelsHandler();
		const { ctx, notes } = commandCtx("anthropic/sonnet");
		await handler("", ctx);

		expect(notes).toHaveLength(1);
		const out = notes[0].text;
		expect(out).toContain("Model routing (v2)");
		// worker has no allowance → inherits the session model (anthropic/sonnet).
		expect(out).toMatch(
			/worker\s+→ anthropic\/sonnet.*\[inherit\] \(inherit\)/,
		);
		// reviewer routes through its standard tier → the roster's standard alias.
		expect(out).toMatch(
			/reviewer\s+→ anthropic\/sonnet.*\[tier\] \(tier standard\)/,
		);
		// explorer's light tier → Haiku.
		expect(out).toMatch(
			/explorer\s+→ anthropic\/haiku.*\[tier\] \(tier light\)/,
		);
		expect(out).toContain("roster daily");
	});

	it("details one agent's tier candidates and marks the selected ref", async () => {
		settings(configured());
		const handler = modelsHandler();
		const { ctx, notes } = commandCtx("anthropic/sonnet");
		await handler("reviewer", ctx);

		const out = notes[0].text;
		expect(out).toContain("reviewer — allowed tiers: standard");
		expect(out).toContain("tier standard (default)");
		// The one available ref in the default tier is marked selected.
		expect(out).toMatch(/▶ Anthropic\/Sonnet: anthropic\/sonnet/);
	});

	it("reports a no-allowance agent as inheriting the session model", async () => {
		settings(configured());
		const handler = modelsHandler();
		const { ctx, notes } = commandCtx("anthropic/sonnet");
		await handler("worker", ctx);

		const out = notes[0].text;
		expect(out).toContain("inherits the session model");
		expect(out).toContain("anthropic/sonnet");
	});

	it("rejects an unknown agent", async () => {
		settings(configured());
		const handler = modelsHandler();
		const { ctx, notes } = commandCtx("anthropic/sonnet");
		await handler("bogus-agent", ctx);

		expect(notes[0].level).toBe("warning");
		expect(notes[0].text).toContain('Unknown agent "bogus-agent"');
	});
});
