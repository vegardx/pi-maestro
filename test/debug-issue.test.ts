import {
	buildDiagnosticIssueDraft,
	type DebugIssueEvidence,
	type DebugIssueReviewState,
	type DiagnosticIssueDraft,
	freezeDiagnosticIssue,
	redactDiagnosticIssueDraft,
	renderDiagnosticIssue,
	renderIssueReviewQuestions,
	reviewAndPostDiagnosticIssue,
	validateDiagnosticIssueDraft,
} from "../packages/modes/src/debug-issue.js";

function evidence(ok = true): DebugIssueEvidence {
	return {
		observed: ["role=maestro, stage=executing", "worker stopped"],
		likelyCause: "Worker process exited unexpectedly",
		recentFailures: [
			"crash-snapshot: token=super-secret-value-that-must-redact",
		],
		runtime: {
			role: "maestro",
			mode: "auto",
			stage: "executing",
			cwd: "~/src/pi-maestro",
			sessionPath: "~/.pi/session.jsonl",
			planSlug: "debug-plan",
			deliverableId: "worker",
			generation: 4,
			node: "v22",
			platform: "darwin",
			architecture: "arm64",
			maestroRevision: "abc123",
		},
		recovery: {
			attemptedAction: "restart-fresh",
			attemptedAt: "2026-01-01T00:00:00Z",
			status: ok ? "succeeded" : "failed",
			detail: ok
				? "worker restarted at generation 5"
				: "kill timeout; token=another-secret-value-that-must-redact",
		},
	};
}

class MemoryReviewController {
	state?: DebugIssueReviewState;
	canceled = false;
	getIssueReview() {
		return this.state;
	}
	startIssueReview(draft: DiagnosticIssueDraft) {
		this.state = { draft, revision: 0, history: [] };
		return this.state;
	}
	recordIssueRevision(
		draft: DiagnosticIssueDraft,
		instruction: string,
		at: string,
	) {
		const current = this.state!;
		this.state = {
			draft,
			revision: current.revision + 1,
			history: [
				...current.history,
				{ at, instruction, previousDraftHash: `hash-${current.revision}` },
			],
		};
		return this.state;
	}
	cancel() {
		this.canceled = true;
		this.state = undefined;
	}
}

function revised(
	current: DiagnosticIssueDraft,
	instruction: string,
): DiagnosticIssueDraft {
	return {
		...current,
		model: {
			...current.model,
			title: `Revised: ${instruction}`,
			summary: `Revision requested: ${instruction}`,
		},
	};
}

describe("diagnostic issue schema and rendering", () => {
	it("renders every section deterministically and keeps provenance structural", () => {
		const draft = buildDiagnosticIssueDraft(evidence(false));
		const first = renderDiagnosticIssue(draft);
		expect(renderDiagnosticIssue(draft)).toBe(first);
		for (const heading of [
			"## Summary",
			"## Steps to reproduce",
			"## Expected behavior",
			"## Actual behavior",
			"## Observed facts",
			"## Likely cause",
			"## Recovery / workaround",
			"## Runtime context",
			"## Suggested fix",
		])
			expect(first).toContain(heading);
		expect(first).toContain("Exact outcome: **failed**");
		expect(draft.mechanical.runtimeContext).toContainEqual({
			label: "Worker generation",
			value: "4",
			source: "executor",
		});
		expect(
			(draft as unknown as Record<string, unknown>).attachments,
		).toBeUndefined();
	});

	it("rejects attachments, missing sections, excessive evidence, and changed mechanics", () => {
		const draft = buildDiagnosticIssueDraft(evidence());
		expect(
			validateDiagnosticIssueDraft(
				{ ...draft, attachment: "raw transcript" },
				draft.mechanical,
			).ok,
		).toBe(false);
		const missing = structuredClone(draft) as unknown as {
			model: Record<string, unknown>;
		};
		delete missing.model.actualBehavior;
		expect(validateDiagnosticIssueDraft(missing, draft.mechanical).ok).toBe(
			false,
		);
		const changed = {
			...structuredClone(draft),
			mechanical: {
				...structuredClone(draft.mechanical),
				observedFacts: ["invented"],
			},
		};
		expect(validateDiagnosticIssueDraft(changed, draft.mechanical).ok).toBe(
			false,
		);
		const excessive = {
			...structuredClone(draft),
			mechanical: {
				...structuredClone(draft.mechanical),
				observedFacts: Array.from({ length: 13 }, () => "x"),
			},
		};
		expect(validateDiagnosticIssueDraft(excessive).ok).toBe(false);
	});

	it("redacts the complete draft before persistence, display, and posting", () => {
		const draft = buildDiagnosticIssueDraft(evidence(false));
		const persisted = redactDiagnosticIssueDraft(draft);
		const frozen = freezeDiagnosticIssue(persisted);
		expect(JSON.stringify(persisted)).not.toContain("another-secret");
		expect(frozen.body).toContain("[redacted]");
		expect(frozen.body).not.toContain("super-secret");
	});
});

