// Agent progress cards: the pure header/body/content builders per event
// kind, the collapsed/expanded TUI renderer output, and the sendAgentEvent
// message shape.

import type {
	ExtensionAPI,
	MessageRenderer,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { ExecutionEvent } from "../packages/modes/src/exec/index.js";
import {
	AGENT_EVENT_MESSAGE_TYPE,
	buildCardBody,
	buildCardHeader,
	buildEventContent,
	eventColor,
	formatDuration,
	registerAgentCardRenderer,
	sendAgentEvent,
} from "../packages/modes/src/runtime/agent-cards.js";

/** Identity theme: styling is a no-op so assertions see plain text. */
const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
} as unknown as Theme;

const doneEvent: ExecutionEvent = {
	kind: "done",
	agentKey: "auth/worker",
	groupTitle: "Auth",
	durationMs: 245_000,
	tokens: { input: 52_000, output: 8_400, turns: 12 },
	cacheRatio: 0.82,
	summary: "## Summary\nImplemented the login endpoint.\nAdded tests.",
};

describe("agent card builders", () => {
	it("formats durations compactly", () => {
		expect(formatDuration(3_000)).toBe("3s");
		expect(formatDuration(245_000)).toBe("4m05s");
		expect(formatDuration(3_720_000)).toBe("1h02m");
	});

	it("colors cards by kind with sensible fallbacks", () => {
		expect(eventColor("spawn")).toBe("accent");
		expect(eventColor("done")).toBe("success");
		expect(eventColor("fix-round")).toBe("warning");
		expect(eventColor("blocked")).toBe("error");
		expect(eventColor("failed")).toBe("error");
		expect(eventColor("shipped")).toBe("success");
		expect(eventColor("settled")).toBe("accent");
	});

	it("builds a spawn header", () => {
		expect(
			buildCardHeader({
				kind: "spawn",
				agentKey: "auth/worker",
				session: "maestro-ada",
				resumed: false,
				groupTitle: "Auth",
			}),
		).toBe("▸ spawned auth/worker — Auth");
		expect(
			buildCardHeader({
				kind: "spawn",
				agentKey: "auth/worker",
				session: "maestro-ada",
				resumed: true,
				groupTitle: "Auth",
			}),
		).toContain("(resumed)");
	});

	it("builds a done header with duration, tokens, and cache", () => {
		const header = buildCardHeader(doneEvent);
		expect(header).toBe(
			"✓ done auth/worker · 4m05s · ↑52k ↓8k · 12 turns · cache 82% — Auth",
		);
	});

	it("expands a done card with a capped summary excerpt", () => {
		const long = {
			...doneEvent,
			summary: Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join("\n"),
		};
		const body = buildCardBody(long);
		expect(body).toHaveLength(11); // 10 lines + ellipsis
		expect(body[0]).toBe("line 1");
		expect(body[10]).toBe("…");
	});

	it("includes commits before the summary when provided", () => {
		const body = buildCardBody({
			...doneEvent,
			commits: ["feat: add login", "test: cover refresh"],
		});
		expect(body.slice(0, 3)).toEqual([
			"commits:",
			"  feat: add login",
			"  test: cover refresh",
		]);
		expect(body).toContain("Implemented the login endpoint.");
	});

	it("builds fix-round header and findings body", () => {
		const event: ExecutionEvent = {
			kind: "fix-round",
			groupId: "auth",
			groupTitle: "Auth",
			round: 2,
			findings: ["missing CSRF check", "no rate limit"],
		};
		expect(buildCardHeader(event)).toBe("↻ fix round 2 — Auth (2 findings)");
		expect(buildCardBody(event)).toEqual([
			"• missing CSRF check",
			"• no rate limit",
		]);
	});

	it("builds blocked and failed headers", () => {
		expect(
			buildCardHeader({
				kind: "blocked",
				groupId: "auth",
				groupTitle: "Auth",
				reason: "fix-round cap reached",
			}),
		).toBe("■ blocked — Auth: fix-round cap reached");
		expect(
			buildCardHeader({
				kind: "failed",
				agentKey: "auth/worker",
				groupTitle: "Auth",
				respawns: 2,
			}),
		).toBe("✗ failed auth/worker after 2 respawns — Auth");
	});

	it("builds a shipped header with the PR number", () => {
		expect(
			buildCardHeader({
				kind: "shipped",
				groupId: "auth",
				groupTitle: "Auth",
				prUrl: "https://github.com/org/repo/pull/42",
			}),
		).toBe("⇧ shipped — Auth (PR #42)");
	});

	it("builds a settled header and group list body", () => {
		const event: ExecutionEvent = {
			kind: "settled",
			groups: [
				{
					id: "auth",
					title: "Auth",
					status: "shipped",
					prUrl: "https://github.com/org/repo/pull/42",
				},
				{ id: "db", title: "DB", status: "abandoned" },
			],
		};
		expect(buildCardHeader(event)).toBe("◆ all groups settled — 1/2 shipped");
		expect(buildCardBody(event)).toEqual([
			"✓ Auth — shipped (#42)",
			"• DB — abandoned",
		]);
	});

	it("content fallback carries header plus body as plain text", () => {
		const content = buildEventContent(doneEvent);
		const [first, ...rest] = content.split("\n");
		expect(first).toBe(buildCardHeader(doneEvent));
		expect(rest.join("\n")).toContain("Implemented the login endpoint.");
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

	it("collapsed: renders a single boxed header line", () => {
		const { pi, renderer } = capture();
		registerAgentCardRenderer(pi);
		const text = renderToText(
			renderer()(message(doneEvent), { expanded: false }, theme),
		);
		const lines = text.split("\n");
		expect(lines).toHaveLength(3); // top border, header, bottom border
		expect(lines[0]).toMatch(/^╭─+╮$/);
		expect(lines[1]).toContain("✓ done auth/worker");
		expect(lines[2]).toMatch(/^╰─+╯$/);
		expect(text).not.toContain("Implemented the login endpoint.");
	});

	it("expanded: adds the summary excerpt inside the box", () => {
		const { pi, renderer } = capture();
		registerAgentCardRenderer(pi);
		const text = renderToText(
			renderer()(message(doneEvent), { expanded: true }, theme),
		);
		expect(text).toContain("✓ done auth/worker");
		expect(text).toContain("Implemented the login endpoint.");
		expect(text).toContain("Added tests.");
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
		expect(msg.content).toContain("✓ done auth/worker");
		expect(sent[0].options).toEqual({ triggerTurn: false });
	});
});
