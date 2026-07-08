// Shorthand reply grammar and the ◆ decision-block parser — plus the
// engine path where a typed `2` settles the pending widget.

import { CAPABILITIES } from "@vegardx/pi-contracts";
import { registerCapability } from "@vegardx/pi-core";
import { afterEach, describe, expect, it } from "vitest";
import { AskEngine } from "../packages/ask/src/engine.js";
import {
	type DecisionPoint,
	parseDecisionBlock,
	parseShorthand,
} from "../packages/ask/src/shorthand.js";

const single: DecisionPoint[] = [
	{
		id: "storage",
		title: "Storage backend",
		options: ["SQLite", "JSONL", "in-memory"],
		recommended: 0,
	},
];

const multi: DecisionPoint[] = [
	...single,
	{ id: "reports", title: "Reports in git", options: ["commit", "ignore"] },
];

describe("parseShorthand", () => {
	it("bare number or letter picks from a single decision", () => {
		expect(parseShorthand("2", single)?.answers).toEqual([
			{ questionId: "storage", value: "JSONL" },
		]);
		expect(parseShorthand("b", single)?.answers).toEqual([
			{ questionId: "storage", value: "JSONL" },
		]);
	});

	it("rec takes every recommendation that exists", () => {
		const match = parseShorthand("rec", multi);
		expect(match?.answers).toEqual([
			{ questionId: "storage", value: "SQLite" },
		]);
	});

	it("q+letter tokens answer several decisions", () => {
		const match = parseShorthand("1c 2b", multi);
		expect(match?.answers).toEqual([
			{ questionId: "storage", value: "in-memory" },
			{ questionId: "reports", value: "ignore" },
		]);
	});

	it("keeps a trailer and exposes the expansion", () => {
		const match = parseShorthand("2 but use WAL mode", single);
		expect(match?.answers[0].value).toBe("JSONL");
		expect(match?.trailer).toBe("but use WAL mode");
		expect(match?.expansion).toContain("Storage backend → JSONL");
		expect(match?.expansion).toContain("but use WAL mode");
	});

	it("rejects non-shorthand text", () => {
		expect(parseShorthand("what about redis?", single)).toBeUndefined();
		expect(parseShorthand("9", single)).toBeUndefined(); // out of range
		expect(parseShorthand("z", single)).toBeUndefined();
		expect(parseShorthand("2", multi)).toBeUndefined(); // ambiguous
		expect(parseShorthand("rec", [multi[1]])).toBeUndefined(); // no rec
		expect(parseShorthand("", single)).toBeUndefined();
	});

	it("rejects one accidental token followed by an essay", () => {
		expect(
			parseShorthand(
				"2 hours later the whole thing fell over in production again",
				single,
			),
		).toBeUndefined();
	});
});

describe("parseDecisionBlock", () => {
	const block = [
		"Some intro prose.",
		"",
		"◆ Where I need your direction",
		"",
		"  1. Storage for run history",
		"     Affects the dashboard.",
		"       a. SQLite via bun:sqlite — durable, queryable   ← rec",
		"       b. JSONL append log — zero deps",
		"",
		"  2. Reports in git?",
		"       a. Commit them",
		"       b. gitignore research/                          ← rec",
		"",
		"  Reply `1a 2b`, `rec`, or just talk to me.",
	].join("\n");

	it("extracts ordered points with options and recommendations", () => {
		const points = parseDecisionBlock(block);
		expect(points).toHaveLength(2);
		expect(points[0].title).toBe("Storage for run history");
		expect(points[0].options).toEqual([
			"SQLite via bun:sqlite",
			"JSONL append log",
		]);
		expect(points[0].recommended).toBe(0);
		expect(points[1].options).toEqual(["Commit them", "gitignore research/"]);
		expect(points[1].recommended).toBe(1);
	});

	it("round-trips with the shorthand parser", () => {
		const points = parseDecisionBlock(block);
		const match = parseShorthand("1a 2b", points);
		expect(match?.expansion).toContain("SQLite via bun:sqlite");
		expect(match?.expansion).toContain("gitignore research/");
	});

	it("returns [] without a block", () => {
		expect(parseDecisionBlock("plain answer, no decisions")).toEqual([]);
	});
});

describe("AskEngine.applyShorthand", () => {
	let dispose: (() => void) | undefined;
	afterEach(() => {
		dispose?.();
		dispose = undefined;
	});

	it("settles pending questions and delivers answers plus trailer", () => {
		const mounted = new Map<string, unknown>();
		dispose = registerCapability(CAPABILITIES.overlays, {
			mount: (id: string, c: unknown) => mounted.set(id, c),
			unmount: (id: string) => mounted.delete(id),
			focusOverlay: () => {},
			focusInput: () => {},
			blockInput: () => {},
			unblockInput: () => {},
			isInputBlocked: false,
		} as never);
		const delivered: string[] = [];
		const engine = new AskEngine();
		engine.setContext({ hasUI: true, ui: {} } as never);
		engine.setDeliver((t) => delivered.push(t));
		engine.post([
			{
				id: "tier",
				question: "Pick a tier",
				options: [{ label: "fast" }, { label: "deep" }],
			},
		]);

		expect(engine.applyShorthand("what do you think?")).toBe(false);
		expect(engine.applyShorthand("2 and explain the cost")).toBe(true);
		expect(engine.pending()).toEqual([]);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toContain("deep");
		expect(delivered[0]).toContain("The user adds: and explain the cost");
	});
});
