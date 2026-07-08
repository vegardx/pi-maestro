// Agent progress cards: the pure header/body/trailer builders per event
// kind, firstParagraph extraction, the collapsed/expanded tinted-block TUI
// renderer output, and the sendAgentEvent message shape.

import type {
	ExtensionAPI,
	MessageRenderer,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { ExecutionEvent } from "../packages/modes/src/exec/index.js";
import {
	AGENT_EVENT_MESSAGE_TYPE,
	type AgentCardEvent,
	buildCardBody,
	buildCardHeader,
	buildEventContent,
	buildStatsTrailer,
	eventBg,
	eventColor,
	firstParagraph,
	formatDuration,
	registerAgentCardRenderer,
	sendAgentEvent,
} from "../packages/modes/src/runtime/agent-cards.js";

/** Identity theme: styling is a no-op so assertions see plain text. */
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
} as unknown as Theme;

const doneEvent = {
	kind: "done",
	agentKey: "auth/worker",
	deliverableTitle: "Auth",
	durationMs: 245_000,
	tokens: { input: 52_000, output: 8_400, turns: 12 },
	cacheRatio: 0.82,
	summary:
		"## Summary\nImplemented the login endpoint.\n\nAdded tests covering refresh and expiry.",
	commits: ["feat: add login", "test: cover refresh"],
} satisfies ExecutionEvent;

const fixRoundEvent: ExecutionEvent = {
	kind: "fix-round",
	deliverableId: "auth",
	deliverableTitle: "Auth",
	round: 2,
	findings: ["missing CSRF check", "no rate limit"],
};

const researchDoneEvent = {
	kind: "research-done",
	question: "how do competing TUI libraries debounce resize events?",
	research: "web",
	ok: true,
	durationMs: 130_000,
	reportPath: "research/03-how-do-competing-tui.md",
	report:
		"Blessed and Ink both debounce SIGWINCH.\n\npi-tui re-renders synchronously.",
} satisfies AgentCardEvent;

/** Minimal event of a given kind — for the color/bg lookups that only
 *  discriminate on `kind`. */
function evt(kind: string): AgentCardEvent {
	return { kind } as unknown as AgentCardEvent;
}

