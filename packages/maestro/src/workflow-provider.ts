/**
 * The consumer side of the workflow provider seam (spec 1.1, 2.4).
 *
 * `@vegardx/pi-workflow` registers a frozen `{contract, acquire(context)}` on
 * Pi's event bus. This module is the other end: it asks the bus who is there,
 * refuses a runtime it was not built against, and hands the hand-off a client
 * that reads everything and starts exactly two allowlisted things.
 *
 * **No import from pi-workflow, of any kind.** The package is an optional
 * peer and is not published on npm, so neither a value import nor a
 * `import type` resolves in a seat that does not have it — and the seat that
 * does not have it is the normal case this seam exists to keep working. The
 * request channel, the request schema and the client surface below are
 * therefore **declared here**, and they are the contract: if pi-workflow
 * changes any of them, this file is wrong and discovery fails loudly rather
 * than quietly mis-calling. `workflow-contract.ts` carries the same bargain
 * for the runtime contract, with a checked-in fixture proving the copy still
 * matches the original.
 *
 * What crosses the seam is narrow on purpose: read, validate, project,
 * observe, and start the one plan workflow a person has just said yes to.
 * There is no `decide`, `stop` or general `run` here: the one start is
 * allowlisted by name inside the runtime, and every other way of starting a
 * workflow is still a tool call in the open, in the transcript.
 *
 * **`startBuiltin` is the seat acting, never the model.** It starts
 * `plan-to-ship`, which writes to worktrees, and the seat may call it because a
 * human answered `Start the run?` with yes in a dialog this seat owns — the
 * model is not in that loop at all.
 *
 * **Nothing in this module throws into the session.** Every failure — no
 * runtime, two runtimes, a wrong revision, a runtime swapped mid-acquisition,
 * a refusal from the runtime itself — becomes one `notify(…, "warning")`
 * naming what a human can do instead, and a `undefined` return. A seat with
 * no workflow runtime is a working seat.
 */

import type { DelegationCeiling } from "./mode.js";
import type { Effort } from "./plan-input.js";
import {
	isWorkflowRuntimeContractShape,
	type WorkflowRuntimeContractView,
	workflowContractMismatch,
} from "./workflow-contract.js";

/** Pi's event bus, as much of it as this module uses. */
export interface WorkflowEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

/**
 * The versioned discovery channel pi-workflow answers on, and the request
 * schema it recognises. Both are literals from
 * `@vegardx/pi-workflow/service-provider`; a mismatch here is a silent
 * `missing`, which is why they are named constants and not inline strings.
 */
export const WORKFLOW_SERVICE_REQUEST_CHANNEL =
	"@vegardx/pi-workflow/service-provider/request/v1";
export const WORKFLOW_SERVICE_REQUEST_SCHEMA = "pi-workflow-service-request-v1";

// ── The client surface, declared locally ─────────────────────────────────────
//
// These types are pi-maestro's statement of what it calls, not a copy of
// pi-workflow's view schemas. Result shapes name the fields this seat reads
// and stop there: reproducing every projection field would be a second full
// contract to keep in step, and the seat neither reads nor validates them.

/** One discovered static definition, as far as the seat reads it. */
export interface WorkflowDefinitionSummaryView {
	readonly name: string;
	readonly description: string;
	readonly version: number;
	readonly scope: string;
	readonly identitySha256: string;
}

/** `validate` resolves a ref and, given an input, checks it against the schema. */
export interface WorkflowValidationView {
	readonly valid: true;
	readonly workflow: WorkflowDefinitionSummaryView;
}

/** The lease-free budget projection a caller may ask the runtime for. */
export interface WorkflowBudgetProjectionView {
	readonly cost: number;
	readonly totalTokens: number;
	readonly childRuntimeMs: number;
	readonly tasks: number;
	readonly fits: boolean;
}

/**
 * What `startBuiltin` hands back.
 *
 * The run id and nothing else, because that is all `startBuiltin` promises: it
 * returns as soon as the run exists, before there is a status worth reading,
 * and the run starts working — starting it was the approval, so there is
 * nothing to park for.
 */
export interface WorkflowStartReceiptView {
	readonly runId: string;
}

/**
 * The kinds a narrator branches on, mirroring pi-workflow's
 * `NARRATED_TASK_KINDS`.
 *
 * NOT the runtime's four execution kinds (`agent`, `support`, `workflow`,
 * `checkpoint`), which say nothing about what a task was for. pi-workflow derives
 * this from the stage key alone, as a view, so it costs a run nothing; `other` is
 * the honest answer for a key its convention does not name and is never an error.
 */
export const NARRATED_TASK_KINDS = [
	"implement",
	"check",
	"review",
	"synthesis",
	"fix",
	"gate",
	"refine",
	"other",
] as const;

export type NarratedTaskKind = (typeof NARRATED_TASK_KINDS)[number];

