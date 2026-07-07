import { homedir } from "node:os";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { ModeName } from "@vegardx/pi-contracts";
import { composeFooterLine, type FooterRightCandidate } from "./footer.js";
import type { UsageLedger } from "./usage-ledger.js";

// ─── Formatting helpers ──────────────────────────────────────────────────────

const k = (n: number): string => {
	if (n < 1000) return `${n}`;
	return `${Math.round(n / 1000)}k`;
};

/**
 * Session-wide input/output token totals.
 * Format: "↑124k ↓45k"
 */
export function formatSessionUsage(ledger: UsageLedger): string | null {
	const { totals } = ledger.snapshot();
	if (totals.totalTokens === 0) return null;
	return `↑${k(totals.input)} ↓${k(totals.output)}`;
}

/**
 * Average cache hit rate across all sources with traffic.
 * Per-source rate: cacheRead / (input + cacheRead), then averaged.
 * Format: "CH 78%"
 */
export function formatCacheHitRate(ledger: UsageLedger): string | null {
	const { bySource } = ledger.snapshot();
	let sum = 0;
	let count = 0;
	for (const snap of bySource.values()) {
		const denominator = snap.input + snap.cacheRead;
		if (denominator === 0) continue;
		sum += snap.cacheRead / denominator;
		count++;
	}
	if (count === 0) return null;
	const avg = Math.round((sum / count) * 100);
	return `CH ${avg}%`;
}

/**
 * Model display label: strip "claude " prefix, drop trailing parentheticals,
 * append thinking level if not "off".
 */
export function formatModelLabel(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): string | null {
	const model = ctx.model;
	if (!model) return null;

	let label = (model.name ?? model.id ?? "").trim();
	if (!label) return null;

	label = label
		.replace(/^claude\s+/i, "")
		.replace(/\s*\([^)]*\)\s*$/, "")
		.trim();
	if (!label) return null;

	let thinking: string | undefined;
	try {
		thinking = pi.getThinkingLevel();
	} catch {
		thinking = undefined;
	}
	if (thinking && thinking !== "off") {
		label = `${label} (${thinking})`;
	}
	return label;
}

// ─── Live agent strip ────────────────────────────────────────────────────────

/** One live agent's view for the footer strip (ExecutionHandle.snapshot()). */
export interface AgentStripAgent {
	readonly status: string;
	readonly tokens: {
		readonly input: number;
		readonly output: number;
		readonly turns: number;
	};
	readonly cacheRatio?: number;
}

/** Cap on per-agent strip lines; overflow collapses into "(+N more)". */
export const AGENT_STRIP_MAX_LINES = 4;

/**
 * One compact line per ACTIVE (working/summarizing) agent:
 * "● <group> <agent> <in>k/<out>k <cache%>". At most
 * {@link AGENT_STRIP_MAX_LINES} lines plus a "(+N more)" overflow line;
 * empty when no agents are active.
 */
export function buildAgentStripLines(
	agents: ReadonlyMap<string, AgentStripAgent> | undefined,
): string[] {
	if (!agents) return [];
	const active: string[] = [];
	for (const [key, agent] of agents) {
		if (agent.status !== "working" && agent.status !== "summarizing") continue;
		const [group = "", name = key] = key.split("/");
		const cache =
			agent.cacheRatio !== undefined
				? ` ${Math.round(agent.cacheRatio * 100)}%`
				: "";
		active.push(
			`● ${group} ${name} ${k(agent.tokens.input)}/${k(agent.tokens.output)}${cache}`,
		);
	}
	if (active.length <= AGENT_STRIP_MAX_LINES) return active;
	return [
		...active.slice(0, AGENT_STRIP_MAX_LINES),
		`  (+${active.length - AGENT_STRIP_MAX_LINES} more)`,
	];
}

// ─── Footer installer ────────────────────────────────────────────────────────

const MODE_COLOR: Record<ModeName, ThemeColor> = {
	plan: "warning",
	auto: "accent",
	hack: "error",
	agent: "muted",
};

export interface FooterDeps {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionContext;
	readonly getMode: () => ModeName;
	readonly getLedger: () => UsageLedger;
	readonly getAgentStatus: () =>
		| { done: number; total: number; failed: number }
		| undefined;
	readonly getPendingQuestions: () => number;
	/** Live agent snapshots for the per-agent strip below the footer line. */
	readonly getActiveAgents?: () =>
		| ReadonlyMap<string, AgentStripAgent>
		| undefined;
}

/**
 * Install a custom footer via `ctx.ui.setFooter()`. Returns an `invalidate`
 * handle the caller can invoke when mode/usage/plan state changes.
 */