describe("agent card builders", () => {
	it("formats durations compactly", () => {
		expect(formatDuration(3_000)).toBe("3s");
		expect(formatDuration(245_000)).toBe("4m05s");
		expect(formatDuration(3_720_000)).toBe("1h02m");
	});

	it("colors card headers by kind", () => {
		expect(eventColor(evt("spawn"))).toBe("accent");
		expect(eventColor(evt("done"))).toBe("success");
		expect(eventColor(evt("fix-round"))).toBe("warning");
		expect(eventColor(evt("blocked"))).toBe("error");
		expect(eventColor(evt("failed"))).toBe("error");
		expect(eventColor(evt("shipped"))).toBe("success");
		expect(eventColor(evt("settled"))).toBe("accent");
		expect(eventColor(evt("research-spawn"))).toBe("accent");
		expect(eventColor({ ...researchDoneEvent, ok: true })).toBe("success");
		expect(eventColor({ ...researchDoneEvent, ok: false })).toBe("error");
	});

	it("tints card backgrounds by kind from the available bg keys", () => {
		expect(eventBg(evt("done"))).toBe("toolSuccessBg");
		expect(eventBg(evt("shipped"))).toBe("toolSuccessBg");
		// No warning bg exists in the theme — fix-round leans on toolPendingBg.
		expect(eventBg(evt("fix-round"))).toBe("toolPendingBg");
		expect(eventBg(evt("blocked"))).toBe("toolErrorBg");
		expect(eventBg(evt("failed"))).toBe("toolErrorBg");
		expect(eventBg(evt("spawn"))).toBe("customMessageBg");
		expect(eventBg(evt("settled"))).toBe("customMessageBg");
		expect(eventBg(evt("research-spawn"))).toBe("customMessageBg");
		expect(eventBg({ ...researchDoneEvent, ok: true })).toBe("toolSuccessBg");
		expect(eventBg({ ...researchDoneEvent, ok: false })).toBe("toolErrorBg");
	});

	it("builds a spawn header and keeps the card body-free", () => {
		const spawn: ExecutionEvent = {
			kind: "spawn",
			agentKey: "auth/worker",
			session: "maestro-ada",
			resumed: false,
			deliverableTitle: "Auth",
		};
		expect(buildCardHeader(spawn)).toBe("◆ Auth · worker started");
		expect(buildCardHeader({ ...spawn, resumed: true })).toBe(
			"◆ Auth · worker started (resumed)",
		);
		expect(buildCardBody(spawn, false)).toEqual([]);
		expect(buildCardBody(spawn, true)).toEqual([]);
		expect(buildStatsTrailer(spawn)).toBe("");
		// Single line — the whole card is one tiny tinted block.
		expect(buildEventContent(spawn)).toBe("◆ Auth · worker started");
	});

	it("builds a summary-first done header without stats", () => {
		expect(buildCardHeader(doneEvent)).toBe(
			"✓ Auth · worker · finished in 4m05s",
		);
	});

	it("demotes done stats to a dim trailer", () => {
		expect(buildStatsTrailer(doneEvent)).toBe(
			"↳ 2 commits · 52.0k/8.4k tok · cache 82% · 12 turns",
		);
	});

	it("omits absent commit and cache stats from the trailer", () => {
		const { cacheRatio: _cache, commits: _commits, ...rest } = doneEvent;
		expect(buildStatsTrailer(rest as ExecutionEvent)).toBe(
			"↳ 52.0k/8.4k tok · 12 turns",
		);
	});

	describe("firstParagraph", () => {
		it("strips a leading ## Summary heading", () => {
			expect(firstParagraph("## Summary\nDid the thing.")).toBe(
				"Did the thing.",
			);
		});

		it("splits on the first blank line", () => {
			expect(firstParagraph("First para\nstill first.\n\nSecond para.")).toBe(
				"First para\nstill first.",
			);
		});

		it("returns the whole summary when it has no blank line", () => {
			expect(firstParagraph("One line.\nTwo lines.")).toBe(
				"One line.\nTwo lines.",
			);
		});
	});

	it("collapsed done body is the summary's first paragraph only", () => {
		expect(buildCardBody(doneEvent, false)).toEqual([
			"Implemented the login endpoint.",
		]);
	});

	it("expanded done body adds the rest of the summary, then commits", () => {
		expect(buildCardBody(doneEvent, true)).toEqual([
			"Implemented the login endpoint.",
			"",
			"Added tests covering refresh and expiry.",
			"",
			"commits:",
			"  feat: add login",
			"  test: cover refresh",
		]);
	});

	it("builds fix-round header, findings body, and resurrection trailer", () => {
		expect(buildCardHeader(fixRoundEvent)).toBe("↻ Auth · fix round 2");
		expect(buildCardBody(fixRoundEvent, false)).toEqual([
			"missing CSRF check",
			"no rate limit",
		]);
		expect(buildStatsTrailer(fixRoundEvent)).toBe(
			"↳ round 2 · 2 findings · worker resurrected",
		);
	});

	it("builds blocked with the reason as body and a /retry trailer", () => {
		const blocked: ExecutionEvent = {
			kind: "blocked",
			deliverableId: "auth",
			deliverableTitle: "Auth",
			reason: "fix-round cap reached",
		};
		expect(buildCardHeader(blocked)).toBe("■ Auth · blocked");
		expect(buildCardBody(blocked, false)).toEqual(["fix-round cap reached"]);
		expect(buildStatsTrailer(blocked)).toBe("↳ /retry after inspecting");
	});

	it("builds failed with a respawn-count trailer", () => {
		const failed: ExecutionEvent = {
			kind: "failed",
			agentKey: "auth/worker",
			deliverableTitle: "Auth",
			respawns: 2,
		};
		expect(buildCardHeader(failed)).toBe("✗ Auth · worker failed");
		expect(buildCardBody(failed, false)).toEqual([]);
		expect(buildStatsTrailer(failed)).toBe("↳ 2 respawns");
	});

	it("builds shipped with the PR URL as body and the deliverable id trailer", () => {
		const shipped: ExecutionEvent = {
			kind: "shipped",
			deliverableId: "auth",
			deliverableTitle: "Auth",
			prUrl: "https://github.com/org/repo/pull/42",
		};
		expect(buildCardHeader(shipped)).toBe("⇧ Auth · shipped");
		expect(buildCardBody(shipped, false)).toEqual([
			"https://github.com/org/repo/pull/42",
		]);
		expect(buildStatsTrailer(shipped)).toBe("↳ deliverable auth");
	});

	it("builds a settled header and per-deliverable status body", () => {
		const settled: ExecutionEvent = {
			kind: "settled",
			deliverables: [
				{
					id: "auth",
					title: "Auth",
					status: "shipped",
					prUrl: "https://github.com/org/repo/pull/42",
				},
				{ id: "db", title: "DB", status: "abandoned" },
			],
		};
		expect(buildCardHeader(settled)).toBe(
			"◆ all deliverables settled · 1/2 shipped",
		);
		expect(buildCardBody(settled, false)).toEqual([
			"Auth — shipped https://github.com/org/repo/pull/42",
			"DB — abandoned",
		]);
		expect(buildStatsTrailer(settled)).toBe("");
	});

	it("content fallback mirrors the summary-first collapsed layout", () => {
		expect(buildEventContent(doneEvent)).toBe(
			[
				"✓ Auth · worker · finished in 4m05s",
				"",
				"Implemented the login endpoint.",
				"",
				"  ↳ 2 commits · 52.0k/8.4k tok · cache 82% · 12 turns",
			].join("\n"),
		);
	});
});

