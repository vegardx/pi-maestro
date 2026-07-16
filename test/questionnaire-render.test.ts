// The questionnaire's two render tiers: the responsive panel (two-column at
// comfortable widths) and the full-screen explorer (page-per-option with a
// compare matrix) — plus the component key flow that drives them. Default
// palette is identity, so assertions run on plain strings.

import { visibleWidth } from "@earendil-works/pi-tui";
import type { Answers, Question } from "@vegardx/pi-contracts";
import {
	CollapsibleQuestionnaireComponent,
	initExplorerView,
	initQuestionnaireState,
	isExplorerQuestion,
	QuestionnaireComponent,
	renderCompareMatrix,
	renderExplorer,
	renderQuestionnaire,
	renderRichText,
} from "@vegardx/pi-ui";
import { describe, expect, it, vi } from "vitest";
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

describe("review confirmation", () => {
	it("shows boxed Edit/Send actions, defaults to Send, and has no recommendation shortcut", () => {
		let answers: Answers | undefined;
		const c = new QuestionnaireComponent(
			[panelQ],
			(value) => {
				answers = value;
			},
			{ recipient: "maestro" },
		);
		c.handleInput(ENTER); // recommended SQLite → review
		const review = c.render(100).join("\n");
		expect(review).toContain("Review answers");
		expect(review).toContain("Confirm what will be sent to maestro");
		expect(review).toContain("[ Edit answers ]");
		expect(review).toContain("› [ Send answer ]");
		expect(review).not.toContain("accept recommended");
		expect(answers).toBeUndefined();
		c.handleInput(ENTER);
		expect(answers).toEqual([{ questionId: "storage", value: "SQLite" }]);
	});

	it("Esc from review returns to editing instead of cancelling", () => {
		const done = vi.fn();
		const c = new QuestionnaireComponent([panelQ], done);
		c.handleInput(ENTER);
		c.handleInput("\u001b");
		expect(done).not.toHaveBeenCalled();
		expect(c.render(100).join("\n")).toContain("Which storage backend?");
		c.handleInput("2");
		c.handleInput(ENTER);
		c.handleInput(ENTER);
		expect(done).toHaveBeenCalledWith([
			{ questionId: "storage", value: "JSONL log" },
		]);
	});

	it("Edit action restores a custom answer", () => {
		const c = new QuestionnaireComponent([panelQ], () => {});
		c.handleInput("3"); // free-text row
		for (const ch of "Postgres") c.handleInput(ch);
		c.handleInput(ENTER); // review
		c.handleInput("\u001b"); // edit
		expect(c.render(100).join("\n")).toContain("Postgres▌");
	});

	it("editing an upstream conditional answer removes stale downstream answers", () => {
		const q: Question[] = [
			{
				id: "mode",
				question: "Mode?",
				options: [{ label: "advanced" }, { label: "simple" }],
			},
			{
				id: "detail",
				question: "Detail?",
				options: [{ label: "verbose" }],
				showIf: { questionId: "mode", choice: "advanced" },
			},
		];
		let answers: Answers | undefined;
		const c = new QuestionnaireComponent(q, (value) => {
			answers = value;
		});
		c.handleInput(ENTER); // advanced
		c.handleInput(ENTER); // verbose → review
		c.handleInput("\u001b"); // edit from first question
		c.handleInput("2"); // simple
		c.handleInput(ENTER); // detail hidden → review
		c.handleInput(ENTER); // send
		expect(answers).toEqual([
			{ questionId: "mode", value: "simple" },
			{ questionId: "detail", value: "", skipped: true },
		]);
	});
});

