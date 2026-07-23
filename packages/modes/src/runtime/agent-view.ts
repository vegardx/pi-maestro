// Live read-only view of an agent's work — the headless replacement for a tmux
// pane attach. Tails the agent's own pi session file (the JSONL transcript the
// pane rendered indirectly) and shows it in a focused overlay modal via
// ctx.ui.custom. Uniform for subagents and execution workers: both write a
// session file the maestro already knows the path of (agent-targets sessionFile).
//
// Granularity is per-message (session files write on message boundaries), not
// per-token — each step lands as it completes.

import { readFileSync, statSync } from "node:fs";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

// ─── Rendering a transcript entry to display lines ───────────────────────────

interface RenderOpts {
	readonly width: number;
	/** Apply the dim style (meta lines: thinking, tool calls/results). */
	readonly dim: (text: string) => string;
}

function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	for (const raw of text.replace(/\r/g, "").split("\n")) {
		if (raw.length <= width) {
			out.push(raw);
			continue;
		}
		let rest = raw;
		while (rest.length > width) {
			// Prefer a space break near the edge; fall back to a hard cut.
			const cut = rest.lastIndexOf(" ", width);
			const at = cut > width * 0.5 ? cut : width;
			out.push(rest.slice(0, at));
			rest = rest.slice(cut > width * 0.5 ? at + 1 : at);
		}
		out.push(rest);
	}
	return out;
}

const firstLine = (text: string): string => (text.split("\n")[0] ?? "").trim();

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => {
				const b = block as { type?: string; text?: string };
				return b?.type === "text" && typeof b.text === "string" ? b.text : "";
			})
			.join(" ");
	}
	return "";
}

function argsSummary(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const entries = Object.entries(args as Record<string, unknown>)
		.map(([k, v]) => {
			const val =
				typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
			return `${k}=${firstLine(String(val)).slice(0, 40)}`;
		})
		.slice(0, 3);
	return entries.length ? ` ${entries.join(" ")}` : "";
}

/** One session entry → display lines. Defensive over content-block shapes. */
export function renderSessionEntry(entry: unknown, opts: RenderOpts): string[] {
	const e = entry as { type?: string; message?: unknown };
	const { width, dim } = opts;

	// The kickoff/seed rides as a custom_message — show it as the task header.
	if (e.type === "custom_message" || e.type === "custom") {
		const text = firstLine(textOf((e as { content?: unknown }).content));
		return text ? wrap(text, width).map((l) => dim(`» ${l}`)) : [];
	}
	if (e.type !== "message" || !e.message) return [];

	const msg = e.message as { role?: string; content?: unknown };
	const content = msg.content;
	if (typeof content === "string") {
		return msg.role === "user"
			? wrap(content, width).map((l) => dim(`» ${l}`))
			: wrap(content, width);
	}
	if (!Array.isArray(content)) return [];

	const lines: string[] = [];
	for (const raw of content) {
		const block = raw as {
			type?: string;
			text?: string;
			thinking?: string;
			name?: string;
			toolName?: string;
			arguments?: unknown;
			input?: unknown;
			content?: unknown;
		};
		switch (block.type) {
			case "text":
				if (block.text?.trim()) lines.push(...wrap(block.text, width));
				break;
			case "thinking":
				if (block.thinking?.trim())
					lines.push(dim(`· ${firstLine(block.thinking).slice(0, width - 2)}`));
				break;
			case "toolCall":
			case "tool_use":
				lines.push(
					dim(
						`  → ${block.name ?? block.toolName ?? "tool"}${argsSummary(
							block.arguments ?? block.input,
						)}`.slice(0, width),
					),
				);
				break;
			case "toolResult":
			case "tool_result": {
				const summary = firstLine(textOf(block.content));
				if (summary) lines.push(dim(`  ← ${summary}`.slice(0, width)));
				break;
			}
		}
	}
	return lines;
}

// ─── Tailing a session JSONL file ────────────────────────────────────────────

/** Poll a JSONL file for newly-appended complete lines (offset-based). */
export class SessionTail {
	private offset = 0;
	private carry = "";
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly path: string,
		private readonly onEntries: (entries: unknown[]) => void,
		private readonly pollMs = 250,
	) {}

	/** Read once now (returns any new entries) and start polling. */
	start(): void {
		this.poll();
		this.timer = setInterval(() => this.poll(), this.pollMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	private poll(): void {
		let size = 0;
		try {
			size = statSync(this.path).size;
		} catch {
			return; // not created yet
		}
		if (size <= this.offset) return;
		let chunk = "";
		try {
			const buf = readFileSync(this.path);
			chunk = buf.subarray(this.offset).toString("utf8");
			this.offset = buf.length;
		} catch {
			return;
		}
		const text = this.carry + chunk;
		const lines = text.split("\n");
		this.carry = lines.pop() ?? ""; // last (possibly partial) line
		const entries: unknown[] = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				entries.push(JSON.parse(line));
			} catch {
				// A torn write — the carry retries it next poll.
			}
		}
		if (entries.length) this.onEntries(entries);
	}
}

