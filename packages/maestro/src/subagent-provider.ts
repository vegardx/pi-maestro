// The plan check, as one delegated attempt.
//
// The check is a ONE-SHOT SUBAGENT and not a workflow run. A workflow run would
// mean a definition, a journal, a budget lease and a lifecycle for something
// that reads a document once and answers; pi-subagent already has exactly that
// shape — preflight, launch, wait, structured output — and the shared service is
// on the bus in every seat that loads it.
//
// It is acquired the way pi-workflow acquires it (`subagent-provider.ts` there):
// `acquireSubagentService(pi.events, ctx)`, then `forOwner` for a client bound
// to an owner id that says who asked. Unlike the workflow seam, THIS package
// imports pi-subagent for real — an exact peer pin — because the delegation
// ceiling is registered through pi-subagent's own function, and a locally
// declared copy of that would be a second definition of the one bound.
//
// FOUR THINGS ARE PINNED ON THE REQUEST, and each of them is the point:
//
//   - `agent: "plan-reviewer"` with `agentRoots` pointing at this package's own
//     `agents/` directory, so the definition the check runs is the one shipped
//     beside this file rather than whatever a project happens to have.
//   - `contextMode: "fresh"` and the definition's empty `contextScopes`: the
//     reviewer has not read the conversation, `AGENTS.md`, or anything else.
//     A reviewer who inherited the conversation agrees with it.
//   - `outputSchema: PlanCheckOutputSchema`, so findings come back as data.
//   - `ceiling: { workspaceModes: ["read-only"] }`. The check never writes,
//     whatever mode the seat is in — the ceiling is the bound, not a request,
//     and pi-subagent refuses a launch above it by name.
//
// NOTHING HERE THROWS AT THE CALLER. Every failure — no runtime, a refused
// launch, a timeout, an output this seat cannot read — becomes
// `{unavailable: <one sanitized sentence>}`, which the confirmation prints and
// the person decides around. A plan check that could block a hand-off by being
// broken would be a worse check than none.

import { fileURLToPath } from "node:url";
import type {
	EventBus,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	CONTRACT_REVISION,
	SUBAGENT_RUNTIME_CONTRACT,
	type SubagentRuntimeContract,
} from "@vegardx/pi-subagent";
import {
	acquireSubagentService,
	SubagentServiceProviderError,
} from "@vegardx/pi-subagent/service-provider";
import type { DelegationCeiling, WorkspaceMode } from "./mode.js";
import type { Plan } from "./plan.js";
import {
	type PlanCheck,
	PlanCheckOutputSchema,
	type PlanCheckResult,
	type PlanCheckUnavailable,
	readPlanCheckResult,
} from "./plan-check.js";
import { planDigest } from "./plan-input.js";

// ── What crosses the boundary, declared here ─────────────────────────────────
//
// pi-subagent publishes four entries and `launch-contracts` is not one of them,
// so `SubagentRequest`, `DelegationCeiling`, `SubagentService` and
// `SubagentClient` are NOT importable types. They are declared below, narrowed
// to exactly what this file builds and calls — the same bargain
// `workflow-provider.ts` makes with pi-workflow, for a different reason: there
// the package may be absent, here the types are simply not exported.
//
// The functions ARE importable, and they are re-typed once, here, against this
// package's own copy of `@earendil-works/pi-coding-agent`. pi-subagent resolves
// its own copy at a different version, so `EventBus` and `ExtensionContext` are
// the same shapes from two module graphs and nominally distinct. ONE cast, at
// the one call, rather than a cast at every use.

/** One launch, as far as this file builds one. */
export interface SubagentLaunchRequest {
	readonly operationId: string;
	readonly agent: string;
	readonly agentRoots?: string[];
	readonly task: {
		readonly goal: string;
		readonly context: string[];
		readonly instructions: string[];
	};
	readonly contextMode: "fresh" | "fork";
	readonly tools: string[];
	readonly preloadSkills: string[];
	readonly contextScopes: ("global" | "project")[];
	readonly workspace: { readonly mode: WorkspaceMode; readonly cwd: string };
	readonly ceiling?: DelegationCeiling;
	readonly outputSchema?: unknown;
	readonly limits: {
		readonly cumulativeRuntimeMs: number;
		readonly attemptTimeoutMs: number;
		readonly totalTokens?: number;
		readonly cost: number;
		readonly outputBytes: number;
		readonly workspaceWriteBytes: number;
		readonly retries: number;
		readonly resumes: number;
	};
}

