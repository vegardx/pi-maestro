// Sandbox isolation for spawned agents (found by the 2026-07-18 live drive):
// a child's env must carry the maestro's own PI_CODING_AGENT_DIR — without
// explicit propagation a sandboxed maestro spawns children that read the HOST's
// config and cannot see its model catalog ("Model ollama/... not found").

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mapProfileToInvocation } from "../packages/subagents/src/invocation.js";

let prevAgentDir: string | undefined;

beforeEach(() => {
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
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
