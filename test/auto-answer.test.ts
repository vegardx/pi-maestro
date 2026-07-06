import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AutoAnswerController, type AutoAnswerDeps } from "../packages/modes/src/auto-answer.js";
import { QuestionQueue } from "../packages/modes/src/question-queue.js";
import type { Answers, Questionnaire } from "../packages/contracts/src/index.js";

function makeQuestions(count = 1): Questionnaire {
	return Array.from({ length: count }, (_, i) => ({
		id: `q${i + 1}`,
		question: `Question ${i + 1}?`,
		options: [
			{ label: "Option A", value: "A" },
			{ label: "Option B", value: "B" },
		],
		recommendation: "A",
	}));
}

function createDeps(overrides: Partial<AutoAnswerDeps> = {}): {
	deps: AutoAnswerDeps;
	queue: QuestionQueue;
	sent: Array<{ content: string; triggerTurn: boolean }>;
	pickerCalls: string[];
	notifications: string[];
} {
	const queue = new QuestionQueue();
	const sent: Array<{ content: string; triggerTurn: boolean }> = [];
	const pickerCalls: string[] = [];
	const notifications: string[] = [];

	const deps: AutoAnswerDeps = {
		sendMessage: (opts, meta) => {
			sent.push({ content: opts.content, triggerTurn: meta.triggerTurn });
		},
		showPicker: (entry) => {
			pickerCalls.push(entry.agentId);
		},
		notify: (msg) => {
			notifications.push(msg);
		},
		queue,
		isAutoMode: () => true,
		...overrides,
	};

	return { deps, queue, sent, pickerCalls, notifications };
}

describe("QuestionQueue extended", () => {
	it("tracks deliveredToLlm and settled state", () => {
		const queue = new QuestionQueue();
		let resolved = false;
		queue.enqueue({
			agentId: "a1",
			agentName: "Agent 1",
			deliverableTitle: "Task 1",
			questions: makeQuestions(),
			resolve: () => { resolved = true; },
		});

		const entry = queue.pendingForAgent("a1");
		expect(entry?.deliveredToLlm).toBe(false);
		expect(entry?.settled).toBe(false);

		queue.markDelivered("a1");
		expect(entry?.deliveredToLlm).toBe(true);

		expect(queue.undelivered()).toHaveLength(0);
	});

	it("answer returns true and resolves entry", () => {
		const queue = new QuestionQueue();
		let resolved: Answers | undefined;
		queue.enqueue({
			agentId: "a1",
			agentName: "Agent 1",
			deliverableTitle: "Task 1",
			questions: makeQuestions(),
			resolve: (a) => { resolved = a; },
		});

		const ok = queue.answer("a1", [{ questionId: "q1", value: "A" }]);
		expect(ok).toBe(true);
		expect(resolved).toEqual([{ questionId: "q1", value: "A" }]);
		expect(queue.count()).toBe(0);
	});

	it("answer returns false for unknown agent", () => {
		const queue = new QuestionQueue();
		const ok = queue.answer("unknown", [{ questionId: "q1", value: "A" }]);
		expect(ok).toBe(false);
	});

	it("answer returns false for already-settled entry", () => {
		const queue = new QuestionQueue();
		let calls = 0;
		queue.enqueue({
			agentId: "a1",
			agentName: "Agent 1",
			deliverableTitle: "Task 1",
			questions: makeQuestions(),
			resolve: () => { calls++; },
		});
		queue.settle("a1");
		const ok = queue.answer("a1", [{ questionId: "q1", value: "A" }]);
		expect(ok).toBe(false);
		expect(calls).toBe(0);
	});

	it("setTimeout stores handle and settle clears it", () => {
		vi.useFakeTimers();
		const queue = new QuestionQueue();
		let fired = false;
		queue.enqueue({
			agentId: "a1",
			agentName: "Agent 1",
			deliverableTitle: "Task 1",
			questions: makeQuestions(),
			resolve: () => {},
		});

		const handle = setTimeout(() => { fired = true; }, 30000);
		queue.setTimeout("a1", handle);
		queue.settle("a1");

		vi.advanceTimersByTime(31000);
		expect(fired).toBe(false); // Timer was cleared
		vi.useRealTimers();
	});

	it("drop clears timeout", () => {
		vi.useFakeTimers();
		const queue = new QuestionQueue();
		let fired = false;
		queue.enqueue({
			agentId: "a1",
			agentName: "Agent 1",
			deliverableTitle: "Task 1",
			questions: makeQuestions(),
			resolve: () => {},
		});
		const handle = setTimeout(() => { fired = true; }, 30000);
		queue.setTimeout("a1", handle);
		queue.drop("a1");

		vi.advanceTimersByTime(31000);
		expect(fired).toBe(false);
		expect(queue.count()).toBe(0);
		vi.useRealTimers();
	});
});

