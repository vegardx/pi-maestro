// Live agent table: a full-width bordered panel rendered ABOVE the editor
// via ctx.ui.setWidget("maestro-agents", …). buildAgentTable is pure string
// assembly over ExecutionHandle.snapshot() data so tests assert on plain
// text; styleAgentTable applies theme colors and the widget wiring lives in
// dashboard.ts.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "./agent-cards.js";

/** Elapsed wall-clock for an agent row — same "4m12s" shape as done cards. */
export const formatElapsed = formatDuration;

/** One live agent's view for the table (ExecutionHandle.snapshot().agents). */
export interface AgentTableAgent {
	readonly status: string;
	readonly startedAt: number;
	readonly tokens: {
		readonly input: number;
		readonly output: number;
		readonly turns: number;
	};
	/** First-turn cacheRead/(cacheRead+input) — cache-prefix hit efficiency. */
	readonly cacheRatio?: number;
	/** Short model name (e.g. "fable-5"). */
	readonly model?: string;
	/** Thinking effort level (low/medium/high/…). */
	readonly effort?: string;
	/** True when the model uses adaptive thinking → renders "A/<level>". */
	readonly adaptive?: boolean;
}

/** Effort → compact cell: "A/H" for adaptive models, bare "H" for fixed. */
const EFFORT_ABBR: Record<string, string> = {
	off: "off",
	minimal: "min",
	low: "L",
	medium: "M",
	high: "H",
	xhigh: "XH",
};
export function formatEffort(effort?: string, adaptive?: boolean): string {
	if (!effort) return "";
	const abbr = EFFORT_ABBR[effort] ?? effort.slice(0, 2).toUpperCase();
	return adaptive ? `A/${abbr}` : abbr;
}

/** Per-deliverable round/blocked view (ExecutionHandle.snapshot().deliverables). */
export interface AgentTableDeliverable {
	readonly round: number;
	readonly blocked?: string;
}

export interface AgentTableInput {
	readonly agents: ReadonlyMap<string, AgentTableAgent> | undefined;
	readonly deliverables?: ReadonlyMap<string, AgentTableDeliverable>;
	/** Full terminal width the box is drawn to. */
	readonly width: number;
	/** Injectable clock for deterministic elapsed columns in tests. */
	readonly now?: number;
}

/** "13.2k" / "0.9k" for >= 100 tokens, raw digits below that. */
export function formatTokens(n: number): string {
	if (n < 100) return `${n}`;
	return `${(n / 1000).toFixed(1)}k`;
}

/** Statuses that count as live — everything else is excluded from the table.
 *  working/summarizing come from execution agents; searching/reading from
 *  research runs (mapped from the child's current tool). */
const ACTIVE_STATUSES = new Set([
	"working",
	"summarizing",
	"searching",
	"reading",
]);

/** Whether any agent would produce a table row (widget shown at all). */
export function hasActiveAgents(
	agents: ReadonlyMap<string, AgentTableAgent> | undefined,
): boolean {
	if (!agents) return false;
	for (const agent of agents.values()) {
		if (ACTIVE_STATUSES.has(agent.status)) return true;
	}
	return false;
}

/** Cap on AGENT cells before "…" truncation (DELIVERABLE flexes to fill). */
const NAME_CAP = 16;
/** DELIVERABLE never shrinks below its header length + a little room. */
const MIN_DELIVERABLE_WIDTH = 8;

const HEADERS = [
	"DELIV",
	"AGENT",
	"STATUS",
	"MODEL",
	"EFF",
	"TOKENS",
	"CACHE",
	"ELAPSED",
];
/** Columns dropped (in order) when the full set doesn't fit the width.
 *  MODEL/EFF are kept longer than CACHE/ELAPSED — they're the "is this on the
 *  model I expect" glance the table exists for. */
const DROP_ORDER = ["CACHE", "ELAPSED", "EFF", "MODEL"];
const COLUMN_GAP = 2;
/** "│ " + " │" around each row's content. */
const FRAME = 4;

/** Truncate to `max` cells, marking cuts with a trailing "…". */
function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max <= 1) return text.slice(0, Math.max(0, max));
	return `${text.slice(0, max - 1)}…`;
}

/**
 * Build the full-width live-agent panel. One row per ACTIVE (working/
 * summarizing) agent; done/pending/failed agents are excluded. A blocked
 * deliverable contributes a full-width "⚠ <deliverable> blocked: <reason>" row. Returns
 * [] when no agents are active (the widget is cleared).
 *
 * Columns are padded to align and the box is drawn to `width`. Below ~60
 * cols the CACHE column is dropped first, then ELAPSED; long deliverable/agent
 * names are truncated with "…".
 */
