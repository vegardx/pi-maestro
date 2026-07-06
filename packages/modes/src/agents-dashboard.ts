import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import type { TokenSnapshot, UsageLedgerV1 } from "@vegardx/pi-contracts";
import {
	defaultPalette,
	formatElapsed,
	type OverlayHandle,
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
import {
	type AgentRole,
	findDeliverable,
	getParentId,
	isChildId,
} from "./schema.js";

export type DashboardAction =
	| { kind: "watch"; agentId: string }
	| { kind: "attach"; agentId: string }
	| { kind: "steer"; agentId: string }
	| { kind: "answer"; agentId: string };

export interface Row {
	readonly agentId: string;
	readonly state: TmuxAgentState;
	readonly title: string;
	readonly role?: AgentRole;
	readonly parentGroupId?: string;
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
	const inner = width - 2;
	const titlePart = `─ ${title} `;
	const fill = "─".repeat(Math.max(0, inner - titlePart.length));
	return `╭${titlePart}${fill}╮`;
}

function boxMid(width: number): string {
	return `│${"─".repeat(width - 2)}│`;
}

function boxBot(width: number): string {
	return `╰${"─".repeat(width - 2)}╯`;
}

function boxLine(content: string, width: number): string {
	const inner = width - 4; // "│ " + " │"
	return `│ ${padRight(truncate(content, inner), inner)} │`;
}

// ─── Build rows ─────────────────────────────────────────────────────────────

export function buildRows(
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
		const parentGroupId = isChildId(agentId) ? getParentId(agentId) : undefined;
		rows.push({
			agentId,
			state,
			title: state.agentName,
			role: d?.agentRole,
			parentGroupId,
			done: tasks.filter((t) => t.done).length,
			total: tasks.length,
			tasks,
			pending,
			elapsedMs: now - (state.startedAt ?? now),
		});
	}
	return rows;
}

// ─── Tree layout ────────────────────────────────────────────────────────────

export interface TreeRow {
	readonly row: Row;
	readonly prefix: string; // tree drawing chars (e.g. " ├─ ", " └─ ")
	readonly groupTitle?: string; // set on the FIRST child of a group
}

/**
 * Organize flat rows into a tree based on parentGroupId.
 * Groups get a header row (groupTitle), children get tree prefixes.
 * Rows without a parent are top-level (leaf deliverables).
 */
