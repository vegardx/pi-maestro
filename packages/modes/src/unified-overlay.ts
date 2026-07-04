/**
 * Unified overlay component that combines the agents dashboard and
 * questions panel into a single persistent widget above the editor.
 *
 * - Tab = expand/collapse
 * - ←/→ = switch between Agents and Questions sections (when questions exist)
 * - ↑/↓ = navigate within section
 * - Enter = confirm selection (questions) or expand agent details (agents)
 * - Esc = collapse
 */

import type { Component } from "@earendil-works/pi-tui";
import type { Answer, Answers, Question } from "@vegardx/pi-contracts";
import {
	defaultPalette,
	formatElapsed,
	type OverlayHandle,
	type Palette,
	padRight,
	truncate,
} from "@vegardx/pi-ui";
import type { Row, TabId } from "./agents-dashboard.js";
import type { PendingQuestion } from "./question-queue.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const KEY_TAB = "\t";
const KEY_ESC = "\u001b";
const KEY_UP = "\u001b[A";
const KEY_DOWN = "\u001b[B";
const KEY_RIGHT = "\u001b[C";
const KEY_LEFT = "\u001b[D";
const KEY_ENTER = "\r";

type Section = "agents" | "questions";

// ─── Status rendering helpers ───────────────────────────────────────────────

const STATUS_GLYPH: Record<string, string> = {
	spawning: "◔",
	working: "◐",
	idle: "◑",
	"awaiting-decision": "?",
	done: "●",
	failed: "✗",
};

const STATUS_LABEL: Record<string, string> = {
	spawning: "spawning",
	working: "working",
	idle: "idle",
	"awaiting-decision": "awaiting",
	done: "done",
	failed: "failed",
};

function statusToTab(status: string): TabId {
	switch (status) {
		case "spawning":
		case "working":
			return "working";
		case "idle":
		case "awaiting-decision":
			return "waiting";
		case "done":
			return "done";
		case "failed":
			return "failed";
		default:
			return "all";
	}
}

// ─── Box drawing helpers ────────────────────────────────────────────────────

function boxLine(content: string, width: number, palette: Palette): string {
	const inner = width - 4;
	return `${palette.dim("│")} ${padRight(content, inner)} ${palette.dim("│")}`;
}

function boxTop(
	leftLabel: string,
	rightLabel: string | undefined,
	width: number,
	palette: Palette,
): string {
	const left = ` ${leftLabel} `;
	const right = rightLabel ? ` ${rightLabel} ` : "";
	const fillLen = Math.max(width - 2 - left.length - right.length, 0);
	const fill = "─".repeat(fillLen);
	return palette.dim(`╭─${left}${fill}${right}─╮`);
}

function boxBot(width: number, palette: Palette): string {
	return palette.dim(`╰${"─".repeat(Math.max(width - 2, 0))}╯`);
}

function boxMid(width: number, palette: Palette): string {
	return palette.dim(`├${"─".repeat(Math.max(width - 2, 0))}┤`);
}

// ─── Component ──────────────────────────────────────────────────────────────

export interface UnifiedOverlayCallbacks {
	onAnswer: (agentId: string, answers: Answers) => void;
	onAction: (action: "watch" | "attach" | "steer", agentId: string) => void;
}

export class UnifiedOverlayComponent implements Component {
	focused = false;
	expanded = false;

	private section: Section = "agents";
	private agentRows: readonly Row[] = [];
	private pendingQuestions: readonly PendingQuestion[] = [];

	// Agents section state
	private agentSelected = 0;

	// Questions section state
	private questionIdx = 0; // which pending question
	private optionIdx = 0; // which option within current question
	private freeText = "";
	private freeTextActive = false;

	private handle: OverlayHandle | undefined;
	private palette: Palette;
	private readonly callbacks: UnifiedOverlayCallbacks;

	constructor(callbacks: UnifiedOverlayCallbacks, palette?: Palette) {
		this.callbacks = callbacks;
		this.palette = palette ?? defaultPalette();
	}

	setHandle(handle: OverlayHandle): void {
		this.handle = handle;
	}

	setPalette(palette: Palette): void {
		this.palette = palette;
	}

