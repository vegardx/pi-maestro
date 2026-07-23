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
	return `↑${k(totals.promptTokens)} ↓${k(totals.output)}`;
}

/**
 * Token-weighted fleet cache hit rate: ΣcacheRead / ΣpromptTokens.
 * Cache writes are prompt misses and therefore remain in the denominator.
 * Format: "CH 78%"
 */
export function formatCacheHitRate(ledger: UsageLedger): string | null {
	const { totals } = ledger.snapshot();
	if (totals.promptTokens === 0) return null;
	return `CH ${Math.round((totals.cacheRead / totals.promptTokens) * 100)}%`;
}

/**
 * The maestro's OWN context fill: tokens/window (e.g. "84k/200k"), distinct
 * from the ledger's fleet-wide ↑/↓ totals. Sourced from ctx.getContextUsage()
 * — the same compaction-aware estimate pi's native footer uses; tokens are
 * unknown right after a compaction, shown as "?/200k". The color escalates
 * muted → warning (>70%) → error (>90%) as compaction approaches.
 */
export function formatContextUsage(
	ctx: ExtensionContext,
): { visible: string; color: ThemeColor } | null {
	const usage = ctx.getContextUsage?.();
	if (!usage?.contextWindow) return null;
	const max = k(usage.contextWindow);
	if (usage.tokens === null) return { visible: `?/${max}`, color: "muted" };
	const pct = usage.percent ?? (usage.tokens / usage.contextWindow) * 100;
	const color: ThemeColor = pct > 90 ? "error" : pct > 70 ? "warning" : "muted";
	return { visible: `${k(usage.tokens)}/${max}`, color };
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
	recon: "success",
	plan: "warning",
	auto: "accent",
	hack: "error",
	agent: "muted",
};

/** The seat's resolved identity for the footer (all optional; segments omit). */
export interface ResolvedIdentity {
	/** The alias the seat model maps to (families lookup), else undefined. */
	readonly alias?: string;
	/** The seat's gateway provider (the prefix of provider/model). */
	readonly provider?: string;
	/** The active region name, else undefined to omit the segment. */
	readonly region?: string;
}

export interface FooterDeps {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionContext;
	readonly getMode: () => ModeName;
	readonly getLedger: () => UsageLedger;
	readonly getPendingQuestions: () => number;
	/** Resolved seat identity (alias / gateway / region), or undefined to omit. */
	readonly getResolvedIdentity?: () => ResolvedIdentity | undefined;
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
		getPendingQuestions,
		getResolvedIdentity,
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
					const questions = getPendingQuestions();

					// ── Left side ──────────────────────────────────────────
					const leftParts: string[] = [];
					if (questions > 0) {
						leftParts.push(theme.fg("accent", `Questions: ${questions}`));
					}
					const shortPath = cwd.startsWith(home)
						? `~${cwd.slice(home.length)}`
						: cwd;
					const location = branch ? `${shortPath} (${branch})` : shortPath;
					leftParts.push(theme.fg("muted", location));

					for (const [, val] of statuses) leftParts.push(val);

					const leftText = leftParts.join("  ");

					// ── Right side (priority chain: first to drop → last) ─
					const ledger = getLedger();
					const usageLabel = formatSessionUsage(ledger);
					const cacheLabel = formatCacheHitRate(ledger);
					const ctxUsage = formatContextUsage(ctx);
					const modelLabel = formatModelLabel(ctx, pi);
					// Resolved identity: the alias the seat maps to (else the raw
					// model label), the gateway in use, and the active region.
					const identity = getResolvedIdentity?.();
					const modelText = identity?.alias ?? modelLabel;
					const modelValue = modelText ? `Model ${modelText}` : null;
					const providerValue = identity?.provider
						? `Provider ${identity.provider}`
						: null;
					const regionName = identity?.region;
					const regionValue = regionName ? `Region ${regionName}` : null;
					const modeLabel = theme.bold(
						theme.fg(MODE_COLOR[mode] ?? "muted", mode),
					);
					const modeLabelVisible = mode;

					const sep = theme.fg("muted", " | ");
					const sepVisible = " | ";

					// A segment: [styled, visible]; assemble candidates by slicing
					// richest → sparsest so each drop step stays consistent.
					type Segment = readonly [string, string];
					const usageSeg: Segment | undefined = usageLabel
						? [theme.fg("muted", usageLabel), usageLabel]
						: undefined;
					const cacheSeg: Segment | undefined = cacheLabel
						? [theme.fg("muted", cacheLabel), cacheLabel]
						: undefined;
					const ctxSeg: Segment | undefined = ctxUsage
						? [theme.fg(ctxUsage.color, ctxUsage.visible), ctxUsage.visible]
						: undefined;
					const modelSeg: Segment | undefined = modelValue
						? [theme.fg("muted", modelValue), modelValue]
						: undefined;
					const providerSeg: Segment | undefined = providerValue
						? [theme.fg("muted", providerValue), providerValue]
						: undefined;
					// Region reads as a warning unless it is the unfiltered "off" —
					// a restricted fleet should be visibly restricted.
					const regionSeg: Segment | undefined = regionValue
						? [
								theme.fg(
									["off", "none"].includes(regionName?.toLowerCase() ?? "")
										? "muted"
										: "warning",
									regionValue,
								),
								regionValue,
							]
						: undefined;
					const modeSeg: Segment = [modeLabel, modeLabelVisible];

					const candidates: FooterRightCandidate[] = [];
					const pushCandidate = (segs: Array<Segment | undefined>): void => {
						const present = segs.filter((s): s is Segment => s !== undefined);
						candidates.push({
							styled: present.map((s) => s[0]).join(sep),
							visible: present.map((s) => s[1]).join(sepVisible),
						});
					};

					// Full: "↑124k ↓45k | CH 78% | 84k/200k | Model Opus 4.8 | Provider github-copilot | Region EEA | plan"
					pushCandidate([
						usageSeg,
						cacheSeg,
						ctxSeg,
						modelSeg,
						providerSeg,
						regionSeg,
						modeSeg,
					]);
					// Drop fleet ↑/↓ totals first — ctx fill predicts compaction and
					// outranks them.
					if (usageSeg)
						pushCandidate([
							cacheSeg,
							ctxSeg,
							modelSeg,
							providerSeg,
							regionSeg,
							modeSeg,
						]);
					// Then cache hit rate
					if (cacheSeg)
						pushCandidate([ctxSeg, modelSeg, providerSeg, regionSeg, modeSeg]);
					// Then the context fill
					if (ctxSeg)
						pushCandidate([modelSeg, providerSeg, regionSeg, modeSeg]);
					// Then region, then provider — the model identity outranks both.
					if (regionSeg) pushCandidate([modelSeg, providerSeg, modeSeg]);
					if (providerSeg) pushCandidate([modelSeg, modeSeg]);
					// Slim: just mode
					pushCandidate([modeSeg]);

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