describe("registerAgentCardRenderer", () => {
	function capture(): {
		renderer: () => MessageRenderer<ExecutionEvent>;
		pi: ExtensionAPI;
	} {
		let captured: MessageRenderer<ExecutionEvent> | undefined;
		const pi = {
			registerMessageRenderer: (
				_type: string,
				renderer: MessageRenderer<ExecutionEvent>,
			) => {
				captured = renderer;
			},
		} as unknown as ExtensionAPI;
		return {
			pi,
			renderer: () => {
				if (!captured) throw new Error("renderer not registered");
				return captured;
			},
		};
	}

	function renderToText(
		component: ReturnType<MessageRenderer<ExecutionEvent>>,
		width = 100,
	): string {
		if (!component) throw new Error("renderer returned nothing");
		// Text pads rendered lines to the full width — trim for assertions.
		return component
			.render(width)
			.map((line) => line.trimEnd())
			.join("\n");
	}

	function message(event: ExecutionEvent) {
		return {
			role: "custom" as const,
			customType: AGENT_EVENT_MESSAGE_TYPE,
			content: buildEventContent(event),
			display: true,
			details: event,
			timestamp: Date.now(),
		};
	}

	function render(event: ExecutionEvent, expanded: boolean): string {
		const { pi, renderer } = capture();
		registerAgentCardRenderer(pi);
		return renderToText(renderer()(message(event), { expanded }, theme));
	}

	it("collapsed: padded tinted block with header, first paragraph, trailer", () => {
		const text = render(doneEvent, false);
		const lines = text.split("\n");
		// paddingY=1: blank tinted rows above and below the content.
		expect(lines[0]).toBe("");
		expect(lines[lines.length - 1]).toBe("");
		// paddingX=1: content is inset one column.
		expect(lines[1]).toBe(" ✓ Auth · worker · finished in 4m05s");
		expect(text).toContain("Implemented the login endpoint.");
		expect(text).toContain(
			"↳ 2 commits · 52.0k/8.4k tok · cache 82% · 12 turns",
		);
		// Summary-first: collapsed hides everything past the first paragraph.
		expect(text).not.toContain("Added tests covering refresh and expiry.");
		expect(text).not.toContain("feat: add login");
	});

	it("expanded: adds the rest of the summary and the commit list", () => {
		const text = render(doneEvent, true);
		expect(text).toContain("Implemented the login endpoint.");
		expect(text).toContain("Added tests covering refresh and expiry.");
		expect(text).toContain("commits:");
		expect(text).toContain("feat: add login");
		expect(text).toContain("test: cover refresh");
	});

	it("wraps long body prose instead of truncating it", () => {
		const wordy = {
			...doneEvent,
			summary: `long-summary ${"word ".repeat(40)}end-of-summary`,
		};
		const text = render(wordy, false);
		expect(text.split("\n").length).toBeGreaterThan(5);
		expect(text).toContain("end-of-summary");
	});

	it("spawn renders as a single header line inside the padding", () => {
		const text = render(
			{
				kind: "spawn",
				agentKey: "auth/worker",
				session: "maestro-ada",
				resumed: false,
				deliverableTitle: "Auth",
			},
			false,
		);
		expect(text.split("\n")).toEqual(["", " ◆ Auth · worker started", ""]);
	});

	it("tints the block with the kind's bg color", () => {
		const bgCalls: string[] = [];
		const spyTheme = {
			fg: (_color: string, text: string) => text,
			bg: (color: string, text: string) => {
				bgCalls.push(color);
				return text;
			},
		} as unknown as Theme;
		const { pi, renderer } = capture();
		registerAgentCardRenderer(pi);
		renderToText(renderer()(message(doneEvent), { expanded: false }, spyTheme));
		expect(bgCalls.length).toBeGreaterThan(0);
		expect(new Set(bgCalls)).toEqual(new Set(["toolSuccessBg"]));
	});

	it("never emits box-drawing characters", () => {
		const events: ExecutionEvent[] = [
			doneEvent,
			fixRoundEvent,
			{
				kind: "spawn",
				agentKey: "auth/worker",
				session: "s",
				resumed: true,
				deliverableTitle: "Auth",
			},
			{
				kind: "blocked",
				deliverableId: "auth",
				deliverableTitle: "Auth",
				reason: "cap",
			},
			{
				kind: "failed",
				agentKey: "auth/worker",
				deliverableTitle: "Auth",
				respawns: 1,
			},
			{ kind: "shipped", deliverableId: "auth", deliverableTitle: "Auth" },
			{
				kind: "settled",
				deliverables: [{ id: "a", title: "A", status: "shipped" }],
			},
		];
		for (const event of events) {
			for (const expanded of [false, true]) {
				const text = render(event, expanded);
				expect(text).not.toMatch(/[─-╿]/);
				expect(buildEventContent(event)).not.toMatch(/[─-╿]/);
			}
		}
	});

	it("falls back to plain content when details are missing", () => {
		const { pi, renderer } = capture();
		registerAgentCardRenderer(pi);
		const component = renderer()(
			{
				role: "custom",
				customType: AGENT_EVENT_MESSAGE_TYPE,
				content: "plain fallback",
				display: true,
				details: undefined,
				timestamp: Date.now(),
			},
			{ expanded: false },
			theme,
		);
		expect(renderToText(component)).toContain("plain fallback");
	});
});

describe("sendAgentEvent", () => {
	it("sends a display-only custom message without triggering a turn", () => {
		const sent: { message: unknown; options: unknown }[] = [];
		const pi = {
			sendMessage: (msg: unknown, options: unknown) => {
				sent.push({ message: msg, options });
			},
		} as unknown as ExtensionAPI;

		sendAgentEvent(pi, doneEvent);

		expect(sent).toHaveLength(1);
		const msg = sent[0].message as {
			customType: string;
			content: string;
			display: boolean;
			details: ExecutionEvent;
		};
		expect(msg.customType).toBe(AGENT_EVENT_MESSAGE_TYPE);
		expect(msg.display).toBe(true);
		expect(msg.details).toEqual(doneEvent);
		expect(msg.content).toContain("✓ Auth · worker · finished in 4m05s");
		expect(sent[0].options).toEqual({ triggerTurn: false });
	});
});
