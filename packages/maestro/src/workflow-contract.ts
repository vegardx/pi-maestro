/**
 * What pi-maestro requires of the workflow runtime it talks to, written down
 * here rather than imported.
 *
 * `@vegardx/pi-workflow` is an **optional** peer and is not published on npm,
 * so this package cannot import `WORKFLOW_RUNTIME_CONTRACT` — not even as a
 * type. The alternative to duplicating it is a hard dependency that breaks
 * every seat without a workflow runtime installed, which is the one thing the
 * seam exists to avoid (spec D3).
 *
 * Duplication is the defect this repository is organised against, so it is
 * bounded on purpose:
 *
 *   1. The literal below names **only** what pi-maestro actually needs — one
 *      revision and eight feature keys — not all of them, so an unrelated
 *      feature flip is not pi-maestro's business.
 *   2. `test/workflow-provider.test.ts` compares the literal against a
 *      checked-in copy of pi-workflow's own shipped constant
 *      (`test/fixtures/pi-workflow-runtime-contract.json`), so the two places
 *      cannot disagree without a test failing. The fixture is refreshed by
 *      hand when pi-workflow's revision changes; nothing generates it at
 *      build time, because there is no dependency to generate it from.
 *   3. Every contract change in pi-workflow bumps `contractRevision`, so the
 *      revision equality check catches everything the feature list does not.
 *
 * The TypeBox mirror below is the **shape** check, not the value check: it
 * says a provider handed us something that is recognisably a workflow runtime
 * contract. It is deliberately permissive about feature keys and top-level
 * fields it does not read — a runtime that grew a feature is not incompatible
 * for that reason, and if it were, the revision would have moved anyway.
 */

import { Type } from "typebox";
import { Value } from "typebox/value";

/**
 * The pi-workflow contract revision this seat was written against.
 *
 * Bumping it is a deliberate act: re-read pi-workflow's contract, refresh the
 * fixture, and check that the features below still mean what they meant.
 */
export const REQUIRED_WORKFLOW_CONTRACT_REVISION = 20;

/**
 * The features the exit loop and `/plan run` actually depend on.
 *
 * - `staticWorkflows` — `plan-to-ship` and `plan-review` are static refs.
 * - `durableRuns` — a run survives the dialog that started it.
 * - `checkpoints` — `approve-plan` and `ship` are where humans decide.
 * - `fanOut` — review lenses are a fan-out.
 * - `settledResults` — one failed reviewer degrades rather than fails the run.
 * - `finalizers` — the receipt publication reads is produced by one.
 * - `worktrees` — every write happens in a worktree, never in this tree.
 * - `serviceProviderStart` — `startBuiltin` exists, so the harness can start
 *   the plan's own run when a person answers `Start the run?` with yes. A
 *   runtime without it leaves the seat with no way to start a plan at all: the
 *   model is never asked to do it, so there is no fallback to degrade to.
 */
export const REQUIRED_WORKFLOW_FEATURES = Object.freeze([
	"staticWorkflows",
	"durableRuns",
	"checkpoints",
	"fanOut",
	"settledResults",
	"finalizers",
	"worktrees",
	"serviceProviderStart",
] as const);

export type RequiredWorkflowFeature =
	(typeof REQUIRED_WORKFLOW_FEATURES)[number];

export interface RequiredWorkflowContract {
	readonly schema: "pi-workflow-runtime";
	readonly contractRevision: number;
	readonly features: Readonly<Record<RequiredWorkflowFeature, boolean>>;
}

/**
 * pi-maestro's own frozen copy of the part of `WORKFLOW_RUNTIME_CONTRACT` it
 * depends on (spec 2.4, decision D3).
 */
export const REQUIRED_WORKFLOW_CONTRACT: RequiredWorkflowContract =
	Object.freeze({
		schema: "pi-workflow-runtime",
		contractRevision: REQUIRED_WORKFLOW_CONTRACT_REVISION,
		features: Object.freeze({
			staticWorkflows: true,
			durableRuns: true,
			checkpoints: true,
			fanOut: true,
			settledResults: true,
			finalizers: true,
			worktrees: true,
			serviceProviderStart: true,
		}),
	});

