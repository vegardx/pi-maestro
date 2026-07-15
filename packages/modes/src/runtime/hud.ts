// The maestro HUD: one borderless component in the overlay manager's
// "agents" slot, always mounted while a maestro session is active. Three
// tabs — Agents / Plan / Questions — rendered from a HudSnapshot the wiring
// pulls live (runtime/hud-wiring.ts); this module is pure presentation +
// input state so tests snapshot fixed-width string arrays.
//
// Layout (self-capped at 10 lines — pi slices widgets at MAX_WIDGET_LINES):
//   line 1     tab rule:  ──[ Agents 4 ]─── Plan 2/5 ─── Questions 1 ── tab ──
//   lines 2..  content rows for the active tab (scrolls with selection)
//   last line  overflow rule — ONLY when rows scroll (pi's editor draws its
//              own top border, so an unconditional separator doubles it)
// Idle (no agents, no active deliverable, no questions) collapses to ONE
// summary line — unless the HUD is focused, which always shows the full tab
// view (Tab must land somewhere visible). When focused the last content row
// is replaced by an action-hint row.
//
// Key scheme while focused (documented in the hint row): up/down move the
// selection, [ and ] switch tabs, left/right/space fold/unfold the selected
// row, Enter is the context action (Agents: attach, Plan: expand/collapse,
// Questions: answer), s steers and i interrupts on agent rows, Esc returns
// to the input (handled by the OverlayManager).

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { OverlayComponent } from "../overlay-manager.js";

export type HudTab = "agents" | "plan" | "questions";

const TABS: readonly HudTab[] = ["agents", "plan", "questions"];

/** Status words the HUD renders — words, never glyphs. */
export type HudStatus =
	| "starting"
	| "running"
	| "done"
	| "blocked"
	| "stopped"
	| "failed";

export interface HudAgentLeaf {
	/** Stable key (fold state and actions address rows by it). */
	readonly key: string;
	/** `name/kind · slug` left label. */
	readonly label: string;
	readonly status: HudStatus;
	readonly startedAt: number;
	/** Model short-name or context note (e.g. "gate: review"). */
	readonly note?: string;
	/** Attach/steer/interrupt target id (agent-targets opaque id). */
	readonly targetId?: string;
}

export interface HudAgentNode extends HudAgentLeaf {
	readonly children: readonly HudAgentLeaf[];
}

export interface HudPlanTask {
	readonly id: string;
	readonly title: string;
	readonly done: boolean;
}

export interface HudPlanRow {
	readonly id: string;
	readonly title: string;
	readonly state: "shipped" | "complete" | "active" | "queued";
	/** Assigned worker note shown on active rows (e.g. "worker running"). */
	readonly worker?: string;
	readonly tasks: readonly HudPlanTask[];
}

export interface HudQuestionRow {
	/** Stable key ("ask:<id>" or "queue:<agentId>:<questionId>"). */
	readonly key: string;
	/** "maestro" or "worker · slug". */
	readonly asker: string;
	readonly blocking: boolean;
	readonly deferred?: boolean;
	readonly text: string;
}

export interface HudPlanView {
	readonly rows: readonly HudPlanRow[];
	/** shipped+complete count for the tab label / idle line. */
	readonly done: number;
	readonly total: number;
}

export interface HudSnapshot {
	readonly agents: readonly HudAgentNode[];
	readonly plan: HudPlanView | undefined;
	readonly questions: readonly HudQuestionRow[];
}

export interface HudActions {
	attach(targetId: string): void;
	steer(targetId: string): void;
	interrupt(targetId: string): void;
	answer(question: HudQuestionRow): void;
}

export interface HudDeps {
	readonly data: () => HudSnapshot;
	readonly actions: HudActions;
	/** Theme accessor; absent (tests) renders plain text. */
	readonly theme?: () => Theme | undefined;
	readonly now?: () => number;
}

/** pi hard-caps widgets at 10 lines (MAX_WIDGET_LINES); we self-limit. */
const MAX_LINES = 10;
/** Rows available after the tab rule; hint and overflow rule subtract more. */
const MAX_CONTENT_ROWS = MAX_LINES - 1;
const INDENT = "  ";