// ─── The overlay component ───────────────────────────────────────────────────

const ESC = "";

/** A scroll-follow pager over an agent's transcript. Read-only. */
class LiveSessionView implements Component {
	private lines: string[] = [];
	private scrollTop = 0;
	private follow = true;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly opts: {
			readonly title: string;
			readonly status: () => string;
			readonly close: () => void;
		},
	) {}

	/** Nothing is cached across renders, so there is nothing to invalidate. */
	invalidate(): void {}

	append(rendered: string[]): void {
		if (!rendered.length) return;
		this.lines.push(...rendered);
		this.tui.requestRender();
	}

	private viewportHeight(): number {
		const rows = process.stdout.rows ?? 40;
		return Math.max(6, Math.floor(rows * 0.8) - 3); // header + two borders
	}

	render(width: number): string[] {
		const dim = (t: string) => this.theme.fg("dim", t);
		const vh = this.viewportHeight();
		const maxTop = Math.max(0, this.lines.length - vh);
		const top = this.follow ? maxTop : Math.min(this.scrollTop, maxTop);
		const window = this.lines.slice(top, top + vh);
		while (window.length < vh) window.push("");
		const header = this.theme.fg(
			"toolOutput",
			`▐ ${this.opts.title} · ${this.opts.status()}`,
		);
		const foot = dim(
			`${top + window.length}/${this.lines.length} · ↑↓ scroll · f ${
				this.follow ? "following" : "paused"
			} · Esc close`,
		);
		return [header.slice(0, width), ...window, foot.slice(0, width)];
	}

	handleInput(data: string): void {
		const vh = this.viewportHeight();
		const maxTop = Math.max(0, this.lines.length - vh);
		if (data === ESC || data === "q") {
			this.opts.close();
			return;
		}
		if (data === "f") this.follow = !this.follow;
		else if (data === `${ESC}[A`) {
			this.follow = false;
			this.scrollTop = Math.max(0, this.currentTop(maxTop) - 1);
		} else if (data === `${ESC}[B`) {
			this.scrollTop = this.currentTop(maxTop) + 1;
			if (this.scrollTop >= maxTop) this.follow = true;
		} else if (data === `${ESC}[5~`) {
			this.follow = false;
			this.scrollTop = Math.max(0, this.currentTop(maxTop) - vh);
		} else if (data === `${ESC}[6~`) {
			this.scrollTop = Math.min(maxTop, this.currentTop(maxTop) + vh);
			if (this.scrollTop >= maxTop) this.follow = true;
		} else if (data === "g") {
			this.follow = false;
			this.scrollTop = 0;
		} else if (data === "G") this.follow = true;
		else return;
		this.tui.requestRender();
	}

	private currentTop(maxTop: number): number {
		return this.follow ? maxTop : Math.min(this.scrollTop, maxTop);
	}
}

// ─── The opener wired behind /view ───────────────────────────────────────────

export interface AgentViewTarget {
	readonly id: string;
	readonly sessionFile?: string;
	readonly status: () => string;
}

/**
 * Open a live read-only view of an agent's transcript as an overlay modal.
 * Resolves when the user closes it (Esc/q). No-op with a notice if the agent
 * has no session file yet.
 */
export async function openAgentLiveView(
	ctx: ExtensionContext,
	target: AgentViewTarget,
): Promise<void> {
	if (!target.sessionFile) {
		ctx.ui.notify(`${target.id} has no session to view yet.`, "info");
		return;
	}
	const dimOf = (theme: Theme) => (t: string) => theme.fg("dim", t);
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const view = new LiveSessionView(tui, theme, {
				title: target.id,
				status: target.status,
				close: () => done(),
			});
			const width = (process.stdout.columns ?? 80) - 4;
			const tail = new SessionTail(target.sessionFile as string, (entries) => {
				for (const entry of entries)
					view.append(renderSessionEntry(entry, { width, dim: dimOf(theme) }));
			});
			tail.start();
			// Attach dispose without spreading (spread would drop the prototype
			// render/handleInput methods the TUI calls).
			return Object.assign(view, { dispose: () => tail.stop() });
		},
		{
			overlay: true,
			overlayOptions: () => ({ width: "90%", maxHeight: "80%" }),
		},
	);
}