/** pi-workflow's `MAX_NARRATION_SUMMARY_LENGTH`: one paragraph, never a report. */
export const MAX_NARRATION_SUMMARY_LENGTH = 1024;

/**
 * What a host needs to narrate ONE task, mirroring
 * `WorkflowTaskNarrationSchema`.
 *
 * `summary` IS ARTIFACT-BACKED AND IS NEVER ON AN OBSERVATION. An observation is
 * a synchronous notice on a durable append that reads no file; a summary is the
 * task's committed result, which lives in an artifact. A host that wants it makes
 * one `inspect(runId, {include: ["tasks", "output"]})` call once the observation
 * has told it which task to look at. `cause` is journal-derived and is on both.
 */
export interface WorkflowTaskNarrationView {
	/** `${namespace.join("/")}/${key}` — the stage key, as one string. */
	readonly stage: string;
	readonly taskKind: NarratedTaskKind;
	/** The deliverable the stage key names, when it names one. */
	readonly deliverable?: string;
	/** Artifact-backed: present on an inspection, never on an observation. */
	readonly summary?: string;
	/** For a task that did not complete: why, sanitized. */
	readonly cause?: string;
}

/** The settled task an observation is about, mirroring `WorkflowObservedTaskSchema`. */
export interface WorkflowObservedTaskView {
	readonly taskId: string;
	readonly status: string;
	readonly outcome?: string;
	readonly narration: WorkflowTaskNarrationView;
}

/**
 * One append to an owned run, as delivered to an `observe` listener.
 *
 * `runId`, `status` and `sequence` are every append's. `task` is present on the
 * append that moved a task to a terminal status, AND ONLY THEN — an observation
 * is one notice per append, so a host narrating completions filters on this field
 * rather than on an event type it cannot see. `narrate.ts` is the single place it
 * is read.
 */
export interface WorkflowRunObservationView {
	readonly runId: string;
	readonly status: string;
	readonly sequence: number;
	readonly task?: WorkflowObservedTaskView;
}

/** One projected task, as far as narration reads an inspection. */
export interface WorkflowInspectedTaskView {
	readonly id: string;
	readonly narration?: WorkflowTaskNarrationView;
}

/**
 * The client (spec 2.4). `inspect` and `runs` are typed loosely on
 * purpose: the seat passes their results through to rendering and narrows at
 * the point of use rather than restating pi-workflow's inspection schema here.
 */
export interface WorkflowReadClient {
	list(): Promise<readonly WorkflowDefinitionSummaryView[]>;
	validate(ref: string, input?: unknown): Promise<WorkflowValidationView>;
	project(ref: string, input: unknown): Promise<WorkflowBudgetProjectionView>;
	/**
	 * Lease-free bounded projection of one run.
	 *
	 * `unknown` on purpose: publication narrows its own sections at the point of
	 * use rather than restating pi-workflow's inspection schema here, and
	 * narration narrows `tasks[].narration` through
	 * {@link WorkflowInspectedTaskView}. With `include` carrying both `"tasks"`
	 * and `"output"` every projected task carries `narration.summary`, which is
	 * the one call a host makes when it wants to say what a task said.
	 */
	inspect(runId: string, options?: unknown): Promise<unknown>;
	runs(query?: unknown): Promise<unknown>;
	observe(
		listener: (observation: WorkflowRunObservationView) => void,
	): () => void;
	/**
	 * Starts `plan-to-ship` for a plan the person just approved, and refuses
	 * every other ref by name. Validates `input` the way `workflow_run` does,
	 * returns as soon as the run exists, and the run starts working: the person
	 * who asked for it has already approved the plan, so the next stop is the
	 * `ship` decision (or each deliverable, under `every-deliverable`).
	 * The runtime journals it with origin `"service-provider"`, so a run this
	 * seat started is never mistaken for one the model started.
	 *
	 * `ceiling` is THE MODE'S, in pi-subagent's vocabulary, and the runtime
	 * refuses a start whose definition needs more than it allows — naming both
	 * the need and the bound. That refusal is why this seat no longer withholds
	 * `workflow_run` from the model by name in plan mode: the bound is a fact
	 * about the launch, checked where launches happen, rather than a tool
	 * allowlist maintained here.
	 */
	startBuiltin(
		ref: string,
		options: {
			readonly input: unknown;
			readonly effort?: Effort;
			readonly ceiling?: DelegationCeiling;
		},
	): Promise<WorkflowStartReceiptView>;
}

/**
 * Every run status that means the run will not change again.
 *
 * Part of the runtime's vocabulary rather than of any one caller's, because two
 * callers read it — publication, which acts on a finished run, and narration,
 * which says a run is over — and two copies of "what does finished mean" is
 * exactly the drift this file exists to prevent.
 */
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
	"completed",
	"failed",
	"cancelled",
	"expired",
]);

