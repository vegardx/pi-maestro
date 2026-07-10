// Agent lifecycle cards: background-tinted, padded chat messages for
// execution milestones (spawn/done/blocked/failed/shipped/
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
import type { ResearchKind } from "../research.js";
import { formatEffort } from "./agent-widget.js";

export const AGENT_EVENT_MESSAGE_TYPE = "maestro.agent.event";

/** Plan-phase research milestones, rendered by the same card renderer. */
export type ResearchCardEvent =
	| {
			readonly kind: "research-spawn";
			readonly question: string;
			readonly research: ResearchKind;
	  }
	| {
			readonly kind: "research-done";
			readonly question: string;
			readonly research: ResearchKind;
			readonly ok: boolean;
			readonly durationMs: number;
			/** Report path relative to the plan dir, e.g. "research/03-….md". */
			readonly reportPath?: string;
			readonly report?: string;
			readonly error?: string;
	  };

/** Everything the agent-event card renderer accepts. */
export type AgentCardEvent = ExecutionEvent | ResearchCardEvent;

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

/** Theme color for a card's header text, keyed by event. */
export function eventColor(event: AgentCardEvent): ThemeColor {
	switch (event.kind) {
		case "spawn":
		case "research-spawn":
			return "accent";
		case "done":
		case "shipped":
			return "success";
		case "blocked":
		case "failed":
			return "error";
		case "settled":
			return "accent";
		case "research-done":
			return event.ok ? "success" : "error";
	}
}

/**
 * Background tint for a card, keyed by event kind. The theme exposes only
 * six bg keys (selectedBg, userMessageBg, customMessageBg, toolPendingBg,
 * toolSuccessBg, toolErrorBg) — there is no warning or accent bg, so:
 *   done/shipped   → toolSuccessBg (success tint)
 *   blocked/failed → toolErrorBg   (error tint)
 *   spawn/settled  → customMessageBg (neutral/accent tint; accent hue is
 *                    carried by the theme.fg("accent") header)
 */
export function eventBg(event: AgentCardEvent): ThemeBgColor {
	switch (event.kind) {
		case "done":
		case "shipped":
			return "toolSuccessBg";
		case "blocked":
		case "failed":
			return "toolErrorBg";
		case "spawn":
		case "settled":
		case "research-spawn":
			return "customMessageBg";
		case "research-done":
			return event.ok ? "toolSuccessBg" : "toolErrorBg";
	}
}

/** Question text fit for a one-line header. */
function shortQuestion(question: string): string {
	const flat = question.replace(/\s+/g, " ").trim();
	return flat.length > 64 ? `${flat.slice(0, 63)}…` : flat;
}