describe("AutoAnswerController", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	it("immediately delivers question to LLM when idle", () => {
		const { deps, queue, sent } = createDeps();
		const ctrl = new AutoAnswerController(deps);

		queue.enqueue({
			agentId: "a1",
			agentName: "vivid-cedar",
			deliverableTitle: "Write docs",
			questions: makeQuestions(),
			resolve: () => {},
		});

		ctrl.onQuestionReceived("a1");

		expect(sent).toHaveLength(1);
		expect(sent[0].triggerTurn).toBe(true);
		expect(sent[0].content).toContain("vivid-cedar");
		expect(sent[0].content).toContain("answer");
	});

	it("queues delivery until turn_end when orchestrator is busy", () => {
		const { deps, queue, sent } = createDeps();
		const ctrl = new AutoAnswerController(deps);

		ctrl.onTurnStart(); // orchestrator busy

		queue.enqueue({
			agentId: "a1",
			agentName: "vivid-cedar",
			deliverableTitle: "Write docs",
			questions: makeQuestions(),
			resolve: () => {},
		});

		ctrl.onQuestionReceived("a1");

		// Not delivered yet
		expect(sent).toHaveLength(0);

		// Turn ends
		ctrl.onTurnEnd();

		expect(sent).toHaveLength(1);
		expect(sent[0].triggerTurn).toBe(true);
	});

	it("resolveFromLlm resolves the question and shows recap", () => {
		const { deps, queue, sent } = createDeps();
		const ctrl = new AutoAnswerController(deps);

		let resolved: Answers | undefined;
		queue.enqueue({
			agentId: "a1",
			agentName: "vivid-cedar",
			deliverableTitle: "Write docs",
			questions: makeQuestions(),
			resolve: (a) => { resolved = a; },
		});

		ctrl.onQuestionReceived("a1");
		sent.length = 0; // Clear the prompt message

		const ok = ctrl.resolveFromLlm("a1", [{ questionId: "q1", value: "A" }], "Plan says so");
		expect(ok).toBe(true);
		expect(resolved).toEqual([{ questionId: "q1", value: "A" }]);

		// Shows recap
		expect(sent).toHaveLength(1);
		expect(sent[0].triggerTurn).toBe(false);
		expect(sent[0].content).toContain("Auto-answered");
		expect(sent[0].content).toContain("/steer");
	});

	it("escalateFromLlm shows picker without resolving", () => {
		const { deps, queue, pickerCalls } = createDeps();
		const ctrl = new AutoAnswerController(deps);

		queue.enqueue({
			agentId: "a1",
			agentName: "vivid-cedar",
			deliverableTitle: "Write docs",
			questions: makeQuestions(),
			resolve: () => {},
		});

		ctrl.onQuestionReceived("a1");

		const ok = ctrl.escalateFromLlm("a1", "Needs human input");
		expect(ok).toBe(true);
		expect(pickerCalls).toEqual(["a1"]);
		// Entry should be settled but not removed (picker will resolve it)
		expect(queue.pendingForAgent("a1")?.settled).toBe(true);
	});

	it("30s timeout fires and shows picker", () => {
		const { deps, queue, pickerCalls, notifications } = createDeps();
		const ctrl = new AutoAnswerController(deps);

		queue.enqueue({
			agentId: "a1",
			agentName: "vivid-cedar",
			deliverableTitle: "Write docs",
			questions: makeQuestions(),
			resolve: () => {},
		});

		ctrl.onQuestionReceived("a1");

		vi.advanceTimersByTime(30001);

		expect(pickerCalls).toEqual(["a1"]);
		expect(notifications).toContain("Question timeout — escalating to user.");
	});

	it("timeout is cancelled when LLM answers in time", () => {
		const { deps, queue, pickerCalls } = createDeps();
		const ctrl = new AutoAnswerController(deps);

		queue.enqueue({
			agentId: "a1",
			agentName: "vivid-cedar",
			deliverableTitle: "Write docs",
			questions: makeQuestions(),
			resolve: () => {},
		});

		ctrl.onQuestionReceived("a1");
		ctrl.resolveFromLlm("a1", [{ questionId: "q1", value: "A" }]);

		vi.advanceTimersByTime(31000);
		expect(pickerCalls).toHaveLength(0); // No escalation
	});

	it("in non-auto mode just notifies", () => {
		const { deps, queue, sent, notifications } = createDeps({
			isAutoMode: () => false,
		});
		const ctrl = new AutoAnswerController(deps);

		queue.enqueue({
			agentId: "a1",
			agentName: "vivid-cedar",
			deliverableTitle: "Write docs",
			questions: makeQuestions(),
			resolve: () => {},
		});

		ctrl.onQuestionReceived("a1");

		expect(sent).toHaveLength(0); // No LLM trigger
		expect(notifications).toContain("Agent has question(s) — /answer to respond.");
	});

	it("handles multiple questions from different agents", () => {
		const { deps, queue, sent } = createDeps();
		const ctrl = new AutoAnswerController(deps);

		queue.enqueue({
			agentId: "a1",
			agentName: "vivid-cedar",
			deliverableTitle: "Write docs",
			questions: makeQuestions(2),
			resolve: () => {},
		});
		queue.enqueue({
			agentId: "a2",
			agentName: "calm-oak",
			deliverableTitle: "Fix tests",
			questions: makeQuestions(1),
			resolve: () => {},
		});

		// Both arrive while idle
		ctrl.onQuestionReceived("a1");
		// First delivery sends both undelivered
		expect(sent).toHaveLength(1);
		expect(sent[0].content).toContain("vivid-cedar");
		expect(sent[0].content).toContain("calm-oak");
	});

	it("resolveFromUser sends recap without auto prefix", () => {
		const { deps, queue, sent } = createDeps();
		const ctrl = new AutoAnswerController(deps);

		queue.enqueue({
			agentId: "a1",
			agentName: "vivid-cedar",
			deliverableTitle: "Write docs",
			questions: makeQuestions(),
			resolve: () => {},
		});

		ctrl.resolveFromUser("a1", [{ questionId: "q1", value: "B" }]);

		expect(sent).toHaveLength(1);
		expect(sent[0].content).toContain("Answered");
		expect(sent[0].content).not.toContain("Auto-answered");
	});
});
