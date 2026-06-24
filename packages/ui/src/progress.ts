// Progress bar + spinner primitives. Pure string output for snapshot tests.

import { defaultPalette, type Palette } from "./format.js";

export const SPINNER_FRAMES = [
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏",
];

export function spinnerFrame(tick: number): string {
	return SPINNER_FRAMES[
		((tick % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) %
			SPINNER_FRAMES.length
	];
}

export interface ProgressBarOptions {
	palette?: Palette;
	/** Include a trailing " NN%" label. Default true. */
	showPercent?: boolean;
	filledChar?: string;
	emptyChar?: string;
}

/**
 * Render a single-line progress bar at the given total width. The bar fills the
 * width minus the optional percent label; fraction is clamped to [0, 1].
 */
export function renderProgressBar(
	fraction: number,
	width: number,
	opts: ProgressBarOptions = {},
): string {
	const palette = opts.palette ?? defaultPalette();
	const showPercent = opts.showPercent ?? true;
	const filledChar = opts.filledChar ?? "█";
	const emptyChar = opts.emptyChar ?? "░";
	const clamped = Number.isFinite(fraction)
		? Math.min(1, Math.max(0, fraction))
		: 0;
	const pct = Math.round(clamped * 100);
	const label = showPercent ? ` ${String(pct).padStart(3)}%` : "";
	const barWidth = Math.max(0, width - label.length);
	const filled = Math.round(clamped * barWidth);
	const bar =
		palette.accent(filledChar.repeat(filled)) +
		palette.dim(emptyChar.repeat(Math.max(0, barWidth - filled)));
	return showPercent ? bar + palette.muted(label) : bar;
}
