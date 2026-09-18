// The plan-mode exit, end to end, driven through a fake UI, a fake completion,
// a fake workflow runtime and a fake audited Bash.
//
// The exit is ONE flow now: two dialogs, a request for the description, a
// request for the document, and then readiness, the graph, the blind review and
// the run. Nothing is on disk between the steps, so what the old suites checked
// after every turn — the pending record — has nothing to check. What is left is
// what actually matters, and every case below asserts the same five facts after
// the fact: the outcome, the plan in the store, the posture, exactly which
// dialogs were opened, and exactly what was asked of the model.
//
// The completion port is a fake with a SCRIPT. That is the point of the
// redesign being a port: the failure modes that killed four by-hand passes —
// an answer in prose, an answer that never validates, a provider that does not
// answer, a session that goes away mid-request — are each one line here.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	AUTHORING_EVIDENCE_FILE,
	AUTHORING_EVIDENCE_SCHEMA_VERSION,
	type AuthoringComplete,
	type AuthoringEvidence,
	type AuthoringRequest,
	authoringThinking,
	CONTEXT_LIMIT_PERCENT,
	DESCRIPTION_SYSTEM_PROMPT,
	DOCUMENT_REQUEST,
	descriptionProblem,
	MAX_AUTHORING_ATTEMPTS,
	MAX_DESCRIPTION_LENGTH,
	MIN_DESCRIPTION_LENGTH,
	PROVIDER_FAILURE_PROBLEM,
	parseDocument,
	renderDocumentSystemPrompt,
	withoutCodeFence,
} from "../packages/maestro/src/authoring.js";
import * as exitFlow from "../packages/maestro/src/exit-flow.js";
import {
	COMPILED_APPROVE,
	COMPILED_BACK,
	COMPILED_REVIEW,
	COMPILED_TITLE,
	chosenOption,
	DIRTY_CONTINUE,
	derivePublication,
	EFFORT_OPTIONS,
	EFFORT_TITLE,
	EXIT_COMPILE,
	EXIT_KEEP_PLANNING,
	EXIT_START_OPTIONS,
	EXIT_START_TITLE,
	EXIT_SWITCH_ONLY,
	type ExitFlowDeps,
	type ExitFlowUi,
	type ExitOption,
	FALLBACK_BASE_BRANCH,
	INTENT_AGREE,
	INTENT_BACK,
	INTENT_EDIT,
	INTENT_EDITOR_TITLE,
	INTENT_OPTIONS,
	INTENT_TITLE,
	optionLabel,
	optionLabels,
	PLAN_MESSAGE_TYPE,
	PLAN_REVIEW_REF,
	renderReviewers,
	runExitFlow,
	START_RUN_TITLE,
} from "../packages/maestro/src/exit-flow.js";
import * as findings from "../packages/maestro/src/findings.js";
import {
	FINDING_DISMISS,
	FINDING_REVISE,
	type Finding,
	MAX_BLIND_REVIEWS,
} from "../packages/maestro/src/findings.js";
import type { ModeName } from "../packages/maestro/src/mode.js";
import {
	inspectPlan,
	type Plan,
	type RepoProbe,
	validatePlan,
} from "../packages/maestro/src/plan.js";
import { PLAN_WORKFLOW_REF } from "../packages/maestro/src/plan-command.js";
import { planDigest } from "../packages/maestro/src/plan-input.js";
import type {
	WorkflowBudgetProjectionView,
	WorkflowReadClient,
} from "../packages/maestro/src/workflow-provider.js";