export function layoutTree(rows: readonly Row[]): TreeRow[] {
	// Group children by parent
	const groups = new Map<string, Row[]>();
	const topLevel: Row[] = [];

	for (const row of rows) {
		if (row.parentGroupId) {
			const list = groups.get(row.parentGroupId) ?? [];
			list.push(row);
			groups.set(row.parentGroupId, list);
		} else {
			topLevel.push(row);
		}
	}

	const result: TreeRow[] = [];

	// Collect all unique group IDs (parents that have children)
	const groupIds = [...groups.keys()];

	// Render groups first (they have children)
	for (const groupId of groupIds) {
		const children = groups.get(groupId)!;
		for (let i = 0; i < children.length; i++) {
			const isLast = i === children.length - 1;
			const prefix = isLast ? " └─ " : " ├─ ";
			result.push({
				row: children[i],
				prefix,
				groupTitle: i === 0 ? groupId : undefined,
			});
		}
	}

	// Then top-level leaf agents (no parent group)
	for (const row of topLevel) {
		result.push({ row, prefix: " " });
	}

	return result;
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

	// Compute column widths for aligned table layout
	// Columns: [prefix 4] [title] [progress] [status] [tokens] [elapsed]
	const COL_PROGRESS = 6; // "xx/xx" max
	const COL_STATUS = 9; // "awaiting" is longest (8) + pad
	const COL_TOKENS = 22; // "↑12.0k ↓3.2k  CH:83%"
	const COL_ELAPSED = 5; // "59m" / "1.2h"
	const COL_ROLE = 8; // "author" is longest (6) + pad
	const innerWidth = width - 4; // inside box lines
	const FIXED_COLS =
		COL_ROLE + COL_PROGRESS + COL_STATUS + COL_TOKENS + COL_ELAPSED;
	const COL_TITLE = Math.max(innerWidth - FIXED_COLS - 8, 10); // 8 = prefix + separating spaces

	const tree = layoutTree(filtered);

	for (let i = 0; i < tree.length; i++) {
		const { row, prefix, groupTitle } = tree[i];
		const sel = i === selected;

		// Group header line
		if (groupTitle) {
			if (i > 0) lines.push(boxLine("", width));
			const rule = "─".repeat(Math.max(0, innerWidth - groupTitle.length - 2));
			lines.push(
				boxLine(` ${palette.dim(groupTitle)} ${palette.dim(rule)}`, width),
			);
		}

		const glyph = STATUS_GLYPH[row.state.status] ?? "·";
		const styledGlyph = glyphStyle(palette, row.state.status)(glyph);
		const progress = padRight(`${row.done}/${row.total}`, COL_PROGRESS);
		const status = padRight(STATUS_LABEL[row.state.status], COL_STATUS);
		const styledStatus = statusLabelStyle(palette, row.state.status)(status);
		const tok = padRight(tokenSummary(row.state.tokens), COL_TOKENS);
		const elapsed = padRight(formatElapsed(row.elapsedMs), COL_ELAPSED);
		const role = padRight(row.role ?? "—", COL_ROLE);
		const nameW = Math.max(COL_TITLE - prefix.length, 4);
		const nameStr = padRight(truncate(row.title, nameW), nameW);

		if (sel) {
			const line = `${prefix}▸${glyph} ${nameStr} ${role} ${progress} ${status} ${tok} ${elapsed}`;
			lines.push(boxLine(palette.accent(line), width));

			// Expanded task list
			for (const t of row.tasks) {
				const mark = t.done ? palette.success("✓") : "·";
				lines.push(
					boxLine(
						`    ${palette.accent("┊")}  ${mark} ${palette.dim(t.title)}`,
						width,
					),
				);
			}
			if (row.pending) {
				lines.push(
					boxLine(
						`    ${palette.accent("┊")}  ${palette.warning("?")} ${palette.dim(row.pending)}`,
						width,
					),
				);
			}
		} else {
			const line = `${prefix} ${styledGlyph} ${nameStr} ${palette.dim(role)} ${progress} ${styledStatus} ${palette.dim(tok)} ${palette.dim(elapsed)}`;
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
				"[←/→] filter  [↑↓] select  [w]atch  [a]ttach  [d] answer  [esc] close",
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
	private rows: readonly Row[];

	constructor(
		rows: readonly Row[],
		private readonly ledger: UsageLedgerV1 | undefined,
		private readonly done: (action: DashboardAction | undefined) => void,
		private readonly palette: Palette = defaultPalette(),
	) {
		this.rows = rows;
	}

	updateRows(rows: readonly Row[]): void {
		this.rows = rows;
		// Clamp selection
		const tree = this.treeRows();
		if (this.selected >= tree.length) {
			this.selected = Math.max(0, tree.length - 1);
		}
	}

	invalidate(): void {}

	private filteredRows(): readonly Row[] {
		if (this.activeTab === "all") return this.rows;
		return this.rows.filter(
			(r) => statusToTab(r.state.status) === this.activeTab,
		);
	}

	private treeRows(): readonly TreeRow[] {
		return layoutTree(this.filteredRows());
	}

	private selectedRow(): Row | undefined {
		const tree = this.treeRows();
		return tree[this.selected]?.row;
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
		const tree = this.treeRows();

		if (
			tree.length === 0 &&
			data !== "\u001b[C" &&
			data !== "\u001b[D" &&
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
				this.selected = Math.min(tree.length - 1, this.selected + 1);
				break;
			case "\u001b[C": {
				// Right — next filter tab
				const idx = TABS.indexOf(this.activeTab);
				this.activeTab = TABS[(idx + 1) % TABS.length];
				this.selected = 0;
				break;
			}
			case "\u001b[D": {
				// Left — previous filter tab
				const idx = TABS.indexOf(this.activeTab);
				this.activeTab = TABS[(idx - 1 + TABS.length) % TABS.length];
				this.selected = 0;
				break;
			}
			case "w": {
				const cur = this.selectedRow();
				if (cur) this.done({ kind: "watch", agentId: cur.agentId });
				break;
			}
			case "a": {
				const cur = this.selectedRow();
				if (cur) this.done({ kind: "attach", agentId: cur.agentId });
				break;
			}
			case "s": {
				const cur = this.selectedRow();
				if (cur) this.done({ kind: "steer", agentId: cur.agentId });
				break;
			}
			case "d": {
				const cur = this.selectedRow();
				if (cur) this.done({ kind: "answer", agentId: cur.agentId });
				break;
			}
			case "\u001b":
				this.done(undefined);
				break;
		}
	}
}

// ─── Collapsible overlay wrapper ────────────────────────────────────────────

const KEY_TAB = "\t";

/**
 * @deprecated Use `UnifiedOverlayComponent` instead — this component is
 * retained for backwards compatibility but no longer mounted by the runtime.
 *
 * Collapsible overlay wrapper around DashboardComponent.
 * Starts collapsed (2-line badge). Tab expands/collapses.
 */
export class CollapsibleDashboardComponent implements Component, Focusable {
	focused = false;
	expanded = false;
	private readonly inner: DashboardComponent;
	private readonly palette: Palette;
	private rows: readonly Row[];
	private handle: OverlayHandle | undefined;

	constructor(
		rows: readonly Row[],
		ledger: UsageLedgerV1 | undefined,
		readonly done: (action: DashboardAction | undefined) => void,
		palette: Palette = defaultPalette(),
	) {
		this.palette = palette;
		this.rows = rows;
		this.inner = new DashboardComponent(rows, ledger, done, palette);
	}

	setHandle(handle: OverlayHandle): void {
		this.handle = handle;
	}

	updateRows(rows: readonly Row[]): void {
		this.rows = rows;
		this.inner.updateRows(rows);
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.expanded) return this.renderCollapsed(width);
		const lines = this.inner.render(width);
		if (!this.focused) return lines.map((l) => this.palette.dim(l));
		return lines;
	}

	handleInput(data: string): void {
		if (data === KEY_TAB) {
			if (this.expanded) {
				this.expanded = false;
				this.handle?.unfocus();
			} else {
				this.expanded = true;
				this.handle?.focus();
			}
			return;
		}
		if (data === "\u001b" && this.expanded) {
			this.expanded = false;
			this.handle?.unfocus();
			return;
		}
		if (this.expanded) {
			this.inner.handleInput(data);
		}
	}

	private renderCollapsed(width: number): string[] {
		const p = this.focused
			? this.palette
			: {
					...this.palette,
					accent: this.palette.dim,
					heading: this.palette.dim,
					muted: this.palette.dim,
				};
		const working = this.rows.filter(
			(r) => statusToTab(r.state.status) === "working",
		).length;
		const waiting = this.rows.filter(
			(r) => statusToTab(r.state.status) === "waiting",
		).length;
		const parts = [`${this.rows.length} agents`];
		if (working > 0) parts.push(`${working} working`);
		if (waiting > 0) parts.push(`${waiting} waiting`);
		const label = parts.join(" · ");
		const hint = "Tab to expand";
		const fillWidth = Math.max(width - 8 - label.length - hint.length, 0);
		const fill = "─".repeat(fillWidth);
		const top = p.dim(`╭─ ${label} ${fill} ${hint} ─╮`);
		const bot = p.dim(`╰${"─".repeat(Math.max(width - 2, 0))}╯`);
		return [top, bot];
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
				opts?: {
					overlay?: boolean;
					overlayOptions?: unknown;
					onHandle?: (h: OverlayHandle) => void;
				},
			): Promise<T>;
		};
	},
	fanout: TmuxFanout,
	engine: PlanEngine,
	ledger: UsageLedgerV1 | undefined,
	queue: QuestionQueue,
): Promise<DashboardAction | undefined> {
	const rows = buildRows(fanout, engine, queue);
	let comp: DashboardComponent | undefined;
	return ctx.ui.custom<DashboardAction | undefined>(
		(_tui, theme, _kb, done) => {
			const palette = paletteFromTheme(theme);
			comp = new DashboardComponent(rows, ledger, done, palette);
			return comp;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "100%",
				maxHeight: "80%",
			},
			onHandle: (handle: OverlayHandle) => {
				handle.focus();
			},
		},
	);
}

function paletteFromTheme(theme: unknown): Palette {
	const t = theme as {
		fg?: (color: string, text: string) => string;
		bold?: (text: string) => string;
	} | null;
	if (!t?.fg || !t?.bold) return defaultPalette();
	return {
		dim: (s) => t.fg!("dim", s),
		muted: (s) => t.fg!("muted", s),
		accent: (s) => t.fg!("accent", s),
		heading: (s) => t.bold!(t.fg!("text", s)),
		success: (s) => t.fg!("success", s),
		warning: (s) => t.fg!("warning", s),
		error: (s) => t.fg!("error", s),
		info: (s) => t.fg!("accent", s),
	};
}