/**
 * The local mirror of `WorkflowRuntimeContractSchema`.
 *
 * `requiredSubagent` is mirrored structurally and **not** compared: which
 * pi-subagent revision the workflow runtime needs is a conversation between
 * those two packages. pi-maestro never calls pi-subagent, so a mismatch there
 * is not pi-maestro's refusal to make — but a contract that has no
 * `requiredSubagent` at all is not this contract, so the shape is checked.
 *
 * `serviceProviderStart` is deliberately NOT named here, although
 * `REQUIRED_WORKFLOW_FEATURES` requires it. A pi-workflow that predates
 * `startBuiltin` is still recognisably a workflow runtime contract, and it
 * should be refused by `workflowContractMismatch` — which names the feature and
 * the value this seat needs — rather than by the shape check, whose only answer
 * is "that is not a workflow runtime contract".
 */
export const WorkflowRuntimeContractMirror = Type.Object({
	schema: Type.Literal("pi-workflow-runtime"),
	contractRevision: Type.Integer({ minimum: 1 }),
	requiredSubagent: Type.Object({
		schema: Type.Literal("pi-subagent-runtime"),
		contractRevision: Type.Integer({ minimum: 1 }),
		features: Type.Record(Type.String(), Type.Boolean()),
	}),
	features: Type.Object(
		{
			staticWorkflows: Type.Boolean(),
			durableRuns: Type.Boolean(),
			checkpoints: Type.Boolean(),
			fanOut: Type.Boolean(),
			settledResults: Type.Boolean(),
			finalizers: Type.Boolean(),
			worktrees: Type.Boolean(),
		},
		{ additionalProperties: Type.Boolean() },
	),
});

/**
 * The declared contract of a workflow runtime, as far as pi-maestro reads it.
 * Extra feature keys are real and simply unread here.
 */
export interface WorkflowRuntimeContractView {
	readonly schema: "pi-workflow-runtime";
	readonly contractRevision: number;
	readonly requiredSubagent: {
		readonly schema: "pi-subagent-runtime";
		readonly contractRevision: number;
		readonly features: Readonly<Record<string, boolean>>;
	};
	readonly features: Readonly<Record<string, boolean>>;
}

/** Whether `value` is shaped like a workflow runtime contract at all. */
export function isWorkflowRuntimeContractShape(
	value: unknown,
): value is WorkflowRuntimeContractView {
	try {
		return Value.Check(WorkflowRuntimeContractMirror, value);
	} catch {
		return false;
	}
}

/**
 * Why this contract is not the one pi-maestro was built against, or
 * `undefined` when it is.
 *
 * A sentence rather than a boolean, because every caller of this turns it
 * into a warning a human reads, and "incompatible" without a reason is a
 * message that sends someone to the source.
 */
export function workflowContractMismatch(value: unknown): string | undefined {
	if (!isWorkflowRuntimeContractShape(value)) {
		return "its declared contract is not a pi-workflow runtime contract";
	}
	if (value.contractRevision !== REQUIRED_WORKFLOW_CONTRACT.contractRevision) {
		return `it declares contract revision ${value.contractRevision}, and this seat was built against ${REQUIRED_WORKFLOW_CONTRACT.contractRevision}`;
	}
	for (const feature of REQUIRED_WORKFLOW_FEATURES) {
		const declared = value.features[feature];
		const required = REQUIRED_WORKFLOW_CONTRACT.features[feature];
		if (declared !== required) {
			return `it declares \`${feature}: ${String(declared)}\`, and this seat needs \`${String(required)}\``;
		}
	}
	return undefined;
}

/** Whether the runtime behind `value` is one this seat may call. */
export function isCompatibleWorkflowContract(
	value: unknown,
): value is WorkflowRuntimeContractView {
	return workflowContractMismatch(value) === undefined;
}
