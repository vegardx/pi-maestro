import { homedir } from "node:os";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ModeName } from "@vegardx/pi-contracts";

interface FooterCandidate {
	readonly visible: string;
	readonly styled: string;
}

function compactNumber(value: number): string {
	if (value < 1_000) return `${Math.round(value)}`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

export function contextLabel(
	ctx: ExtensionContext,
): { readonly text: string; readonly color: ThemeColor } | undefined {
	const usage = ctx.getContextUsage?.();
	if (!usage?.contextWindow) return undefined;
	if (usage.tokens === null)
		return { text: `?/${compactNumber(usage.contextWindow)}`, color: "muted" };
	const percent = usage.percent ?? (usage.tokens / usage.contextWindow) * 100;
	return {
		text: `${compactNumber(usage.tokens)}/${compactNumber(usage.contextWindow)}`,
		color: percent > 90 ? "error" : percent > 70 ? "warning" : "muted",
	};
}

function modelLabel(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): string | undefined {
	if (!ctx.model) return undefined;
	let value = (ctx.model.name || ctx.model.id)
		.replace(/^claude\s+/i, "")
		.trim();
	if (!value) return undefined;
	const thinking = pi.getThinkingLevel?.();
	if (thinking && thinking !== "off") value += ` (${thinking})`;
	return value;
}

function compose(
	left: string,
	candidates: readonly FooterCandidate[],
	width: number,
): string {
	if (width <= 0) return "";
	const selected = candidates.find(
		(candidate) => visibleWidth(candidate.visible) + 1 <= width,
	) ?? { visible: "", styled: "" };
	const rightWidth = visibleWidth(selected.visible);
	const clippedLeft = truncateToWidth(
		left,
		Math.max(0, width - rightWidth - (rightWidth > 0 ? 1 : 0)),
	);
	const gap =
		rightWidth > 0
			? Math.max(1, width - visibleWidth(clippedLeft) - rightWidth)
			: 0;
	return truncateToWidth(
		`${clippedLeft}${" ".repeat(gap)}${selected.styled}`,
		width,
	);
}

const MODE_COLOR: Record<ModeName, ThemeColor> = {
	plan: "warning",
	auto: "accent",
	hack: "error",
};

export function installMaestroFooter(options: {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionContext;
	readonly mode: () => ModeName;
}): (() => void) | undefined {
	const { pi, ctx, mode } = options;
	if (!ctx.hasUI || !ctx.ui.setFooter) return undefined;
	let tui: TUI | undefined;
	const cwd = ctx.cwd ?? "";
	const home = homedir();

	ctx.ui.setFooter(
		(tuiHandle: TUI, theme: Theme, data: ReadonlyFooterDataProvider) => {
			tui = tuiHandle;
			return {
				invalidate: () => tuiHandle.requestRender(),
				render: (width: number) => {
					const branch = data.getGitBranch();
					const short = cwd.startsWith(home)
						? `~${cwd.slice(home.length)}`
						: cwd;
					const left = theme.fg(
						"muted",
						branch ? `${short} (${branch})` : short,
					);
					const context = contextLabel(ctx);
					const model = modelLabel(ctx, pi);
					const currentMode = mode();
					type Segment = readonly [styled: string, visible: string];
					const segments: Array<Segment | undefined> = [
						context
							? [theme.fg(context.color, context.text), context.text]
							: undefined,
						model ? [theme.fg("muted", model), model] : undefined,
						[
							theme.bold(theme.fg(MODE_COLOR[currentMode], currentMode)),
							currentMode,
						],
					];
					const present = segments.filter((value): value is Segment => !!value);
					const candidates: FooterCandidate[] = [];
					const push = (chosen: readonly Segment[]) => {
						candidates.push({
							styled: chosen
								.map(([styled]) => styled)
								.join(theme.fg("muted", " | ")),
							visible: chosen.map(([, visible]) => visible).join(" | "),
						});
					};
					push(present);
					let reduced = present;
					if (context) {
						reduced = reduced.filter((segment) => segment[1] !== context.text);
						push(reduced);
					}
					if (model) {
						reduced = reduced.filter((segment) => segment[1] !== model);
						push(reduced);
					}
					return [compose(left, candidates, width)];
				},
			};
		},
	);
	return () => tui?.requestRender();
}
