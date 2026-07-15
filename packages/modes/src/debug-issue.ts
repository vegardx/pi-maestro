import { createHash } from "node:crypto";
import type { Answer, AskCapabilityV1, Question } from "@vegardx/pi-contracts";
import { redactSecrets } from "@vegardx/pi-core";

const LIMITS = {
	title: 160,
	text: 2_000,
	item: 1_000,
	steps: 8,
	facts: 12,
	runtime: 16,
	revisions: 20,
	instruction: 1_000,
} as const;

export interface DiagnosticIssueModelFields {
	readonly title: string;
	readonly summary: string;
	readonly stepsToReproduce: readonly string[];
	readonly expectedBehavior: string;
	readonly actualBehavior: string;
	readonly likelyCause?: string;
	readonly recoveryWorkaround: string;
	readonly suggestedFix: string;
}

export interface DiagnosticRuntimeFact {
	readonly label: string;
	readonly value: string;
	readonly source: "runtime" | "session" | "plan" | "executor" | "platform";
}

export interface DiagnosticRecoveryOutcome {
	readonly attemptedAction: string;
	readonly attemptedAt: string;
	readonly status: "succeeded" | "failed";
	readonly detail: string;
}

/**
 * Provenance is structural: a reviser may replace `model`, while `mechanical`
 * is generated from the frozen diagnosis/runtime and must remain byte-equal.
 * There is intentionally no attachment or arbitrary-log field.
 */
export interface DiagnosticIssueDraft {
	readonly version: 1;
	readonly model: DiagnosticIssueModelFields;
	readonly mechanical: {
		readonly observedFacts: readonly string[];
		readonly runtimeContext: readonly DiagnosticRuntimeFact[];
		readonly recoveryOutcome: DiagnosticRecoveryOutcome;
	};
}

export interface FrozenDiagnosticIssue {
	readonly title: string;
	readonly body: string;
}

export interface DebugIssueRevisionRecord {
	readonly at: string;
	readonly instruction: string;
	readonly previousDraftHash: string;
}

export interface DebugIssueReviewState {
	readonly draft: DiagnosticIssueDraft;
	readonly revision: number;
	readonly history: readonly DebugIssueRevisionRecord[];
}

export interface DebugIssueEvidence {
	readonly observed: readonly string[];
	readonly likelyCause: string;
	readonly recentFailures: readonly string[];
	readonly runtime: {
		readonly role: string;
		readonly mode: string;
		readonly stage: string;
		readonly cwd: string;
		readonly sessionPath?: string;
		readonly planSlug?: string;
		readonly deliverableId?: string;
		readonly generation?: number;
		readonly node: string;
		readonly platform: string;
		readonly architecture: string;
		readonly maestroRevision: string;
	};
	readonly recovery: DiagnosticRecoveryOutcome;
}

function bounded(value: string, max: number): string {
	return value.trim().slice(0, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return (
		actual.length === expected.length &&
		actual.every((key, i) => key === expected[i])
	);
}

function validText(value: unknown, max: number = LIMITS.text): value is string {
	return (
		typeof value === "string" && value.trim().length > 0 && value.length <= max
	);
}

function validItems(value: unknown, maxItems: number): value is string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.length <= maxItems &&
		value.every((item) => validText(item, LIMITS.item))
	);
}

function validateMechanical(
	value: unknown,
): value is DiagnosticIssueDraft["mechanical"] {
	if (
		!isRecord(value) ||
		!exactKeys(value, ["observedFacts", "runtimeContext", "recoveryOutcome"])
	)
		return false;
	if (!validItems(value.observedFacts, LIMITS.facts)) return false;
	if (
		!Array.isArray(value.runtimeContext) ||
		value.runtimeContext.length === 0 ||
		value.runtimeContext.length > LIMITS.runtime
	)
		return false;
	for (const fact of value.runtimeContext) {
		if (!isRecord(fact) || !exactKeys(fact, ["label", "value", "source"]))
			return false;
		if (!validText(fact.label, 80) || !validText(fact.value, LIMITS.item))
			return false;
		if (
			!["runtime", "session", "plan", "executor", "platform"].includes(
				String(fact.source),
			)
		)
			return false;
	}
	const outcome = value.recoveryOutcome;
	if (
		!isRecord(outcome) ||
		!exactKeys(outcome, ["attemptedAction", "attemptedAt", "status", "detail"])
	)
		return false;
	return (
		validText(outcome.attemptedAction, 120) &&
		validText(outcome.attemptedAt, 80) &&
		["succeeded", "failed"].includes(String(outcome.status)) &&
		validText(outcome.detail)
	);
}

