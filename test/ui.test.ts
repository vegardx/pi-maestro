import type {
	DeliverableId,
	Question,
	Questionnaire,
	RunId,
	RunRecord,
	WorkItemId,
} from "@vegardx/pi-contracts";
import {
	commitQuestion,
	deliverableStatusGlyph,
	formatCount,
	formatElapsed,
	initQuestionnaireState,
	isShown,
	moveCursor,
	type PlanTreeNode,
	recommendedIndex,
	renderPlanTree,
	renderProgressBar,
	renderQuestionnaire,
	renderRunDashboard,
	runStatusGlyph,
	toggleSelection,
} from "@vegardx/pi-ui";

const did = (s: string) => s as DeliverableId;
const wid = (s: string) => s as WorkItemId;
const rid = (s: string) => s as RunId;

describe("format helpers", () => {
	it("maps statuses to glyphs and formats counts/elapsed", () => {
		expect(runStatusGlyph("succeeded")).toBe("✓");
		expect(runStatusGlyph("failed")).toBe("✗");
		expect(deliverableStatusGlyph("shipped")).toBe("✓");
		expect(formatCount(2, 5)).toBe("2/5");
		expect(formatElapsed(3000)).toBe("3s");
		expect(formatElapsed(90000)).toBe("1m30s");
		expect(formatElapsed(3_600_000)).toBe("1h");
		expect(formatElapsed(-1)).toBe("—");
	});
});

describe("progress bar", () => {
	it("renders a clamped bar with percent label", () => {
		expect(renderProgressBar(0.5, 14)).toBe("█████░░░░  50%");
		expect(renderProgressBar(2, 14)).toBe("█████████ 100%");
		expect(renderProgressBar(-1, 14)).toBe("░░░░░░░░░   0%");
	});
});

describe("plan tree", () => {
	const nodes: PlanTreeNode[] = [
		{
			deliverable: { id: did("d1"), title: "Foundation", status: "active" },
			depth: 0,
			items: [
				{ id: wid("w1"), title: "Write core", kind: "task", done: true },
				{ id: wid("w2"), title: "Write tests", kind: "task", done: false },
				{ id: wid("w3"), title: "Ask Vegard", kind: "question", done: false },
			],
		},
		{
			deliverable: { id: did("d2"), title: "Child", status: "planned" },
			depth: 1,
		},
	];

	it("renders headers with task counts and indentation", () => {
		const lines = renderPlanTree(nodes, 60);
		expect(lines[0]).toBe("◐ Foundation 1/2");
		expect(lines[1]).toBe("  ○ Child");
	});

	it("expands work items with kind tags when showItems", () => {
		const lines = renderPlanTree(nodes, 60, { showItems: true });
		expect(lines).toContain("  ✓ Write core");
		expect(lines).toContain("  ○ Write tests");
		expect(lines).toContain("  ○ ? Ask Vegard");
	});
});

describe("run dashboard", () => {
	it("renders one line per run with status and elapsed", () => {
		const runs: RunRecord[] = [
			{
				id: rid("r1"),
				profile: { profile: "reviewer" },
				status: "running",
				createdAt: 1000,
				updatedAt: 1000,
			},
			{
				id: rid("r2"),
				profile: { profile: "deliverable-worker" },
				status: "succeeded",
				createdAt: 0,
				updatedAt: 5000,
			},
		];
		const lines = renderRunDashboard(
			runs.map((run) => ({ run })),
			80,
			{ now: 5000 },
		);
		expect(lines[0]).toContain("◐");
		expect(lines[0]).toContain("reviewer");
		expect(lines[0]).toContain("4s");
		expect(lines[1]).toContain("✓");
		expect(lines[1]).toContain("5s");
	});

	it("renders an empty-state line", () => {
		expect(renderRunDashboard([], 40)).toEqual(["  (no runs)"]);
	});
});

describe("questionnaire reducers", () => {
	const q: Questionnaire = [
		{
			id: "scope",
			question: "Pick a scope",
			options: [{ label: "Thin" }, { label: "Thick", value: "thick" }],
		},
		{
			id: "tags",
			question: "Pick tags",
			multiple: true,
			options: [{ label: "a" }, { label: "b" }, { label: "c" }],
			allowFreeText: true,
		},
	];

	it("commits a single-choice answer at the cursor and advances", () => {
		let state = initQuestionnaireState();
		state = moveCursor(state, q[0], 1);
		const r = commitQuestion(q, state);
		expect(r.done).toBe(false);
		expect(r.state.index).toBe(1);
		expect(r.state.answers).toEqual([{ questionId: "scope", value: "thick" }]);
	});

	it("collects multiple selections and finishes on the last question", () => {
		let state = { ...initQuestionnaireState(), index: 1 };
		state = toggleSelection(state, q[1]); // a
		state = moveCursor(state, q[1], 2);
		state = toggleSelection(state, q[1]); // c
		const r = commitQuestion(q, state);
		expect(r.done).toBe(true);
		expect(r.answers).toEqual([
			{ questionId: "tags", value: "a" },
			{ questionId: "tags", value: "c" },
		]);
	});

	it("renders tabs, cursor, and free-text hint", () => {
		const lines = renderQuestionnaire(
			q,
			{ ...initQuestionnaireState(), index: 1 },
			60,
		);
		expect(lines[0]).toContain("Q1✓");
		expect(lines[0]).toContain("[Q2]");
		expect(lines.some((l) => l.includes("[ ] a"))).toBe(true);
		expect(lines.at(-1)).toContain("press 't'");
	});

	it("uses header labels in tabs and marks the recommendation", () => {
		const rq: Questionnaire = [
			{
				id: "e",
				header: "ErrType",
				question: "Which error?",
				options: [{ label: "RangeError" }, { label: "Custom" }],
				recommendation: "RangeError",
			},
			{
				id: "x",
				header: "Overflow",
				question: "Guard?",
				options: [{ label: "Yes" }],
			},
		];
		const lines = renderQuestionnaire(rq, initQuestionnaireState(), 60);
		expect(lines[0]).toContain("[ErrType]");
		expect(lines[0]).toContain("Overflow");
		expect(lines.some((l) => l.includes("[rec]"))).toBe(true);
	});

	it("evaluates showIf against prior answers", () => {
		const dep: Question = {
			id: "d",
			question: "dep",
			showIf: { questionId: "e", anyOf: ["Custom"] },
		};
		expect(isShown(dep, [{ questionId: "e", value: "RangeError" }])).toBe(
			false,
		);
		expect(isShown(dep, [{ questionId: "e", value: "Custom" }])).toBe(true);
		expect(isShown(dep, [{ questionId: "e", value: "", skipped: true }])).toBe(
			false,
		);
	});

	it("recommendedIndex matches by option value or label", () => {
		const rq: Question = {
			id: "e",
			question: "q",
			options: [{ label: "A", value: "a" }, { label: "B" }],
			recommendation: "B",
		};
		expect(recommendedIndex(rq)).toBe(1);
		expect(recommendedIndex({ ...rq, recommendation: "a" })).toBe(0);
		expect(recommendedIndex({ ...rq, recommendation: undefined })).toBe(-1);
	});
});