const KEY_UP = "\u001b[A";
const KEY_DOWN = "\u001b[B";
const KEY_RIGHT = "\u001b[C";
const KEY_LEFT = "\u001b[D";
const KEY_ENTER = "\r";

/** "4m12s" elapsed, same shape as the agent cards. */
export function hudElapsed(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const m = Math.floor(total / 60);
	const s = total % 60;
	if (m === 0) return `${s}s`;
	if (m < 60) return `${m}m${String(s).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** One selectable content row, pre-styling. */
interface HudRow {
	/** Selection/fold identity; undefined rows are not selectable. */
	readonly key?: string;
	readonly left: string;
	readonly right?: string;
	/** Row-level accent (blocking questions, failed agents). */
	readonly tone?: "accent" | "error" | "dim";
	/** Enter/steer/interrupt payloads. */
	readonly targetId?: string;
	readonly question?: HudQuestionRow;
	/** Fold toggling: the key whose fold state left/right/space flips. */
	readonly foldKey?: string;
	/** EFFECTIVE expansion (manual override or auto rule) for toggling. */
	readonly foldExpanded?: boolean;
}

export class HudComponent implements OverlayComponent {
	focused = false;
	expanded = false;

	#tab: HudTab = "agents";
	#selected = 0;
	#scroll = 0;
	/** Sticky manual fold overrides, pruned when the key disappears. */
	readonly #folds = new Map<string, boolean>();
	#cache: { width: number; sig: string; lines: string[] } | undefined;

	constructor(private readonly deps: HudDeps) {}

	get activeTab(): HudTab {
		return this.#tab;
	}

	setTab(tab: HudTab): void {
		if (this.#tab !== tab) {
			this.#tab = tab;
			this.#selected = 0;
			this.#scroll = 0;
		}
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (data === "[" || data === "]") {
			const at = TABS.indexOf(this.#tab);
			const next =
				data === "]"
					? TABS[(at + 1) % TABS.length]
					: TABS[(at + TABS.length - 1) % TABS.length];
			this.setTab(next);
			return;
		}
		const rows = this.#contentRows(this.deps.data());
		const selectable = rows.filter((r) => r.key !== undefined);
		if (selectable.length === 0) return;
		this.#selected = Math.min(this.#selected, selectable.length - 1);
		const current = selectable[this.#selected];

		if (data === KEY_UP) {
			this.#selected = Math.max(0, this.#selected - 1);
			return;
		}
		if (data === KEY_DOWN) {
			this.#selected = Math.min(selectable.length - 1, this.#selected + 1);
			return;
		}
		if (data === KEY_LEFT || data === KEY_RIGHT || data === " ") {
			if (current?.foldKey) {
				const expandedNow = current.foldExpanded ?? false;
				const want =
					data === KEY_RIGHT ? true : data === KEY_LEFT ? false : !expandedNow;
				this.#folds.set(current.foldKey, want);
			}
			return;
		}
		if (data === KEY_ENTER) {
			if (this.#tab === "questions" && current?.question) {
				this.deps.actions.answer(current.question);
			} else if (this.#tab === "agents" && current?.targetId) {
				this.deps.actions.attach(current.targetId);
			} else if (this.#tab === "plan" && current?.foldKey) {
				this.#folds.set(current.foldKey, !(current.foldExpanded ?? false));
			}
			return;
		}
		if (this.#tab === "agents" && data === "s" && current?.targetId) {
			this.deps.actions.steer(current.targetId);
			return;
		}
		if (this.#tab === "agents" && data === "i" && current?.targetId) {
			this.deps.actions.interrupt(current.targetId);
			return;
		}
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const snap = this.deps.data();
		this.#pruneFolds(snap);
		const plain = this.#buildPlain(snap, width);
		const sig = `${this.#tab}|${this.focused}|${this.#selected}|${plain.sig}`;
		if (this.#cache && this.#cache.width === width && this.#cache.sig === sig) {
			return this.#cache.lines;
		}
		const lines = this.#style(plain, width);
		this.#cache = { width, sig, lines };
		return lines;
	}

	// ── model → plain rows ────────────────────────────────────────────────────

	#pruneFolds(snap: HudSnapshot): void {
		if (this.#folds.size === 0) return;
		const live = new Set<string>();
		for (const node of snap.agents) live.add(node.key);
		for (const row of snap.plan?.rows ?? []) live.add(`plan:${row.id}`);
		for (const key of [...this.#folds.keys()]) {
			if (!live.has(key)) this.#folds.delete(key);
		}
	}

	#idle(snap: HudSnapshot): boolean {
		return (
			snap.agents.length === 0 &&
			snap.questions.length === 0 &&
			!snap.plan?.rows.some((row) => row.state === "active")
		);
	}

	#contentRows(snap: HudSnapshot): HudRow[] {
		if (this.#tab === "agents") return this.#agentRows(snap);
		if (this.#tab === "plan") return this.#planRows(snap);
		return this.#questionRows(snap);
	}

	#agentRows(snap: HudSnapshot): HudRow[] {
		const now = this.deps.now?.() ?? Date.now();
		const rows: HudRow[] = [];
		if (snap.agents.length === 0) {
			return [{ left: `${INDENT}no agents`, tone: "dim" }];
		}
		for (const node of snap.agents) {
			const hasChildren = node.children.length > 0;
			const expanded = this.#agentExpanded(node);
			const marker = hasChildren ? (expanded ? "▾ " : "▸ ") : "";
			const suffix =
				hasChildren && !expanded ? ` · ${node.children.length} subagents` : "";
			rows.push({
				key: node.key,
				left: `${INDENT}${marker}${node.label}${suffix}`,
				right: agentRight(node, now),
				targetId: node.targetId,
				...(hasChildren ? { foldKey: node.key, foldExpanded: expanded } : {}),
				...(node.status === "failed" ? { tone: "error" as const } : {}),
			});
			if (hasChildren && expanded) {
				node.children.forEach((leaf, i) => {
					const connector = i === node.children.length - 1 ? "└─" : "├─";
					rows.push({
						key: leaf.key,
						left: `${INDENT}${connector} ${leaf.label}`,
						right: agentRight(leaf, now),
						targetId: leaf.targetId,
						...(leaf.status === "failed" ? { tone: "error" as const } : {}),
					});
				});
			}
		}
		return rows;
	}

	/**
	 * Fold rules: a manual override (left/right/space) is sticky and wins;
	 * otherwise a worker auto-expands ONLY while it has running children —
	 * done/blocked workers collapse to one line with an `N subagents` suffix.
	 */
	#agentExpanded(node: HudAgentNode): boolean {
		const manual = this.#folds.get(node.key);
		if (manual !== undefined) return manual;
		return node.children.some(
			(c) => c.status === "running" || c.status === "starting",
		);
	}

	#planRows(snap: HudSnapshot): HudRow[] {
		const plan = snap.plan;
		if (!plan || plan.rows.length === 0) {
			return [{ left: `${INDENT}no plan`, tone: "dim" }];
		}
		const rows: HudRow[] = [];
		for (const row of plan.rows) {
			const foldKey = `plan:${row.id}`;
			// The ACTIVE deliverable auto-expands its tasks; a manual override
			// (space/enter/arrows) is sticky either way.
			const expanded = this.#folds.get(foldKey) ?? row.state === "active";
			const box =
				row.state === "shipped" || row.state === "complete"
					? "[x]"
					: row.state === "active"
						? "[~]"
						: "[ ]";
			const marker = row.tasks.length > 0 && !expanded ? "▸ " : "";
			const worker =
				row.state === "active" && row.worker ? ` · ${row.worker}` : "";
			rows.push({
				key: foldKey,
				foldKey,
				foldExpanded: expanded,
				left: `${INDENT}${box} ${marker}${row.title}${worker}`,
				...(row.state === "active" ? { tone: "accent" as const } : {}),
			});
			if (expanded) {
				for (const task of row.tasks) {
					rows.push({
						key: `${foldKey}:${task.id}`,
						foldKey,
						foldExpanded: expanded,
						left: `${INDENT}   ${task.done ? "[x]" : "[ ]"} ${task.title}`,
						...(task.done ? { tone: "dim" as const } : {}),
					});
				}
			}
		}
		return rows;
	}

	#questionRows(snap: HudSnapshot): HudRow[] {
		if (snap.questions.length === 0) {
			return [{ left: `${INDENT}no questions`, tone: "dim" }];
		}
		return snap.questions.map((q) => ({
			key: q.key,
			question: q,
			left: `${INDENT}${q.asker}${q.blocking ? " · blocking" : ""}${
				q.deferred ? " · deferred" : ""
			} — ${q.text.replace(/\s+/g, " ")}`,
			...(q.blocking ? { tone: "accent" as const } : {}),
		}));
	}

	// ── assembly ──────────────────────────────────────────────────────────────

	#buildPlain(
		snap: HudSnapshot,
		width: number,
	): { lines: PlainLine[]; sig: string } {
		const lines: PlainLine[] = [];
		// Focused always gets the full tab view — Tab must land somewhere
		// visible, even when everything is idle.
		if (this.#idle(snap) && !this.focused) {
			const plan = snap.plan;
			const summary = plan
				? `${INDENT}agents idle · plan ${plan.done}/${plan.total}`
				: `${INDENT}agents idle`;
			lines.push({ text: truncateToWidth(summary, width), kind: "idle" });
			return { lines, sig: lines.map((l) => l.text).join("\n") };
		}

		lines.push({ text: this.#tabRule(snap, width), kind: "tabs" });

		const rows = this.#contentRows(snap);
		const selectable = rows.filter((r) => r.key !== undefined);
		this.#selected = Math.min(
			this.#selected,
			Math.max(0, selectable.length - 1),
		);
		const selectedKey = this.focused
			? selectable[this.#selected]?.key
			: undefined;

		// Budget: tabs always; hint when focused; the overflow rule only when
		// rows actually scroll (pi's editor top border handles separation).
		const base = this.focused ? MAX_CONTENT_ROWS - 1 : MAX_CONTENT_ROWS;
		const overflows = rows.length > base;
		const maxRows = overflows ? base - 1 : base;
		// Keep the selection inside the window.
		const selectedRowIndex = selectedKey
			? rows.findIndex((r) => r.key === selectedKey)
			: 0;
		if (selectedRowIndex >= 0) {
			if (selectedRowIndex < this.#scroll) this.#scroll = selectedRowIndex;
			if (selectedRowIndex >= this.#scroll + maxRows) {
				this.#scroll = selectedRowIndex - maxRows + 1;
			}
		}
		this.#scroll = Math.max(
			0,
			Math.min(this.#scroll, Math.max(0, rows.length - maxRows)),
		);
		const visible = rows.slice(this.#scroll, this.#scroll + maxRows);

		for (const row of visible) {
			lines.push({
				text: composeRow(row, width),
				kind: "row",
				tone: row.tone,
				selected: row.key !== undefined && row.key === selectedKey,
			});
		}
		if (this.focused) {
			lines.push({
				text: truncateToWidth(`${INDENT}${this.#hint()}`, width),
				kind: "hint",
			});
		}

		if (overflows) {
			const above = this.#scroll;
			const below = Math.max(0, rows.length - this.#scroll - maxRows);
			lines.push({ text: bottomRule(width, above, below), kind: "rule" });
		}
		return {
			lines,
			sig: lines
				.map((l) => `${l.selected ? ">" : " "}${l.tone ?? ""}|${l.text}`)
				.join("\n"),
		};
	}

	#tabRule(snap: HudSnapshot, width: number): string {
		const agentCount = countAgents(snap.agents);
		const plan = snap.plan;
		const blocking = snap.questions.filter((q) => q.blocking).length;
		const labels: Record<HudTab, string> = {
			agents: `Agents${agentCount > 0 ? ` ${agentCount}` : ""}`,
			plan: plan ? `Plan ${plan.done}/${plan.total}` : "Plan",
			questions: `Questions${
				snap.questions.length > 0 ? ` ${snap.questions.length}` : ""
			}${blocking > 0 ? ` · ${blocking} blocking` : ""}`,
		};
		let rule = "──";
		for (const tab of TABS) {
			rule += tab === this.#tab ? `[ ${labels[tab]} ]` : `─ ${labels[tab]} ─`;
			rule += "──";
		}
		const hint = " tab ──";
		const fill = Math.max(0, width - visibleWidth(rule) - visibleWidth(hint));
		return truncateToWidth(`${rule}${"─".repeat(fill)}${hint}`, width);
	}

	#hint(): string {
		if (this.#tab === "agents") {
			return "↑↓ move · [ ] tab · ←→ fold · enter attach · s steer · i interrupt · esc";
		}
		if (this.#tab === "plan") {
			return "↑↓ move · [ ] tab · enter expand/collapse · esc";
		}
		return "↑↓ move · [ ] tab · enter answer · esc";
	}

	// ── styling ───────────────────────────────────────────────────────────────

	#style(plain: { lines: PlainLine[] }, width: number): string[] {
		const theme = this.deps.theme?.();
		if (!theme) return plain.lines.map((l) => l.text);
		return plain.lines.map((line) => {
			if (
				line.kind === "rule" ||
				line.kind === "idle" ||
				line.kind === "hint"
			) {
				return theme.fg("dim", line.text);
			}
			if (line.kind === "tabs") {
				return styleTabRule(line.text, theme);
			}
			// Content row: selection is inverse-video; tone colors the text.
			let text = line.text;
			if (line.tone === "accent") text = theme.fg("accent", text);
			else if (line.tone === "error") text = theme.fg("error", text);
			else if (line.tone === "dim") text = theme.fg("dim", text);
			if (line.selected) {
				// Pad to full width first so the inverse band spans the row.
				const pad = Math.max(0, width - visibleWidth(line.text));
				text = inverse(`${text}${" ".repeat(pad)}`);
			}
			return text;
		});
	}
}

interface PlainLine {
	readonly text: string;
	readonly kind: "tabs" | "row" | "hint" | "rule" | "idle";
	readonly tone?: "accent" | "error" | "dim";
	readonly selected?: boolean;
}

function countAgents(agents: readonly HudAgentNode[]): number {
	let n = 0;
	for (const node of agents) n += 1 + node.children.length;
	return n;
}

function agentRight(agent: HudAgentLeaf, now: number): string {
	const parts = [agent.status, hudElapsed(now - agent.startedAt)];
	if (agent.note) parts.push(agent.note);
	return parts.join(" · ");
}

/** `left …gap… right` fitted to width; right drops first, left truncates. */
function composeRow(row: HudRow, width: number): string {
	const right = row.right ?? "";
	const rightWidth = visibleWidth(right);
	if (right && rightWidth + 6 <= width) {
		const left = truncateToWidth(row.left, width - rightWidth - 2);
		const gap = width - visibleWidth(left) - rightWidth;
		return `${left}${" ".repeat(gap)}${right}`;
	}
	return truncateToWidth(row.left, width);
}

function bottomRule(width: number, above: number, below: number): string {
	if (above === 0 && below === 0) return "─".repeat(width);
	const parts: string[] = [];
	if (above > 0) parts.push(`↑ ${above} more`);
	if (below > 0) parts.push(`↓ ${below} more`);
	const label = ` ${parts.join(" · ")} `;
	const lead = "──";
	const fill = Math.max(0, width - visibleWidth(lead) - visibleWidth(label));
	return truncateToWidth(`${lead}${label}${"─".repeat(fill)}`, width);
}

/** Dim the rule dashes, bold+accent the active `[ … ]` tab label. */
function styleTabRule(text: string, theme: Theme): string {
	const open = text.indexOf("[");
	const close = text.indexOf("]");
	if (open === -1 || close === -1 || close < open) return theme.fg("dim", text);
	const before = text.slice(0, open);
	const active = text.slice(open, close + 1);
	const after = text.slice(close + 1);
	return (
		theme.fg("dim", before) +
		theme.bold(theme.fg("accent", active)) +
		theme.fg("dim", after)
	);
}

function inverse(text: string): string {
	return `\u001b[7m${text}\u001b[27m`;
}
