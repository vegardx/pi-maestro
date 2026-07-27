// The one liveness predicate. Liveness means "a process exists that a bounded
// stop would have to shut down" — so this set must stay identical to what
// prepareStop kills, or a guard waves through work the stop then destroys.
//
// The regression this locks: the posture guards used to check only
// working|summarizing, so a worker mid-spawn was invisible to "stop them first?"
// and was killed anyway.

import { describe, expect, it } from "vitest";
import type { ExecutionAgentSnapshot } from "../packages/modes/src/exec/index.js";
import {
	isLiveAgentStatus,
	LIVE_AGENT_STATUSES,
	liveAgentKeys,
} from "../packages/modes/src/plan/live-agents.js";
import type { NodeAgentStatus } from "../packages/modes/src/plan/node-executor.js";

const agent = (status: string): ExecutionAgentSnapshot =>
	({ status, startedAt: 0, tokens: {} }) as unknown as ExecutionAgentSnapshot;

const handle = (statuses: Record<string, string>) => ({
	snapshot: () => ({
		agents: new Map(
			Object.entries(statuses).map(([key, status]) => [key, agent(status)]),
		),
		deliverables: new Map(),
	}),
});

describe("live agent statuses", () => {
	it("counts every status that owns a process", () => {
		expect([...LIVE_AGENT_STATUSES].sort()).toEqual([
			"restarting",
			"spawning",
			"summarizing",
			"working",
		]);
	});

	it("treats parked and terminal statuses as not live", () => {
		// pending is parked (blocked, awaiting resume) — not a running process.
		const notLive: NodeAgentStatus[] = ["pending", "done", "failed"];
		for (const status of notLive) expect(isLiveAgentStatus(status)).toBe(false);
	});

	it("counts spawning and restarting — the statuses the old guards missed", () => {
		expect(isLiveAgentStatus("spawning")).toBe(true);
		expect(isLiveAgentStatus("restarting")).toBe(true);
	});

	it("treats an unknown status as not live", () => {
		expect(isLiveAgentStatus("idle")).toBe(false);
		expect(isLiveAgentStatus("")).toBe(false);
	});
});

describe("liveAgentKeys", () => {
	it("returns only the live keys", () => {
		const keys = liveAgentKeys(
			handle({
				a: "working",
				b: "pending",
				c: "spawning",
				d: "done",
				e: "restarting",
				f: "failed",
				g: "summarizing",
			}),
		);
		expect(keys.sort()).toEqual(["a", "c", "e", "g"]);
	});

	it("reports nothing running when no adapter exists", () => {
		// The honest answer for "no execution": nothing is live, so a posture
		// change needs no stop prompt.
		expect(liveAgentKeys(undefined)).toEqual([]);
	});

	it("reports nothing running when every agent has settled", () => {
		expect(liveAgentKeys(handle({ a: "done", b: "failed" }))).toEqual([]);
	});
});