	updateAgents(rows: readonly Row[]): void {
		this.agentRows = rows;
		if (this.agentSelected >= rows.length) {
			this.agentSelected = Math.max(0, rows.length - 1);
		}
	}

	updateQuestions(pending: readonly PendingQuestion[]): void {
		this.pendingQuestions = pending;
		if (pending.length === 0) {
			if (this.section === "questions") this.section = "agents";
		}
		if (this.questionIdx >= pending.length) {
			this.questionIdx = Math.max(0, pending.length - 1);
		}
		this.clampOptionIdx();
	}

	/** Navigate to questions section (e.g. when /answer is called). */
	showQuestions(): void {
		if (this.pendingQuestions.length === 0) return;
		this.section = "questions";
		this.expanded = true;
		this.handle?.focus();
	}

	/** Navigate to agents section (e.g. when /agents is called). */
	showAgents(): void {
		this.section = "agents";
		this.expanded = true;
		this.handle?.focus();
	}

	invalidate(): void {}

	// ─── Render ───────────────────────────────────────────────────────────────

	render(width: number): string[] {
		if (!this.expanded) return this.renderCollapsed(width);
		if (this.section === "agents") return this.renderAgents(width);
		return this.renderQuestions(width);
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

		const working = this.agentRows.filter(
			(r) => statusToTab(r.state.status) === "working",
		).length;
		const waiting = this.agentRows.filter(
			(r) => statusToTab(r.state.status) === "waiting",
		).length;
		const done = this.agentRows.filter(
			(r) => statusToTab(r.state.status) === "done",
		).length;
		const parts: string[] = [];
		if (working > 0) parts.push(`${working} working`);
		if (waiting > 0) parts.push(`${waiting} waiting`);
		if (done > 0) parts.push(`${done} done`);
		const summary = parts.length > 0 ? parts.join(" · ") : "no agents";

		const qCount = this.pendingQuestions.length;
		const rightLabel =
			qCount > 0 ? `${qCount} question${qCount > 1 ? "s" : ""} ▶` : undefined;

		const top = boxTop("Agents", rightLabel, width, p);
		const content = boxLine(`  ▸ ${summary}`, width, p);
		const bot = boxBot(width, p);
		return [top, content, bot];
	}

	private renderAgents(width: number): string[] {
		const p = this.palette;
		const lines: string[] = [];

		const qCount = this.pendingQuestions.length;
		const rightLabel =
			qCount > 0 ? `${qCount} question${qCount > 1 ? "s" : ""} ▶` : undefined;
		lines.push(boxTop("Agents", rightLabel, width, p));
		lines.push(boxLine("", width, p));

		if (this.agentRows.length === 0) {
			lines.push(boxLine(p.muted("  (no agents)"), width, p));
			lines.push(boxLine("", width, p));
			lines.push(boxMid(width, p));
			lines.push(boxLine(p.muted("tab collapse · esc close"), width, p));
			lines.push(boxBot(width, p));
			return lines;
		}

		const innerWidth = width - 4;
		const COL_PROGRESS = 6;
		const COL_STATUS = 9;
		const COL_ELAPSED = 5;
		const PREFIX_W = 4;
		const FIXED = PREFIX_W + COL_PROGRESS + COL_STATUS + COL_ELAPSED + 3;
		const COL_TITLE = Math.max(innerWidth - FIXED, 10);

		for (let i = 0; i < this.agentRows.length; i++) {
			const row = this.agentRows[i];
			const sel = i === this.agentSelected;
			const glyph = STATUS_GLYPH[row.state.status] ?? "·";
			const progress = padRight(`${row.done}/${row.total}`, COL_PROGRESS);
			const status = padRight(
				STATUS_LABEL[row.state.status] ?? row.state.status,
				COL_STATUS,
			);
			const elapsed = padRight(formatElapsed(row.elapsedMs), COL_ELAPSED);
			const title = padRight(truncate(row.title, COL_TITLE), COL_TITLE);

			if (sel) {
				const line = `▸ ${glyph} ${title} ${progress} ${status} ${elapsed}`;
				lines.push(boxLine(p.accent(line), width, p));
				for (const t of row.tasks) {
					const mark = t.done ? p.success("✓") : "·";
					lines.push(
						boxLine(`  ${p.accent("┊")}  ${mark} ${p.dim(t.title)}`, width, p),
					);
				}
				if (row.pending) {
					lines.push(
						boxLine(
							`  ${p.accent("┊")}  ${p.warning("?")} ${p.dim(row.pending)}`,
							width,
							p,
						),
					);
				}
			} else {
				const line = `  ${glyph} ${title} ${progress} ${status} ${p.dim(elapsed)}`;
				lines.push(boxLine(line, width, p));
			}
		}

		lines.push(boxLine("", width, p));
		lines.push(boxMid(width, p));

		const hints: string[] = ["tab collapse", "↑/↓ select"];
		if (qCount > 0) hints.push("→ questions");
		hints.push("w watch", "a attach", "esc close");
		lines.push(boxLine(p.muted(hints.join(" · ")), width, p));
		lines.push(boxBot(width, p));
		return lines;
	}