/** Validate a full replacement and, when provided, pin all mechanical provenance. */
export function validateDiagnosticIssueDraft(
	value: unknown,
	expectedMechanical?: DiagnosticIssueDraft["mechanical"],
): { ok: true; draft: DiagnosticIssueDraft } | { ok: false; error: string } {
	if (
		!isRecord(value) ||
		!exactKeys(value, ["version", "model", "mechanical"]) ||
		value.version !== 1
	)
		return {
			ok: false,
			error: "draft must be a complete version 1 replacement",
		};
	if (!isRecord(value.model))
		return { ok: false, error: "draft model fields are missing" };
	const model = value.model;
	const allowedModelKeys = [
		"title",
		"summary",
		"stepsToReproduce",
		"expectedBehavior",
		"actualBehavior",
		"likelyCause",
		"recoveryWorkaround",
		"suggestedFix",
	] as const;
	if (
		Object.keys(model).some((key) => !allowedModelKeys.includes(key as never))
	)
		return {
			ok: false,
			error: "draft contains an unsupported model field or attachment",
		};
	const required = allowedModelKeys.filter((key) => key !== "likelyCause");
	if (required.some((key) => !(key in model)))
		return { ok: false, error: "draft omits a required issue section" };
	if (
		!validText(model.title, LIMITS.title) ||
		!validText(model.summary) ||
		!validItems(model.stepsToReproduce, LIMITS.steps) ||
		!validText(model.expectedBehavior) ||
		!validText(model.actualBehavior) ||
		(model.likelyCause !== undefined && !validText(model.likelyCause)) ||
		!validText(model.recoveryWorkaround) ||
		!validText(model.suggestedFix)
	)
		return {
			ok: false,
			error: "draft fields are empty or exceed diagnostic bounds",
		};
	if (!validateMechanical(value.mechanical))
		return { ok: false, error: "mechanical provenance is malformed" };
	if (
		expectedMechanical &&
		JSON.stringify(value.mechanical) !== JSON.stringify(expectedMechanical)
	)
		return { ok: false, error: "reviser changed frozen mechanical provenance" };
	return { ok: true, draft: value as unknown as DiagnosticIssueDraft };
}

export function buildDiagnosticIssueDraft(
	evidence: DebugIssueEvidence,
): DiagnosticIssueDraft {
	const runtimeContext: DiagnosticRuntimeFact[] = [
		{ label: "Role", value: evidence.runtime.role, source: "runtime" as const },
		{ label: "Mode", value: evidence.runtime.mode, source: "runtime" as const },
		{
			label: "Execution stage",
			value: evidence.runtime.stage,
			source: "executor" as const,
		},
		{
			label: "Working directory",
			value: evidence.runtime.cwd,
			source: "runtime" as const,
		},
		...(evidence.runtime.sessionPath
			? [
					{
						label: "Session",
						value: evidence.runtime.sessionPath,
						source: "session" as const,
					},
				]
			: []),
		...(evidence.runtime.planSlug
			? [
					{
						label: "Plan",
						value: evidence.runtime.planSlug,
						source: "plan" as const,
					},
				]
			: []),
		...(evidence.runtime.deliverableId
			? [
					{
						label: "Deliverable",
						value: evidence.runtime.deliverableId,
						source: "plan" as const,
					},
				]
			: []),
		...(evidence.runtime.generation !== undefined
			? [
					{
						label: "Worker generation",
						value: String(evidence.runtime.generation),
						source: "executor" as const,
					},
				]
			: []),
		{
			label: "Node",
			value: evidence.runtime.node,
			source: "platform" as const,
		},
		{
			label: "Platform",
			value: evidence.runtime.platform,
			source: "platform" as const,
		},
		{
			label: "Architecture",
			value: evidence.runtime.architecture,
			source: "platform" as const,
		},
		{
			label: "Maestro revision",
			value: evidence.runtime.maestroRevision,
			source: "runtime" as const,
		},
	].slice(0, LIMITS.runtime);
	const observedFacts = [...evidence.observed, ...evidence.recentFailures]
		.map((item) => bounded(item, LIMITS.item))
		.filter(Boolean)
		.slice(0, LIMITS.facts);
	if (observedFacts.length === 0)
		observedFacts.push("No bounded failure evidence was available.");
	return {
		version: 1,
		model: {
			title: bounded(`Debug: ${evidence.likelyCause}`, LIMITS.title),
			summary: bounded(evidence.likelyCause, LIMITS.text),
			stepsToReproduce: [
				"Run the affected pi-maestro workflow in the runtime context below.",
				"Observe the behavior described under Actual behavior.",
			],
			expectedBehavior:
				"The workflow should complete or present a safe, actionable recovery path.",
			actualBehavior: bounded(
				observedFacts.at(-1) ?? evidence.likelyCause,
				LIMITS.text,
			),
			likelyCause: bounded(evidence.likelyCause, LIMITS.text),
			recoveryWorkaround:
				"Use the explicitly selected recovery action shown below; no other mutation was attempted.",
			suggestedFix:
				"Investigate the bounded facts and preserve the existing lifecycle, workspace, and review safety invariants.",
		},
		mechanical: {
			observedFacts,
			runtimeContext,
			recoveryOutcome: {
				attemptedAction: bounded(evidence.recovery.attemptedAction, 120),
				attemptedAt: bounded(evidence.recovery.attemptedAt, 80),
				status: evidence.recovery.status,
				detail: bounded(evidence.recovery.detail, LIMITS.text),
			},
		},
	};
}