/** What `preflight` hands back, as far as `launch` needs it. */
interface PreflightView {
	readonly preflightId: string;
	readonly identitySha256: string;
}

/** What an attempt ended as, as far as the check reads it. */
interface AttemptView {
	readonly result: {
		readonly status: string;
		readonly structuredOutput?: unknown;
		readonly failure?: { readonly code: string };
	};
	readonly structuredOutput?: unknown;
}

/** The owner client, narrowed to the four calls one check makes. */
interface SubagentClientPort {
	preflight(request: SubagentLaunchRequest): Promise<PreflightView>;
	launch(
		preflightId: string,
		expectedIdentitySha256: string,
	): Promise<{ readonly runId: string }>;
	wait(runId: string): Promise<AttemptView>;
	interrupt(runId: string): Promise<unknown>;
}

interface SubagentServicePort {
	forOwner(owner: {
		readonly id: string;
		readonly parentSessionId?: string;
	}): SubagentClientPort;
}

/**
 * `acquireSubagentService`, re-typed against this package's pi-coding-agent.
 *
 * The one cast in this file. It is a cast about WHICH COPY of a type, not about
 * what the function does: the value is pi-subagent's own export, and the shapes
 * on both sides of it are the same shapes.
 */
const acquireService = acquireSubagentService as unknown as (
	events: EventBus,
	context: ExtensionContext,
) => Promise<SubagentServicePort>;

/** The definition this check runs, shipped in this package's `agents/`. */
export const PLAN_REVIEWER_AGENT = "plan-reviewer";

/** The owner every plan-check run is registered under. */
export const PLAN_CHECK_OWNER_ID = "pi-maestro:plan-check";

/**
 * How long the check may take before the hand-off stops waiting for it.
 *
 * The bound is the flow's, not the runtime's: `limits.attemptTimeoutMs` below
 * stops the attempt, and this stops WAITING for it, because a person standing in
 * front of `/mode auto` is the thing being spent here. The two are the same
 * number so that a timeout means one thing.
 */
export const PLAN_CHECK_TIMEOUT_MS = 600_000;

/**
 * What one check may spend.
 *
 * `workspaceWriteBytes: 0` says in the request what the read-only workspace and
 * the ceiling already say: this attempt writes nothing. `retries` and `resumes`
 * are zero because the harness has its own bound — two rewrites — and a retry
 * underneath it would spend somebody's budget twice on the same reading.
 */
export const PLAN_CHECK_LIMITS = Object.freeze({
	cumulativeRuntimeMs: PLAN_CHECK_TIMEOUT_MS,
	attemptTimeoutMs: PLAN_CHECK_TIMEOUT_MS,
	totalTokens: 2_000_000,
	cost: 5,
	outputBytes: 262_144,
	workspaceWriteBytes: 0,
	retries: 0,
	resumes: 0,
});

/** The ceiling a plan check always launches under, whatever mode the seat is in. */
export const PLAN_CHECK_CEILING: Readonly<DelegationCeiling> = Object.freeze({
	workspaceModes: ["read-only"] as WorkspaceMode[],
});

// ── The contract this seat was built against ─────────────────────────────────

export const REQUIRED_SUBAGENT_CONTRACT_REVISION = 8;

/**
 * The features the plan check depends on.
 *
 * Short on purpose: an unrelated feature flip in pi-subagent is not pi-maestro's
 * business, and the revision equality below catches everything this list does
 * not.
 */
export const REQUIRED_SUBAGENT_FEATURES = Object.freeze([
	"preflight",
	"idempotentLaunch",
	"structuredOutput",
	"agentRootsFirst",
	"delegationCeiling",
] as const);

/**
 * Why the installed pi-subagent is not the one this seat was built against, or
 * `undefined` when it is.
 *
 * A sentence rather than a boolean, for the same reason
 * `workflowContractMismatch` gives one: this becomes a line in a confirmation
 * that a person reads, and "incompatible" without a reason sends somebody to the
 * source. The dependency is an exact pin, so a mismatch here means the installed
 * tree moved without this file moving with it.
 */
