// Execution recap — formats a summary of all agent work.

import type { TmuxAgentState } from "./execution-tmux.js";

/**
 * Format a terminal hyperlink (OSC 8).
 * Falls back to plain text if the terminal doesn't support it.
 */
function hyperlink(url: string, text: string): string {
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	const m = Math.floor(s / 60);
	const sec = s % 60;
	return m > 0 ? `${m}m ${sec.toString().padStart(2, "0")}s` : `${sec}s`;
}

/**
 * Build the recap text from agent states.
 */
export function formatRecap(
	agents: ReadonlyMap<string, TmuxAgentState>,
): string {
	const now = Date.now();
	const total = agents.size;
	let done = 0;
	let failed = 0;
	for (const a of agents.values()) {
		if (a.status === "done") done++;
		else if (a.status === "failed") failed++;
	}

	const lines: string[] = [];
	const divider = "\u2500".repeat(60);
	const finished = done + failed;
	const failedSuffix = failed > 0 ? `, ${failed} failed` : "";
	const headerStatus = finished === total ? "complete" : "in progress";
	lines.push(`\u2500\u2500\u2500 Execution ${headerStatus} (${finished}/${total} done${failedSuffix}) ${divider}`);
	lines.push("");

	for (const [, agent] of agents) {
		const elapsed = formatDuration(now - agent.startedAt);
		let icon: string;
		let status: string;
		switch (agent.status) {
			case "done":
				icon = "\u2713";
				status = "";
				break;
			case "failed":
				icon = "\u2717";
				status = "(failed)";
				break;
			case "working":
				icon = "\u25b6";
				status = "running";
				break;
			case "spawning":
				icon = "\u25cb";
				status = "starting";
				break;
			case "awaiting-decision":
				icon = "\u2753";
				status = "waiting for answer";
				break;
			default:
				icon = "\u25cb";
				status = agent.status;
				break;
		}

		let line = `  ${icon}  ${agent.agentName.padEnd(20)}`;

		if (agent.summary) {
			line += `  ${agent.summary}`;
		} else if (status) {
			line += `  ${status}`;
		}

		lines.push(line);

		// Details line
		const details: string[] = [];
		details.push(elapsed);
		if (agent.prUrl) {
			details.push(hyperlink(agent.prUrl, agent.prUrl));
		}
		if (details.length > 0) {
			lines.push(`      ${details.join("  ")}`);
		}
		lines.push("");
	}

	lines.push(divider);
	return lines.join("\n");
}
