// /distill and /handoff entry points: the distill sink hands the curated
// document to the integrated compaction (maestro-owned marker + summary
// override), and a handoff refuses while workers are mid-flight.

import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isMaestroOwnedCompaction } from "@vegardx/pi-contracts";
import { describe, expect, it } from "vitest";
import { CarryForwardController } from "../packages/modes/src/carry-forward.js";
import {
	beginDistill,
	beginHandoff,
	liveWorkers,
} from "../packages/modes/src/runtime/carry-commands.js";
import type { RuntimeContext } from "../packages/modes/src/runtime/context.js";

function fakes(opts: { agents?: Array<[string, { status: string }]> } = {}) {
	const messages: string[] = [];
	const notes: Array<[string, string]> = [];
	const compacts: Array<{ customInstructions?: string }> = [];
	const rt = {
		carryForward: new CarryForwardController(),
		engine: undefined,
		pendingCompaction: undefined as
			| { nonce: string; summaryOverride?: string }
			| undefined,
		pi: {
			sendUserMessage: (text: string) => {
				messages.push(text);
			},
		},
		maestro: { capabilities: { get: () => undefined } },
		execution: opts.agents
			? {
					snapshot: () => ({
						agents: new Map(opts.agents),
						deliverables: new Map(),
					}),
				}
			: undefined,
	} as unknown as RuntimeContext;
	const ctx = {
		ui: {
			notify: (m: string, level: string) => {
				notes.push([m, level]);
			},
		},
		compact: (o: { customInstructions?: string }) => {
			compacts.push(o);
		},
		sessionManager: { getEntries: () => [] },
	} as unknown as ExtensionContext;
	return { rt, ctx, messages, notes, compacts };
}

describe("beginDistill", () => {
	it("starts the episode, sends the directive, and the sink hands the doc to the compaction", async () => {
		const { rt, ctx, messages, compacts } = fakes();
		beginDistill(rt, ctx);
		const episode = rt.carryForward.get();
		expect(episode?.kind).toBe("distill");
		expect(episode?.selfCurate).toBe(false);
		expect(messages[0]).toContain("/distill episode started");

		const outcome = await episode?.sink(
			"THE DOC",
			"/plans/x/handoffs/01-distill.md",
			ctx,
		);
		expect(rt.pendingCompaction?.summaryOverride).toBe("THE DOC");
		expect(compacts).toHaveLength(1);
		expect(isMaestroOwnedCompaction(compacts[0].customInstructions)).toBe(true);
		expect(outcome).toContain("audit: /plans/x/handoffs/01-distill.md");
	});

	it("forced: self-curated episode with the divergence-check directive", () => {
		const { rt, ctx, messages } = fakes();
		beginDistill(rt, ctx, { forced: true, fillPct: 52 });
		expect(rt.carryForward.get()?.selfCurate).toBe(true);
		expect(messages[0]).toContain("FORCED distill");
		expect(messages[0]).toContain("divergence check");
		expect(messages[0]).toContain("52%");
	});

	it("refuses a second episode", () => {
		const { rt, ctx, notes } = fakes();
		beginDistill(rt, ctx);
		beginDistill(rt, ctx);
		expect(notes.some(([m]) => m.includes("already running"))).toBe(true);
	});
});

describe("beginHandoff — refusal", () => {
	it("refuses while workers are mid-flight", async () => {
		const { rt, ctx, notes } = fakes({
			agents: [
				["auth/worker", { status: "working" }],
				["docs/worker", { status: "done" }],
			],
		});
		expect(liveWorkers(rt)).toEqual(["auth/worker"]);
		await beginHandoff(rt, ctx as ExtensionCommandContext);
		expect(rt.carryForward.get()).toBeUndefined();
		expect(notes[0][0]).toContain("Handoff refused");
		expect(notes[0][0]).toContain("auth/worker");
		expect(notes[0][0]).toContain("/recover");
	});

	it("proceeds when the fleet is settled (episode starts)", async () => {
		const { rt, ctx, messages } = fakes({
			agents: [["auth/worker", { status: "done" }]],
		});
		await beginHandoff(rt, ctx as ExtensionCommandContext);
		expect(rt.carryForward.get()?.kind).toBe("handoff");
		expect(messages[0]).toContain("/handoff episode started");
		expect(messages[0]).toContain("archaeologist was unavailable");
	});
});