function bulletList(items: readonly string[]): string {
	return items.map((item) => `- ${item}`).join("\n");
}

/** Deterministic Markdown; mechanical values are never regenerated by a model. */
export function renderDiagnosticIssue(draft: DiagnosticIssueDraft): string {
	const sections = [
		"## Summary",
		draft.model.summary,
		"## Steps to reproduce",
		draft.model.stepsToReproduce
			.map((step, i) => `${i + 1}. ${step}`)
			.join("\n"),
		"## Expected behavior",
		draft.model.expectedBehavior,
		"## Actual behavior",
		draft.model.actualBehavior,
		"## Observed facts",
		bulletList(draft.mechanical.observedFacts),
	];
	if (draft.model.likelyCause)
		sections.push("## Likely cause", draft.model.likelyCause);
	sections.push(
		"## Recovery / workaround",
		draft.model.recoveryWorkaround,
		`- Attempted action: \`${draft.mechanical.recoveryOutcome.attemptedAction}\``,
		`- Attempted at: \`${draft.mechanical.recoveryOutcome.attemptedAt}\``,
		`- Exact outcome: **${draft.mechanical.recoveryOutcome.status}** — ${draft.mechanical.recoveryOutcome.detail}`,
		"## Runtime context",
		draft.mechanical.runtimeContext
			.map(
				(fact) =>
					`- ${fact.label}: \`${fact.value}\` _(source: ${fact.source})_`,
			)
			.join("\n"),
		"## Suggested fix",
		draft.model.suggestedFix,
	);
	return `${sections.join("\n\n")}\n`;
}

export function redactDiagnosticIssueDraft(
	draft: DiagnosticIssueDraft,
): DiagnosticIssueDraft {
	return {
		version: 1,
		model: {
			title: redactSecrets(draft.model.title),
			summary: redactSecrets(draft.model.summary),
			stepsToReproduce: draft.model.stepsToReproduce.map(
				(item) => redactSecrets(item) ?? "[redacted]",
			),
			expectedBehavior: redactSecrets(draft.model.expectedBehavior),
			actualBehavior: redactSecrets(draft.model.actualBehavior),
			...(draft.model.likelyCause
				? { likelyCause: redactSecrets(draft.model.likelyCause) }
				: {}),
			recoveryWorkaround: redactSecrets(draft.model.recoveryWorkaround),
			suggestedFix: redactSecrets(draft.model.suggestedFix),
		},
		mechanical: {
			observedFacts: draft.mechanical.observedFacts.map(
				(item) => redactSecrets(item) ?? "[redacted]",
			),
			runtimeContext: draft.mechanical.runtimeContext.map((fact) => ({
				...fact,
				value: redactSecrets(fact.value),
			})),
			recoveryOutcome: {
				...draft.mechanical.recoveryOutcome,
				detail: redactSecrets(draft.mechanical.recoveryOutcome.detail),
			},
		},
	};
}

/** Final privacy boundary. The returned title/body are the only postable bytes. */
export function freezeDiagnosticIssue(
	draft: DiagnosticIssueDraft,
): FrozenDiagnosticIssue {
	return Object.freeze({
		title: redactSecrets(draft.model.title),
		body: redactSecrets(renderDiagnosticIssue(draft)),
	});
}

export function diagnosticDraftHash(draft: DiagnosticIssueDraft): string {
	return createHash("sha256").update(JSON.stringify(draft)).digest("hex");
}

export function appendRevisionHistory(
	history: readonly DebugIssueRevisionRecord[],
	record: DebugIssueRevisionRecord,
): readonly DebugIssueRevisionRecord[] {
	return [...history, record].slice(-LIMITS.revisions);
}

export interface DebugIssueReviserInput {
	readonly currentDraft: DiagnosticIssueDraft;
	readonly frozenEvidence: DebugIssueEvidence;
	readonly instruction: string;
}

export interface DebugIssueReviser {
	revise(input: DebugIssueReviserInput): Promise<unknown>;
}

