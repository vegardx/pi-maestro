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
	const failedSuffix = failed > 0 ? `, ${failed} failed` : "";
	lines.push(`\u2500\u2500\u2500 Execution complete (${done + failed}/${total} done${failedSuffix}) ${divider}`);
	lines.push("");

	for (const [, agent] of agents) {
		const elapsed = formatDuration(now - agent.startedAt);
		const icon = agent.status === "done" ? "\u2713" : "\u2717";
		const statusColor = agent.status === "done" ? icon : icon;

		let line = `  ${statusColor}  ${agent.agentName.padEnd(20)}`;

		if (agent.summary) {
			line += `  ${agent.summary}`;
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
