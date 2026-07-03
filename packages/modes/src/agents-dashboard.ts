import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import type { TokenSnapshot, UsageLedgerV1 } from "@vegardx/pi-contracts";
import {
	defaultPalette,
	formatElapsed,
	type Palette,
	padRight,
	truncate,
} from "@vegardx/pi-ui";
import type { PlanEngine } from "./engine.js";
import type {
	TmuxAgentState,
	TmuxAgentStatus,
	TmuxFanout,
} from "./execution-tmux.js";
import type { QuestionQueue } from "./question-queue.js";
import { findDeliverable } from "./schema.js";

export type DashboardAction =
	| { kind: "watch"; agentId: string }
	| { kind: "attach"; agentId: string }
	| { kind: "steer"; agentId: string }
	| { kind: "answer"; agentId: string };

export interface Row {
	readonly agentId: string;
	readonly state: TmuxAgentState;
	readonly title: string;
	readonly done: number;
	readonly total: number;
	readonly tasks: readonly { title: string; done: boolean }[];
	readonly pending?: string;
	readonly elapsedMs: number;
}

// ─── Tab definitions ────────────────────────────────────────────────────────

export type TabId = "all" | "working" | "waiting" | "done" | "failed";

const TABS: readonly TabId[] = ["all", "working", "waiting", "done", "failed"];

const TAB_LABELS: Record<TabId, string> = {
	all: "All",
	working: "Working",
	waiting: "Waiting",
	done: "Done",
	failed: "Failed",
};

function statusToTab(status: TmuxAgentStatus): TabId {
	switch (status) {
		case "spawning":
		case "working":
		case "idle":
			return "working";
		case "awaiting-decision":
			return "waiting";
		case "done":
			return "done";
		case "failed":
			return "failed";
	}
}

// ─── Status glyphs ─────────────────────────────────────────────────────────

const STATUS_GLYPH: Record<TmuxAgentStatus, string> = {
	spawning: "…",
	working: "◐",
	idle: "·",
	"awaiting-decision": "?",
	done: "✓",
	failed: "✗",
};

const STATUS_LABEL: Record<TmuxAgentStatus, string> = {
	spawning: "spawning",
	working: "working",
	idle: "idle",
	"awaiting-decision": "awaiting",
	done: "done",
	failed: "failed",
};

function glyphStyle(
	palette: Palette,
	status: TmuxAgentStatus,
): (s: string) => string {
	switch (status) {
		case "working":
			return palette.accent;
		case "awaiting-decision":
			return palette.warning;
		case "done":
			return palette.success;
		case "failed":
			return palette.error;
		default:
			return palette.muted;
	}
}