export function buildAgentTable(input: AgentTableInput): string[] {
	const { agents, deliverables, width } = input;
	if (!agents) return [];
	const now = input.now ?? Date.now();

	// ── Collect cell text per active agent ─────────────────────────────
	type Row = Record<string, string>;
	const rows: Row[] = [];
	const inputTokens: string[] = [];
	const outputTokens: string[] = [];
	for (const [key, agent] of agents) {
		if (!ACTIVE_STATUSES.has(agent.status)) continue;
		const [deliverable = "", name = key] = key.split("/");
		const deliverableState = deliverables?.get(deliverable);
		const status =
			agent.status === "working" &&
			name === "worker" &&
			deliverableState &&
			deliverableState.round > 0
				? `fixing r${deliverableState.round}`
				: agent.status;
		inputTokens.push(formatTokens(agent.tokens.input));
		outputTokens.push(formatTokens(agent.tokens.output));
		rows.push({
			DELIV: deliverable,
			AGENT: clip(name, NAME_CAP),
			STATUS: status,
			MODEL: agent.model ?? "",
			EFF: formatEffort(agent.effort, agent.adaptive),
			CACHE:
				agent.cacheRatio !== undefined
					? `${String(Math.round(agent.cacheRatio * 100)).padStart(2)}%`
					: "",
			ELAPSED: formatElapsed(Math.max(0, now - agent.startedAt)),
		});
	}
	if (rows.length === 0) return [];

	// TOKENS aligns its in/out halves on the "/" across rows.
	const inWidth = Math.max(...inputTokens.map((t) => t.length));
	const outWidth = Math.max(...outputTokens.map((t) => t.length));
	rows.forEach((row, i) => {
		row.TOKENS = `${inputTokens[i].padStart(inWidth)} / ${outputTokens[i].padStart(outWidth)}`;
	});

	// ── Fit columns: DELIVERABLE flexes to fill; drop CACHE then ELAPSED when
	// even a minimal DELIVERABLE column no longer fits ────────────────────────
	const inner = Math.max(1, width - FRAME);
	const fixedWidthsFor = (headers: string[]): number[] =>
		headers.map((h) =>
			h === "DELIV"
				? 0
				: Math.max(h.length, ...rows.map((row) => row[h]?.length ?? 0)),
		);
	const fixedTotalFor = (widths: number[]): number =>
		widths.reduce((sum, w) => sum + w, 0) + COLUMN_GAP * (widths.length - 1);

	let headers = HEADERS;
	let colWidths = fixedWidthsFor(headers);
	for (const drop of DROP_ORDER) {
		if (fixedTotalFor(colWidths) + MIN_DELIVERABLE_WIDTH <= inner) break;
		headers = headers.filter((h) => h !== drop);
		colWidths = fixedWidthsFor(headers);
	}
	// DELIVERABLE absorbs all remaining width so the box always spans the terminal.
	// Two chars are held back: header labels sit +1 right of their columns
	// (the rule's "┌─ " prefix vs the rows' "│ "), and the last label keeps
	// a trailing "─┐" — "… ELAPSED ─┐" — instead of butting the corner.
	const deliverableIdx = headers.indexOf("DELIV");
	colWidths[deliverableIdx] = Math.max(
		MIN_DELIVERABLE_WIDTH,
		inner - fixedTotalFor(colWidths) - 2,
	);
	for (const row of rows) {
		row.DELIV = clip(row.DELIV, colWidths[deliverableIdx]);
	}

	// ── Draw the box (headers live in the top border rule) ─────────────
	const line = (content: string): string =>
		`│ ${clip(content, inner).padEnd(inner)} │`;
	const tableRow = (cells: string[]): string =>
		line(cells.map((cell, i) => cell.padEnd(colWidths[i])).join("  "));

	const lines: string[] = [buildHeaderRule(headers, colWidths, width)];
	for (const row of rows) {
		lines.push(tableRow(headers.map((h) => row[h] ?? "")));
	}
	if (deliverables) {
		for (const [deliverableId, deliverableState] of deliverables) {
			if (!deliverableState.blocked) continue;
			lines.push(
				line(`⚠ ${deliverableId} blocked: ${deliverableState.blocked}`),
			);
		}
	}
	lines.push(`└${"─".repeat(Math.max(0, width - 2))}┘`);
	return lines;
}

/**
 * Top border with the column headers embedded in the rule:
 * `┌─ DELIVERABLE ────────── AGENT ───── STATUS ─ … ─┐`. Each label sits above
 * its column (one space either side, dashes filling the gaps).
 */
function buildHeaderRule(
	headers: string[],
	colWidths: number[],
	width: number,
): string {
	let rule = "┌─ ";
	headers.forEach((h, i) => {
		if (i === headers.length - 1) {
			rule += `${h} `;
			return;
		}
		const span = colWidths[i] + COLUMN_GAP;
		const seg = `${h} `.padEnd(span, "─");
		rule += `${seg.slice(0, -1)} `;
	});
	return `${rule.slice(0, Math.max(3, width - 2)).padEnd(width - 2, "─")}─┐`;
}

/**
 * Theme pass over buildAgentTable output: the frame (borders including the
 * header rule) is always dim; row CONTENT is styled on its own — plain for
 * agent rows, error-colored for "⚠ … blocked" rows — so a colored row never
 * bleeds into the box characters. Kept separate so the builder stays pure.
 */
export function styleAgentTable(lines: string[], theme: Theme): string[] {
	return lines.map((line, i) => {
		if (i === 0 || i === lines.length - 1) return theme.fg("dim", line);
		const left = theme.fg("dim", line.slice(0, 2));
		const right = theme.fg("dim", line.slice(-2));
		const content = line.slice(2, -2);
		const styled = content.trimStart().startsWith("⚠")
			? theme.fg("error", content)
			: content;
		return `${left}${styled}${right}`;
	});
}
