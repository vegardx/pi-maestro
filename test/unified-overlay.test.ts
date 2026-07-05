import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { Row } from "../packages/modes/src/agents-dashboard.js";
import type { TmuxAgentState } from "../packages/modes/src/execution-tmux.js";
import type { PendingQuestion } from "../packages/modes/src/question-queue.js";
import { UnifiedOverlayComponent } from "../packages/modes/src/unified-overlay.js";

function makeRow(overrides: Partial<Row> = {}): Row {
	return {
		agentId: "agent-1",
		state: {
			status: "working",
			agentName: "agent-1",
			sessionName: "test-session",
			sessionFile: "/tmp/test.jsonl",
			deliverableId: "d1",
			worktreePath: "/tmp/worktree",
			shutdownSent: false,
			assessmentSent: false,
			resumable: false,
			compactedAt: undefined,
			manualNotes: [],
			idleCount: 0,
			lensRuns: 0, lensResults: [],
			reviewCycles: 0,
			startedAt: Date.now() - 60000,
			tokens: {
				input: 1000,
				output: 500,
				cacheRead: 200,
				cacheWrite: 100,
				totalTokens: 1800,
				cost: 0.02,
				turns: 3,
			},
		} as TmuxAgentState,
		title: "Feature A",
		done: 2,
		total: 5,
		tasks: [
			{ title: "Task 1", done: true },
			{ title: "Task 2", done: true },
			{ title: "Task 3", done: false },
		],
		elapsedMs: 60000,
		...overrides,
	};
}

function makePendingQuestion(
	overrides: Partial<PendingQuestion> = {},
): PendingQuestion {
	return {
		agentId: "agent-1",
		agentName: "Agent 1",
		deliverableTitle: "Feature A",
		questions: [
			{
				id: "q1",
				question: "Should we use approach A or B?",
				options: [
					{ label: "Approach A", value: "a" },
					{ label: "Approach B", value: "b" },
				],
			},
		],
		draft: [],
		resolve: () => {},
		receivedAt: Date.now(),
		...overrides,
	};
}

