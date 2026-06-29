// Live view overlay component — renders a scrolling log of a agent's events.
// Shows tool calls as compact lines, assistant text abbreviated. Used by /view.

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

export interface LiveViewOptions {
	readonly agentName: string;
	readonly deliverableTitle: string;
	readonly onClose: () => void;
}

interface AgentEventLike {
	type: string;
	toolName?: string;
	toolCallId?: string;
	args?: unknown;
	result?: unknown;
	isError?: boolean;
	message?: { role?: string; content?: unknown };
}

export class LiveViewComponent implements Component {
	private lines: string[] = [];
	private maxLines = 30;
	private cachedWidth?: number;
	private cachedRender?: string[];
	private theme?: Theme;

	constructor(private readonly opts: LiveViewOptions) {}

	setTheme(theme: Theme): void {
		this.theme = theme;
		this.invalidate();
	}

	pushEvent(event: AgentEventLike): void {
		const line = this.formatEvent(event);
		if (line) {
			this.lines.push(line);
			if (this.lines.length > this.maxLines) {
				this.lines.shift();
			}
			this.invalidate();
		}
	}

	handleInput(data: string): void {
		// Escape or 'q' closes the view
		if (data === "\x1b" || data === "q") {
			this.opts.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedRender && this.cachedWidth === width) {
			return this.cachedRender;
		}

		const fg = this.theme?.fg.bind(this.theme);
		const header = `─── ${this.opts.agentName} (${this.opts.deliverableTitle}) `;
		const closeHint = " Escape to close ──";
		const pad = Math.max(0, width - header.length - closeHint.length);
		const headerLine = fg
			? fg("border", header + "─".repeat(pad) + closeHint)
			: header + "─".repeat(pad) + closeHint;

		const output: string[] = [truncateToWidth(headerLine, width)];

		if (this.lines.length === 0) {
			const waiting = fg
				? fg("muted", "  Waiting for events...")
				: "  Waiting for events...";
			output.push(truncateToWidth(waiting, width));
		} else {
			for (const line of this.lines) {
				output.push(truncateToWidth(line, width));
			}
		}

		const footer = "─".repeat(width);
		output.push(fg ? fg("border", footer) : footer);

		this.cachedRender = output;
		this.cachedWidth = width;
		return output;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedRender = undefined;
	}

	private formatEvent(event: AgentEventLike): string | undefined {
		const fg = this.theme?.fg.bind(this.theme);
		switch (event.type) {
			case "tool_execution_start": {
				const name = event.toolName ?? "tool";
				const argsStr = this.formatArgs(event.args);
				return fg
					? `  ${fg("accent", name)} ${fg("muted", argsStr)}`
					: `  ${name} ${argsStr}`;
			}
			case "tool_execution_end": {
				const name = event.toolName ?? "tool";
				if (event.isError) {
					return fg ? `  ${fg("error", `✗ ${name}`)}` : `  ✗ ${name}`;
				}
				return fg ? `  ${fg("success", `✓ ${name}`)}` : `  ✓ ${name}`;
			}
			case "message_end": {
				const msg = event.message;
				if (msg?.role === "assistant") {
					const content = msg.content;
					const text =
						typeof content === "string"
							? content
							: Array.isArray(content)
								? content
										.filter(
											(p: unknown): p is { type: string; text: string } =>
												typeof p === "object" &&
												p !== null &&
												(p as { type?: string }).type === "text",
										)
										.map((p) => p.text)
										.join(" ")
								: "";
					const abbreviated = text.slice(0, 120).replace(/\n/g, " ");
					return fg
						? `  ${fg("muted", "│")} ${abbreviated}${text.length > 120 ? "…" : ""}`
						: `  │ ${abbreviated}${text.length > 120 ? "…" : ""}`;
				}
				return undefined;
			}
			case "turn_start":
				return fg ? fg("dim", "  ── turn ──") : "  ── turn ──";
			default:
				return undefined;
		}
	}

	private formatArgs(args: unknown): string {
		if (!args || typeof args !== "object") return "";
		const obj = args as Record<string, unknown>;
		// Show the most relevant arg for common tools
		if (typeof obj.path === "string")
			return obj.path.split("/").slice(-2).join("/");
		if (typeof obj.command === "string") return obj.command.slice(0, 60);
		if (typeof obj.action === "string") return obj.action;
		return "";
	}
}
