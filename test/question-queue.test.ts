import type { Answers, Questionnaire } from "@vegardx/pi-contracts";
import { describe, expect, it, vi } from "vitest";
import { QuestionQueue } from "../packages/modes/src/question-queue.js";

const q: Questionnaire = [{ id: "a", question: "?" }];

function entry(agentId: string, resolve: (a: Answers) => void) {
	return {
		agentId,
		agentName: agentId,
		deliverableTitle: agentId,
		questions: q,
		resolve,
	};
}

describe("QuestionQueue", () => {
	it("peeks FIFO and answers by agentId out of order", () => {
		const queue = new QuestionQueue();
		const r1 = vi.fn();
		const r2 = vi.fn();
		queue.enqueue(entry("a1", r1));
		queue.enqueue(entry("a2", r2));
		expect(queue.count()).toBe(2);
		expect(queue.peek()?.agentId).toBe("a1");

		// answer the second one first (dashboard targeted)
		queue.answer("a2", [{ questionId: "a", value: "x" }]);
		expect(r2).toHaveBeenCalledWith([{ questionId: "a", value: "x" }]);
		expect(queue.count()).toBe(1);
		expect(queue.peek()?.agentId).toBe("a1");
	});

	it("keeps at most one entry per agent", () => {
		const queue = new QuestionQueue();
		queue.enqueue(entry("a1", vi.fn()));
		queue.enqueue(entry("a1", vi.fn()));
		expect(queue.count()).toBe(1);
	});

	it("round-trips a draft and clears on drop", () => {
		const queue = new QuestionQueue();
		queue.enqueue(entry("a1", vi.fn()));
		queue.saveDraft("a1", [{ questionId: "a", value: "partial" }]);
		expect(queue.pendingForAgent("a1")?.draft).toEqual([
			{ questionId: "a", value: "partial" },
		]);
		queue.drop("a1");
		expect(queue.count()).toBe(0);
	});

	it("drop does not resolve the agent's promise", () => {
		const queue = new QuestionQueue();
		const r = vi.fn();
		queue.enqueue(entry("a1", r));
		queue.drop("a1");
		expect(r).not.toHaveBeenCalled();
	});
});