export function subagentContractMismatch(
	contract: SubagentRuntimeContract = SUBAGENT_RUNTIME_CONTRACT,
): string | undefined {
	if (contract.contractRevision !== REQUIRED_SUBAGENT_CONTRACT_REVISION)
		return `the installed pi-subagent declares contract revision ${contract.contractRevision}, and this seat was built against ${REQUIRED_SUBAGENT_CONTRACT_REVISION}`;
	for (const feature of REQUIRED_SUBAGENT_FEATURES)
		if (contract.features[feature] !== true)
			return `the installed pi-subagent declares \`${feature}: false\`, and the plan check needs it`;
	return undefined;
}

// ── The request ──────────────────────────────────────────────────────────────

/**
 * This package's own `agents/` directory, absolute.
 *
 * From `import.meta.url` rather than from a configured path: the definition the
 * check runs ships beside this file, and a path a host could set would be a
 * second answer to "which reviewer is this".
 */
export function maestroAgentsDir(): string {
	return fileURLToPath(new URL("../agents", import.meta.url));
}

/**
 * The operation this check is, named so a retry is the same launch.
 *
 * The plan's digest and the round: pi-subagent's `launch` is idempotent per
 * operation id, so a flow that asked twice for the same bytes gets one run —
 * and a rewrite, which changes the digest, is honestly a different reading.
 */
export function planCheckOperationId(plan: Plan, round: number): string {
	return `${PLAN_CHECK_OWNER_ID}:${planDigest(plan).slice(0, 16)}:${round}`;
}

export interface PlanCheckRequestInput {
	readonly plan: Plan;
	readonly description: string;
	/** The repository the reviewer may read. */
	readonly cwd: string;
	readonly round: number;
	readonly agentRoots?: readonly string[];
}

/**
 * The launch request, built from the plan and the description and nothing else.
 *
 * A pure function so a test can read every pinned field without a runtime —
 * which is the only way "the reviewer cannot see the conversation" is a check
 * rather than a claim.
 */
export function planCheckRequest(
	input: PlanCheckRequestInput,
): SubagentLaunchRequest {
	return {
		operationId: planCheckOperationId(input.plan, input.round),
		agent: PLAN_REVIEWER_AGENT,
		agentRoots: [...(input.agentRoots ?? [maestroAgentsDir()])],
		task: {
			goal:
				`Check the plan \`${input.plan.slug}\` against the description it is meant to serve,` +
				" and report findings. You did not write this plan and you were not in the" +
				" conversation it came from.",
			context: [
				`The description we agreed this plan is for:\n\n${input.description}`,
				`The plan document, as stored:\n\n${JSON.stringify(input.plan, null, 2)}`,
			],
			instructions: [
				"Answer with the structured output alone: a verdict, the findings, and" +
					" short notes. Nothing you write starts anything.",
				"Mark `needsPerson` on a finding only another person can answer — a" +
					" trade-off nobody has made, or intent the document cannot settle." +
					" Everything else blocking goes back to the plan's author to rewrite," +
					" so give it a `direction`.",
			],
		},
		contextMode: "fresh",
		tools: ["read", "grep", "find", "ls"],
		preloadSkills: [],
		contextScopes: [],
		workspace: { mode: "read-only", cwd: input.cwd },
		ceiling: {
			workspaceModes: [...(PLAN_CHECK_CEILING.workspaceModes ?? [])],
		},
		outputSchema: PlanCheckOutputSchema,
		limits: { ...PLAN_CHECK_LIMITS },
	};
}

// ── The seam's implementation ────────────────────────────────────────────────

/** The one sentence a seat with no reachable reviewer gets. */
export const UNAVAILABLE_REFUSED = "the subagent runtime refused this launch";
export const UNAVAILABLE_UNREADABLE =
	"the reviewer answered with an output this seat could not read";
export const UNAVAILABLE_ABORTED = "the check was stopped";

export function unavailableTimeout(timeoutMs: number): string {
	return `the reviewer did not finish within ${Math.round(timeoutMs / 1000)}s`;
}

