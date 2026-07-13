// /distill and /handoff entry points: the distill sink hands the curated
// document to the integrated compaction (maestro-owned marker + summary
// override), and a handoff refuses while workers are mid-flight.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isMaestroOwnedCompaction } from "@vegardx/pi-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CarryForwardController } from "../packages/modes/src/carry-forward.js";
import {
	beginDistill,
	beginHandoff,
	HANDOFF_ARRIVAL_ENTRY,
	handoffSeedPromptBlock,
	liveWorkers,
	scheduleHandoffArrival,
} from "../packages/modes/src/runtime/carry-commands.js";
import type { RuntimeContext } from "../packages/modes/src/runtime/context.js";
import {
	appendModesState,
	hydrateModesState,
} from "../packages/modes/src/session.js";

function fakes(
	opts: {
		agents?: Array<[string, { status: string }]>;
		subagents?: unknown;
		entries?: unknown[];
	} = {},
) {
	const messages: string[] = [];
	const notes: Array<[string, string]> = [];
	const compacts: Array<{ customInstructions?: string }> = [];
	const cards: Array<{ customType?: string; content?: string }> = [];
	const rt = {
		carryForward: new CarryForwardController(),
		engine: undefined,
		state: { mode: "plan", execution: { stage: "idle" }, updatedAt: "t" },
		pendingCompaction: undefined as
			| { nonce: string; summaryOverride?: string }
			| undefined,
		persist: () => {},
		setMode: () => {},
		pi: {
			sendUserMessage: (text: string) => {
				messages.push(text);
			},
			sendMessage: (msg: { customType?: string; content?: string }) => {
				cards.push(msg);
			},
		},
		maestro: {
			capabilities: {
				get: (name: string) =>
					name === "subagents.v1" ? opts.subagents : undefined,
			},
		},
		execution: opts.agents
			? {
					snapshot: () => ({
						agents: new Map(opts.agents),
						deliverables: new Map(),
					}),
					destroy: async () => {},
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
		newSession: async () => ({ cancelled: false }),
		isIdle: () => true,
		sessionManager: { getEntries: () => opts.entries ?? [] },
	} as unknown as ExtensionContext;
	return { rt, ctx, messages, notes, compacts, cards };
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

describe("handoff arrival (the new session's side)", () => {
	const SEED_DOC = [
		"# Handoff seed — t",
		"",
		"CONTEXT ONLY — the previous arc is closed; its plan `old-arc` remains loadable via /plan old-arc.",
		"",
		"## State",
		"stuff",
		"",
		"## Threads",
		"### Thread one",
		"body",
		"",
		"### Thread two",
		"body",
		"",
		"## Also on the radar",
		"- a — thing",
		"- b — thing",
		"- c — thing",
	].join("\n");

	function withSeedFile(fn: (path: string) => void): void {
		const dir = mkdtempSync(join(tmpdir(), "maestro-seed-"));
		const path = join(dir, "01-handoff.md");
		writeFileSync(path, SEED_DOC);
		try {
			fn(path);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	it("the sink stashes the marker instead of sending the seed mid-turn", async () => {
		const { rt, ctx, messages, cards } = fakes();
		await beginHandoff(rt, ctx as ExtensionCommandContext);
		const episode = rt.carryForward.get();
		const outcome = await episode?.sink(
			"THE DOC",
			"/plans/x/01-handoff.md",
			ctx,
		);

		expect(rt.state.pendingHandoffSeedPath).toBe("/plans/x/01-handoff.md");
		expect(outcome).toContain("Arc closed");
		// Option B: the raw document is never a visible user message.
		expect(messages.some((m) => m.includes("<handoff-seed>"))).toBe(false);
		expect(messages.some((m) => m.includes("THE DOC"))).toBe(false);
		// The arrival delivered: card + orientation prompt.
		expect(cards).toHaveLength(1);
		expect(cards[0].customType).toBe(HANDOFF_ARRIVAL_ENTRY);
		expect(messages.some((m) => m.includes("orientation paragraph"))).toBe(
			true,
		);
	});

	it("arrival card summarizes the seed: threads, radar, previous plan", () => {
		withSeedFile((path) => {
			const { rt, ctx, cards } = fakes();
			rt.state.pendingHandoffSeedPath = path;
			scheduleHandoffArrival(rt, ctx);
			expect(cards).toHaveLength(1);
			const card = cards[0].content ?? "";
			expect(card).toContain("continuing from a handoff");
			expect(card).toContain("2 thread(s) carried");
			expect(card).toContain("3 radar item(s)");
			expect(card).toContain("/plan old-arc");
			expect(card).toContain(path);
		});
	});

	it("does not re-deliver when the session already has the arrival card", () => {
		const { rt, ctx, cards, messages } = fakes({
			entries: [{ type: "custom_message", customType: HANDOFF_ARRIVAL_ENTRY }],
		});
		rt.state.pendingHandoffSeedPath = "/plans/x/01-handoff.md";
		scheduleHandoffArrival(rt, ctx);
		expect(cards).toHaveLength(0);
		expect(messages).toHaveLength(0);
	});

	it("seed rides the plan-mode prompt block until a real plan exists", () => {
		withSeedFile((path) => {
			const { rt } = fakes();
			rt.state.pendingHandoffSeedPath = path;

			// No engine yet → injected.
			expect(handoffSeedPromptBlock(rt)).toContain("Thread one");
			// Auto-opened draft → still injected.
			(rt as { engine: unknown }).engine = { isDraft: () => true };
			expect(handoffSeedPromptBlock(rt)).toContain("## Handoff seed");
			// A real plan formed → the seed retires.
			(rt as { engine: unknown }).engine = { isDraft: () => false };
			expect(handoffSeedPromptBlock(rt)).toBeUndefined();
		});
	});

	it("the marker round-trips modes-state persistence (survives reopen)", () => {
		const entries: Array<{ type: string; customType: string; data: unknown }> =
			[];
		appendModesState(
			{
				appendEntry: (customType: string, data?: unknown) => {
					entries.push({ type: "custom", customType, data });
				},
			},
			{
				mode: "plan",
				execution: { stage: "idle" },
				updatedAt: "t",
				pendingHandoffSeedPath: "/plans/x/01-handoff.md",
			},
		);
		const hydrated = hydrateModesState(entries as never);
		expect(hydrated?.pendingHandoffSeedPath).toBe("/plans/x/01-handoff.md");
	});
});

describe("beginHandoff — archaeologist timeout hygiene", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("clears the 3-minute timer once the run settles (no late stop)", async () => {
		// Regression: the un-cleared timeout fired stop() on the finished run
		// minutes later, in the NEW post-handoff session — an uncaught
		// exception in a timer callback that killed pi.
		vi.useFakeTimers();
		const stop = vi.fn(() => {
			throw new Error("Client not started");
		});
		const subagents = {
			spawn: () => ({
				result: () =>
					Promise.resolve({ status: "succeeded", summary: "- (clean)" }),
				stop,
			}),
		};
		const entries = [
			{ message: { role: "user", content: "do the thing" } },
			{ message: { role: "assistant", content: "on it" } },
		];
		const { rt, ctx } = fakes({ subagents, entries });

		await beginHandoff(rt, ctx as ExtensionCommandContext);
		await vi.advanceTimersByTimeAsync(4 * 60_000);

		expect(stop).not.toHaveBeenCalled();
	});
});
