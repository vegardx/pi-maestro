// Authoring: how the harness asks the model for the two things only the model
// can write — the description we agree on, and the plan document.
//
// NOT A TOOL. It was, twice: `plan_intent` submitted the sentences and `plan`
// stored the document, and the exit steered the seat model with an injected
// user message and waited for the call. Four by-hand passes failed at the same
// place — the model reached for other tools, answered in prose, streamed one
// tool call for nine minutes, and repeated an identical refusal four times —
// because a steer is a request the model is free to interpret, and an agent
// loop is a place it is free to do something else.
//
// So the harness asks directly. An ordinary completion outside Pi's agent loop
// — exactly the shape `command-auditor.ts` uses — with the session's own
// history as its context, a system prompt that says what is wanted, one user
// message that asks for it, AND NO TOOLS AT ALL. The model can only answer in
// text; the harness parses, validates and stores. Nothing it writes here runs
// anything, and nothing it writes lands in the conversation.
//
// Three bounds make that dependable rather than merely direct:
//
//   - **Three attempts, and the failure is shown.** A retry appends the
//     previous answer and the validator's own sentences, so the second request
//     is a conversation about a specific document rather than the same request
//     asked again.
//   - **The validators are the document's own.** `authoredPlanProblems` →
//     `withoutEmptyOptionals` → `planFrom` → `inspectPlan` is the tool-free
//     path `plan-document.ts` was split out for.
//   - **Every attempt leaves evidence.** `authoring.json` beside the plan says
//     what was asked, how long it took and what was wrong with the answer, in
//     the validator's words. Never the raw answer, never a provider error,
//     never a path.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	convertToLlm,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, type ThinkingLevel } from "@vegardx/pi-models";
import { type PlanPolicy, resolvePolicy } from "./plan.js";
import { PLAN_DOCUMENT_GUIDE, PlanSchema } from "./plan-document.js";
import type { Effort } from "./plan-input.js";

// ── What a description has to be ─────────────────────────────────────────────

/**
 * The bounds, as numbers rather than as sentences.
 *
 * Shorter than `MIN_DESCRIPTION_LENGTH` is a title; longer than
 * `MAX_DESCRIPTION_LENGTH` is the plan. Counting sentences was tried and
 * removed: it over-counted abbreviations, under-counted semicolons, and
 * refused good descriptions over punctuation.
 */
export const MIN_DESCRIPTION_LENGTH = 40;
export const MAX_DESCRIPTION_LENGTH = 700;