export interface SubagentPlanCheckDeps {
	/** Pi's shared bus, where pi-subagent answers discovery. */
	readonly events: EventBus;
	/** The live session, which is what `acquire` is given. */
	readonly context: () => ExtensionContext | undefined;
	/** The repository the reviewer may read. */
	readonly cwd: string;
	readonly agentRoots?: readonly string[];
	readonly timeoutMs?: number;
	/** The session's own id for this seat, for the owner registration. */
	readonly sessionId?: () => string | undefined;
}

/**
 * pi-subagent's own error, recognised across the module boundary.
 *
 * `instanceof` works here — this package imports pi-subagent — but the check is
 * by `name` as well, because the service may have been built from a differently
 * resolved copy of the package and a wrong answer to "is this pi-subagent's own
 * refusal?" decides whether its message reaches a person.
 */
function providerRefusal(error: unknown): string | undefined {
	if (error instanceof SubagentServiceProviderError) return error.message;
	if (
		typeof error === "object" &&
		error !== null &&
		(error as { name?: unknown }).name === "SubagentServiceProviderError" &&
		typeof (error as { message?: unknown }).message === "string"
	)
		return (error as { message: string }).message;
	return undefined;
}

/**
 * The plan check, against the shared pi-subagent service.
 *
 * One attempt per call, and the round is what makes two calls in one hand-off
 * two launches rather than one replayed receipt.
 */
export function createSubagentPlanCheck(
	deps: SubagentPlanCheckDeps,
): PlanCheck {
	const timeoutMs = deps.timeoutMs ?? PLAN_CHECK_TIMEOUT_MS;
	let round = 0;
	const unavailable = (reason: string): PlanCheckUnavailable => ({
		unavailable: reason,
	});

	return async (plan, description, signal) => {
		const mismatch = subagentContractMismatch();
		if (mismatch) return unavailable(mismatch);
		const context = deps.context();
		if (!context)
			return unavailable(
				"this session has no live context to acquire the subagent runtime with",
			);
		if (signal?.aborted) return unavailable(UNAVAILABLE_ABORTED);

		const attempt = round++;
		try {
			const service = await acquireService(deps.events, context);
			const client = service.forOwner({
				id: PLAN_CHECK_OWNER_ID,
				...(deps.sessionId?.()
					? { parentSessionId: deps.sessionId() as string }
					: {}),
			});
			const request = planCheckRequest({
				plan,
				description,
				cwd: deps.cwd,
				round: attempt,
				...(deps.agentRoots ? { agentRoots: deps.agentRoots } : {}),
			});
			const preflight = await client.preflight(request);
			if (signal?.aborted) return unavailable(UNAVAILABLE_ABORTED);
			const receipt = await client.launch(
				preflight.preflightId,
				preflight.identitySha256,
			);
			// THE WAIT IS BOUNDED HERE, because `wait` is not: a person is standing
			// in front of this. Whichever way it ends, the run is interrupted so the
			// attempt does not go on spending after nobody is listening.
			const result = await Promise.race([
				client.wait(receipt.runId),
				new Promise<"timeout">((resolve) => {
					const timer = setTimeout(() => resolve("timeout"), timeoutMs);
					(timer as { unref?: () => void }).unref?.();
					signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							resolve("timeout");
						},
						{ once: true },
					);
				}),
			]);
			if (result === "timeout") {
				await client.interrupt(receipt.runId).catch(() => undefined);
				return unavailable(
					signal?.aborted ? UNAVAILABLE_ABORTED : unavailableTimeout(timeoutMs),
				);
			}
			if (result.result.status !== "completed")
				return unavailable(
					`the reviewer ended \`${result.result.status}\`${
						result.result.failure ? ` (${result.result.failure.code})` : ""
					}`,
				);
			const read = readPlanCheckResult(
				result.structuredOutput ?? result.result.structuredOutput,
			);
			return read ?? unavailable(UNAVAILABLE_UNREADABLE);
		} catch (error) {
			// pi-subagent's own refusals are literals it wrote; anything else may
			// carry a path, a key or a stack, and none of that is evidence about a
			// plan.
			return unavailable(providerRefusal(error) ?? UNAVAILABLE_REFUSED);
		}
	};
}

/** What this module was built against, for a caller that wants to say so. */
export const INSTALLED_SUBAGENT_CONTRACT_REVISION: number = CONTRACT_REVISION;

/** Narrowed for a test: the result type without the runtime. */
export type PlanCheckAnswer = PlanCheckResult | PlanCheckUnavailable;