describe("collapsed badge width (regression: ESC-defer crash)", () => {
	// The deferred badge carries ⛔ (U+26D4), a 2-column emoji whose JS .length
	// is 1. Sizing the border with .length made it one column too wide and
	// crashed the TUI. Every collapsed line must measure ≤ width in DISPLAY
	// columns, including when a deferred count shows the emoji.
	function collapsed(width: number, deferred: number): string[] {
		const comp = new CollapsibleQuestionnaireComponent([panelQ], () => {}, {
			palette: defaultPalette(),
			badge: () => ({ pending: 2, deferred }),
		});
		comp.focused = true;
		comp.expanded = false; // collapsed = the badge line
		return comp.render(width);
	}

	it("keeps every collapsed line within the terminal width, with ⛔", () => {
		for (const width of [40, 60, 80, 88, 120]) {
			for (const deferred of [0, 1, 12]) {
				for (const line of collapsed(width, deferred)) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	it("shows the deferred ⛔ badge when a question was deferred", () => {
		expect(collapsed(88, 3).join("\n")).toContain("⛔");
	});
});

describe("renderRichText (structured question context)", () => {
	const p = defaultPalette(); // identity palette → assert on plain text

	it("keeps paragraphs separate instead of flattening to one block", () => {
		const lines = renderRichText("First para.\n\nSecond para.", 40, p);
		expect(lines).toEqual(["First para.", "", "Second para."]);
	});

	it("renders bullets with a • glyph and hanging indent", () => {
		const lines = renderRichText(
			"- S3 + CloudFront — private origin with OAC is the production default here",
			30,
			p,
		);
		expect(lines[0].startsWith("• ")).toBe(true);
		expect(lines.length).toBeGreaterThan(1); // wrapped
		expect(lines[1].startsWith("  ")).toBe(true); // continuation indented
	});

	it("promotes a **Heading:** lead onto its own line, bullets under it", () => {
		const lines = renderRichText(
			"**Open risks:**\n- generic\n- pricing varies",
			60,
			p,
		);
		expect(lines[0]).toBe("Open risks"); // colon + ** stripped
		expect(lines[1]).toBe("• generic");
		expect(lines[2]).toBe("• pricing varies");
	});

	it("strips inline **bold** markers and stays within width", () => {
		const lines = renderRichText("use **OAC** always and never go wide", 12, p);
		for (const l of lines) expect(l.length).toBeLessThanOrEqual(12);
		expect(lines.join(" ")).not.toContain("**");
		expect(lines.join(" ")).toContain("OAC");
	});
});

describe("unbreakable-word width (regression: renderer crash)", () => {
	// A single word wider than the box (a slash-joined component list, a long
	// path, a URL) cannot wrap at whitespace. Emitting it whole overflowed the
	// box border and crashed pi ("Rendered line 1100 exceeds terminal width").
	const LONG =
		"Text/Box/Container/SelectList/SettingsList/TreeSelectorComponent/Markdown/Loader/DynamicBorder";

	it("hard-breaks long words in renderRichText bullets", () => {
		const p = defaultPalette();
		const lines = renderRichText(`- taxonomy: (${LONG} + helpers)`, 60, p);
		for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
		// Nothing lost: the pieces reassemble the word.
		expect(lines.join("").replace(/[•\s]/g, "")).toContain("DynamicBorder");
	});

	it("keeps every panel line within width when a description has a long word", () => {
		const q: Question = {
			id: "w",
			question: "pick",
			options: [{ label: "a", description: `wraps ${LONG} fine` }],
		};
		const width = 88;
		const lines = renderQuestionnaire([q], initQuestionnaireState(), width, {
			palette: defaultPalette(),
		});
		for (const line of lines)
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it("keeps every explorer line within width when a body has a long word", () => {
		const q: Question = {
			id: "w",
			question: "pick",
			options: [
				{
					label: "a",
					body: `the ${LONG} taxonomy`,
					dimensions: { effort: "S" },
				},
			],
		};
		const width = 88;
		const lines = renderExplorer(
			[q],
			initQuestionnaireState(),
			initExplorerView(),
			width,
			{ palette: defaultPalette() },
		);
		for (const line of lines)
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});
});

describe("SS3 arrows (application-cursor mode, e.g. outside tmux)", () => {
	// DECCKM terminals send arrows as ESC O B rather than ESC [ B; pi forwards
	// raw bytes, so the component must accept both forms.
	const SS3_DOWN = "\u001bOB";

	it("navigates options with SS3 arrows", () => {
		const c = new QuestionnaireComponent([panelQ], () => {});
		c.handleInput(SS3_DOWN);
		const text = c.render(60).join(String.fromCharCode(10));
		expect(text).toContain("› 2. JSONL log");
	});
});