function statusLabelStyle(
	palette: Palette,
	status: TmuxAgentStatus,
): (s: string) => string {
	switch (status) {
		case "awaiting-decision":
			return palette.warning;
		case "failed":
			return palette.error;
		default:
			return palette.dim;
	}
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

function short(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

function cacheHitPct(t: TokenSnapshot): string {
	const denom = t.input + t.cacheRead;
	if (denom === 0) return "0%";
	return `${Math.round((t.cacheRead / denom) * 100)}%`;
}

function tokenSummary(t: TokenSnapshot): string {
	return `↑${short(t.input)} ↓${short(t.output)}  CH:${cacheHitPct(t)}`;
}

function tokenSummaryWithTurns(t: TokenSnapshot): string {
	return `↑${short(t.input)} ↓${short(t.output)}  CH:${cacheHitPct(t)}  turns:${t.turns}`;
}

// ─── Box drawing ────────────────────────────────────────────────────────────

function boxTop(title: string, width: number): string {
	const inner = width - 2; // account for ┌ and ┐
	const titlePart = `─ ${title} `;
	const fill = "─".repeat(Math.max(0, inner - titlePart.length));
	return `┌${titlePart}${fill}┐`;
}

function boxMid(width: number): string {
	return `├${"─".repeat(width - 2)}┤`;
}

function boxBot(width: number): string {
	return `└${"─".repeat(width - 2)}┘`;
}

function boxLine(content: string, width: number): string {
	const inner = width - 4; // "│ " + " │"
	return `│ ${padRight(truncate(content, inner), inner)} │`;
}

// ─── Build rows ─────────────────────────────────────────────────────────────

function buildRows(
	fanout: TmuxFanout,
	engine: PlanEngine,
	queue: QuestionQueue,
): Row[] {
	const plan = engine.get();
	const rows: Row[] = [];
	const now = Date.now();
	for (const [agentId, state] of fanout.snapshot().agents) {
		const d = findDeliverable(plan, agentId);
		const tasks = (d?.children ?? [])
			.filter((c) => c.type === "work-item" && (c.kind === "task" || !c.kind))
			.map((c) => ({
				title: (c as { title: string }).title,
				done: (c as { done?: boolean }).done ?? false,
			}));
		const pendingEntry = queue.pendingForAgent(agentId);
		const pending = pendingEntry?.questions[0]?.question;
		rows.push({
			agentId,
			state,
			title: d?.title ?? state.agentName,
			done: tasks.filter((t) => t.done).length,
			total: tasks.length,
			tasks,
			pending,
			elapsedMs: now - (state.startedAt ?? now),
		});
	}
	return rows;
}

// ─── Tab bar rendering ──────────────────────────────────────────────────────

function renderTabBar(
	rows: readonly Row[],
	activeTab: TabId,
	_width: number,
	palette: Palette,
): string {
	const counts: Record<TabId, number> = {
		all: rows.length,
		working: 0,
		waiting: 0,
		done: 0,
		failed: 0,
	};
	for (const row of rows) {
		counts[statusToTab(row.state.status)]++;
	}

	const parts = TABS.map((tab) => {
		const label = `${TAB_LABELS[tab]} ${counts[tab]}`;
		if (tab === activeTab) return palette.accent(`[${label}]`);
		if (tab === "waiting" && counts.waiting > 0) return palette.warning(label);
		if (tab === "failed" && counts.failed > 0) return palette.error(label);
		return palette.muted(label);
	});

	return parts.join("  ");
}

// ─── Main render ────────────────────────────────────────────────────────────

export interface DashboardRenderState {
	readonly activeTab: TabId;
	readonly selected: number;
}

/** Renders the agents dashboard to plain lines with box frame. */
export function renderDashboard(
	rows: readonly Row[],
	renderState: DashboardRenderState,
	_ledger: UsageLedgerV1 | undefined,
	width: number,
	palette: Palette = defaultPalette(),
): string[] {
	const lines: string[] = [];

	// Top border
	lines.push(palette.dim(boxTop("Agents", width)));
	lines.push(boxLine("", width));

	if (rows.length === 0) {
		lines.push(boxLine(palette.muted("(no agents)"), width));
		lines.push(boxLine("", width));
		lines.push(palette.dim(boxMid(width)));
		lines.push(boxLine(palette.muted("[esc] close"), width));
		lines.push(palette.dim(boxBot(width)));
		return lines;
	}

	// Tab bar
	lines.push(
		boxLine(
			renderTabBar(rows, renderState.activeTab, width - 4, palette),
			width,
		),
	);
	lines.push(boxLine(palette.dim("─".repeat(width - 4)), width));
	lines.push(boxLine("", width));

	// Filter rows
	const filtered =
		renderState.activeTab === "all"
			? rows
			: rows.filter(
					(r) => statusToTab(r.state.status) === renderState.activeTab,
				);

	if (filtered.length === 0) {
		lines.push(boxLine(palette.muted("  (none)"), width));
	}

	const selected = Math.min(renderState.selected, filtered.length - 1);
	for (let i = 0; i < filtered.length; i++) {
		const row = filtered[i];
		const sel = i === selected;
		const glyph = STATUS_GLYPH[row.state.status] ?? "·";
		const styledGlyph = glyphStyle(palette, row.state.status)(glyph);
		const progress = `${row.done}/${row.total}`;
		const status = STATUS_LABEL[row.state.status];
		const styledStatus = statusLabelStyle(palette, row.state.status)(status);
		const tokens = palette.dim(tokenSummary(row.state.tokens));
		const elapsed = palette.dim(formatElapsed(row.elapsedMs));

		if (sel) {
			const line = `▸ ${glyph} ${row.title}  ${progress}  ${status}  ${tokenSummary(row.state.tokens)}  ${formatElapsed(row.elapsedMs)}`;
			lines.push(boxLine(palette.accent(line), width));

			// Expanded task list
			for (const t of row.tasks) {
				const mark = t.done ? palette.success("✓") : "·";
				lines.push(
					boxLine(
						`  ${palette.accent("┊")}  ${mark} ${palette.dim(t.title)}`,
						width,
					),
				);
			}
			if (row.pending) {
				lines.push(
					boxLine(
						`  ${palette.accent("┊")}  ${palette.warning("?")} ${palette.dim(row.pending)}`,
						width,
					),
				);
			}
		} else {
			const line = `  ${styledGlyph} ${row.title}  ${progress}  ${styledStatus}  ${tokens}  ${elapsed}`;
			lines.push(boxLine(line, width));
		}
	}

	// Footer
	lines.push(boxLine("", width));
	lines.push(palette.dim(boxMid(width)));

	const totals = filtered.reduce(
		(acc, r) => ({
			input: acc.input + r.state.tokens.input,
			output: acc.output + r.state.tokens.output,
			cacheRead: acc.cacheRead + r.state.tokens.cacheRead,
			cacheWrite: acc.cacheWrite + r.state.tokens.cacheWrite,
			totalTokens: acc.totalTokens + r.state.tokens.totalTokens,
			cost: acc.cost + r.state.tokens.cost,
			turns: acc.turns + r.state.tokens.turns,
		}),
		{
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: 0,
			turns: 0,
		},
	);
	lines.push(
		boxLine(palette.dim(`Total: ${tokenSummaryWithTurns(totals)}`), width),
	);
	lines.push(
		boxLine(
			palette.muted(
				"[tab] filter  [↑↓] select  [w]atch  [a]ttach  [d] answer  [esc] close",
			),
			width,
		),
	);
	lines.push(palette.dim(boxBot(width)));
	return lines;
}

// ─── Component ──────────────────────────────────────────────────────────────

class DashboardComponent implements Component, Focusable {
	focused = false;
	private activeTab: TabId = "all";
	private selected = 0;

	constructor(
		private readonly rows: readonly Row[],
		private readonly ledger: UsageLedgerV1 | undefined,
		private readonly done: (action: DashboardAction | undefined) => void,
		private readonly palette: Palette = defaultPalette(),
	) {}

	invalidate(): void {}

	private filteredRows(): readonly Row[] {
		if (this.activeTab === "all") return this.rows;
		return this.rows.filter(
			(r) => statusToTab(r.state.status) === this.activeTab,
		);
	}

	render(width: number): string[] {
		return renderDashboard(
			this.rows,
			{ activeTab: this.activeTab, selected: this.selected },
			this.ledger,
			width,
			this.palette,
		);
	}

	handleInput(data: string): void {
		const filtered = this.filteredRows();

		if (
			filtered.length === 0 &&
			data !== "\t" &&
			data !== "\u001b[Z" &&
			data !== "\u001b"
		) {
			if (data === "\u001b") this.done(undefined);
			return;
		}

		switch (data) {
			case "\u001b[A": // Up
				this.selected = Math.max(0, this.selected - 1);
				break;
			case "\u001b[B": // Down
				this.selected = Math.min(filtered.length - 1, this.selected + 1);
				break;
			case "\t": {
				// Tab — next filter
				const idx = TABS.indexOf(this.activeTab);
				this.activeTab = TABS[(idx + 1) % TABS.length];
				this.selected = 0;
				break;
			}
			case "\u001b[Z": {
				// Shift+Tab — previous filter
				const idx = TABS.indexOf(this.activeTab);
				this.activeTab = TABS[(idx - 1 + TABS.length) % TABS.length];
				this.selected = 0;
				break;
			}
			case "w": {
				const cur = filtered[this.selected];
				if (cur) this.done({ kind: "watch", agentId: cur.agentId });
				break;
			}
			case "a": {
				const cur = filtered[this.selected];
				if (cur) this.done({ kind: "attach", agentId: cur.agentId });
				break;
			}
			case "s": {
				const cur = filtered[this.selected];
				if (cur) this.done({ kind: "steer", agentId: cur.agentId });
				break;
			}
			case "d": {
				const cur = filtered[this.selected];
				if (cur) this.done({ kind: "answer", agentId: cur.agentId });
				break;
			}
			case "\u001b":
				this.done(undefined);
				break;
		}
	}
}

// ─── Entrypoint ─────────────────────────────────────────────────────────────

/** Show the dashboard; resolves with the chosen action (or undefined). */
export function runAgentsDashboard(
	ctx: {
		ui: {
			custom<T>(
				factory: (
					tui: TUI,
					theme: unknown,
					keybindings: unknown,
					done: (v: T) => void,
				) => Component,
				opts?: { overlay?: boolean },
			): Promise<T>;
		};
	},
	fanout: TmuxFanout,
	engine: PlanEngine,
	ledger: UsageLedgerV1 | undefined,
	queue: QuestionQueue,
): Promise<DashboardAction | undefined> {
	const rows = buildRows(fanout, engine, queue);
	return ctx.ui.custom<DashboardAction | undefined>(
		(_tui, theme, _kb, done) => {
			const palette = paletteFromTheme(theme);
			return new DashboardComponent(rows, ledger, done, palette);
		},
	);
}

function paletteFromTheme(theme: unknown): Palette {
	const t = theme as {
		fg?: (color: string, text: string) => string;
		bold?: (text: string) => string;
	} | null;
	if (!t?.fg || !t?.bold) return defaultPalette();
	const fg = t.fg;
	const bold = t.bold;
	return {
		dim: (s) => fg("dim", s),
		muted: (s) => fg("muted", s),
		accent: (s) => fg("accent", s),
		heading: (s) => bold(fg("text", s)),
		success: (s) => fg("success", s),
		warning: (s) => fg("warning", s),
		error: (s) => fg("error", s),
		info: (s) => fg("accent", s),
	};
}