/** One-line card header — `<icon> <deliverable> · <what happened>`. */
export function buildCardHeader(event: AgentCardEvent): string {
	switch (event.kind) {
		case "research-spawn":
			return `◇ research (${event.research}) · ${shortQuestion(event.question)}`;
		case "research-done":
			return event.ok
				? `✓ research · ${shortQuestion(event.question)} · ${formatDuration(event.durationMs)}`
				: `✗ research failed · ${shortQuestion(event.question)}`;
		case "spawn":
			return `◆ ${event.deliverableTitle} · ${agentRole(event.agentKey)} started${event.resumed ? " (resumed)" : ""}`;
		case "done":
			return `✓ ${event.deliverableTitle} · ${agentRole(event.agentKey)} · finished in ${formatDuration(event.durationMs)}`;
		case "blocked":
			return `■ ${event.deliverableTitle} · blocked`;
		case "failed":
			return `✗ ${event.deliverableTitle} · ${agentRole(event.agentKey)} failed`;
		case "shipped":
			return `⇧ ${event.deliverableTitle} · shipped`;
		case "settled": {
			const shipped = event.deliverables.filter(
				(g) => g.status === "shipped",
			).length;
			return `◆ all deliverables settled · ${shipped}/${event.deliverables.length} shipped`;
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
	event: AgentCardEvent,
	expanded: boolean,
): string[] {
	switch (event.kind) {
		case "spawn":
		case "research-spawn":
			// Spawn stays minimal: header line only, no body.
			return [];
		case "research-done": {
			if (!event.ok) return event.error ? [event.error] : [];
			if (!event.report) return [];
			const lines = [firstParagraph(event.report)];
			if (expanded) {
				const rest = restOfSummary(event.report);
				if (rest) lines.push("", rest);
			}
			return lines;
		}
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
		case "blocked":
			return [event.reason];
		case "failed":
			// The failed event carries no error payload — header + trailer only.
			return [];
		case "shipped":
			return event.prUrl ? [event.prUrl] : [];
		case "settled":
			return event.deliverables.map(
				(g) => `${g.title} — ${g.status}${g.prUrl ? ` ${g.prUrl}` : ""}`,
			);
	}
}

/** Dim one-line stats trailer — "↳ …" under the body; "" when none. */
export function buildStatsTrailer(event: AgentCardEvent): string {
	switch (event.kind) {
		case "spawn":
		case "settled":
		case "research-spawn":
			return "";
		case "research-done": {
			if (!event.ok) return "";
			const parts: string[] = [event.research];
			if (event.reportPath) parts.push(event.reportPath);
			return `↳ ${parts.join(" · ")}`;
		}
		case "done": {
			const t = event.tokens;
			const parts: string[] = [];
			if (event.model) parts.push(event.model);
			if (event.effort) parts.push(formatEffort(event.effort, event.adaptive));
			if (event.commits?.length)
				parts.push(plural(event.commits.length, "commit"));
			// Zero tokens across real turns = the provider reported no usage
			// (e.g. a gateway that drops streaming usage) — say so instead of
			// rendering a plausible-looking "0/0 tok".
			if (t.input === 0 && t.output === 0 && t.turns > 0) {
				parts.push("no usage reported");
			} else {
				parts.push(`${k(t.input)}/${k(t.output)} tok`);
				if (event.cacheRatio !== undefined)
					parts.push(`cache ${Math.round(event.cacheRatio * 100)}%`);
			}
			parts.push(`${t.turns} turns`);
			return `↳ ${parts.join(" · ")}`;
		}
		case "blocked":
			return "↳ /retry after inspecting";
		case "failed":
			return `↳ ${plural(event.respawns, "respawn")}`;
		case "shipped":
			return `↳ deliverable ${event.deliverableId}`;
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
export function buildEventContent(event: AgentCardEvent): string {
	return assembleLines(
		buildCardHeader(event),
		buildCardBody(event, false),
		buildStatsTrailer(event),
	).join("\n");
}

/** Mirror an execution/research event into the chat as a progress card. */
export function sendAgentEvent(pi: ExtensionAPI, event: AgentCardEvent): void {
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
	pi.registerMessageRenderer<AgentCardEvent>(
		AGENT_EVENT_MESSAGE_TYPE,
		(message, options, theme) => {
			const event = message.details;
			if (!event || typeof event !== "object" || !("kind" in event)) {
				// No structured payload — fall back to the plain content.
				const content =
					typeof message.content === "string" ? message.content : "";
				return new Text(content, 0, 0);
			}
			const header = theme.fg(eventColor(event), buildCardHeader(event));
			const body = buildCardBody(event, options.expanded === true);
			const trailer = buildStatsTrailer(event);
			const lines = [header];
			if (body.length > 0) lines.push("", ...body);
			if (trailer) lines.push("", theme.fg("dim", `  ${trailer}`));
			// Tool-call style frame: padded Text with a per-kind bg tint,
			// word-wrapped natively by the component.
			return new Text(lines.join("\n"), 1, 1, (text) =>
				theme.bg(eventBg(event), text),
			);
		},
	);
}