export function installFooter(deps: FooterDeps): (() => void) | undefined {
	const {
		pi,
		ctx,
		getMode,
		getLedger,
		getAgentStatus,
		getPendingQuestions,
		getActiveAgents,
	} = deps;
	if (!ctx.hasUI || !ctx.ui.setFooter) return undefined;

	const home = homedir();
	const cwd = ctx.cwd ?? "";
	let tui: TUI | undefined;

	ctx.ui.setFooter(
		(tuiHandle: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
			tui = tuiHandle;

			return {
				invalidate() {
					tuiHandle.requestRender();
				},

				render(width: number): string[] {
					const mode = getMode();
					const branch = footerData.getGitBranch();
					const statuses = footerData.getExtensionStatuses();
					const agents = getAgentStatus();
					const questions = getPendingQuestions();

					// ── Left side ──────────────────────────────────────────
					const leftParts: string[] = [];
					const shortPath = cwd.startsWith(home)
						? `~${cwd.slice(home.length)}`
						: cwd;
					const location = branch ? `${shortPath} (${branch})` : shortPath;
					leftParts.push(theme.fg("muted", location));

					if (agents && agents.total > 0) {
						let agentLabel = `Agents: ${agents.done}/${agents.total}`;
						if (agents.failed > 0) {
							agentLabel += ` (${agents.failed} failed)`;
						}
						const color = agents.failed > 0 ? "error" : "muted";
						leftParts.push(theme.fg(color, agentLabel));
					}
					if (questions > 0) {
						leftParts.push(theme.fg("accent", `Questions: ${questions}`));
					}

					for (const [, val] of statuses) leftParts.push(val);

					const leftText = leftParts.join("  ");

					// ── Right side (priority chain: first to drop → last) ─
					const ledger = getLedger();
					const usageLabel = formatSessionUsage(ledger);
					const cacheLabel = formatCacheHitRate(ledger);
					const modelLabel = formatModelLabel(ctx, pi);
					const modeLabel = theme.bold(
						theme.fg(MODE_COLOR[mode] ?? "muted", mode),
					);
					const modeLabelVisible = mode;

					const sep = theme.fg("muted", " | ");
					const sepVisible = " | ";

					const candidates: FooterRightCandidate[] = [];

					// Full: "↑124k ↓45k | CH 78% | Sonnet 4 (high) | auto"
					{
						const parts: string[] = [];
						const vis: string[] = [];
						if (usageLabel) {
							parts.push(theme.fg("muted", usageLabel));
							vis.push(usageLabel);
						}
						if (cacheLabel) {
							parts.push(theme.fg("muted", cacheLabel));
							vis.push(cacheLabel);
						}
						if (modelLabel) {
							parts.push(theme.fg("muted", modelLabel));
							vis.push(modelLabel);
						}
						parts.push(modeLabel);
						vis.push(modeLabelVisible);
						candidates.push({
							styled: parts.join(sep),
							visible: vis.join(sepVisible),
						});
					}

					// Drop token usage
					if (usageLabel) {
						const parts: string[] = [];
						const vis: string[] = [];
						if (cacheLabel) {
							parts.push(theme.fg("muted", cacheLabel));
							vis.push(cacheLabel);
						}
						if (modelLabel) {
							parts.push(theme.fg("muted", modelLabel));
							vis.push(modelLabel);
						}
						parts.push(modeLabel);
						vis.push(modeLabelVisible);
						candidates.push({
							styled: parts.join(sep),
							visible: vis.join(sepVisible),
						});
					}

					// Drop cache hit
					if (modelLabel) {
						const parts: string[] = [];
						const vis: string[] = [];
						parts.push(theme.fg("muted", modelLabel));
						vis.push(modelLabel);
						parts.push(modeLabel);
						vis.push(modeLabelVisible);
						candidates.push({
							styled: parts.join(sep),
							visible: vis.join(sepVisible),
						});
					}

					// Slim: just mode
					candidates.push({ styled: modeLabel, visible: modeLabelVisible });

					const mainLine = composeFooterLine(leftText, candidates, width);

					// Live agent strip: one line per active agent, below the
					// footer line. No agents active → no strip.
					const strip = buildAgentStripLines(getActiveAgents?.());
					if (strip.length === 0) return [mainLine];
					return [
						mainLine,
						...strip.map((line) =>
							truncateToWidth(
								line.startsWith("●")
									? theme.fg("accent", "●") + theme.fg("muted", line.slice(1))
									: theme.fg("dim", line),
								width,
							),
						),
					];
				},
			};
		},
	);

	// Return invalidation handle
	return () => {
		tui?.requestRender();
	};
}