/** A fenced block anywhere in the answer. */
const CODE_FENCE_RE = /```/;

/** A Markdown list item at the start of any line. */
const LIST_ITEM_RE = /^[ \t]*([-*+]|\d+[.)])\s/m;

/** Why this answer is not a description, in the validator's own words. */
export function descriptionProblem(answer: string): string | undefined {
	const text = answer.trim();
	if (text.length < MIN_DESCRIPTION_LENGTH)
		return `it is ${text.length} characters, short of the ${MIN_DESCRIPTION_LENGTH} a description needs — two or three sentences, not a title`;
	if (text.length > MAX_DESCRIPTION_LENGTH)
		return `it is ${text.length} characters, past the ${MAX_DESCRIPTION_LENGTH} bound — two or three sentences, not the plan`;
	if (CODE_FENCE_RE.test(text))
		return "it carries a code fence, and the description is plain prose";
	if (LIST_ITEM_RE.test(text))
		return "it is written as a list, and the description is two or three sentences of prose";
	return undefined;
}

// ── The two system prompts ───────────────────────────────────────────────────

/**
 * The description: what `renderIntentSteer` used to ask for, as a system
 * prompt.
 *
 * It is the yardstick — what the plan check is told the plan is FOR — so it
 * comes from the model rather than from a person typing one line into a dialog:
 * the conversation already contains it, and asking somebody to retype their own
 * intent is the flow asking them to do the model's reading for it.
 */
export const DESCRIPTION_SYSTEM_PROMPT = [
	"You are writing the agreed description for a plan, on the way out of plan mode.",
	"",
	"Read the conversation above and write two or three sentences that a reader" +
		" who has not seen it would understand: what we are setting out to do, and" +
		" why it is worth doing. Not a title, not the plan, not a list of steps —" +
		" this is the yardstick the plan will be judged against.",
	"",
	`Answer with those sentences and nothing else: plain prose between ${MIN_DESCRIPTION_LENGTH} and ${MAX_DESCRIPTION_LENGTH} characters, with no heading, no code fence, no list, no preamble and no closing question.`,
	"",
	"You have no tools here and nothing you write starts anything. The person is" +
		" shown exactly what you write, beside the plan, in the one confirmation" +
		" that starts the run — they start it, edit this, or keep planning. Do not" +
		" ask them to write it for you.",
].join("\n");

/** The one user message that asks for the description. */
export const DESCRIPTION_REQUEST =
	"Write the description now, and write nothing else.";

/** The one user message that asks for the document. */
export const DOCUMENT_REQUEST =
	"Write the plan document as one JSON object and nothing else.";

/**
 * The document: what `renderExitSteer` used to ask for, as a system prompt.
 *
 * THE POLICY IS NOT ASKED FOR, and it is still said out loud. Effort, gates and
 * publication were settled by dialogs before this document existed; the harness
 * attaches them to the plan itself and the schema has no field for any of them.
 * A decision the author cannot see is one they will write around.
 */
export function renderDocumentSystemPrompt(
	policy: PlanPolicy,
	description: string,
): string {
	const resolved = resolvePolicy(policy);
	return [
		"You are writing the plan document for the conversation above, on the way out of plan mode.",
		"",
		PLAN_DOCUMENT_GUIDE,
		"",
		"The description we have agreed on, which is what this plan will be judged against:",
		"",
		description.trim(),
		"",
		`Already decided, and not yours to write: effort ${resolved.effort}, gates` +
			` ${resolved.gates}, publication ${resolved.publish.mode}` +
			`${resolved.publish.base ? ` onto \`${resolved.publish.base}\`` : ""}.` +
			" The person chose those on the way out of plan mode and the harness puts" +
			" them on the document itself. The schema has no `policy` field and no" +
			" `stages` field: how a deliverable is run is derived from its tasks, its" +
			" reviews and those dials.",
		"",
		"A deliverable's `tasks` are the work — implementation, tests, docs — and" +
			" its `reviews` are the independent readings that work earns, listed once" +
			" beside the tasks. A deliverable that needs no independent reader leaves" +
			" `reviews` out.",
		"",
		"Write the whole plan from the conversation: every repository, every" +
			" deliverable, its `after` and `reads` edges, its tasks and the reviews" +
			" those tasks earn. Do not ask for any of it to be restated, and do not" +
			" narrow it to the part that is easy to write down.",
		"",
		"Your whole answer is one JSON object matching this schema — no prose around" +
			" it, no code fence, no explanation:",
		"",
		JSON.stringify(PlanSchema, null, 2),
		"",
		"You have no tools here and nothing you write starts anything: the plan is" +
			" read in a fresh context the moment it is stored, and a plan checked by" +
			" its author is not checked. The person starts any run themselves.",
	].join("\n");
}

// ── What a document answer has to be ─────────────────────────────────────────

/**
 * The answer with a code fence taken off, if it wore one.
 *
 * The system prompt asks for bare JSON and a model wraps it in a fence anyway,
 * often enough that refusing it would spend an attempt on punctuation. Nothing
 * else is rewritten: what is inside the fence is parsed exactly as written.
 */
export function withoutCodeFence(answer: string): string {
	const text = answer.trim();
	if (!text.startsWith("```")) return text;
	const firstBreak = text.indexOf("\n");
	if (firstBreak === -1) return text;
	const end = text.lastIndexOf("```");
	return (end > firstBreak ? text.slice(firstBreak + 1, end) : text).trim();
}

/** The one sentence a document that is not JSON earns. */
export const NOT_JSON_PROBLEM =
	"the answer is not one JSON object — send the document as JSON alone, with no prose and no code fence around it";

/** A parsed document, or the problem that says why there is none. */
export function parseDocument(
	answer: string,
): { readonly value: unknown } | { readonly problems: string[] } {
	try {
		return { value: JSON.parse(withoutCodeFence(answer)) as unknown };
	} catch {
		return { problems: [NOT_JSON_PROBLEM] };
	}
}

// ── Asking ───────────────────────────────────────────────────────────────────

/** One turn of the mini-conversation the harness holds with the model. */
export interface AuthoringMessage {
	readonly role: "user" | "assistant";
	readonly text: string;
}

export interface AuthoringRequest {
	readonly systemPrompt: string;
	/**
	 * The mini-conversation ONLY. The session's own history is the port's job,
	 * because it is the one part a caller cannot supply honestly: what the LLM
	 * would see is what `buildSessionContext` says it would see.
	 */
	readonly messages: readonly AuthoringMessage[];
	readonly signal?: AbortSignal;
}