describe("diagnostic issue review", () => {
	it("uses conditional free text and performs unlimited user-driven revisions", async () => {
		const controller = new MemoryReviewController();
		const draft = buildDiagnosticIssueDraft(evidence());
		const displayed: string[] = [];
		let asks = 0;
		const ask = {
			ask: async (questions: ReturnType<typeof renderIssueReviewQuestions>) => {
				displayed.push(questions[0]?.context ?? "");
				asks++;
				if (asks <= 4)
					return [
						{ questionId: "debug-issue-action-episode", value: "revise" },
						{
							questionId: "debug-issue-instruction-episode",
							value: `iteration ${asks}`,
							custom: true,
						},
					];
				return [
					{ questionId: "debug-issue-action-episode", value: "create" },
					{
						questionId: "debug-issue-instruction-episode",
						value: "",
						skipped: true,
					},
				];
			},
		};
		let posted: ReturnType<typeof freezeDiagnosticIssue> | undefined;
		const result = await reviewAndPostDiagnosticIssue({
			id: "episode",
			controller,
			ask: ask as never,
			reviser: {
				revise: async ({ currentDraft, instruction }) =>
					revised(currentDraft, instruction),
			},
			evidence: evidence(),
			initialDraft: draft,
			post: async (exact) => {
				posted = exact;
				return { url: "https://github.com/vegardx/pi-maestro/issues/1" };
			},
			now: () => "now",
		});
		expect(result.status).toBe("posted");
		expect(asks).toBe(5);
		expect(posted).toEqual({
			title: "Revised: iteration 4",
			body: expect.any(String),
		});
		expect(displayed.at(-1)).toBe(`# ${posted?.title}\n\n${posted?.body}`);
		const questions = renderIssueReviewQuestions(
			"episode",
			freezeDiagnosticIssue(draft),
		);
		expect(questions[1]?.allowFreeText).toBe(true);
		expect(questions[1]?.showIf).toEqual({
			questionId: "debug-issue-action-episode",
			choice: "revise",
		});
	});

	it("retains the prior draft after reviser failure and never posts on cancel", async () => {
		const controller = new MemoryReviewController();
		const draft = buildDiagnosticIssueDraft(evidence());
		const contexts: string[] = [];
		const errors: string[] = [];
		let call = 0;
		const result = await reviewAndPostDiagnosticIssue({
			id: "episode",
			controller,
			ask: {
				ask: async (questions: readonly { context?: string }[]) => {
					contexts.push(questions[0]?.context ?? "");
					call++;
					return call === 1
						? [
								{ questionId: "debug-issue-action-episode", value: "revise" },
								{
									questionId: "debug-issue-instruction-episode",
									value: "invent a fact",
								},
							]
						: [{ questionId: "debug-issue-action-episode", value: "cancel" }];
				},
			} as never,
			reviser: {
				revise: async ({ currentDraft }) => ({
					...currentDraft,
					mechanical: {
						...currentDraft.mechanical,
						observedFacts: ["invented"],
					},
				}),
			},
			evidence: evidence(),
			initialDraft: draft,
			post: async () => {
				throw new Error("must not post");
			},
			onRevisionError: (error) => errors.push(error),
		});
		expect(result.status).toBe("canceled");
		expect(contexts[1]).toBe(contexts[0]);
		expect(errors[0]).toContain("prior draft was retained");
		expect(controller.canceled).toBe(true);
	});

	it("reports GitHub failure without changing the completed recovery outcome", async () => {
		const controller = new MemoryReviewController();
		const draft = buildDiagnosticIssueDraft(evidence(false));
		const result = await reviewAndPostDiagnosticIssue({
			id: "episode",
			controller,
			ask: {
				ask: async () => [
					{ questionId: "debug-issue-action-episode", value: "create" },
				],
			} as never,
			reviser: { revise: async () => draft },
			evidence: evidence(false),
			initialDraft: draft,
			post: async () => ({ url: null, error: "network uncertain" }),
		});
		expect(result).toEqual({
			status: "post-failed",
			error: "network uncertain",
		});
		expect(renderDiagnosticIssue(draft)).toContain("Exact outcome: **failed**");
	});
});
