// Agent lifecycle cards: bordered, theme-colored, collapsible chat messages
// for execution milestones (spawn/done/fix-round/blocked/failed/shipped/
// settled). sendAgentEvent mirrors an ExecutionEvent into the session as a
// custom message; registerAgentCardRenderer draws it in the TUI. The header/
// body builders are pure string assembly so tests assert on plain text, and
// the message `content` carries the same info unstyled for non-TUI modes.

import type {
	ExtensionAPI,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExecutionEvent } from "../exec/index.js";

export const AGENT_EVENT_MESSAGE_TYPE = "maestro.agent.event";

/** Expanded done-cards show at most this many summary lines. */
const SUMMARY_EXCERPT_LINES = 10;
/** Card inner width cap — keeps boxes readable on wide terminals. */
const CARD_MAX_WIDTH = 76;

const k = (n: number): string => {
	if (n < 1000) return `${n}`;
	return `${Math.round(n / 1000)}k`;
};

/** "3s" / "4m05s" / "1h02m" — compact duration for the done card. */
export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) {
		const rs = s % 60;
		return rs > 0 ? `${m}m${String(rs).padStart(2, "0")}s` : `${m}m`;
	}
	const h = Math.floor(m / 60);
	const rm = m % 60;
	return rm > 0 ? `${h}h${String(rm).padStart(2, "0")}m` : `${h}h`;
}

/** "#123" from a GitHub PR url, or the url itself when it doesn't match. */
function prLabel(prUrl: string): string {
	const match = /\/pull\/(\d+)/.exec(prUrl);
	return match ? `#${match[1]}` : prUrl;
}

/** Theme color for a card's border and header, keyed by event kind. */
export function eventColor(kind: ExecutionEvent["kind"]): ThemeColor {
	switch (kind) {
		case "spawn":
			return "accent";
		case "done":
		case "shipped":
			return "success";
		case "fix-round":
			return "warning";
		case "blocked":
		case "failed":
			return "error";
		case "settled":
			return "accent";
	}
}

/** One-line card header — the entire collapsed card. */
export function buildCardHeader(event: ExecutionEvent): string {
	switch (event.kind) {
		case "spawn":
			return `▸ spawned ${event.agentKey}${event.resumed ? " (resumed)" : ""} — ${event.groupTitle}`;
		case "done": {
			const t = event.tokens;
			const cache =
				event.cacheRatio !== undefined
					? ` · cache ${Math.round(event.cacheRatio * 100)}%`
					: "";
			return `✓ done ${event.agentKey} · ${formatDuration(event.durationMs)} · ↑${k(t.input)} ↓${k(t.output)} · ${t.turns} turns${cache} — ${event.groupTitle}`;
		}
		case "fix-round":
			return `↻ fix round ${event.round} — ${event.groupTitle} (${event.findings.length} finding${event.findings.length === 1 ? "" : "s"})`;
		case "blocked":
			return `■ blocked — ${event.groupTitle}: ${event.reason}`;
		case "failed":
			return `✗ failed ${event.agentKey} after ${event.respawns} respawn${event.respawns === 1 ? "" : "s"} — ${event.groupTitle}`;
		case "shipped":
			return `⇧ shipped — ${event.groupTitle}${event.prUrl ? ` (PR ${prLabel(event.prUrl)})` : ""}`;
		case "settled": {
			const shipped = event.groups.filter((g) => g.status === "shipped").length;
			return `◆ all groups settled — ${shipped}/${event.groups.length} shipped`;
		}
	}
}

/** Extra lines shown only when the card is expanded. */
export function buildCardBody(event: ExecutionEvent): string[] {
	switch (event.kind) {
		case "done": {
			const lines: string[] = [];
			if (event.commits?.length) {
				lines.push("commits:");
				for (const commit of event.commits) lines.push(`  ${commit}`);
			}
			if (event.summary) {
				const all = event.summary.trim().split("\n");
				lines.push(...all.slice(0, SUMMARY_EXCERPT_LINES));
				if (all.length > SUMMARY_EXCERPT_LINES) lines.push("…");
			}
			return lines;
		}
		case "fix-round":
			return event.findings.map((finding) => `• ${finding}`);
		case "settled":
			return event.groups.map(
				(g) =>
					`${g.status === "shipped" ? "✓" : "•"} ${g.title} — ${g.status}${g.prUrl ? ` (${prLabel(g.prUrl)})` : ""}`,
			);
		default:
			return [];
	}
}

/** Plain-text fallback (message content) — same info, no styling or box. */
export function buildEventContent(event: ExecutionEvent): string {
	const body = buildCardBody(event);
	const header = buildCardHeader(event);
	return body.length > 0 ? `${header}\n${body.join("\n")}` : header;
}

/** Mirror an execution event into the chat as a progress-card message. */
export function sendAgentEvent(pi: ExtensionAPI, event: ExecutionEvent): void {
	pi.sendMessage(
		{
			customType: AGENT_EVENT_MESSAGE_TYPE,
			content: buildEventContent(event),
			display: true,
			details: event,
		},
		{ triggerTurn: false },
	);
}

/** Draw a rounded box around the header (+ body when expanded). */
function renderCard(
	header: string,
	body: string[],
	color: ThemeColor,
	theme: Theme,
): string {
	const inner = Math.min(
		CARD_MAX_WIDTH,
		Math.max(visibleWidth(header), ...body.map((line) => visibleWidth(line))),
	);
	const edge = (text: string) => theme.fg(color, text);
	const row = (text: string, paint: (s: string) => string): string => {
		const clipped = truncateToWidth(text, inner);
		const pad = " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
		return `${edge("│")} ${paint(clipped)}${pad} ${edge("│")}`;
	};
	const lines = [
		edge(`╭${"─".repeat(inner + 2)}╮`),
		row(header, (s) => theme.fg(color, s)),
	];
	for (const line of body) lines.push(row(line, (s) => theme.fg("muted", s)));
	lines.push(edge(`╰${"─".repeat(inner + 2)}╯`));
	return lines.join("\n");
}

/** Register the TUI renderer for maestro.agent.event messages. */
export function registerAgentCardRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<ExecutionEvent>(
		AGENT_EVENT_MESSAGE_TYPE,
		(message, options, theme) => {
			const event = message.details;
			if (!event || typeof event !== "object" || !("kind" in event)) {
				// No structured payload — fall back to the plain content.
				const content =
					typeof message.content === "string" ? message.content : "";
				return new Text(content, 0, 0);
			}
			const header = buildCardHeader(event);
			const body = options.expanded ? buildCardBody(event) : [];
			return new Text(
				renderCard(header, body, eventColor(event.kind), theme),
				0,
				0,
			);
		},
	);
}