/**
 * Every method the client must have; a missing one is `incompatible`.
 *
 * WHAT THIS SEAT CALLS, not everything the runtime offers. pi-workflow's client
 * also has `awaitRun` and `hostCeiling`, and neither is here.
 *
 * `hostCeiling()` is deliberately not called: it answers for the mode the
 * provider is in NOW, and the hand-off starts the run while the posture is
 * switching, so the bound that matters is `modeCeiling(deps.wanted)` — the mode
 * being switched TO — which this seat computes itself and passes explicitly.
 * Showing the host's answer beside the confirmation would show the wrong bound.
 */
const CLIENT_METHODS = [
	"list",
	"validate",
	"project",
	"inspect",
	"runs",
	"observe",
	"startBuiltin",
] as const satisfies readonly (keyof WorkflowReadClient)[];

/** The provider object pi-workflow registers. */
export interface WorkflowServiceProviderView {
	readonly contract: WorkflowRuntimeContractView;
	acquire(context: unknown): Promise<unknown>;
}

// ── Failures ────────────────────────────────────────────────────────────────

/**
 * Everything that can go wrong on this side of the seam.
 *
 * `validation` is the runtime's own refusal passed through — a `startBuiltin`
 * for a ref outside its allowlist, or an input that does not fit the
 * definition's schema. `acquisition` is the catch-all: the runtime was reached
 * and did not give an answer this seat can use.
 */
export type WorkflowProviderErrorCode =
	| "missing"
	| "duplicate"
	| "incompatible"
	| "replaced"
	| "validation"
	| "acquisition";

export class WorkflowProviderError extends Error {
	constructor(
		readonly code: WorkflowProviderErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "WorkflowProviderError";
	}
}

/**
 * What a human can do instead, which is the only part of a warning that is
 * worth reading.
 *
 * ONE SENTENCE, because there is one fallback: every failure on this seam means
 * the run is out of reach, and the stored plan and `/plan run` are what remain.
 * There used to be a second — the blind reviewer's — and the plan check does
 * not come through here at all: it is a one-shot subagent, and its own
 * unavailability is a line in the confirmation rather than a warning about a
 * runtime.
 */
export const WORKFLOW_FALLBACK_HINT =
	"The plan is stored — start it later with `/plan run <slug>`.";

/**
 * pi-workflow's own `WorkflowServiceError` crosses the seam as a plain object
 * from another module graph, so `instanceof` cannot see it. Its `name` and
 * `code` can.
 */
function serviceErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const candidate = error as { name?: unknown; code?: unknown };
	if (candidate.name !== "WorkflowServiceError") return undefined;
	return typeof candidate.code === "string" ? candidate.code : undefined;
}

function messageOf(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "string" && error) return error;
	return "The workflow runtime could not complete the request.";
}

/**
 * Any thrown thing, as one of this seat's six codes.
 *
 * A runtime refusal whose code is not `validation` (`not-found`, `conflict`,
 * `persistence`, `execution`) is `acquisition`: the seat asked and did not get
 * a usable answer. Its own message travels with it, so the warning still says
 * which of those it was.
 */
export function classifyWorkflowFailure(
	error: unknown,
): WorkflowProviderErrorCode {
	if (error instanceof WorkflowProviderError) return error.code;
	if (serviceErrorCode(error) === "validation") return "validation";
	return "acquisition";
}

/** The warning text for a failure, naming the fallback. */
export function workflowProviderWarning(error: unknown): string {
	const code = classifyWorkflowFailure(error);
	return `Workflow runtime unavailable (${code}): ${messageOf(error)} ${WORKFLOW_FALLBACK_HINT}`;
}

/** Just enough of `ExtensionUIContext` to report, so tests pass a fake. */
export type WorkflowNotify = (
	message: string,
	type?: "info" | "warning" | "error",
) => void;

/**
 * Report a failure and return nothing.
 *
 * Always `"warning"`, never `"error"`: an absent or mismatched workflow
 * runtime is a reduced seat, not a broken one, and the message says what to do
 * instead. A `notify` that throws is swallowed — the point of this function is
 * that the caller keeps going.
 */
export function reportWorkflowFailure(
	notify: WorkflowNotify,
	error: unknown,
): void {
	try {
		notify(workflowProviderWarning(error), "warning");
	} catch {
		// A host whose notifier fails must not turn a degraded path into a
		// thrown one; there is nowhere left to report it.
	}
}

// ── Discovery ───────────────────────────────────────────────────────────────

function hasClientMethods(value: unknown): value is WorkflowReadClient {
	if (typeof value !== "object" || value === null) return false;
	try {
		return CLIENT_METHODS.every(
			(method) =>
				typeof (value as Record<string, unknown>)[method] === "function",
		);
	} catch {
		return false;
	}
}