export interface DebugIssueReviewController {
	getIssueReview(): DebugIssueReviewState | undefined;
	startIssueReview(draft: DiagnosticIssueDraft): DebugIssueReviewState;
	recordIssueRevision(
		draft: DiagnosticIssueDraft,
		instruction: string,
		at: string,
	): DebugIssueReviewState;
	cancel(): void;
}

export interface DebugIssuePostResult {
	readonly url: string | null;
	readonly error?: string;
}

export type DebugIssueReviewResult =
	| { readonly status: "posted"; readonly url: string | null }
	| { readonly status: "post-failed"; readonly error: string }
	| { readonly status: "canceled" }
	| { readonly status: "unavailable"; readonly error: string };

export function renderIssueReviewQuestions(
	id: string,
	draft: FrozenDiagnosticIssue,
): readonly Question[] {
	const actionId = `debug-issue-action-${id}`;
	return [
		{
			id: actionId,
			header: "Issue review",
			question:
				"Review the exact redacted GitHub issue, then create, revise, or cancel it.",
			context: `# ${draft.title}\n\n${draft.body}`,
			blocking: true,
			whyBlocking:
				"Creating an issue is an external mutation and requires explicit confirmation of these exact bytes.",
			options: [
				{
					label: "Create issue",
					value: "create",
					description: "Post exactly the title and body displayed above.",
				},
				{
					label: "Revise draft",
					value: "revise",
					description:
						"Run one constrained structured revision, then review again.",
				},
				{
					label: "Cancel",
					value: "cancel",
					description: "Post nothing and delete the transient debug artifact.",
				},
			],
		},
		{
			id: `debug-issue-instruction-${id}`,
			header: "Revision",
			question: "How should the structured issue draft change?",
			allowFreeText: true,
			showIf: { questionId: actionId, choice: "revise" },
		},
	];
}

function answerFor(answers: readonly Answer[], id: string): Answer | undefined {
	return answers.find((answer) => answer.questionId === id);
}

/** Unlimited because every iteration requires a new explicit user selection. */
export async function reviewAndPostDiagnosticIssue(input: {
	readonly id: string;
	readonly controller: DebugIssueReviewController;
	readonly ask: AskCapabilityV1 | undefined;
	readonly reviser: DebugIssueReviser;
	readonly evidence: DebugIssueEvidence;
	readonly initialDraft: DiagnosticIssueDraft;
	readonly post: (
		draft: FrozenDiagnosticIssue,
	) => Promise<DebugIssuePostResult>;
	readonly now?: () => string;
	readonly onRevisionError?: (error: string) => void;
}): Promise<DebugIssueReviewResult> {
	if (!input.ask)
		return {
			status: "unavailable",
			error: "issue review capability is unavailable",
		};
	let state =
		input.controller.getIssueReview() ??
		input.controller.startIssueReview(
			redactDiagnosticIssueDraft(input.initialDraft),
		);
	for (;;) {
		const frozen = freezeDiagnosticIssue(state.draft);
		const answers = await input.ask.ask(
			renderIssueReviewQuestions(input.id, frozen),
		);
		const actionId = `debug-issue-action-${input.id}`;
		const action = answerFor(answers, actionId);
		if (
			!action ||
			action.deferred ||
			action.value === "cancel" ||
			!action.value
		) {
			input.controller.cancel();
			return { status: "canceled" };
		}
		if (action.value === "create") {
			// `frozen` is the exact value shown in this question. Never re-render here.
			const result = await input.post(frozen);
			input.controller.cancel();
			return result.error
				? { status: "post-failed", error: result.error }
				: { status: "posted", url: result.url };
		}
		if (action.value !== "revise") {
			input.controller.cancel();
			return { status: "canceled" };
		}
		const instructionAnswer = answerFor(
			answers,
			`debug-issue-instruction-${input.id}`,
		);
		const instruction = instructionAnswer?.value
			?.trim()
			.slice(0, LIMITS.instruction);
		if (
			!instruction ||
			instructionAnswer?.deferred ||
			instructionAnswer?.skipped
		) {
			input.onRevisionError?.(
				"Revision instruction was empty; the prior draft was retained.",
			);
			continue;
		}
		try {
			const replacement = await input.reviser.revise({
				currentDraft: state.draft,
				frozenEvidence: input.evidence,
				instruction,
			});
			const validated = validateDiagnosticIssueDraft(
				replacement,
				state.draft.mechanical,
			);
			if (!validated.ok) throw new Error(validated.error);
			state = input.controller.recordIssueRevision(
				redactDiagnosticIssueDraft(validated.draft),
				instruction,
				(input.now ?? (() => new Date().toISOString()))(),
			);
		} catch (error) {
			input.onRevisionError?.(
				`Revision failed; the prior draft was retained: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
