import { describe, it, expect } from "vitest";
import { formatQuestionsForLlm, formatAnswerNotice } from "../packages/modes/src/question-formatter.js";
import type { PendingQuestion } from "../packages/modes/src/question-queue.js";
import type { Questionnaire } from "../packages/contracts/src/index.js";

function makePending(overrides: Partial<PendingQuestion> = {}): PendingQuestion {
	return {
		agentId: "a1",
		agentName: "vivid-cedar",
		deliverableTitle: "Write API docs",
		questions: [
			{
				id: "q-docs",
				question: "How should I handle stubbed helpers?",
				options: [
					{ label: "Document as-is", value: "A", description: "Other workers implement them" },
					{ label: "Mark as coming soon", value: "B" },
					{ label: "Only document implemented", value: "C" },
				],
				recommendation: "A",
			},
		],
		draft: [],
		resolve: () => {},
		receivedAt: Date.now(),
		deliveredToLlm: false,
		settled: false,
		...overrides,
	} as PendingQuestion;
}

describe("formatQuestionsForLlm", () => {
	it("formats a single question with options and recommendation", () => {
		const entry = makePending();
		const result = formatQuestionsForLlm([entry]);

		expect(result).toContain("vivid-cedar");
		expect(result).toContain("Write API docs");
		expect(result).toContain("[q-docs]");
		expect(result).toContain("How should I handle stubbed helpers?");
		expect(result).toContain("A) Document as-is");
		expect(result).toContain("B) Mark as coming soon");
		expect(result).toContain("C) Only document implemented");
		expect(result).toContain("[recommended]");
		expect(result).toContain("Worker recommends: A");
		expect(result).toContain("answer");
		expect(result).toContain("escalate");
	});

	it("formats multiple entries", () => {
		const e1 = makePending();
		const e2 = makePending({
			agentId: "a2",
			agentName: "calm-oak",
			deliverableTitle: "Fix tests",
			questions: [{ id: "q-test", question: "Which framework?", options: [{ label: "vitest" }, { label: "jest" }] }],
		});
		const result = formatQuestionsForLlm([e1, e2]);

		expect(result).toContain("vivid-cedar");
		expect(result).toContain("calm-oak");
		expect(result).toContain("[q-docs]");
		expect(result).toContain("[q-test]");
	});

	it("handles free text questions", () => {
		const entry = makePending({
			questions: [{ id: "q1", question: "Custom name?", allowFreeText: true }],
		});
		const result = formatQuestionsForLlm([entry]);
		expect(result).toContain("Free text answer allowed");
	});
});

describe("formatAnswerNotice", () => {
	it("shows auto-answered with reasoning and steer hint", () => {
		const entry = makePending();
		const result = formatAnswerNotice(
			entry,
			[{ questionId: "q-docs", value: "A" }],
			"Plan has parallel workers",
			true,
		);

		expect(result).toContain("❓ vivid-cedar — Write API docs");
		expect(result).toContain("Auto-answered");
		expect(result).toContain("A — Document as-is");
		expect(result).toContain("Plan has parallel workers");
		expect(result).toContain("/steer vivid-cedar");
	});

	it("shows user-answered without Auto prefix or steer hint", () => {
		const entry = makePending();
		const result = formatAnswerNotice(
			entry,
			[{ questionId: "q-docs", value: "B" }],
			undefined,
			false,
		);

		expect(result).toContain("Answered");
		expect(result).not.toContain("Auto-answered");
		expect(result).not.toContain("/steer");
	});
});