export type AuthoringAnswer =
	| { readonly ok: true; readonly text: string }
	/** The provider, the timeout or the abort. Never shown to the model. */
	| { readonly ok: false; readonly failure: string };

/** One completion, outside the agent loop, with no tools. */
export type AuthoringComplete = (
	request: AuthoringRequest,
) => Promise<AuthoringAnswer>;

/** How many times one artifact is asked for before the exit gives up. */
export const MAX_AUTHORING_ATTEMPTS = 3;

/**
 * Above this share of the model's context window, the exit does not start.
 *
 * A session near its window cannot carry a whole plan document as well: the
 * request would be truncated or refused, and the failure would read as the
 * model's. `/compact` and then leaving plan mode again is the way through.
 */
export const CONTEXT_LIMIT_PERCENT = 80;

// ── The thinking level ───────────────────────────────────────────────────────

/** What each effort is worth in reasoning, before the session's own level. */
const EFFORT_THINKING: Readonly<Record<Effort, ThinkingLevel>> = Object.freeze({
	cheap: "low",
	standard: "medium",
	deep: "high",
});

/**
 * The level this request asks for: the effort's, and never below the session's.
 *
 * Somebody who set `high` for this conversation did so because the work is
 * hard, and writing the plan for that work is not the moment to think less.
 */
export function authoringThinking(
	effort: Effort,
	session?: ThinkingLevel,
): ThinkingLevel {
	const wanted = EFFORT_THINKING[effort];
	if (!session) return wanted;
	const rank = (level: ThinkingLevel): number => THINKING_LEVELS.indexOf(level);
	return rank(session) > rank(wanted) ? session : wanted;
}

// ── The completion port, against a live session ──────────────────────────────

/** What `createSessionAuthor` reads of an `ExtensionContext`. */
export type AuthoringHost = Pick<
	ExtensionContext,
	"model" | "modelRegistry" | "sessionManager"
>;

/** How long one authoring request may take before it is abandoned. */
export const DEFAULT_AUTHORING_TIMEOUT_MS = 300_000;

export interface SessionAuthorOptions {
	readonly timeoutMs?: number;
	/** The session-replacement signal; aborts a request in flight. */
	readonly signal?: AbortSignal;
	readonly maxTokens?: number;
}

/**
 * The real port: the seat's current model, the session's own history, no tools.
 *
 * `ModelRegistry.complete` takes a `Context` of `{systemPrompt, messages,
 * tools?}` and `tools` is left out, so there is nothing for the model to call.
 * The history is `buildSessionContext` — what the LLM would see, with
 * compaction and branch summaries already resolved — through `convertToLlm`,
 * which is the same pair Pi's own turn goes through.
 *
 * THE THINKING LEVEL IS NOT PASSED. `complete` takes `ApiStreamOptions`, whose
 * reasoning controls are per-provider (`thinkingEnabled` on Anthropic,
 * `reasoning_effort` elsewhere); the provider-agnostic `reasoning` level lives
 * on `SimpleStreamOptions`, which `ModelRegistry` does not expose. The level
 * this request WOULD have asked for is on the record all the same, because
 * that is the number a later reader compares against.
 */
export function createSessionAuthor(
	host: AuthoringHost,
	options: SessionAuthorOptions = {},
): AuthoringComplete {
	return async (request) => {
		const model = host.model as Model<Api> | undefined;
		if (!model) return { ok: false, failure: "no model is selected" };
		const controller = new AbortController();
		const abort = (): void => controller.abort();
		options.signal?.addEventListener("abort", abort, { once: true });
		request.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted || request.signal?.aborted) abort();
		let timedOut = false;
		const timeoutMs = options.timeoutMs ?? DEFAULT_AUTHORING_TIMEOUT_MS;
		const timer = setTimeout(() => {
			timedOut = true;
			abort();
		}, timeoutMs);
		(timer as { unref?: () => void }).unref?.();
		try {
			const response = await host.modelRegistry.complete(
				model,
				{
					systemPrompt: request.systemPrompt,
					messages: [
						...sessionHistory(host),
						...asMessages(request.messages, model),
					],
				},
				{
					maxTokens: Math.min(
						options.maxTokens ?? model.maxTokens,
						model.maxTokens,
					),
					signal: controller.signal,
				},
			);
			const text = response.content
				.filter(
					(part): part is { type: "text"; text: string } =>
						part.type === "text",
				)
				.map((part) => part.text)
				.join("\n")
				.trim();
			if (text.length === 0)
				return {
					ok: false,
					failure: `the model answered with no text (stop=${response.stopReason})`,
				};
			return { ok: true, text };
		} catch (error) {
			if (timedOut)
				return { ok: false, failure: `timed out after ${timeoutMs}ms` };
			if (controller.signal.aborted)
				return { ok: false, failure: "the request was aborted" };
			return {
				ok: false,
				failure: error instanceof Error ? error.message : String(error),
			};
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			request.signal?.removeEventListener("abort", abort);
		}
	};
}

