// Sandbox isolation for spawned agents (found by the 2026-07-18 live drive):
// (1) a child's env must carry the maestro's own PI_CODING_AGENT_DIR — a tmux
// child gets the tmux SERVER's environment, so without explicit propagation a
// sandboxed maestro spawns children that read the HOST's config and cannot see
// its model catalog ("Model ollama/... not found"); (2) the operator's
// PI_MAESTRO_TRANSPORT override must beat a per-spawn profile transport — a
// runtime policy pinning tmux in a headless harness spawns into the wrong
// world.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mapProfileToInvocation } from "../packages/subagents/src/invocation.js";
import { resolveSpawnTransport } from "../packages/subagents/src/service.js";

let prevAgentDir: string | undefined;
let prevTransport: string | undefined;

beforeEach(() => {
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	prevTransport = process.env.PI_MAESTRO_TRANSPORT;
});

afterEach(() => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	if (prevTransport === undefined) delete process.env.PI_MAESTRO_TRANSPORT;
	else process.env.PI_MAESTRO_TRANSPORT = prevTransport;
});

const CTX = { repoRoot: "/repo", parentDepth: 0 } as const;

describe("child invocation env carries the maestro's config dir", () => {
	it("propagates PI_CODING_AGENT_DIR when the maestro has one", () => {
		process.env.PI_CODING_AGENT_DIR = "/sandbox/.pi/agent";
		const invocation = mapProfileToInvocation({ profile: "general" }, CTX);
		expect(invocation.env.PI_CODING_AGENT_DIR).toBe("/sandbox/.pi/agent");
	});

	it("omits it when the maestro runs on defaults", () => {
		delete process.env.PI_CODING_AGENT_DIR;
		const invocation = mapProfileToInvocation({ profile: "general" }, CTX);
		expect(invocation.env.PI_CODING_AGENT_DIR).toBeUndefined();
	});
});

describe("spawn transport precedence", () => {
	it("the operator's PI_MAESTRO_TRANSPORT beats a profile transport", () => {
		expect(
			resolveSpawnTransport("tmux", "tmux", {
				PI_MAESTRO_TRANSPORT: "headless",
			}),
		).toBe("headless");
		expect(
			resolveSpawnTransport("headless", undefined, {
				PI_MAESTRO_TRANSPORT: "tmux",
			}),
		).toBe("tmux");
	});

	it("without an override: profile, then service default, then tmux", () => {
		expect(resolveSpawnTransport("headless", "tmux", {})).toBe("headless");
		expect(resolveSpawnTransport(undefined, "headless", {})).toBe("headless");
		expect(resolveSpawnTransport(undefined, undefined, {})).toBe("tmux");
	});

	it("ignores a malformed override", () => {
		expect(
			resolveSpawnTransport("headless", undefined, {
				PI_MAESTRO_TRANSPORT: "bogus",
			}),
		).toBe("headless");
	});
});