const dirs: string[] = [];
afterEach(() => {
	for (const directory of dirs.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function temp(): string {
	const path = mkdtempSync(join(tmpdir(), "maestro-exit-"));
	dirs.push(path);
	return path;
}

const REPO = "/nowhere/pi-workflow";

// ── The fakes ────────────────────────────────────────────────────────────────

interface Opened {
	readonly kind: "select" | "input" | "confirm" | "editor";
	readonly title: string;
	readonly options?: readonly string[];
	readonly signal: boolean;
}

type Answer = string | boolean | undefined;

/** The label in `options` that starts with `text`; the fake answers labels. */
function pick(options: readonly string[] | undefined, text: string): string {
	const found = options?.find((option) => option.startsWith(text));
	if (!found)
		throw new Error(
			`no option starting with ${JSON.stringify(text)} in ${JSON.stringify(options)}`,
		);
	return found;
}

function fakeUi(
	answer: (opened: Opened, index: number) => Answer = () => undefined,
	after?: (opened: Opened, index: number) => void,
) {
	const opened: Opened[] = [];
	const notices: [string, string][] = [];
	const ask = async (
		kind: Opened["kind"],
		title: string,
		options: readonly string[] | undefined,
		opts: { signal?: AbortSignal } | undefined,
	): Promise<Answer> => {
		const entry: Opened = {
			kind,
			title,
			signal: Boolean(opts?.signal),
			...(options ? { options: [...options] } : {}),
		};
		opened.push(entry);
		const value = answer(entry, opened.length - 1);
		after?.(entry, opened.length - 1);
		return value;
	};
	const ui: ExitFlowUi = {
		select: (title, options, opts) =>
			ask("select", title, options, opts) as Promise<string | undefined>,
		input: (title, _placeholder, opts) =>
			ask("input", title, undefined, opts) as Promise<string | undefined>,
		confirm: async (title, _message, opts) =>
			((await ask("confirm", title, undefined, opts)) ?? false) as boolean,
		editor: (title, _prefill) =>
			ask("editor", title, undefined, undefined) as Promise<string | undefined>,
		notify: (message, type) => {
			notices.push([message, type ?? "info"]);
		},
	};
	return {
		ui,
		opened,
		notices,
		titles: () => opened.map((entry) => entry.title),
		said: () => notices.map(([message]) => message).join("\n---\n"),
	};
}

/** One scripted turn: what the model answers, or how it fails to. */
type Turn =
	| string
	/** The provider did not answer. */
	| { readonly failure: string }
	/** The session goes away while this request is in flight. */
	| { readonly abort: AbortController };

function fakeComplete(script: readonly Turn[]) {
	const requests: AuthoringRequest[] = [];
	let index = 0;
	const complete: AuthoringComplete = async (request) => {
		requests.push(request);
		const turn = script[index++];
		if (turn === undefined)
			throw new Error(
				`the flow made request ${index} and the script has ${script.length}`,
			);
		if (typeof turn === "string") return { ok: true, text: turn };
		if ("abort" in turn) {
			turn.abort.abort();
			return { ok: false, failure: "the request was aborted" };
		}
		return { ok: false, failure: turn.failure };
	};
	return {
		complete,
		requests,
		/** The user text of the last turn of request `n`. */
		lastUserText: (n: number): string => {
			const messages = requests[n]?.messages ?? [];
			return [...messages].reverse().find((m) => m.role === "user")?.text ?? "";
		},
	};
}

/** A working-tree root with nothing uncommitted in it, without a filesystem. */
const cleanProbe: RepoProbe = (path) => ({
	root: path,
	resolved: path,
	dirty: false,
});

/** Readiness' whole view of the world, all of it saying yes. */
const readyWorld = {
	exists: () => true,
	probe: cleanProbe,
	refExists: () => true,
	ghPresent: () => true,
};

/** The store, with a real root so the evidence file lands somewhere real. */
function fakeStore(root: string) {
	const saves: Plan[] = [];
	const plans = new Map<string, Plan>();
	return {
		saves,
		current: (): Plan | undefined => saves.at(-1),
		store: {
			planDir: (slug: string): string => join(root, slug),
			workflowInputFile: (slug: string): string =>
				join(root, slug, "workflow-input.json"),
			loadPlan: (slug: string): Plan | null => plans.get(slug) ?? null,
			savePlan: (plan: Plan): void => {
				// The real store's rule, with the real validator: nothing invalid
				// reaches disk, and the exit flow has to survive being told so.
				const errors = validatePlan(plan, cleanProbe);
				if (errors.length > 0)
					throw new Error(
						`refusing to save an invalid plan:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
					);
				plans.set(plan.slug, plan);
				saves.push(plan);
			},
		},
	};
}

const PROJECTION = {
	cost: 1.25,
	totalTokens: 120_000,
	childRuntimeMs: 900_000,
	tasks: 9,
	budget: { cost: 10, totalTokens: 1_000_000, childRuntimeMs: 3_600_000 },
	fits: true,
} as unknown as WorkflowBudgetProjectionView;

interface FakeClientOptions {
	readonly reviews?: readonly unknown[];
	readonly runBuiltin?: () => Promise<{ runId: string; status: string }>;
	readonly awaitRun?: () => Promise<{
		runId: string;
		status: string;
		output?: unknown;
		timedOut?: true;
	}>;
}

function fakeClient(options: FakeClientOptions = {}) {
	const calls: { ref: string; input: unknown }[] = [];
	let round = 0;
	const client: WorkflowReadClient = {
		list: async () => [],
		validate: async (ref: string, input?: unknown) => {
			calls.push({ ref: `validate:${ref}`, input });
			return {
				valid: true as const,
				workflow: {
					name: ref,
					description: "",
					version: 1,
					scope: "builtin",
					identitySha256: "0".repeat(64),
				},
			};
		},
		project: async (ref: string, input: unknown) => {
			calls.push({ ref: `project:${ref}`, input });
			return PROJECTION;
		},
		inspect: async () => ({}),
		runs: async () => ({}),
		observe: () => () => {},
		runBuiltin:
			options.runBuiltin ??
			(async (ref: string, input: unknown) => {
				calls.push({ ref: `runBuiltin:${ref}`, input });
				return { runId: `run-${++round}`, status: "running" };
			}),
		awaitRun:
			options.awaitRun ??
			(async (runId: string) => ({
				runId,
				status: "completed",
				output: options.reviews?.[round - 1] ?? {
					verdict: "ready",
					findings: [],
				},
			})),
	} as WorkflowReadClient;
	return {
		client,
		calls,
		started: () => calls.filter((c) => c.ref.startsWith("runBuiltin")),
	};
}

function fakeBash() {
	const commands: string[] = [];
	return {
		commands,
		bash: async (command: string) => {
			commands.push(command);
			return { ok: true, output: "" };
		},
	};
}

// ── What the model is scripted to say ────────────────────────────────────────

const DESCRIPTION =
	"We are shipping the component catalogue so that every workflow stops" +
	" re-authoring the same four stages. It is worth doing because the" +
	" duplication is where the drift starts.";

/** The authored document, in the shape `PlanSchema` describes. */
function documentText(over: Record<string, unknown> = {}): string {
	return JSON.stringify({
		slug: "compose",
		title: "Compose the catalogue",
		repos: [{ key: "wf", path: REPO }],
		deliverables: [
			{
				id: "d1",
				title: "Deliverable one",
				tasks: [{ id: "impl", title: "Do the work" }],
				reviews: [{ lens: "contracts", tier: "standard" }],
			},
			{
				id: "d2",
				title: "Deliverable two",
				after: ["d1"],
				tasks: [{ id: "impl", title: "Do the other work" }],
				reviews: [{ lens: "contracts", tier: "standard" }],
			},
		],
		...over,
	});
}

/** A document that parses, fits the schema, and does not validate. */
const BROKEN_EDGE = documentText({
	deliverables: [
		{
			id: "d1",
			title: "Deliverable one",
			after: ["nowhere"],
			tasks: [{ id: "impl", title: "Do the work" }],
		},
	],
});

// ── The harness ──────────────────────────────────────────────────────────────

/** A repository with an `origin` remote, `gh`, and a tracked `trunk`. */
const FULLY_EQUIPPED = derivePublication({
	originPresent: () => true,
	ghPresent: () => true,
	upstreamHead: () => "trunk",
});

interface HarnessOptions {
	readonly script?: readonly Turn[];
	readonly answer?: (opened: Opened, index: number) => Answer;
	readonly after?: (opened: Opened, index: number) => void;
	readonly client?: FakeClientOptions | null;
	readonly world?: ExitFlowDeps["readiness"];
	readonly signal?: AbortSignal;
	readonly contextUsage?: ExitFlowDeps["contextUsage"];
	readonly publication?: ExitFlowDeps["publication"];
	readonly announce?: false;
}

function harness(options: HarnessOptions = {}) {
	const root = temp();
	const store = fakeStore(root);
	const ui = fakeUi(options.answer, options.after);
	const model = fakeComplete(options.script ?? []);
	const provider =
		options.client === null ? undefined : fakeClient(options.client ?? {});
	const bash = fakeBash();
	const steers: string[] = [];
	const inputs: [string, string][] = [];
	const modes: ModeName[] = [];
	const announced: exitFlow.PlanAnnouncement[] = [];
	let clock = Date.UTC(2026, 8, 16, 12, 0, 0);
	const deps: ExitFlowDeps = {
		ui: ui.ui,
		wanted: "auto",
		setMode: (name) => {
			modes.push(name);
		},
		complete: model.complete,
		store: store.store,
		bash: bash.bash,
		cwd: REPO,
		readiness: options.world ?? readyWorld,
		inspect: (candidate) => inspectPlan(candidate, cleanProbe),
		workflow: async () => provider?.client,
		publication: options.publication ?? (() => FULLY_EQUIPPED),
		sendUserMessage: (content) => steers.push(content),
		inputPath: (slug) => join(root, `${slug}-input.json`),
		writeInput: (path, json) => inputs.push([path, json]),
		modelId: "anthropic/opus-5",
		thinkingLevel: "low",
		now: () => {
			clock += 1_000;
			return new Date(clock);
		},
		...(options.announce === false
			? {}
			: { announce: (message) => announced.push(message) }),
		...(options.signal ? { signal: options.signal } : {}),
		...(options.contextUsage ? { contextUsage: options.contextUsage } : {}),
	};
	return {
		root,
		deps,
		ui,
		store,
		bash,
		model,
		steers,
		inputs,
		modes,
		announced,
		provider,
		said: () => ui.said(),
		evidence: (slug = "compose"): AuthoringEvidence =>
			JSON.parse(
				readFileSync(join(root, slug, AUTHORING_EVIDENCE_FILE), "utf8"),
			) as AuthoringEvidence,
		evidenceText: (slug = "compose"): string =>
			readFileSync(join(root, slug, AUTHORING_EVIDENCE_FILE), "utf8"),
	};
}

/**
 * The answers that walk the happy path: compile, agree, review, start.
 *
 * Every one of them is given EXPLICITLY, because escape means none of them:
 * the recommended row is first in each table and the escape row is the safe way
 * out, and this path is the one where somebody said yes.
 */
const happyPath = (opened: Opened, _index = 0): Answer => {
	if (opened.kind === "confirm" && opened.title === START_RUN_TITLE)
		return true;
	if (opened.title === EXIT_START_TITLE)
		return pick(opened.options, EXIT_COMPILE);
	if (opened.title === COMPILED_TITLE)
		return pick(opened.options, COMPILED_REVIEW);
	if (opened.title.startsWith(INTENT_TITLE))
		return pick(opened.options, INTENT_AGREE);
	if (opened.title.includes("uncommitted"))
		return pick(opened.options, DIRTY_CONTINUE);
	return undefined;
};

// ── The two dialogs that come before anything is asked of the model ──────────

describe("the first question, and the two answers that end the flow", () => {
	it("keeps planning, asks the model nothing, and leaves the posture", async () => {
		const h = harness({
			answer: (o) =>
				o.title === EXIT_START_TITLE ? EXIT_KEEP_PLANNING : undefined,
		});

		expect(await runExitFlow(h.deps)).toEqual({ kind: "keep-planning" });
		expect(h.modes).toEqual([]);
		expect(h.model.requests).toEqual([]);
		expect(h.store.saves).toEqual([]);
		expect(h.ui.titles()).toEqual([EXIT_START_TITLE]);
		// Compiling is first, because it is what somebody who typed `/mode auto`
		// after a planning conversation usually wants. It is NOT what escape
		// takes.
		expect(h.ui.opened[0]?.options).toEqual([
			`${EXIT_COMPILE} (default)`,
			EXIT_SWITCH_ONLY,
			EXIT_KEEP_PLANNING,
		]);
	});

	it("treats escape, and an answer it cannot resolve, as keeping planning", async () => {
		for (const answer of [undefined, "something else"]) {
			const h = harness({ answer: () => answer });
			expect(await runExitFlow(h.deps)).toEqual({ kind: "keep-planning" });
			expect(h.model.requests).toEqual([]);
		}
	});

	it("switches with no plan and no request on `Just switch mode`", async () => {
		const h = harness({
			answer: (o) =>
				o.title === EXIT_START_TITLE ? EXIT_SWITCH_ONLY : undefined,
		});

		expect(await runExitFlow(h.deps)).toEqual({ kind: "switch-only" });
		expect(h.modes).toEqual(["auto"]);
		expect(h.model.requests).toEqual([]);
		expect(h.ui.titles()).toEqual([EXIT_START_TITLE]);
	});
});

describe("publication, derived rather than asked", () => {
	it("reads the repository, says so, and opens no dialog for it", async () => {
		for (const [publication, expected] of [
			[FULLY_EQUIPPED, { mode: "pr", base: "trunk" }],
			[
				derivePublication({
					originPresent: () => true,
					ghPresent: () => false,
					upstreamHead: () => null,
				}),
				{ mode: "branch", base: FALLBACK_BASE_BRANCH },
			],
			[
				derivePublication({
					originPresent: () => false,
					ghPresent: () => false,
					upstreamHead: () => null,
				}),
				{ mode: "none" },
			],
		] as const) {
			const h = harness({
				publication: () => publication,
				script: [DESCRIPTION, documentText()],
				answer: (o) =>
					o.title === COMPILED_TITLE
						? pick(o.options, COMPILED_BACK)
						: happyPath(o),
			});
			await runExitFlow(h.deps);
			expect(
				h.ui.notices.filter(([message]) => message.startsWith("Publication: ")),
			).toEqual([[publication.why, "info"]]);
			// The dials reach the model through the system prompt, which is where
			// a decision the author cannot see would otherwise be invisible.
			expect(h.model.requests[1]?.systemPrompt).toContain(
				`publication ${expected.mode}`,
			);
			expect(h.ui.titles()).toEqual([
				EXIT_START_TITLE,
				EFFORT_TITLE,
				expect.stringContaining(INTENT_TITLE),
				COMPILED_TITLE,
			]);
		}
	});

	it("refuses a base branch Git would not accept, before anything is asked", async () => {
		const h = harness({
			publication: () => ({
				mode: "pr" as const,
				base: "no spaces here",
				why: "Publication: pull request onto `no spaces here`.",
			}),
			answer: (o) =>
				o.title === EXIT_START_TITLE
					? pick(o.options, EXIT_COMPILE)
					: undefined,
		});

		const outcome = await runExitFlow(h.deps);
		expect(outcome.kind).toBe("refused");
		expect(h.modes).toEqual([]);
		expect(h.model.requests).toEqual([]);
	});
});

// ── The context guard ────────────────────────────────────────────────────────

describe("the context guard", () => {
	it("stops before the first request when the session is too full", async () => {
		const h = harness({
			contextUsage: () => ({
				tokens: 190_000,
				contextWindow: 200_000,
				percent: 95,
			}),
			answer: (o) =>
				o.title === EXIT_START_TITLE
					? pick(o.options, EXIT_COMPILE)
					: undefined,
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("back");
		// The whole point: nothing was asked of a session that could not answer.
		expect(h.model.requests).toEqual([]);
		expect(h.modes).toEqual([]);
		expect(h.said()).toContain("95%");
		expect(h.said()).toContain(`${CONTEXT_LIMIT_PERCENT}%`);
		expect(h.said()).toContain("/compact");
		expect(h.said()).toContain("/mode auto");
	});

	it("asks when there is room, and when the host cannot say", async () => {
		for (const usage of [
			() => ({ tokens: 10_000, contextWindow: 200_000, percent: 5 }),
			() => ({ tokens: null, contextWindow: 200_000, percent: null }),
			undefined,
		]) {
			const h = harness({
				...(usage ? { contextUsage: usage } : {}),
				script: [DESCRIPTION],
				answer: (o) =>
					o.title === EXIT_START_TITLE
						? pick(o.options, EXIT_COMPILE)
						: o.title.startsWith(INTENT_TITLE)
							? pick(o.options, INTENT_BACK)
							: undefined,
			});
			await runExitFlow(h.deps);
			expect(h.model.requests.length).toBe(1);
		}
	});
});

// ── The description ──────────────────────────────────────────────────────────

describe("the description the harness asks for", () => {
	it("asks once, with the description prompt and no tools, and shows it back", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			answer: happyPath,
			client: { reviews: [{ verdict: "ready", findings: [] }] },
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("handed-off");
		const first = h.model.requests[0];
		expect(first?.systemPrompt).toBe(DESCRIPTION_SYSTEM_PROMPT);
		expect(first?.messages).toEqual([
			{ role: "user", text: expect.stringContaining("Write the description") },
		]);
		// The dialog's title IS the description, because Pi's `select` carries
		// no body and the thing being agreed to has to be on screen.
		expect(h.ui.titles()).toContain(`${INTENT_TITLE}\n\n${DESCRIPTION}`);
		// And the agreed text is what the reviewer is told the plan is for.
		expect(h.provider?.started()[0]?.input).toMatchObject({
			intent: DESCRIPTION,
		});
	});

	it("re-asks with the previous answer and the problem, then takes the good one", async () => {
		const h = harness({
			script: ["Too short.", DESCRIPTION, documentText()],
			answer: happyPath,
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("handed-off");
		expect(h.model.requests.length).toBe(3);
		// The retry is a conversation about a specific answer, not the same
		// request sent again.
		expect(h.model.requests[1]?.messages).toEqual([
			{ role: "user", text: expect.stringContaining("Write the description") },
			{ role: "assistant", text: "Too short." },
			{
				role: "user",
				text: expect.stringContaining(`short of the ${MIN_DESCRIPTION_LENGTH}`),
			},
		]);
		// One dialog, over the answer that passed.
		expect(
			h.ui.titles().filter((title) => title.startsWith(INTENT_TITLE)),
		).toEqual([`${INTENT_TITLE}\n\n${DESCRIPTION}`]);
	});

	it("gives up after three, prints the problem, and changes nothing", async () => {
		const h = harness({
			script: ["Short.", "Also short.", "Still short."],
			answer: happyPath,
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("back");
		expect(h.model.requests.length).toBe(MAX_AUTHORING_ATTEMPTS);
		expect(h.modes).toEqual([]);
		expect(h.store.saves).toEqual([]);
		expect(h.said()).toContain(`after ${MAX_AUTHORING_ATTEMPTS} attempts`);
		expect(h.said()).toContain("/mode auto");
	});

	it("lets a person edit it, and refuses an edit past the bound", async () => {
		const edited = `${"E".repeat(60)}.`;
		let edits = 0;
		const h = harness({
			script: [DESCRIPTION, documentText()],
			answer: (opened) => {
				if (opened.title === INTENT_EDITOR_TITLE)
					return edits++ === 0
						? "x".repeat(MAX_DESCRIPTION_LENGTH + 1)
						: edited;
				if (opened.title.startsWith(INTENT_TITLE))
					return pick(opened.options, edits < 2 ? INTENT_EDIT : INTENT_AGREE);
				return happyPath(opened, 0);
			},
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("handed-off");
		expect(h.said()).toContain(`past the ${MAX_DESCRIPTION_LENGTH}`);
		// The edited text is what the document prompt and the reviewer both get.
		expect(h.model.requests[1]?.systemPrompt).toContain(edited);
		expect(h.provider?.started()[0]?.input).toMatchObject({ intent: edited });
	});

	it("goes back to the conversation without asking for a document", async () => {
		const h = harness({
			script: [DESCRIPTION],
			answer: (o) =>
				o.title === EXIT_START_TITLE
					? pick(o.options, EXIT_COMPILE)
					: o.title.startsWith(INTENT_TITLE)
						? pick(o.options, INTENT_BACK)
						: undefined,
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("back");
		expect(h.model.requests.length).toBe(1);
		expect(h.modes).toEqual([]);
		expect(h.said()).toContain("still in plan mode");
	});

	it("knows what a description is not", () => {
		expect(descriptionProblem(DESCRIPTION)).toBeUndefined();
		expect(descriptionProblem("Too short.")).toContain("short of the 40");
		expect(
			descriptionProblem("x".repeat(MAX_DESCRIPTION_LENGTH + 1)),
		).toContain("past the 700");
		expect(descriptionProblem(`${DESCRIPTION}\n\`\`\`ts\nx\n\`\`\``)).toContain(
			"code fence",
		);
		expect(descriptionProblem(`${DESCRIPTION}\n- one\n- two`)).toContain(
			"list",
		);
		expect(descriptionProblem(`${DESCRIPTION}\n1. one`)).toContain("list");
	});
});

// ── The document ─────────────────────────────────────────────────────────────

describe("the document the harness asks for", () => {
	it("asks with the guide, the schema, the description and the decided dials", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			answer: happyPath,
		});

		await runExitFlow(h.deps);

		const request = h.model.requests[1];
		expect(request?.messages).toEqual([
			{ role: "user", text: DOCUMENT_REQUEST },
		]);
		const prompt = request?.systemPrompt ?? "";
		expect(prompt).toContain(DESCRIPTION);
		expect(prompt).toContain("effort standard");
		expect(prompt).toContain("gates approve-plan+ship");
		expect(prompt).toContain("publication pr onto `trunk`");
		expect(prompt).toContain("not yours to write");
		// The schema travels as JSON Schema, which is what TypeBox already is.
		expect(prompt).toContain('"deliverables"');
		expect(prompt).toContain('"reviews"');
		expect(prompt).not.toContain('"policy"');
	});

	it("stores a v5 plan with the policy the dialogs settled", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			answer: happyPath,
		});

		await runExitFlow(h.deps);

		const stored = h.store.saves[0];
		expect(stored).toMatchObject({
			slug: "compose",
			title: "Compose the catalogue",
			repos: [{ key: "wf", path: REPO }],
			policy: {
				effort: "standard",
				gates: "approve-plan+ship",
				publish: { mode: "pr", base: "trunk" },
			},
		});
		// v5: tasks are work, reviews are a list beside them, no stages.
		expect(stored?.deliverables[0]).toMatchObject({
			id: "d1",
			after: [],
			reads: [],
			tasks: [{ id: "impl", title: "Do the work" }],
			reviews: [{ lens: "contracts", tier: "standard" }],
		});
		expect(stored).not.toHaveProperty("stages");
		expect(validatePlan(stored as Plan, cleanProbe)).toEqual([]);
	});

	it("re-asks with the previous document and the problems, then stores", async () => {
		const h = harness({
			script: [DESCRIPTION, BROKEN_EDGE, documentText()],
			answer: happyPath,
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("handed-off");
		expect(h.model.requests.length).toBe(3);
		const retry = h.model.requests[2]?.messages ?? [];
		expect(retry[0]).toEqual({ role: "user", text: DOCUMENT_REQUEST });
		// The previous answer, verbatim, and the validator's own sentences.
		expect(retry[1]).toEqual({ role: "assistant", text: BROKEN_EDGE });
		expect(retry[2]?.role).toBe("user");
		expect(retry[2]?.text).toContain("send the whole document again");
		expect(retry[2]?.text).toContain("nowhere");
		expect(h.store.saves.length).toBe(1);
	});

	it("takes a fenced answer off the fence rather than spending an attempt", async () => {
		const h = harness({
			script: [DESCRIPTION, `\`\`\`json\n${documentText()}\n\`\`\``],
			answer: happyPath,
		});

		expect((await runExitFlow(h.deps)).kind).toBe("handed-off");
		expect(h.model.requests.length).toBe(2);
		expect(withoutCodeFence("```json\n{}\n```")).toBe("{}");
		expect(withoutCodeFence('{"a":1}')).toBe('{"a":1}');
	});

	it("says so plainly when the answer is prose", () => {
		const parsed = parseDocument("Sure! Here is the plan you asked for.");
		expect("problems" in parsed && parsed.problems[0]).toContain(
			"not one JSON object",
		);
	});

	it("gives up after three, prints the problems, and stores nothing", async () => {
		const h = harness({
			script: [DESCRIPTION, BROKEN_EDGE, BROKEN_EDGE, BROKEN_EDGE],
			answer: happyPath,
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("back");
		expect(h.store.saves).toEqual([]);
		expect(h.modes).toEqual([]);
		expect(h.said()).toContain(`after ${MAX_AUTHORING_ATTEMPTS} attempts`);
		expect(h.said()).toContain("nowhere");
		// Three plan attempts on the record, and the description's one beside
		// them: the file is the whole story of this exit, not part of it.
		const evidence = h.evidence();
		expect(evidence.schemaVersion).toBe(AUTHORING_EVIDENCE_SCHEMA_VERSION);
		expect(evidence.attempts.filter((a) => a.kind === "plan").length).toBe(
			MAX_AUTHORING_ATTEMPTS,
		);
		expect(evidence.attempts.map((a) => a.kind)).toEqual([
			"intent",
			"plan",
			"plan",
			"plan",
		]);
		expect(
			evidence.attempts.every((a) => a.ok === false || a.kind === "intent"),
		).toBe(true);
	});
});

// ── When the provider does not answer ────────────────────────────────────────

describe("a provider that does not answer", () => {
	it("ends back in the conversation with a cause nothing leaked into", async () => {
		const secret = "https://api.example.invalid/v1?key=sk-live-1234";
		const h = harness({
			script: [
				DESCRIPTION,
				{ failure: `connect ECONNREFUSED ${secret}` },
				{ failure: `connect ECONNREFUSED ${secret}` },
				{ failure: `connect ECONNREFUSED ${secret}` },
			],
			answer: happyPath,
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("back");
		expect(h.store.saves).toEqual([]);
		expect(h.said()).toContain(PROVIDER_FAILURE_PROBLEM);
		// The provider's own message never reaches the person or the record.
		expect(h.said()).not.toContain(secret);
	});

	it("records the sanitised cause and nothing else, with no plan directory", async () => {
		// Nothing named a slug, so there is nowhere beside a plan to write: the
		// evidence is a record ABOUT a plan, and there is no plan.
		const h = harness({
			script: [{ failure: "boom" }, { failure: "boom" }, { failure: "boom" }],
			answer: happyPath,
		});

		expect((await runExitFlow(h.deps)).kind).toBe("back");
		expect(() => h.evidence()).toThrow();
		expect(h.said()).toContain(PROVIDER_FAILURE_PROBLEM);
	});
});

// ── When the session goes away ───────────────────────────────────────────────

describe("a session replaced mid-request", () => {
	it("ends the flow without a plan, a posture change or a notice", async () => {
		const live = new AbortController();
		const h = harness({
			signal: live.signal,
			script: [DESCRIPTION, { abort: live }],
			answer: happyPath,
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome).toEqual({ kind: "aborted" });
		expect(h.store.saves).toEqual([]);
		expect(h.modes).toEqual([]);
		expect(h.announced).toEqual([]);
	});

	it("believes the signal over a dialog that resolved like an escape", async () => {
		const live = new AbortController();
		const h = harness({
			signal: live.signal,
			answer: happyPath,
			after: (opened) => {
				if (opened.title === EFFORT_TITLE) live.abort();
			},
		});

		expect(await runExitFlow(h.deps)).toEqual({ kind: "aborted" });
		expect(h.model.requests).toEqual([]);
	});
});

// ── The evidence ─────────────────────────────────────────────────────────────

describe("authoring.json", () => {
	it("holds one entry per attempt, and nothing that could identify the answer", async () => {
		const h = harness({
			script: [DESCRIPTION, BROKEN_EDGE, documentText()],
			answer: happyPath,
		});

		await runExitFlow(h.deps);

		const evidence = h.evidence();
		expect(evidence.schemaVersion).toBe(1);
		expect(evidence.attempts.map((a) => [a.kind, a.ok])).toEqual([
			["intent", true],
			["plan", false],
			["plan", true],
		]);
		for (const attempt of evidence.attempts) {
			expect(attempt.model).toBe("anthropic/opus-5");
			// `low` for the session, `medium` for standard effort: never below
			// what the session was already set to, and never below the effort.
			expect(attempt.thinking).toBe("medium");
			expect(attempt.durationMs).toBeGreaterThanOrEqual(0);
			expect(attempt.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(attempt.responseDigest).toMatch(/^[0-9a-f]{16}$/);
		}
		const text = h.evidenceText();
		// Not the answer, not a path, not a provider's words.
		expect(text).not.toContain("Compose the catalogue");
		expect(text).not.toContain(DESCRIPTION);
		expect(text).not.toContain(h.root);
		expect(text).not.toContain(REPO);
		// The problems ARE the validator's sentences.
		expect(evidence.attempts[1]?.problems.join("\n")).toContain("nowhere");
	});

	it("maps effort to a level, and never below the session's own", () => {
		expect(authoringThinking("cheap")).toBe("low");
		expect(authoringThinking("standard")).toBe("medium");
		expect(authoringThinking("deep")).toBe("high");
		expect(authoringThinking("cheap", "high")).toBe("high");
		expect(authoringThinking("deep", "low")).toBe("high");
		expect(authoringThinking("standard", "max")).toBe("max");
	});
});

// ── What the conversation is told ────────────────────────────────────────────

describe("the one message the conversation gets", () => {
	it("names the slug, the digest, the deliverables and the outcome", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			answer: happyPath,
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("handed-off");
		const digest = planDigest(h.store.saves.at(-1) as Plan);
		expect(h.announced.map((m) => m.customType)).toEqual([
			PLAN_MESSAGE_TYPE,
			PLAN_MESSAGE_TYPE,
		]);
		for (const message of h.announced) {
			expect(message.display).toBe(true);
			expect(message.content).toContain("`compose`");
			expect(message.content).toContain(digest);
			expect(message.content).toContain("2 deliverables");
		}
		expect(h.announced[0]?.content).toContain("stored");
		expect(h.announced[1]?.content).toContain("run has been requested");
		// NOTHING ELSE reaches the conversation: the requests, the retries and
		// the validators' complaints stay on the record.
		expect(h.steers.length).toBe(1);
		expect(h.steers[0]).toContain("workflow_run");
		expect(h.announced.map((m) => m.content).join("\n")).not.toContain(
			DOCUMENT_REQUEST,
		);
	});

	it("says so when the exit goes back instead", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			answer: (opened) =>
				opened.title === COMPILED_TITLE
					? pick(opened.options, COMPILED_BACK)
					: happyPath(opened, 0),
		});

		expect((await runExitFlow(h.deps)).kind).toBe("back");
		expect(h.announced.map((m) => m.content.includes("without a run"))).toEqual(
			[false, true],
		);
		expect(h.modes).toEqual([]);
	});
});

// ── The rest of the exit ─────────────────────────────────────────────────────

describe("readiness, the graph and the run", () => {
	it("asks exactly five dialogs for a two-deliverable plan and hands off", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			answer: happyPath,
			client: { reviews: [{ verdict: "ready", findings: [] }] },
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("handed-off");
		expect(h.ui.titles()).toEqual([
			EXIT_START_TITLE,
			EFFORT_TITLE,
			`${INTENT_TITLE}\n\n${DESCRIPTION}`,
			COMPILED_TITLE,
			START_RUN_TITLE,
		]);
		// The posture moves exactly once, and only here.
		expect(h.modes).toEqual(["auto"]);
		expect(h.provider?.started().map((c) => c.ref)).toEqual([
			`runBuiltin:${PLAN_REVIEW_REF}`,
		]);
		expect(h.inputs.length).toBe(1);
		expect(h.steers[0]).toContain(PLAN_WORKFLOW_REF);
	});

	it("stops at a dirty tree when the person says so, with the plan stored", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			world: {
				...readyWorld,
				probe: (path) => ({ root: path, resolved: path, dirty: true }),
			},
			answer: (opened) =>
				opened.title.includes("uncommitted") ? undefined : happyPath(opened, 0),
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("back");
		expect(h.store.saves.length).toBe(1);
		expect(h.modes).toEqual([]);
		expect(h.provider?.started()).toEqual([]);
	});

	it("ends with the plan stored when there is no runtime to compile against", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			client: null,
			answer: happyPath,
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("stored");
		expect(h.store.saves.length).toBe(1);
		expect(h.modes).toEqual([]);
		expect(h.said()).toContain("/plan run compose");
	});

	it("does not start the run when the last question is answered no", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			answer: (opened) =>
				opened.title === START_RUN_TITLE ? false : happyPath(opened, 0),
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("stored");
		expect(h.modes).toEqual([]);
		expect(h.steers).toEqual([]);
	});

	it("shows the reviewers the plan settled, beside the description", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			answer: happyPath,
		});
		await runExitFlow(h.deps);
		const shown = h.ui.notices.find(([message]) =>
			message.startsWith("Agreed: "),
		);
		expect(shown?.[0]).toContain(DESCRIPTION);
		expect(shown?.[0]).toContain("Reviewers: contracts/standard ×2");
	});
});

