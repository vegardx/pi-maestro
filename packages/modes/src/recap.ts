// Execution recap — formats a summary of all agent work.

import type { TokenSnapshot } from "@vegardx/pi-contracts";
import type { TmuxAgentState } from "./execution-tmux.js";
import type { UsageLedger } from "./usage-ledger.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const W = 80; // max width

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

function fmtTokens(t: TokenSnapshot): string {
	return `↑${k(t.input)} ↓${k(t.output)}`;
}

function fmtCache(t: TokenSnapshot): string {
	const denom = t.input + t.cacheRead;
	if (denom === 0) return "—";
	return `${Math.round((t.cacheRead / denom) * 100)}%`;
}

function fmtCost(t: TokenSnapshot): string {
	if (t.cost < 0.01) return `$${t.cost.toFixed(3)}`;
	return `$${t.cost.toFixed(2)}`;
}

function padR(s: string, w: number): string {
	return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

function padL(s: string, w: number): string {
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
		if (key === `agent:${agentId}` || key.startsWith(`lens:${agentId}:`)) {
			input += snap.input;
			output += snap.output;
			cacheRead += snap.cacheRead;
			cacheWrite += snap.cacheWrite;
			cost += snap.cost;
			turns += snap.turns;
		}
	}
	if (input === 0 && output === 0) return agentState.tokens;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output,
		cost,
		turns,
	};
}

// ─── Main format ────────────────────────────────────────────────────────────

export function formatRecap(
	agents: ReadonlyMap<string, TmuxAgentState>,
	ledger?: UsageLedger,
	deliverableTitles?: ReadonlyMap<string, string>,
): string {
	const now = Date.now();
	const total = agents.size;
	let doneCount = 0;
	let failedCount = 0;
	let earliest = now;
	for (const a of agents.values()) {
		if (a.status === "done") doneCount++;
		else if (a.status === "failed") failedCount++;
		if (a.startedAt < earliest) earliest = a.startedAt;
	}

	const lines: string[] = [];
	const finished = doneCount + failedCount;
	const headerStatus = finished === total ? "complete" : "in progress";
	const failedSuffix = failedCount > 0 ? `, ${failedCount} failed` : "";
	const divider = "─".repeat(W);

	const hdrText = `─── Execution ${headerStatus} (${finished}/${total} done${failedSuffix}) `;
	lines.push(hdrText + "─".repeat(Math.max(0, W - hdrText.length)));
	lines.push("");

	// ─── Section 1: Details per agent ─────────────────────────────────────
	for (const [id, agent] of agents) {
		const icon =
			agent.status === "done"
				? "✓"
				: agent.status === "failed"
					? "✗"
					: agent.status === "working"
						? "▶"
						: agent.status === "awaiting-decision"
							? "❓"
							: "○";

		const delivTitle = deliverableTitles?.get(id);
		const title = delivTitle
			? `${agent.agentName} — ${delivTitle}`
			: agent.agentName;
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
	lines.push(divider);

	// Column layout: name(38) + tokens(14) + cache(8) + cost(8) + time(8) = 76 (+4 pad)
	const nameW = 38;
	const tokW = 14;
	const cacheW = 8;
	const costW = 8;
	const timeW = 8;

	lines.push(
		padR("", nameW) +
			padL("tokens", tokW) +
			padL("cache", cacheW) +
			padL("cost", costW) +
			padL("time", timeW),
	);

	let totalTok: TokenSnapshot = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
		turns: 0,
	};

	for (const [id, agent] of agents) {
		const tokens = getAgentTokens(id, agent, ledger);
		totalTok = {
			input: totalTok.input + tokens.input,
			output: totalTok.output + tokens.output,
			cacheRead: totalTok.cacheRead + tokens.cacheRead,
			cacheWrite: totalTok.cacheWrite + tokens.cacheWrite,
			totalTokens: totalTok.totalTokens + tokens.totalTokens,
			cost: totalTok.cost + tokens.cost,
			turns: totalTok.turns + tokens.turns,
		};

		const elapsed = now - agent.startedAt;
		lines.push(
			padR(`  ${agent.agentName}`, nameW) +
				padL(fmtTokens(tokens), tokW) +
				padL(fmtCache(tokens), cacheW) +
				padL(fmtCost(tokens), costW) +
				padL(formatDuration(elapsed), timeW),
		);
	}

	// Totals — wall-clock time from first start to now
	const wallClock = now - earliest;
	lines.push(divider);
	lines.push(
		padR("  Totals", nameW) +
			padL(fmtTokens(totalTok), tokW) +
			padL(fmtCache(totalTok), cacheW) +
			padL(fmtCost(totalTok), costW) +
			padL(formatDuration(wallClock), timeW),
	);
	lines.push(divider);

	return lines.join("\n");
}