	private renderQuestions(width: number): string[] {
		const p = this.palette;
		const lines: string[] = [];
		const innerWidth = width - 4;

		const entry = this.pendingQuestions[this.questionIdx];
		if (!entry) {
			this.section = "agents";
			return this.renderAgents(width);
		}

		const leftLabel = `◀ Agents (${this.agentRows.length})`;
		lines.push(boxTop(leftLabel, "Questions", width, p));
		lines.push(boxLine("", width, p));

		// Question header
		const total = this.pendingQuestions.length;
		if (total > 1) {
			lines.push(
				boxLine(
					p.muted(`Question ${this.questionIdx + 1} of ${total}`),
					width,
					p,
				),
			);
		}
		lines.push(
			boxLine(
				p.dim(`from: ${entry.agentName} — ${entry.deliverableTitle}`),
				width,
				p,
			),
		);
		lines.push(boxLine("", width, p));

		const question = entry.questions[0];
		if (!question) {
			lines.push(boxLine(p.muted("(no question data)"), width, p));
			lines.push(boxBot(width, p));
			return lines;
		}

		// Question text
		lines.push(
			boxLine(p.heading(truncate(question.question, innerWidth)), width, p),
		);
		if (question.context) {
			const ctx = truncate(question.context, innerWidth);
			lines.push(boxLine(p.dim(ctx), width, p));
		}
		lines.push(boxLine("", width, p));

		// Options
		const options = question.options ?? [];
		const _totalItems = options.length + 1; // +1 for free-text input

		for (let i = 0; i < options.length; i++) {
			const opt = options[i];
			const selected = !this.freeTextActive && i === this.optionIdx;
			const prefix = selected ? "›" : " ";
			const num = `${i + 1}.`;
			const label = truncate(opt.label, innerWidth - 6);
			const line = `${prefix} ${num} ${label}`;
			lines.push(boxLine(selected ? p.accent(line) : line, width, p));
			if (selected && opt.description) {
				lines.push(
					boxLine(
						`     ${p.dim(truncate(opt.description, innerWidth - 5))}`,
						width,
						p,
					),
				);
			}
		}

		// Free-text input field
		const ftSelected = this.freeTextActive || this.optionIdx >= options.length;
		const ftPrefix = ftSelected ? "›" : " ";
		const ftNum = `${options.length + 1}.`;
		const ftContent = this.freeText || (ftSelected ? "" : "");
		const ftPlaceholder = ftContent
			? ftContent
			: p.dim("type a custom answer...");
		const ftLine = `${ftPrefix} ${ftNum} ${ftPlaceholder}${ftSelected ? "▌" : ""}`;
		lines.push(boxLine(ftSelected ? p.accent(ftLine) : ftLine, width, p));

		lines.push(boxLine("", width, p));
		lines.push(boxMid(width, p));

		const hints: string[] = ["← agents", "enter select", "↑/↓ navigate"];
		if (total > 1) hints.push("←/→ question");
		hints.push("tab collapse");
		lines.push(boxLine(p.muted(hints.join(" · ")), width, p));
		lines.push(boxBot(width, p));
		return lines;
	}

