import { homedir } from "node:os";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
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

// ─── Footer installer ────────────────────────────────────────────────────────

const MODE_COLOR: Record<ModeName, ThemeColor> = {
	plan: "warning",
	auto: "accent",
	hack: "error",
	worker: "muted",
};

export interface FooterDeps {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionContext;
	readonly getMode: () => ModeName;
	readonly getLedger: () => UsageLedger;
	readonly getPlanSlug: () => string | undefined;
}

/**
 * Install a custom footer via `ctx.ui.setFooter()`. Returns an `invalidate`
 * handle the caller can invoke when mode/usage/plan state changes.
 */
export function installFooter(deps: FooterDeps): (() => void) | undefined {
	const { pi, ctx, getMode, getLedger, getPlanSlug } = deps;
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

					// ── Left side ──────────────────────────────────────────
					const leftParts: string[] = [];
					const shortPath = cwd.startsWith(home)
						? `~${cwd.slice(home.length)}`
						: cwd;
					const location = branch ? `${shortPath} (${branch})` : shortPath;
					leftParts.push(theme.fg("muted", location));

					const planSlug = getPlanSlug();
					if (planSlug) {
						leftParts.push(theme.fg("muted", `plan:${planSlug}`));
					}

					for (const [, val] of statuses) leftParts.push(val);

					const leftText = leftParts.join("  ");

					// ── Right side ─────────────────────────────────────────
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

					// Build candidates from richest to sparsest
					const candidates: FooterRightCandidate[] = [];

					// Full: "↑124k ↓45k | CH 78% | Sonnet 4.5 | auto"
					const fullParts: string[] = [];
					const fullVisible: string[] = [];
					if (usageLabel) {
						fullParts.push(theme.fg("muted", usageLabel));
						fullVisible.push(usageLabel);
					}
					if (cacheLabel) {
						fullParts.push(theme.fg("muted", cacheLabel));
						fullVisible.push(cacheLabel);
					}
					if (modelLabel) {
						fullParts.push(theme.fg("muted", modelLabel));
						fullVisible.push(modelLabel);
					}
					fullParts.push(modeLabel);
					fullVisible.push(modeLabelVisible);

					if (fullParts.length > 0) {
						candidates.push({
							styled: fullParts.join(sep),
							visible: fullVisible.join(sepVisible),
						});
					}

					// Medium: "↑124k ↓45k | CH 78% | auto" (drop model)
					if (modelLabel) {
						const medParts: string[] = [];
						const medVisible: string[] = [];
						if (usageLabel) {
							medParts.push(theme.fg("muted", usageLabel));
							medVisible.push(usageLabel);
						}
						if (cacheLabel) {
							medParts.push(theme.fg("muted", cacheLabel));
							medVisible.push(cacheLabel);
						}
						medParts.push(modeLabel);
						medVisible.push(modeLabelVisible);
						candidates.push({
							styled: medParts.join(sep),
							visible: medVisible.join(sepVisible),
						});
					}

					// Slim: just mode
					candidates.push({
						styled: modeLabel,
						visible: modeLabelVisible,
					});

					return [composeFooterLine(leftText, candidates, width)];
				},
			};
		},
	);

	// Return invalidation handle
	return () => {
		tui?.requestRender();
	};
}
