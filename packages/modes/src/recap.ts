// Execution recap — formats a summary of all agent work.

import type { TokenSnapshot } from "@vegardx/pi-contracts";
import type { LensRunRecord, TmuxAgentState } from "./execution-tmux.js";
import type { UsageLedger } from "./usage-ledger.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const W = 80;

function hyperlink(url: string, text: string): string {
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function fmtDur(ms: number): string {
	const s = Math.floor(ms / 1000);
	const m = Math.floor(s / 60);
	const sec = s % 60;
	if (m > 0) return `${m}m ${sec.toString().padStart(2, "0")}s`;
	return `${sec}s`;
}

const k = (n: number): string => (n < 1000 ? `${n}` : `${Math.round(n / 1000)}k`);

function fmtTok(t: TokenSnapshot): string {
	return `↑${k(t.input)} ↓${k(t.output)}`;
}

function fmtCache(t: TokenSnapshot): string {
	const d = t.input + t.cacheRead;
	return d === 0 ? "—" : `${Math.round((t.cacheRead / d) * 100)}%`;
}

function fmtCost(t: TokenSnapshot): string {
	return t.cost < 0.01 ? `$${t.cost.toFixed(3)}` : `$${t.cost.toFixed(2)}`;
}

function padR(s: string, w: number): string {
	return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

function padL(s: string, w: number): string {
	return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

function addTokens(a: TokenSnapshot, b: TokenSnapshot): TokenSnapshot {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		cost: a.cost + b.cost,
		turns: a.turns + b.turns,
	};
}

const ZERO: TokenSnapshot = {
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
	totalTokens: 0, cost: 0, turns: 0,
};

// ─── Get per-agent token splits ─────────────────────────────────────────────

function getWorkerTokens(
	agentId: string,
	state: TmuxAgentState,
	ledger?: UsageLedger,
): TokenSnapshot {
	if (!ledger) return state.tokens;
	const { bySource } = ledger.snapshot();
	return bySource.get(`agent:${agentId}`) ?? state.tokens;
}

function getLensTokens(
	agentId: string,
	ledger?: UsageLedger,
): TokenSnapshot {
	if (!ledger) return ZERO;
	const { bySource } = ledger.snapshot();
	let result = { ...ZERO };
	for (const [key, snap] of bySource) {
		if (key.startsWith(`lens:${agentId}:`)) {
			result = addTokens(result, snap);
		}
	}
	return result;
}

// ─── Format findings line ───────────────────────────────────────────────────

function fmtLensLine(r: LensRunRecord): string {
	const lens = padR(r.lens, 10);
	let findingsText: string;
	if (r.findings === 0) {
		findingsText = "0 findings";
	} else {
		const fixedPart = r.fixed > 0 ? ` → ${r.fixed} fixed` : "";
		findingsText = `${r.findings} finding${r.findings > 1 ? "s" : ""}${fixedPart}`;
	}
	const modelPart = r.model
		? `  ${r.model}${r.effort ? ` (${r.effort})` : ""}`
		: "";
	return `       ${lens}${padR(findingsText, 22)}${modelPart}`;
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
	const div = "─".repeat(W);

	const hdr = `─── Execution ${headerStatus} (${finished}/${total} done${failedSuffix}) `;
	lines.push(hdr + "─".repeat(Math.max(0, W - hdr.length)));
	lines.push("");

	// ─── Section 1: Details per agent ─────────────────────────────────────
	for (const [id, agent] of agents) {
		const icon =
			agent.status === "done" ? "✓" :
			agent.status === "failed" ? "✗" :
			agent.status === "working" ? "▶" :
			agent.status === "awaiting-decision" ? "❓" : "○";

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
		if (agent.lensResults.length > 0) {
			lines.push("     Lenses:");
			for (const r of agent.lensResults) {
				lines.push(fmtLensLine(r));
			}
		}
		lines.push("");
	}

	// ─── Section 2: Stats table ───────────────────────────────────────────
	lines.push(div);

	const nameW = 36;
	const tokW = 14;
	const cacheW = 8;
	const costW = 8;
	const timeW = 8;
	const subDiv = "─".repeat(nameW + tokW + cacheW + costW + timeW);

	lines.push(
		padR("", nameW) +
		padL("tokens", tokW) +
		padL("cache", cacheW) +
		padL("cost", costW) +
		padL("time", timeW),
	);

	let grandTotal = { ...ZERO };
	const wallClock = now - earliest;

	for (const [id, agent] of agents) {
		const workerTok = getWorkerTokens(id, agent, ledger);
		const lensTok = getLensTokens(id, ledger);
		const subtotal = addTokens(workerTok, lensTok);
		grandTotal = addTokens(grandTotal, subtotal);
		const elapsed = now - agent.startedAt;

		// Agent name header
		lines.push(`  ${agent.agentName}`);

		// Worker row
		lines.push(
			padR("    worker", nameW) +
			padL(fmtTok(workerTok), tokW) +
			padL(fmtCache(workerTok), cacheW) +
			padL(fmtCost(workerTok), costW) +
			padL("", timeW),
		);

		// Lenses row
		if (agent.lensResults.length > 0) {
			lines.push(
				padR(`    lenses (${agent.lensResults.length} runs)`, nameW) +
				padL(fmtTok(lensTok), tokW) +
				padL(fmtCache(lensTok), cacheW) +
				padL(fmtCost(lensTok), costW) +
				padL("", timeW),
			);
		}

		// Subtotal
		lines.push(`    ${subDiv.slice(0, nameW + tokW + cacheW + costW + timeW - 4)}`);
		lines.push(
			padR("    subtotal", nameW) +
			padL(fmtTok(subtotal), tokW) +
			padL(fmtCache(subtotal), cacheW) +
			padL(fmtCost(subtotal), costW) +
			padL(fmtDur(elapsed), timeW),
		);
		lines.push("");
	}

	// Grand total
	lines.push(div);
	lines.push(
		padR("  Total", nameW) +
		padL(fmtTok(grandTotal), tokW) +
		padL(fmtCache(grandTotal), cacheW) +
		padL(fmtCost(grandTotal), costW) +
		padL(fmtDur(wallClock), timeW),
	);
	lines.push(div);

	return lines.join("\n");
}
