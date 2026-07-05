import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * One styled-vs-visible pair for a right-side footer segment. `visible` is
 * the unstyled text used for width math; `styled` is the ANSI-coded form
 * actually emitted to the terminal.
 */
export interface FooterRightCandidate {
	readonly visible: string;
	readonly styled: string;
}

/**
 * Compose a single-line `left ⟨gap⟩ right` footer that never exceeds
 * `width`. Right-side candidates are tried in order from richest to
 * sparsest; the first one that fits with at least one column for the gap
 * is chosen. If nothing fits, the line is truncated as a final safety net.
 */
export function composeFooterLine(
	leftText: string,
	rightCandidates: FooterRightCandidate[],
	width: number,
): string {
	if (width <= 0) return "";

	// Empty sentinel guarantees at least one fitting candidate.
	const candidates: FooterRightCandidate[] = [
		...rightCandidates,
		{ visible: "", styled: "" },
	];

	let chosen = candidates[candidates.length - 1] as FooterRightCandidate;
	for (const cand of candidates) {
		const cw = visibleWidth(cand.visible);
		if (cw === 0 || cw + 1 <= width) {
			chosen = cand;
			break;
		}
	}

	const rightWidth = visibleWidth(chosen.visible);
	const safeLeft = truncateToWidth(
		leftText,
		Math.max(0, width - rightWidth - (rightWidth === 0 ? 0 : 1)),
	);
	const leftWidth = visibleWidth(safeLeft);
	const gap =
		rightWidth === 0 ? 0 : Math.max(1, width - leftWidth - rightWidth);

	const line = safeLeft + " ".repeat(gap) + chosen.styled;
	return truncateToWidth(line, width);
}
