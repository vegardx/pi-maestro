// Plan tree widget. Renders a depth-annotated list of deliverables (the modes
// package owns tree-building / ordering rules and flattens its tree into nodes;
// this widget only owns rendering, so pi-ui never depends on modes).

import type { Component } from "@earendil-works/pi-tui";
import type {
	DeliverableSummary,
	WorkItemSummary,
} from "@vegardx/pi-contracts";
import {
	defaultPalette,
	deliverableStatusGlyph,
	deliverableStatusStyle,
	formatCount,
	type Palette,
	truncate,
} from "./format.js";

export interface PlanTreeNode {
	readonly deliverable: DeliverableSummary;
	/** Work items to render beneath the deliverable (when showItems). */
	readonly items?: readonly WorkItemSummary[];
	/** Indentation depth; 0 for roots. */
	readonly depth?: number;
}

export interface PlanTreeOptions {
	palette?: Palette;
	/** Expand work items beneath each deliverable. Default false. */
	showItems?: boolean;
	/** Spaces per depth level. Default 2. */
	indent?: number;
}

const KIND_TAG: Record<WorkItemSummary["kind"], string> = {
	task: "",
	followup: "↪",
	question: "?",
	manual: "☐",
};

function countTasks(items: readonly WorkItemSummary[]): {
	done: number;
	total: number;
} {
	let done = 0;
	let total = 0;
	for (const item of items) {
		if (item.kind !== "task") continue;
		total++;
		if (item.done) done++;
	}
	return { done, total };
}

export function renderPlanTree(
	nodes: readonly PlanTreeNode[],
	width: number,
	opts: PlanTreeOptions = {},
): string[] {
	const palette = opts.palette ?? defaultPalette();
	const indentSize = opts.indent ?? 2;
	const showItems = opts.showItems ?? false;
	const lines: string[] = [];

	for (const node of nodes) {
		const depth = node.depth ?? 0;
		const pad = " ".repeat(depth * indentSize);
		const glyph = deliverableStatusGlyph(node.deliverable.status);
		const style = deliverableStatusStyle(palette, node.deliverable.status);
		const items = node.items ?? [];
		const { done, total } = countTasks(items);
		const badge =
			total > 0 ? ` ${palette.muted(formatCount(done, total))}` : "";
		const lifecycle = node.deliverable.lifecycle
			? `${palette.dim(`[${node.deliverable.lifecycle}] `)}`
			: "";
		const head = `${pad}${style(glyph)} ${lifecycle}${node.deliverable.title}`;
		lines.push(truncate(head, width) + badge);

		if (showItems) {
			const itemPad = " ".repeat((depth + 1) * indentSize);
			for (const item of items) {
				const mark = item.done ? "✓" : "○";
				const tag = KIND_TAG[item.kind];
				const prefix = tag ? `${tag} ` : "";
				const line = `${itemPad}${palette.dim(mark)} ${prefix}${item.title}`;
				lines.push(truncate(line, width));
			}
		}
	}

	return lines;
}

/** Live component wrapper around renderPlanTree. */
export class PlanTreeComponent implements Component {
	private nodes: readonly PlanTreeNode[] = [];

	constructor(private readonly opts: PlanTreeOptions = {}) {}

	setNodes(nodes: readonly PlanTreeNode[]): void {
		this.nodes = nodes;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return renderPlanTree(this.nodes, width, this.opts);
	}
}
