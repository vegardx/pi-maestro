// The questionnaire's two render tiers: the responsive panel (two-column at
// comfortable widths) and the full-screen explorer (page-per-option with a
// compare matrix) — plus the component key flow that drives them. Default
// palette is identity, so assertions run on plain strings.

import type { Answers, Question } from "@vegardx/pi-contracts";
import {
	initExplorerView,
	initQuestionnaireState,
	isExplorerQuestion,
	QuestionnaireComponent,
	renderCompareMatrix,
	renderExplorer,
	renderQuestionnaire,
} from "@vegardx/pi-ui";
import { describe, expect, it } from "vitest";
import { defaultPalette } from "../packages/ui/src/format.js";

const ENTER = "\r";
const RIGHT = "[C";
const DOWN = "[B";

const panelQ: Question = {
	id: "storage",
	question: "Which storage backend?",
	options: [
		{
			label: "SQLite",
			description: "Durable and queryable.",
			preview: "The slowest-agents view becomes one SQL query.",
		},
		{ label: "JSONL log", description: "Zero deps." },
	],
	recommendation: "SQLite",
};

const explorerQ: Question = {
	id: "transport",
	question: "How should agent output stream?",
	options: [
		{
			label: "Socket RPC",
			body: "Extend the per-agent unix socket with a stream message kind.",
			tradeoffs: {
				pros: ["reuses packages/rpc", "typed end to end"],
				cons: ["protocol bump"],
			},
			sketch: "agent ──socket──▶ maestro",
			touches: ["packages/rpc/src/server.ts"],
			dimensions: { latency: "instant", effort: "M" },
		},
		{
			label: "File tailing",
			body: "Tail a per-agent log file.",
			dimensions: { latency: "~1s poll", effort: "S" },
		},
	],
	recommendation: "Socket RPC",
};

describe("panel layout", () => {
	it("goes two-column when wide: options left, detail right", () => {
		const lines = renderQuestionnaire([panelQ], initQuestionnaireState(), 160);
		const text = lines.join("\n");
		expect(text).toContain("┃");
		// Highlighted option's description lands in the right pane...
		expect(text).toContain("Durable and queryable.");
		expect(text).toContain("one SQL query");
		// ...on the same row band as the option list, not stacked under it.
		const optionRow = lines.find((l) => l.includes("1. SQLite"));
		expect(optionRow).toContain("┃");
	});

	it("stays stacked when narrow", () => {
		const lines = renderQuestionnaire([panelQ], initQuestionnaireState(), 80);
		const text = lines.join("\n");
		expect(text).not.toContain("┃");
		expect(text).toContain("Durable and queryable.");
	});

	it("renders whyBlocking under the question", () => {
		const q: Question = {
			...panelQ,
			blocking: true,
			whyBlocking: "every remaining task writes through this layer",
		};
		const text = renderQuestionnaire([q], initQuestionnaireState(), 120).join(
			"\n",
		);
		expect(text).toContain("⛔ why this blocks:");
		expect(text).toContain("writes through this layer");
	});
});

describe("explorer", () => {
	it("triggers on body or dimensions only", () => {
		expect(isExplorerQuestion(explorerQ)).toBe(true);
		expect(isExplorerQuestion(panelQ)).toBe(false);
	});

	it("renders the option page: tabs, body, tradeoffs, sketch, touches", () => {
		const text = renderExplorer(
			[explorerQ],
			initQuestionnaireState(),
			initExplorerView(),
			110,
		).join("\n");
		expect(text).toContain("▌1 Socket RPC [rec]▐");
		expect(text).toContain("2 File tailing");
		expect(text).toContain("stream message kind");
		expect(text).toContain("+ reuses packages/rpc");
		expect(text).toContain("− protocol bump");
		expect(text).toContain("agent ──socket──▶ maestro");
		expect(text).toContain("Touches  packages/rpc/src/server.ts");
		expect(text).toContain("c compare");
	});

	it("compare matrix lines up dimensions across options", () => {
		const lines = renderCompareMatrix(explorerQ, 0, 100, defaultPalette());
		const text = lines.join("\n");
		expect(text).toContain("latency");
		expect(text).toContain("instant");
		expect(text).toContain("~1s poll");
		expect(text).toContain("effort");
	});

	it("marks absent dimension values with a dash", () => {
		const q: Question = {
			...explorerQ,
			options: [
				explorerQ.options?.[0] as never,
				{ label: "bare", body: "no dims" },
			],
		};
		const text = renderCompareMatrix(q, 0, 100, defaultPalette()).join("\n");
		expect(text).toContain("—");
	});

	it("scrolls long bodies and shows the scroll hint", () => {
		const q: Question = {
			id: "long",
			question: "long body",
			options: [
				{
					label: "a",
					body: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n\n"),
				},
			],
		};
		const top = renderExplorer(
			[q],
			initQuestionnaireState(),
			initExplorerView(),
			110,
		);
		expect(top.join("\n")).toContain("↑/↓ scroll");
		expect(top.join("\n")).toContain("line 0");
		const scrolled = renderExplorer(
			[q],
			initQuestionnaireState(),
			{ compare: false, scroll: 5 },
			110,
		);
		expect(scrolled.join("\n")).not.toContain("line 0");
	});
});

describe("explorer key flow", () => {
	function comp(onDone: (a: Answers | undefined) => void) {
		return new QuestionnaireComponent([explorerQ], onDone);
	}

	it("cycles options with arrows, jumps with digits, chooses with enter", () => {
		let answers: Answers | undefined;
		const c = comp((a) => {
			answers = a;
		});
		c.handleInput(RIGHT); // → File tailing
		expect(c.render(110).join("\n")).toContain("▌2 File tailing▐");
		c.handleInput("1"); // jump back
		expect(c.render(110).join("\n")).toContain("▌1 Socket RPC [rec]▐");
		c.handleInput(RIGHT);
		c.handleInput(ENTER); // choose File tailing, review, send
		c.handleInput(ENTER);
		expect(answers).toEqual([
			{ questionId: "transport", value: "File tailing" },
		]);
	});

	it("c toggles the compare matrix", () => {
		const c = comp(() => {});
		c.handleInput("c");
		const text = c.render(110).join("\n");
		expect(text).toContain("latency");
		expect(text).toContain("c page");
		c.handleInput("c");
		expect(c.render(110).join("\n")).toContain("c compare");
	});

	it("o opens a free-text counter-proposal committed on enter", () => {
		let answers: Answers | undefined;
		const c = comp((a) => {
			answers = a;
		});
		c.handleInput("o");
		for (const ch of "do both") c.handleInput(ch);
		expect(c.render(110).join("\n")).toContain("propose: do both▌");
		c.handleInput(ENTER);
		c.handleInput(ENTER); // review → send
		expect(answers).toEqual([
			{ questionId: "transport", value: "do both", custom: true },
		]);
	});

	it("down scrolls the page body", () => {
		const q: Question = {
			id: "long",
			question: "long",
			options: [
				{
					label: "a",
					body: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n\n"),
				},
			],
		};
		const c = new QuestionnaireComponent([q], () => {});
		expect(c.render(110).join("\n")).toContain("line 0");
		for (let i = 0; i < 6; i++) c.handleInput(DOWN);
		expect(c.render(110).join("\n")).not.toContain("line 0");
	});
});
