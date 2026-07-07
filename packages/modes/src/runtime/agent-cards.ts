// Agent lifecycle cards: background-tinted, padded chat messages for
// execution milestones (spawn/done/fix-round/blocked/failed/shipped/
// settled), rendered exactly how pi renders tool calls — a Text component
// with paddingX/paddingY and a theme.bg tint, no box-drawing characters.
// Layout is summary-first: one header line, the summary's first paragraph
// as the body, and a dim stats trailer. Expanding adds the rest of the
// summary and the commit list. sendAgentEvent mirrors an ExecutionEvent
// into the session as a custom message; registerAgentCardRenderer draws it
// in the TUI. The header/body/trailer builders are pure string assembly so
// tests assert on plain text, and the message `content` carries the same
// summary-first layout unstyled for non-TUI modes.

import type {
	ExtensionAPI,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { ExecutionEvent } from "../exec/index.js";

export const AGENT_EVENT_MESSAGE_TYPE = "maestro.agent.event";

/** Background tint keys accepted by theme.bg (type not exported upstream). */
type ThemeBgColor = Parameters<Theme["bg"]>[0];

const k = (n: number): string => {
	if (n < 1000) return `${n}`;
	return `${(n / 1000).toFixed(1)}k`;
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

/** "worker" from "auth/worker" — the role half of an agent key. */
function agentRole(agentKey: string): string {
	const slash = agentKey.lastIndexOf("/");
	return slash === -1 ? agentKey : agentKey.slice(slash + 1);
}

const plural = (n: number, word: string): string =>
	`${n} ${word}${n === 1 ? "" : "s"}`;

/** Theme color for a card's header text, keyed by event kind. */
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

/**
 * Background tint for a card, keyed by event kind. The theme exposes only
 * six bg keys (selectedBg, userMessageBg, customMessageBg, toolPendingBg,
 * toolSuccessBg, toolErrorBg) — there is no warning or accent bg, so:
 *   done/shipped   → toolSuccessBg (success tint)
 *   blocked/failed → toolErrorBg   (error tint)
 *   fix-round      → toolPendingBg (closest to a warning; the warning hue
 *                    is carried by the theme.fg("warning") header instead)
 *   spawn/settled  → customMessageBg (neutral/accent tint; accent hue is
 *                    carried by the theme.fg("accent") header)
 */
export function eventBg(kind: ExecutionEvent["kind"]): ThemeBgColor {
	switch (kind) {
		case "done":
		case "shipped":
			return "toolSuccessBg";
		case "fix-round":
			return "toolPendingBg";
		case "blocked":
		case "failed":
			return "toolErrorBg";
		case "spawn":
		case "settled":
			return "customMessageBg";
	}
}

/** One-line card header — `<icon> <group> · <what happened>`. */
export function buildCardHeader(event: ExecutionEvent): string {
	switch (event.kind) {
		case "spawn":
			return `◆ ${event.groupTitle} · ${agentRole(event.agentKey)} started${event.resumed ? " (resumed)" : ""}`;
		case "done":
			return `✓ ${event.groupTitle} · ${agentRole(event.agentKey)} · finished in ${formatDuration(event.durationMs)}`;
		case "fix-round":
			return `↻ ${event.groupTitle} · fix round ${event.round}`;
		case "blocked":
			return `■ ${event.groupTitle} · blocked`;
		case "failed":
			return `✗ ${event.groupTitle} · ${agentRole(event.agentKey)} failed`;
		case "shipped":
			return `⇧ ${event.groupTitle} · shipped`;
		case "settled": {
			const shipped = event.groups.filter((g) => g.status === "shipped").length;
			return `◆ all groups settled · ${shipped}/${event.groups.length} shipped`;
		}
	}
}

/**
 * First paragraph of an agent summary: strips a leading "## Summary"
 * heading (any level), then cuts at the first blank line. Returns the whole
 * summary when it has no blank line.
 */
export function firstParagraph(summary: string): string {
	const stripped = summary.trim().replace(/^#{1,6}[ \t]*summary[ \t]*\n+/i, "");
	const blank = stripped.search(/\n[ \t]*\n/);
	return (blank === -1 ? stripped : stripped.slice(0, blank)).trim();
}

/** Everything after the first paragraph — shown only when expanded. */
function restOfSummary(summary: string): string {
	const stripped = summary.trim().replace(/^#{1,6}[ \t]*summary[ \t]*\n+/i, "");
	const blank = stripped.search(/\n[ \t]*\n/);
	return blank === -1 ? "" : stripped.slice(blank).trim();
}

/**
 * Card body lines — summary-first prose. Collapsed done cards show only the
 * summary's first paragraph; expanding adds the rest of the summary and the
 * commit list.
 */
export function buildCardBody(
	event: ExecutionEvent,
	expanded: boolean,
): string[] {
	switch (event.kind) {
		case "spawn":
			// Spawn stays minimal: header line only, no body.
			return [];
		case "done": {
			const lines: string[] = [];
			if (event.summary) {
				lines.push(firstParagraph(event.summary));
				if (expanded) {
					const rest = restOfSummary(event.summary);
					if (rest) lines.push("", rest);
				}
			}
			if (expanded && event.commits?.length) {
				if (lines.length > 0) lines.push("");
				lines.push("commits:");
				for (const commit of event.commits) lines.push(`  ${commit}`);
			}
			return lines;
		}
		case "fix-round":
			return [...event.findings];
		case "blocked":
			return [event.reason];
		case "failed":
			// The failed event carries no error payload — header + trailer only.
			return [];
		case "shipped":
			return event.prUrl ? [event.prUrl] : [];
		case "settled":
			return event.groups.map(
				(g) => `${g.title} — ${g.status}${g.prUrl ? ` ${g.prUrl}` : ""}`,
			);
	}
}

/** Dim one-line stats trailer — "↳ …" under the body; "" when none. */
export function buildStatsTrailer(event: ExecutionEvent): string {
	switch (event.kind) {
		case "spawn":
		case "settled":
			return "";
		case "done": {
			const t = event.tokens;
			const parts: string[] = [];
			if (event.commits?.length)
				parts.push(plural(event.commits.length, "commit"));
			parts.push(`${k(t.input)}/${k(t.output)} tok`);
			if (event.cacheRatio !== undefined)
				parts.push(`cache ${Math.round(event.cacheRatio * 100)}%`);
			parts.push(`${t.turns} turns`);
			return `↳ ${parts.join(" · ")}`;
		}
		case "fix-round":
			return `↳ round ${event.round} · ${plural(event.findings.length, "finding")} · worker resurrected`;
		case "blocked":
			return "↳ /retry after inspecting";
		case "failed":
			return `↳ ${plural(event.respawns, "respawn")}`;
		case "shipped":
			return `↳ group ${event.groupId}`;
	}
}

/** Header + blank line + body + blank line + indented trailer. */
function assembleLines(
	header: string,
	body: string[],
	trailer: string,
): string[] {
	const lines = [header];
	if (body.length > 0) lines.push("", ...body);
	if (trailer) lines.push("", `  ${trailer}`);
	return lines;
}

/** Plain-text fallback (message content) — same summary-first layout. */
export function buildEventContent(event: ExecutionEvent): string {
	return assembleLines(
		buildCardHeader(event),
		buildCardBody(event, false),
		buildStatsTrailer(event),
	).join("\n");
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
			const header = theme.fg(eventColor(event.kind), buildCardHeader(event));
			const body = buildCardBody(event, options.expanded === true);
			const trailer = buildStatsTrailer(event);
			const lines = [header];
			if (body.length > 0) lines.push("", ...body);
			if (trailer) lines.push("", theme.fg("dim", `  ${trailer}`));
			// Tool-call style frame: padded Text with a per-kind bg tint,
			// word-wrapped natively by the component.
			return new Text(lines.join("\n"), 1, 1, (text) =>
				theme.bg(eventBg(event.kind), text),
			);
		},
	);
}
