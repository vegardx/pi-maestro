/**
 * The consumer side of the workflow provider seam (spec 1.1, 2.4).
 *
 * `@vegardx/pi-workflow` registers a frozen `{contract, acquire(context)}` on
 * Pi's event bus. This module is the other end: it asks the bus who is there,
 * refuses a runtime it was not built against, and hands the exit loop a client
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
 * observe, start one allowlisted headless builtin, and start the one plan
 * workflow a person has just said yes to. There is no `decide`, `stop` or
 * general `run` here: both starts are allowlisted by name inside the runtime,
 * and every other way of starting a workflow is still a tool call in the open,
 * in the transcript.
 *
 * **`startBuiltin` is the seat acting, never the model.** `runBuiltin` starts
 * the blind reviewer, which writes nothing; `startBuiltin` starts
 * `plan-to-ship`, which writes to worktrees. The seat may call it because a
 * human answered `Start the run?` with yes, in a dialog this seat owns — the
 * model is not in that loop at all, and the pi-maestro seat still refuses the
 * model's own `workflow_run` in plan mode by name.
 *
 * **Nothing in this module throws into the session.** Every failure — no
 * runtime, two runtimes, a wrong revision, a runtime swapped mid-acquisition,
 * a refusal from the runtime itself — becomes one `notify(…, "warning")`
 * naming what a human can do instead, and a `undefined` return. A seat with
 * no workflow runtime is a working seat.
 */

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

/** The lease-free budget projection the exit loop shows before a run starts. */
export interface WorkflowBudgetProjectionView {
	readonly cost: number;
	readonly totalTokens: number;
	readonly childRuntimeMs: number;
	readonly tasks: number;
	readonly fits: boolean;
}

/** What `runBuiltin` hands back: an identity to await, and nothing else. */
export interface WorkflowRunReceiptView {
	readonly runId: string;
	readonly status: string;
}

/**
 * What `startBuiltin` hands back.
 *
 * The run id and nothing else, because that is all `startBuiltin` promises: it
 * returns as soon as the run exists, before there is a status worth reading,
 * and the run's own `approve-plan` checkpoint is what happens next.
 */
export interface WorkflowStartReceiptView {
	readonly runId: string;
}

/** One append to an owned run, as delivered to an `observe` listener. */
export interface WorkflowRunObservationView {
	readonly runId: string;
	readonly status: string;
	readonly sequence: number;
}

/** A run driven to a durable terminal state, or to a timeout or a checkpoint. */
export interface WorkflowRunWaitView {
	readonly runId: string;
	readonly status: string;
	readonly output?: unknown;
	readonly timedOut?: true;
	readonly parked?: true;
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
	inspect(runId: string, options?: unknown): Promise<unknown>;
	runs(query?: unknown): Promise<unknown>;
	observe(
		listener: (observation: WorkflowRunObservationView) => void,
	): () => void;
	runBuiltin(ref: string, input: unknown): Promise<WorkflowRunReceiptView>;
	/**
	 * Starts `plan-to-ship` for a plan the person just approved, and refuses
	 * every other ref by name. Validates `input` the way `workflow_run` does,
	 * returns as soon as the run exists, and the run parks at `approve-plan`.
	 * The runtime journals it with origin `"service-provider"`, so a run this
	 * seat started is never mistaken for one the model started.
	 */
	startBuiltin(
		ref: string,
		options: { readonly input: unknown; readonly effort?: Effort },
	): Promise<WorkflowStartReceiptView>;
	awaitRun(
		runId: string,
		options?: { timeoutMs?: number },
	): Promise<WorkflowRunWaitView>;
}

/** Every method the client must have; a missing one is `incompatible`. */
const CLIENT_METHODS = [
	"list",
	"validate",
	"project",
	"inspect",
	"runs",
	"observe",
	"runBuiltin",
	"startBuiltin",
	"awaitRun",
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
 * `validation` is the runtime's own refusal passed through — a `runBuiltin` or
 * a `startBuiltin` for a ref outside its allowlist, an input that does not fit
 * the definition's schema, or an `awaitRun` for a run this client did not
 * start. `acquisition` is the catch-all: the runtime was reached and did not
 * give an answer this seat can use.
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
 * - `run` — the whole run is out of reach; the stored plan and `/plan run`
 *   remain.
 * - `reviewer` — only the blind reviewer is unreachable; the compiled plan is
 *   in hand and `Approve as is` continues.
 */
export type WorkflowProviderFallback = "run" | "reviewer";

const FALLBACK_HINT: Readonly<Record<WorkflowProviderFallback, string>> =
	Object.freeze({
		run: "The plan is stored — start it later with `/plan run <slug>`.",
		reviewer:
			"The blind reviewer is unreachable — choose `Approve as is` to continue without it.",
	});

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
export function workflowProviderWarning(
	error: unknown,
	fallback: WorkflowProviderFallback,
): string {
	const code = classifyWorkflowFailure(error);
	return `Workflow runtime unavailable (${code}): ${messageOf(error)} ${FALLBACK_HINT[fallback]}`;
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
	fallback: WorkflowProviderFallback,
): void {
	try {
		notify(workflowProviderWarning(error, fallback), "warning");
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
	fallback: WorkflowProviderFallback = "run",
): Promise<WorkflowReadClient | undefined> {
	try {
		return await acquireWorkflowClient(events, context);
	} catch (error) {
		reportWorkflowFailure(notify, error, fallback);
		return undefined;
	}
}

/**
 * Run one client call, or warn and return nothing.
 *
 * This is where the runtime's own refusals surface: a `runBuiltin` or a
 * `startBuiltin` for a ref outside pi-workflow's frozen allowlist throws a
 * `validation` error, and it arrives here as a warning naming what a person
 * can do instead — `Approve as is`, or `/plan run <slug>` — rather than as an
 * exception inside a dialog sequence.
 */
export async function callWorkflow<T>(
	operation: () => Promise<T>,
	notify: WorkflowNotify,
	fallback: WorkflowProviderFallback,
): Promise<T | undefined> {
	try {
		return await operation();
	} catch (error) {
		reportWorkflowFailure(notify, error, fallback);
		return undefined;
	}
}