	// ─── Input handling ─────────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (data === KEY_TAB) {
			this.toggleExpand();
			return;
		}
		if (data === KEY_ESC) {
			if (this.expanded) {
				this.expanded = false;
				this.handle?.unfocus();
			}
			return;
		}
		if (!this.expanded) return;

		if (this.section === "agents") {
			this.handleAgentsInput(data);
		} else {
			this.handleQuestionsInput(data);
		}
	}

	private toggleExpand(): void {
		if (this.expanded) {
			this.expanded = false;
			this.handle?.unfocus();
		} else {
			this.expanded = true;
			this.handle?.focus();
		}
	}

	private handleAgentsInput(data: string): void {
		switch (data) {
			case KEY_UP:
				this.agentSelected = Math.max(0, this.agentSelected - 1);
				break;
			case KEY_DOWN:
				this.agentSelected = Math.min(
					this.agentRows.length - 1,
					this.agentSelected + 1,
				);
				break;
			case KEY_RIGHT:
				if (this.pendingQuestions.length > 0) {
					this.section = "questions";
					this.clampOptionIdx();
				}
				break;
			case "w": {
				const row = this.agentRows[this.agentSelected];
				if (row) this.callbacks.onAction("watch", row.agentId);
				break;
			}
			case "a": {
				const row = this.agentRows[this.agentSelected];
				if (row) this.callbacks.onAction("attach", row.agentId);
				break;
			}
			case "s": {
				const row = this.agentRows[this.agentSelected];
				if (row) this.callbacks.onAction("steer", row.agentId);
				break;
			}
		}
	}

	private handleQuestionsInput(data: string): void {
		const entry = this.pendingQuestions[this.questionIdx];
		if (!entry) return;
		const question = entry.questions[0];
		if (!question) return;
		const options = question.options ?? [];
		const _totalItems = options.length + 1; // +1 for free text

		switch (data) {
			case KEY_LEFT:
				this.section = "agents";
				break;
			case KEY_UP:
				if (this.freeTextActive) {
					this.freeTextActive = false;
					this.optionIdx = options.length - 1;
				} else {
					this.optionIdx = Math.max(0, this.optionIdx - 1);
				}
				break;
			case KEY_DOWN:
				if (this.optionIdx >= options.length - 1 && !this.freeTextActive) {
					this.freeTextActive = true;
				} else if (!this.freeTextActive) {
					this.optionIdx = Math.min(options.length - 1, this.optionIdx + 1);
				}
				break;
			case KEY_ENTER:
				this.submitAnswer(entry, question);
				break;
			case "\u007f": // Backspace
				if (this.freeTextActive) {
					this.freeText = this.freeText.slice(0, -1);
				}
				break;
			default:
				// Number keys jump to option
				if (data >= "1" && data <= "9") {
					const idx = Number.parseInt(data, 10) - 1;
					if (idx < options.length) {
						this.freeTextActive = false;
						this.optionIdx = idx;
					} else if (idx === options.length) {
						this.freeTextActive = true;
					}
				} else if (this.freeTextActive && data.length === 1 && data >= " ") {
					this.freeText += data;
				}
				break;
		}
	}

	private submitAnswer(entry: PendingQuestion, question: Question): void {
		const options = question.options ?? [];
		let answer: Answer;

		if (this.freeTextActive && this.freeText.trim()) {
			answer = {
				questionId: question.id,
				value: this.freeText.trim(),
				custom: true,
			};
		} else if (!this.freeTextActive && this.optionIdx < options.length) {
			const opt = options[this.optionIdx];
			answer = {
				questionId: question.id,
				value: opt.value ?? opt.label,
			};
		} else {
			return; // Nothing to submit
		}

		this.callbacks.onAnswer(entry.agentId, [answer]);
		this.freeText = "";
		this.freeTextActive = false;
		this.optionIdx = 0;

		// Advance to next question or switch back to agents
		if (this.pendingQuestions.length <= 1) {
			this.section = "agents";
		} else {
			this.questionIdx = Math.min(
				this.questionIdx,
				this.pendingQuestions.length - 2,
			);
		}
	}

	private clampOptionIdx(): void {
		const entry = this.pendingQuestions[this.questionIdx];
		if (!entry) return;
		const question = entry.questions[0];
		if (!question) return;
		const maxIdx = (question.options?.length ?? 0) - 1;
		if (!this.freeTextActive && this.optionIdx > maxIdx) {
			this.optionIdx = Math.max(0, maxIdx);
		}
	}
}
