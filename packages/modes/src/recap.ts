// Execution recap — formats a summary of all agent work.

import type { TokenSnapshot } from "@vegardx/pi-contracts";
import type { TmuxAgentState } from "./execution-tmux.js";
import type { UsageLedger } from "./usage-ledger.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function hyperlink(url: string, text: string): string {
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	const m = Math.floor(s / 60);
	const sec = s % 60;
	if (m > 0) return `${m}m ${sec.toString().padStart(2, "0")}s`;
	return `${sec}s`;
}

const k = (n: number): string => {
	if (n < 1000) return `${n}`;
	return `${Math.round(n / 1000)}k`;
};

function formatTokens(t: TokenSnapshot): string {
	return `↑${k(t.input)} ↓${k(t.output)}`;
}

function formatCacheHit(t: TokenSnapshot): string {
	const denom = t.input + t.cacheRead;
	if (denom === 0) return "—";
	return `${Math.round((t.cacheRead / denom) * 100)}%`;
}

function formatCost(t: TokenSnapshot): string {
	if (t.cost < 0.01) return `$${t.cost.toFixed(3)}`;
	return `$${t.cost.toFixed(2)}`;
}

function padRight(s: string, w: number): string {
	return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function padLeft(s: string, w: number): string {
	return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

// ─── Aggregate tokens for an agent (includes lens subagents) ────────────────

function getAgentTokens(
	agentId: string,
	agentState: TmuxAgentState,
	ledger?: UsageLedger,
): TokenSnapshot {
	if (!ledger) return agentState.tokens;
	const { bySource } = ledger.snapshot();
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let turns = 0;
	for (const [key, snap] of bySource) {
		// Match "agent:<id>" and "lens:<id>:*"
		if (key === `agent:${agentId}` || key.startsWith(`lens:${agentId}:`)) {
			input += snap.input;
			output += snap.output;
			cacheRead += snap.cacheRead;
			cacheWrite += snap.cacheWrite;
			cost += snap.cost;
			turns += snap.turns;
		}
	}
	// Fall back to agent state if ledger has nothing
	if (input === 0 && output === 0) return agentState.tokens;
	return { input, output, cacheRead, cacheWrite, totalTokens: input + output, cost, turns };
}

// ─── Main format ────────────────────────────────────────────────────────────

export function formatRecap(
	agents: ReadonlyMap<string, TmuxAgentState>,
	ledger?: UsageLedger,
): string {
	const now = Date.now();
	const total = agents.size;
	let doneCount = 0;
	let failedCount = 0;
	for (const a of agents.values()) {
		if (a.status === "done") doneCount++;
		else if (a.status === "failed") failedCount++;
	}

	const lines: string[] = [];
	const finished = doneCount + failedCount;
	const headerStatus = finished === total ? "complete" : "in progress";
	const failedSuffix = failedCount > 0 ? `, ${failedCount} failed` : "";
	const divider = "─".repeat(80);

	lines.push(`─── Execution ${headerStatus} (${finished}/${total} done${failedSuffix}) ${divider.slice(0, 40)}`);
	lines.push("");

	// ─── Section 1: Details per agent ─────────────────────────────────────
	for (const [id, agent] of agents) {
		const icon =
			agent.status === "done" ? "✓" :
			agent.status === "failed" ? "✗" :
			agent.status === "working" ? "▶" :
			agent.status === "awaiting-decision" ? "❓" : "○";

		const title = agent.summary ?? agent.agentName;
		lines.push(`  ${icon}  ${title}`);

		if (agent.prUrl) {
			lines.push(`     PR:       ${hyperlink(agent.prUrl, agent.prUrl)}`);
		}
		if (agent.commits && agent.commits.length > 0) {
			lines.push(`     Commits:  ${agent.commits[0]}`);
			for (let i = 1; i < agent.commits.length; i++) {
				lines.push(`               ${agent.commits[i]}`);
			}
		}
		if (agent.model) {
			lines.push(`     Model:    ${agent.model}`);
		}
		if (agent.status === "failed" && agent.errorDetail) {
			lines.push(`     Error:    ${agent.errorDetail}`);
		}
		lines.push("");
	}

	// ─── Section 2: Stats table ───────────────────────────────────────────
	lines.push(divider.slice(0, 80));

	// Column widths
	const nameW = 40;
	const tokW = 12;
	const cacheW = 6;
	const costW = 7;
	const timeW = 7;

	// Header
	lines.push(
		padRight("", nameW) +
		padLeft("tokens", tokW) +
		padLeft("cache", cacheW) +
		padLeft("cost", costW) +
		padLeft("time", timeW),
	);

	// Per-agent rows
	let totalTokens: TokenSnapshot = {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
		totalTokens: 0, cost: 0, turns: 0,
	};
	let totalDuration = 0;

	for (const [id, agent] of agents) {
		const tokens = getAgentTokens(id, agent, ledger);
		const elapsed = now - agent.startedAt;
		totalDuration += elapsed;
		totalTokens = {
			input: totalTokens.input + tokens.input,
			output: totalTokens.output + tokens.output,
			cacheRead: totalTokens.cacheRead + tokens.cacheRead,
			cacheWrite: totalTokens.cacheWrite + tokens.cacheWrite,
			totalTokens: totalTokens.totalTokens + tokens.totalTokens,
			cost: totalTokens.cost + tokens.cost,
			turns: totalTokens.turns + tokens.turns,
		};

		const name = `  ${agent.agentName}`;
		lines.push(
			padRight(name.slice(0, nameW), nameW) +
			padLeft(formatTokens(tokens), tokW) +
			padLeft(formatCacheHit(tokens), cacheW) +
			padLeft(formatCost(tokens), costW) +
			padLeft(formatDuration(elapsed), timeW),
		);
	}

	// Totals
	lines.push(divider.slice(0, 80));
	lines.push(
		padRight("  Totals", nameW) +
		padLeft(formatTokens(totalTokens), tokW) +
		padLeft(formatCacheHit(totalTokens), cacheW) +
		padLeft(formatCost(totalTokens), costW) +
		padLeft(formatDuration(totalDuration), timeW),
	);
	lines.push(divider.slice(0, 80));

	return lines.join("\n");
}