/**
 * The three compatibility checks, in the order pi-workflow makes them of
 * pi-subagent: `acquire` is callable, the declared contract is a runtime
 * contract, and every feature this seat requires equals the provider's.
 */
export function isCompatibleWorkflowProvider(
	value: unknown,
): value is WorkflowServiceProviderView {
	if (typeof value !== "object" || value === null) return false;
	try {
		const provider = value as Partial<WorkflowServiceProviderView>;
		if (typeof provider.acquire !== "function") return false;
		if (!isWorkflowRuntimeContractShape(provider.contract)) return false;
		return workflowContractMismatch(provider.contract) === undefined;
	} catch {
		return false;
	}
}

/**
 * Ask the bus who is registered, and accept exactly one compatible answer.
 *
 * `emit` is synchronous, so every handler has run by the time it returns and
 * `providers` is complete. Two providers is a refusal rather than a choice:
 * picking one would mean a run landing in whichever runtime loaded first.
 */
export function discoverWorkflowProvider(
	events: WorkflowEventBus,
): WorkflowServiceProviderView {
	const providers: unknown[] = [];
	events.emit(WORKFLOW_SERVICE_REQUEST_CHANNEL, {
		schema: WORKFLOW_SERVICE_REQUEST_SCHEMA,
		respond(provider: unknown) {
			providers.push(provider);
		},
	});
	if (providers.length === 0) {
		throw new WorkflowProviderError(
			"missing",
			"No workflow runtime is registered in this session; `@vegardx/pi-workflow` is an optional peer.",
		);
	}
	if (providers.length !== 1) {
		throw new WorkflowProviderError(
			"duplicate",
			`Expected one workflow runtime, ${providers.length} answered discovery.`,
		);
	}
	const provider = providers[0];
	if (!isCompatibleWorkflowProvider(provider)) {
		const reason =
			typeof provider === "object" &&
			provider !== null &&
			typeof (provider as { acquire?: unknown }).acquire !== "function"
				? "it does not offer an `acquire` function"
				: (workflowContractMismatch(
						(provider as { contract?: unknown } | null)?.contract,
					) ?? "it is not a workflow service provider");
		throw new WorkflowProviderError(
			"incompatible",
			`The registered workflow runtime cannot be used: ${reason}.`,
		);
	}
	return provider;
}

/**
 * Discover, acquire, and discover again.
 *
 * The second discovery is the `replaced` check: an extension that registered
 * while `acquire` was awaited would leave this seat holding a client from a
 * runtime that is no longer the one on the bus. Refusing is the only honest
 * answer — the seat cannot know which of the two the human meant.
 *
 * Throws `WorkflowProviderError`; callers that must not throw use
 * {@link acquireWorkflowClientOrWarn}.
 */
export async function acquireWorkflowClient(
	events: WorkflowEventBus,
	context: unknown,
): Promise<WorkflowReadClient> {
	const provider = discoverWorkflowProvider(events);
	let client: unknown;
	try {
		client = await provider.acquire(context);
	} catch (error) {
		if (error instanceof WorkflowProviderError) throw error;
		if (serviceErrorCode(error) === "validation") {
			throw new WorkflowProviderError("validation", messageOf(error), {
				cause: error,
			});
		}
		throw new WorkflowProviderError(
			"acquisition",
			`The workflow runtime could not be acquired: ${messageOf(error)}`,
			{ cause: error },
		);
	}
	if (discoverWorkflowProvider(events) !== provider) {
		throw new WorkflowProviderError(
			"replaced",
			"The workflow runtime changed while this seat was acquiring it.",
		);
	}
	if (!hasClientMethods(client)) {
		throw new WorkflowProviderError(
			"incompatible",
			"The workflow runtime returned a client without the read surface this seat calls.",
		);
	}
	return client;
}

/**
 * The form every caller in the seat uses: a client, or a warning and nothing.
 */
export async function acquireWorkflowClientOrWarn(
	events: WorkflowEventBus,
	context: unknown,
	notify: WorkflowNotify,
): Promise<WorkflowReadClient | undefined> {
	try {
		return await acquireWorkflowClient(events, context);
	} catch (error) {
		reportWorkflowFailure(notify, error);
		return undefined;
	}
}

/**
 * Run one client call, or warn and return nothing.
 *
 * This is where the runtime's own refusals surface: a `startBuiltin` for a ref
 * outside pi-workflow's frozen allowlist throws a `validation` error, and it
 * arrives here as a warning naming what a person can do instead —
 * `/plan run <slug>` — rather than as an exception inside a dialog sequence.
 */
export async function callWorkflow<T>(
	operation: () => Promise<T>,
	notify: WorkflowNotify,
): Promise<T | undefined> {
	try {
		return await operation();
	} catch (error) {
		reportWorkflowFailure(notify, error);
		return undefined;
	}
}
