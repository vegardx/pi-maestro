import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import type { TokenSnapshot, UsageLedgerV1 } from "@vegardx/pi-contracts";
import { defaultPalette, type Palette, truncate } from "@vegardx/pi-ui";
import type { PlanEngine } from "./engine.js";
import type { TmuxAgentState, TmuxFanout } from "./execution-tmux.js";
import type { QuestionQueue } from "./question-queue.js";
import { findDeliverable } from "./schema.js";

export type DashboardAction =
	| { kind: "watch"; agentId: string }
	| { kind: "attach"; agentId: string }
	| { kind: "steer"; agentId: string }
	| { kind: "answer"; agentId: string };

interface Row {
	readonly agentId: string;
	readonly state: TmuxAgentState;
	readonly title: string;
	readonly done: number;
	readonly total: number;
	readonly tasks: readonly { title: string; done: boolean }[];
	readonly pending?: string;
}

const STATUS_ICON: Record<string, string> = {
	spawning: "…",
	working: "*",
	idle: "·",
	"awaiting-decision": "?",
	done: "v",
	failed: "!",
};

function short(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

function cacheHit(t: TokenSnapshot): string {
	const denom = t.input + t.cacheRead;
	if (denom === 0) return "0%";
	return `${Math.round((t.cacheRead / denom) * 100)}%`;
}

function tokenLine(t: TokenSnapshot): string {
	return `↑${short(t.input)} ↓${short(t.output)}  CH:${cacheHit(t)}  $${t.cost.toFixed(2)}  turns:${t.turns}`;
}

function buildRows(
	fanout: TmuxFanout,
	engine: PlanEngine,
	queue: QuestionQueue,
): Row[] {
	const plan = engine.get();
	const rows: Row[] = [];
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
		});
	}
	return rows;
}

/** Renders the agents dashboard to plain lines. */
export function renderDashboard(
	rows: readonly Row[],
	selected: number,
	ledger: UsageLedgerV1 | undefined,
	width: number,
	palette: Palette = defaultPalette(),
): string[] {
	const lines: string[] = [palette.heading("Agents"), ""];
	if (rows.length === 0) lines.push(palette.muted("  (no agents)"));
	rows.forEach((row, i) => {
		const sel = i === selected;
		const icon = STATUS_ICON[row.state.status] ?? "-";
		const head = `[${icon}] ${row.title}  ${row.done}/${row.total} tasks  ${row.state.status}`;
		lines.push(
			truncate(sel ? palette.accent(`▸ ${head}`) : `  ${head}`, width),
		);
		for (const t of row.tasks) {
			lines.push(
				palette.dim(truncate(`      ${t.done ? "✓" : "·"} ${t.title}`, width)),
			);
		}
		if (row.pending) {
			lines.push(palette.accent(truncate(`      ? ${row.pending}`, width)));
		}
		lines.push(
			palette.dim(truncate(`      ${tokenLine(row.state.tokens)}`, width)),
		);
		lines.push("");
	});

	// Compute agent-only totals (exclude orchestrator/lens from the footer).
	const agentTotals = rows.reduce(
		(acc, r) => ({
			input: acc.input + r.state.tokens.input,
			output: acc.output + r.state.tokens.output,
			cacheRead: acc.cacheRead + r.state.tokens.cacheRead,
			cacheWrite: acc.cacheWrite + r.state.tokens.cacheWrite,
			totalTokens: acc.totalTokens + r.state.tokens.totalTokens,
			cost: acc.cost + r.state.tokens.cost,
			turns: acc.turns + r.state.tokens.turns,
		}),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
	);
	if (rows.length > 0) {
		lines.push(palette.dim("─".repeat(width)));
		lines.push(palette.muted(`  Agents: ${tokenLine(agentTotals)}`));
	}
	lines.push(
		palette.muted(
			"  [↑↓] select  [w]atch  [a]ttach  [s]teer  [d] answer  [esc] close",
		),
	);
	return lines;
}

class DashboardComponent implements Component, Focusable {
	focused = false;
	private selected = 0;

	constructor(
		private readonly rows: readonly Row[],
		private readonly ledger: UsageLedgerV1 | undefined,
		private readonly done: (action: DashboardAction | undefined) => void,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		return renderDashboard(this.rows, this.selected, this.ledger, width);
	}

	handleInput(data: string): void {
		if (this.rows.length === 0) {
			if (data === "\u001b") this.done(undefined);
			return;
		}
		const cur = this.rows[this.selected];
		switch (data) {
			case "\u001b[A":
				this.selected = Math.max(0, this.selected - 1);
				break;
			case "\u001b[B":
				this.selected = Math.min(this.rows.length - 1, this.selected + 1);
				break;
			case "w":
				this.done({ kind: "watch", agentId: cur.agentId });
				break;
			case "a":
				this.done({ kind: "attach", agentId: cur.agentId });
				break;
			case "s":
				this.done({ kind: "steer", agentId: cur.agentId });
				break;
			case "d":
				this.done({ kind: "answer", agentId: cur.agentId });
				break;
			case "\u001b":
				this.done(undefined);
				break;
		}
	}
}

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
		(_tui, _theme, _kb, done) => new DashboardComponent(rows, ledger, done),
	);
}