// ── The revise loop ──────────────────────────────────────────────────────────

const BLOCKING: Finding = {
	id: "f1",
	severity: "blocking",
	kind: "gap",
	where: "/deliverables/0",
	what: "nothing tests the catalogue",
};

describe("revise with the model", () => {
	it("re-requests in the same conversation, re-stores, and re-reviews", async () => {
		const revised = documentText({ title: "Compose the catalogue, revised" });
		const h = harness({
			script: [DESCRIPTION, documentText(), revised],
			client: {
				reviews: [
					{
						verdict: "blocked",
						findings: [BLOCKING],
						notes: "It needs tests.",
					},
					{ verdict: "ready", findings: [] },
				],
			},
			answer: (opened) => {
				if (opened.title.includes(BLOCKING.what))
					return pick(opened.options, FINDING_REVISE);
				return happyPath(opened, 0);
			},
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("handed-off");
		// Three requests: the description, the document, the rewrite — and the
		// rewrite is the SAME mini-conversation, with the review appended.
		expect(h.model.requests.length).toBe(3);
		const rewrite = h.model.requests[2]?.messages ?? [];
		expect(rewrite[0]?.text).toBe(DOCUMENT_REQUEST);
		expect(rewrite[1]).toEqual({ role: "assistant", text: documentText() });
		expect(rewrite[2]?.role).toBe("user");
		expect(rewrite[2]?.text).toContain(BLOCKING.what);
		expect(rewrite[2]?.text).toContain("It needs tests.");
		// No steer: the review went back through the request, not the session.
		expect(h.steers.length).toBe(1);
		// Two plans stored, two reviews run, and the compiled dialog was asked
		// once — the re-review does not ask it again.
		expect(h.store.saves.map((plan) => plan.title)).toEqual([
			"Compose the catalogue",
			"Compose the catalogue, revised",
		]);
		expect(h.provider?.started().length).toBe(2);
		expect(h.ui.titles().filter((t) => t === COMPILED_TITLE).length).toBe(1);
		// The revise attempt is on the record under its own name.
		expect(h.evidence().attempts.map((a) => a.kind)).toEqual([
			"intent",
			"plan",
			"revise",
		]);
	});

	it("keeps the bound of three blind reviews per exit", async () => {
		const blocked = { verdict: "blocked", findings: [BLOCKING] };
		const h = harness({
			script: [
				DESCRIPTION,
				documentText(),
				documentText({ title: "Two" }),
				documentText({ title: "Three" }),
			],
			client: { reviews: [blocked, blocked, blocked] },
			answer: (opened) => {
				if (opened.title.includes(BLOCKING.what))
					return opened.options?.some((option) =>
						option.startsWith(FINDING_REVISE),
					)
						? pick(opened.options, FINDING_REVISE)
						: pick(opened.options, FINDING_DISMISS);
				if (opened.kind === "input") return "we disagree, on the record";
				return happyPath(opened, 0);
			},
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("back");
		expect(h.provider?.started().length).toBe(MAX_BLIND_REVIEWS);
		expect(h.modes).toEqual([]);
	});

	it("goes back when the rewrite never validates", async () => {
		const h = harness({
			script: [
				DESCRIPTION,
				documentText(),
				BROKEN_EDGE,
				BROKEN_EDGE,
				BROKEN_EDGE,
			],
			client: { reviews: [{ verdict: "blocked", findings: [BLOCKING] }] },
			answer: (opened) =>
				opened.title.includes(BLOCKING.what)
					? pick(opened.options, FINDING_REVISE)
					: happyPath(opened, 0),
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("back");
		// The first plan is still stored; the rewrite never replaced it.
		expect(h.store.saves.length).toBe(1);
		expect(h.modes).toEqual([]);
		expect(h.said()).toContain(`after ${MAX_AUTHORING_ATTEMPTS} attempts`);
	});
});

// ── Every option table ───────────────────────────────────────────────────────

/** Every exported `ExitOption` table, found rather than listed. */
function optionTables(
	modules: Record<string, Record<string, unknown>>,
): [string, readonly ExitOption<unknown>[]][] {
	const found: [string, readonly ExitOption<unknown>[]][] = [];
	for (const [where, module] of Object.entries(modules))
		for (const [name, value] of Object.entries(module)) {
			if (!Array.isArray(value) || value.length === 0) continue;
			const table = value as readonly unknown[];
			if (
				!table.every(
					(entry) =>
						typeof entry === "object" &&
						entry !== null &&
						"value" in entry &&
						"text" in entry &&
						typeof (entry as { text: unknown }).text === "string",
				)
			)
				continue;
			found.push([`${where}.${name}`, table as readonly ExitOption<unknown>[]]);
		}
	return found;
}

describe("what is recommended, and what escape takes", () => {
	it("marks exactly one of each, and never lets escape be a commitment", () => {
		const tables = optionTables({ "exit-flow": exitFlow, findings });
		// The list is found, not written down, so a table added later is covered
		// by this test without anybody remembering to add it.
		expect(tables.map(([name]) => name).sort()).toEqual([
			"exit-flow.COMPILED_OPTIONS",
			"exit-flow.COMPILED_OPTIONS_UNREVIEWED",
			"exit-flow.DIRTY_OPTIONS",
			"exit-flow.EFFORT_OPTIONS",
			"exit-flow.EXIT_START_OPTIONS",
			"exit-flow.INTENT_OPTIONS",
			"findings.FINDING_OPTIONS",
			"findings.FINDING_OPTIONS_FINAL",
			"findings.FINDING_OPTIONS_FINAL_UNPATCHABLE",
			"findings.FINDING_OPTIONS_UNPATCHABLE",
		]);
		for (const [name, table] of tables) {
			const recommended = table.filter((option) => option.recommended);
			const escapes = table.filter((option) => option.escape);
			expect([name, recommended.length]).toEqual([name, 1]);
			expect([name, escapes.length]).toEqual([name, 1]);
			expect([name, table[0]?.recommended]).toEqual([name, true]);
			expect([
				name,
				optionLabels(table).filter((label) => label.endsWith(" (default)")),
			]).toEqual([name, [optionLabel(table[0] as ExitOption<unknown>)]]);
			expect([name, chosenOption(table, undefined)]).toEqual([
				name,
				escapes[0]?.value,
			]);
			expect([name, chosenOption(table, "something else")]).toEqual([
				name,
				escapes[0]?.value,
			]);
			for (const option of table)
				expect([name, chosenOption(table, optionLabel(option))]).toEqual([
					name,
					option.value,
				]);
		}
	});

	it("separates the two everywhere it matters, and joins them only on effort", () => {
		const both = optionTables({ "exit-flow": exitFlow, findings }).filter(
			([, table]) =>
				table.some((option) => option.recommended && option.escape),
		);
		expect(both.map(([name]) => name)).toEqual(["exit-flow.EFFORT_OPTIONS"]);
	});

	it("offers the three efforts with `standard` first", () => {
		expect(optionLabels(EFFORT_OPTIONS)).toEqual([
			"standard (default)",
			"cheap",
			"deep",
		]);
		expect(chosenOption(EFFORT_OPTIONS, undefined)).toBe("standard");
	});

	it("does not make agreement the thing an unanswered dialog does", () => {
		expect(chosenOption(INTENT_OPTIONS, undefined)).toBe("back");
		expect(optionLabels(INTENT_OPTIONS)).toEqual([
			`${INTENT_AGREE} (default)`,
			INTENT_EDIT,
			INTENT_BACK,
		]);
		expect(optionLabels(EXIT_START_OPTIONS)[0]).toBe(
			`${EXIT_COMPILE} (default)`,
		);
	});
});

// ── The prompts themselves ───────────────────────────────────────────────────

describe("the two system prompts", () => {
	it("say the model has no tools and starts nothing", () => {
		const document = renderDocumentSystemPrompt(
			{ effort: "deep", gates: "approve-plan", publish: { mode: "none" } },
			DESCRIPTION,
		);
		for (const prompt of [DESCRIPTION_SYSTEM_PROMPT, document]) {
			expect(prompt).toContain("no tools");
			expect(prompt).toContain("nothing you write starts anything");
		}
		// The document prompt keeps the facts the old steer carried.
		expect(document).toContain("effort deep");
		expect(document).toContain("gates approve-plan");
		expect(document).toContain("blind");
		expect(document).toContain("`tasks` are the work");
		// And the description prompt keeps its own.
		expect(DESCRIPTION_SYSTEM_PROMPT).toContain("two or three sentences");
		expect(DESCRIPTION_SYSTEM_PROMPT).toContain("Not a title");
		expect(DESCRIPTION_SYSTEM_PROMPT).toContain(String(MIN_DESCRIPTION_LENGTH));
		expect(DESCRIPTION_SYSTEM_PROMPT).toContain(String(MAX_DESCRIPTION_LENGTH));
	});
});

describe("renderReviewers", () => {
	it("says so when nothing in the plan is read by anybody", () => {
		expect(
			renderReviewers({
				deliverables: [{ id: "d1", stages: [] }],
			} as never),
		).toContain("none");
	});
});

describe("the compiled dialog without a reviewer", () => {
	it("drops `Review it blind` and recommends approving", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			client: {
				runBuiltin: async () => {
					throw new Error("no reviewer here");
				},
			},
			answer: (opened) =>
				opened.title === COMPILED_TITLE &&
				!opened.options?.some((o) => o.startsWith(COMPILED_REVIEW))
					? pick(opened.options, COMPILED_APPROVE)
					: happyPath(opened, 0),
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("handed-off");
		const asked = h.ui.opened.filter((o) => o.title === COMPILED_TITLE);
		expect(asked.length).toBe(2);
		expect(asked[1]?.options?.some((o) => o.startsWith(COMPILED_REVIEW))).toBe(
			false,
		);
	});
});