/** The session as the LLM would see it. */
function sessionHistory(host: AuthoringHost): Message[] {
	const manager = host.sessionManager;
	return convertToLlm(
		buildSessionContext(manager.getBranch(), manager.getLeafId()).messages,
	);
}

/** Zero usage, because nothing here was spent by the turn being replayed. */
const NO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function asMessages(
	turns: readonly AuthoringMessage[],
	model: Model<Api>,
): Message[] {
	return turns.map(
		(turn): Message =>
			turn.role === "user"
				? {
						role: "user",
						content: [{ type: "text", text: turn.text }],
						timestamp: Date.now(),
					}
				: {
						role: "assistant",
						content: [{ type: "text", text: turn.text }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: { ...NO_USAGE },
						stopReason: "stop",
						timestamp: Date.now(),
					},
	);
}

// ── The evidence ─────────────────────────────────────────────────────────────

export const AUTHORING_EVIDENCE_FILE = "authoring.json";
export const AUTHORING_EVIDENCE_SCHEMA_VERSION = 2 as const;

/**
 * Which of the four things happened, in the order they can happen.
 *
 * `check` is not a request to the model at all — it is the one-shot plan check
 * — and it is on the same record because the record answers one question: what
 * did the harness do between "leaving plan mode" and "a plan". An attempt list
 * that held the two requests and not the read that rewrote them would be a
 * record of half the exit.
 */
export type AuthoringAttemptKind = "intent" | "plan" | "revise" | "check";

/**
 * One request and what came back, in terms a later reader can check.
 *
 * `problems` are the VALIDATOR'S OWN SENTENCES and nothing else: never a
 * provider error, a stack, a path, or any of the answer's own text.
 * `responseDigest` is what stands in for the answer — enough to tell two
 * attempts apart, and not enough to read either.
 *
 * `verdict` and `counts` are only on a `check` attempt, and they are the whole
 * of what a check leaves behind: what it said about the plan, and how many
 * things of each severity it said it about. The findings themselves are not
 * here — they are the reviewer's prose about somebody's repository, and this
 * file is a record of what the harness did, not a copy of what it read.
 */
export interface AuthoringAttempt {
	readonly kind: AuthoringAttemptKind;
	readonly startedAt: string;
	readonly durationMs: number;
	readonly model: string;
	readonly thinking: string;
	readonly ok: boolean;
	readonly problems: string[];
	readonly responseDigest: string;
	/** `check` only: what the reviewer said about the plan as a whole. */
	readonly verdict?: string;
	/** `check` only: how many findings of each severity. */
	readonly counts?: Readonly<Record<string, number>>;
}

export interface AuthoringEvidence {
	readonly schemaVersion: typeof AUTHORING_EVIDENCE_SCHEMA_VERSION;
	readonly attempts: readonly AuthoringAttempt[];
}

/** The answer, reduced to something that identifies it and reveals nothing. */
export function responseDigest(answer: string): string {
	return createHash("sha256").update(answer, "utf8").digest("hex").slice(0, 16);
}

/**
 * What a provider failure is allowed to say on the record.
 *
 * One sentence, the same one every time. A provider's own message may carry a
 * URL, a key prefix, a path or a stack, and none of that is evidence about the
 * plan.
 */
export const PROVIDER_FAILURE_PROBLEM = "the model did not answer this request";

/** Write the whole file: every attempt so far, every time. One small array. */
export function writeAuthoringEvidence(
	dir: string,
	attempts: readonly AuthoringAttempt[],
): string {
	const path = join(dir, AUTHORING_EVIDENCE_FILE);
	const evidence: AuthoringEvidence = {
		schemaVersion: AUTHORING_EVIDENCE_SCHEMA_VERSION,
		attempts,
	};
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
	return path;
}