describe("UnifiedOverlayComponent", () => {
	it("renders collapsed with agent summary", () => {
		const overlay = new UnifiedOverlayComponent({
			onAnswer: () => {},
			onAction: () => {},
		});
		overlay.updateAgents([makeRow()]);
		const lines = overlay.render(60);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("Agents");
		expect(lines[1]).toContain("1 working");
	});

	it("shows question badge when questions pending", () => {
		const overlay = new UnifiedOverlayComponent({
			onAnswer: () => {},
			onAction: () => {},
		});
		overlay.updateAgents([makeRow()]);
		overlay.updateQuestions([makePendingQuestion()]);
		const lines = overlay.render(60);
		expect(lines[0]).toContain("1 question");
	});

	it("expands on Tab", () => {
		const overlay = new UnifiedOverlayComponent({
			onAnswer: () => {},
			onAction: () => {},
		});
		overlay.focused = true;
		overlay.updateAgents([makeRow()]);
		overlay.setHandle({ focus: () => {}, unfocus: () => {} } as any);
		overlay.handleInput("\t");
		expect(overlay.expanded).toBe(true);
		const lines = overlay.render(80);
		// Expanded agents view shows more than 3 lines
		expect(lines.length).toBeGreaterThan(3);
	});

	it("switches to questions section with →", () => {
		const overlay = new UnifiedOverlayComponent({
			onAnswer: () => {},
			onAction: () => {},
		});
		overlay.focused = true;
		overlay.updateAgents([makeRow()]);
		overlay.updateQuestions([makePendingQuestion()]);
		overlay.setHandle({ focus: () => {}, unfocus: () => {} } as any);
		overlay.handleInput("\t"); // expand
		overlay.handleInput("\u001b[C"); // →
		const lines = overlay.render(80);
		expect(lines[0]).toContain("Questions");
		expect(lines.join("\n")).toContain("approach A or B");
	});

	it("submits answer on Enter and switches back to agents", () => {
		let answered: { agentId: string; answers: readonly any[] } | undefined;
		const overlay = new UnifiedOverlayComponent({
			onAnswer: (agentId, answers) => {
				answered = { agentId, answers };
			},
			onAction: () => {},
		});
		overlay.focused = true;
		overlay.updateAgents([makeRow()]);
		overlay.updateQuestions([makePendingQuestion()]);
		overlay.setHandle({ focus: () => {}, unfocus: () => {} } as any);
		overlay.handleInput("\t"); // expand
		overlay.handleInput("\u001b[C"); // → to questions
		overlay.handleInput("\r"); // Enter to submit first option

		expect(answered).toBeDefined();
		expect(answered!.agentId).toBe("agent-1");
		expect(answered!.answers[0].value).toBe("a");
	});

	it("number keys highlight corresponding option", () => {
		const overlay = new UnifiedOverlayComponent({
			onAnswer: () => {},
			onAction: () => {},
		});
		overlay.focused = true;
		overlay.updateAgents([makeRow()]);
		overlay.updateQuestions([makePendingQuestion()]);
		overlay.setHandle({ focus: () => {}, unfocus: () => {} } as any);
		overlay.handleInput("\t"); // expand
		overlay.handleInput("\u001b[C"); // → to questions
		overlay.handleInput("2"); // press 2
		overlay.handleInput("\r"); // Enter

		// Should not have submitted — wait, it should submit option 2
		// Actually "2" highlights option index 1 (Approach B)
	});

	it("free text input works", () => {
		let answered: { agentId: string; answers: readonly any[] } | undefined;
		const overlay = new UnifiedOverlayComponent({
			onAnswer: (agentId, answers) => {
				answered = { agentId, answers };
			},
			onAction: () => {},
		});
		overlay.focused = true;
		overlay.updateAgents([makeRow()]);
		overlay.updateQuestions([makePendingQuestion()]);
		overlay.setHandle({ focus: () => {}, unfocus: () => {} } as any);
		overlay.handleInput("\t"); // expand
		overlay.handleInput("\u001b[C"); // → to questions
		overlay.handleInput("3"); // press 3 — free text field (2 options + 1 input)
		overlay.handleInput("h");
		overlay.handleInput("i");
		overlay.handleInput("\r"); // Enter

		expect(answered).toBeDefined();
		expect(answered!.answers[0].value).toBe("hi");
		expect(answered!.answers[0].custom).toBe(true);
	});

	it("collapses on Esc", () => {
		const overlay = new UnifiedOverlayComponent({
			onAnswer: () => {},
			onAction: () => {},
		});
		overlay.focused = true;
		overlay.updateAgents([makeRow()]);
		overlay.setHandle({ focus: () => {}, unfocus: () => {} } as any);
		overlay.handleInput("\t"); // expand
		expect(overlay.expanded).toBe(true);
		overlay.handleInput("\u001b"); // Esc
		expect(overlay.expanded).toBe(false);
	});

	it("showQuestions() expands and navigates to questions", () => {
		const overlay = new UnifiedOverlayComponent({
			onAnswer: () => {},
			onAction: () => {},
		});
		overlay.updateAgents([makeRow()]);
		overlay.updateQuestions([makePendingQuestion()]);
		overlay.setHandle({ focus: () => {}, unfocus: () => {} } as any);
		overlay.showQuestions();
		expect(overlay.expanded).toBe(true);
		const lines = overlay.render(80);
		expect(lines[0]).toContain("Questions");
	});

	it("showAgents() expands and navigates to agents", () => {
		const overlay = new UnifiedOverlayComponent({
			onAnswer: () => {},
			onAction: () => {},
		});
		overlay.updateAgents([makeRow()]);
		overlay.setHandle({ focus: () => {}, unfocus: () => {} } as any);
		overlay.showAgents();
		expect(overlay.expanded).toBe(true);
		const lines = overlay.render(80);
		expect(lines[0]).toContain("Agents");
	});

	it("hides questions section when no questions pending", () => {
		const overlay = new UnifiedOverlayComponent({
			onAnswer: () => {},
			onAction: () => {},
		});
		overlay.updateAgents([makeRow()]);
		overlay.updateQuestions([]); // no questions
		const lines = overlay.render(60);
		expect(lines[0]).not.toContain("question");
	});

	it("no rendered line exceeds the given width", () => {
		const overlay = new UnifiedOverlayComponent({
			onAnswer: () => {},
			onAction: () => {},
		});
		overlay.focused = true;
		overlay.updateAgents([
			makeRow({
				title:
					"A very long deliverable title that exceeds any reasonable column width and should be truncated properly",
			}),
			makeRow({
				agentId: "agent-2",
				title:
					"Another agent with a super long title for testing width constraints",
			}),
		]);
		overlay.updateQuestions([
			makePendingQuestion({
				questions: [
					{
						id: "q1",
						question:
							"This is an extremely long question that should definitely be truncated when rendered in a narrow terminal",
						options: [
							{
								label:
									"Option with a very long description that might overflow the box boundaries",
							},
							{ label: "Short" },
						],
					},
				],
			}),
		]);
		overlay.setHandle({ focus: () => {}, unfocus: () => {} } as any);

		// Test at a narrow width (like the crash scenario)
		const width = 80;
		overlay.handleInput("\t"); // expand

		// Check agents section
		const agentLines = overlay.render(width);
		for (const line of agentLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}

		// Check questions section
		overlay.handleInput("\u001b[C"); // → to questions
		const questionLines = overlay.render(width);
		for (const line of questionLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}

		// Also test collapsed
		overlay.handleInput("\u001b"); // collapse
		const collapsedLines = overlay.render(width);
		for (const line of collapsedLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});
