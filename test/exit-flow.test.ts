// The plan-mode hand-off, end to end, driven through a fake UI, a fake
// completion, a fake workflow runtime and a fake plan check.
//
// The hand-off is ONE flow: the effort dial, a request for the description, a
// request for the document, the plan check the harness acts on itself, and one
// confirmation. Nothing is on disk between the steps, so what the old suites
// checked after every turn — the pending record — has nothing to check. What is
// left is what actually matters, and every case below asserts the same five
// facts after the fact: the outcome, the plan in the store, the posture, exactly
// which dialogs were opened, and exactly what was asked of the model.
//
// The completion port is a fake with a SCRIPT, and so is the plan check. That is
// the point of both being ports: the failure modes that killed four by-hand
// passes — an answer in prose, an answer that never validates, a provider that
// does not answer, a session that goes away mid-request — are each one line
// here, and so is a reviewer that blocks, one that needs a person, and one that
// cannot be reached at all.

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
	CHECK_KEEP_PLANNING,
	CHECK_OPTIONS,
	CHECK_PROCEED,
	chosenOption,
	createModeExitController,
	DESCRIPTION_EDITOR_TITLE,
	derivePublication,
	EFFORT_OPTIONS,
	EFFORT_TITLE,
	type ExitFlowDeps,
	type ExitFlowUi,
	type ExitOption,
	FALLBACK_BASE_BRANCH,
	optionLabel,
	optionLabels,
	PLAN_MESSAGE_TYPE,
	renderPlanSummary,
	runExitFlow,
	START_EDIT,
	START_KEEP_PLANNING,
	START_OPTIONS,
	START_RUN,
	START_SWITCH,
	START_TITLE,
} from "../packages/maestro/src/exit-flow.js";
import { type ModeName, modeCeiling } from "../packages/maestro/src/mode.js";
import {
	inspectPlan,
	type Plan,
	type RepoProbe,
	validatePlan,
} from "../packages/maestro/src/plan.js";
import * as planCheck from "../packages/maestro/src/plan-check.js";
import {
	MAX_PLAN_CHECK_REVISIONS,
	NO_PLAN_CHECK_REASON,
	type PlanCheck,
	type PlanCheckFinding,
	type PlanCheckResult,
	type PlanCheckUnavailable,
} from "../packages/maestro/src/plan-check.js";
import { PLAN_WORKFLOW_REF } from "../packages/maestro/src/plan-command.js";
import { planDigest } from "../packages/maestro/src/plan-input.js";
import type { WorkflowReadClient } from "../packages/maestro/src/workflow-provider.js";

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
	return { complete, requests };
}

/** A working-tree root with nothing uncommitted in it, without a filesystem. */
const cleanProbe: RepoProbe = (path) => ({
	root: path,
	resolved: path,
	dirty: false,
});

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
				// reaches disk, and the hand-off has to survive being told so.
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

interface FakeClientOptions {
	/** The plan's own run. Scripted so a refusal is a test, not a mock. */
	readonly startBuiltin?: () => Promise<{ runId: string }>;
}

function fakeClient(options: FakeClientOptions = {}) {
	const calls: { ref: string; input: unknown }[] = [];
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
		project: async () => {
			throw new Error("the hand-off projects nothing");
		},
		inspect: async () => ({}),
		runs: async () => ({}),
		observe: () => () => {},
		startBuiltin:
			options.startBuiltin ??
			(async (ref: string, options_: { input: unknown; effort?: string }) => {
				calls.push({ ref: `startBuiltin:${ref}`, input: options_ });
				return { runId: PLAN_RUN_ID };
			}),
	} as WorkflowReadClient;
	return {
		client,
		calls,
		plansStarted: () => calls.filter((c) => c.ref.startsWith("startBuiltin")),
	};
}

/** The run id the fake runtime hands back for the plan's own run. */
const PLAN_RUN_ID = "wfr-plan-to-ship-1";

/** A plan check with a scripted answer per round. */
function fakeCheck(
	rounds: readonly (PlanCheckResult | PlanCheckUnavailable)[],
) {
	const seen: { slug: string; description: string }[] = [];
	let index = 0;
	const check: PlanCheck = async (plan, description) => {
		seen.push({ slug: plan.slug, description });
		const answer = rounds[index++];
		if (answer === undefined)
			throw new Error(
				`the flow checked ${index} times and the script has ${rounds.length}`,
			);
		return answer;
	};
	return { check, seen, ran: () => index };
}

const APPROVED: PlanCheckResult = {
	verdict: "approve",
	findings: [],
	notes: "",
};

const BLOCKING: PlanCheckFinding = {
	id: "f1",
	severity: "blocking",
	where: "deliverable d1",
	summary: "nothing tests the catalogue",
	direction: "add a task that runs the suite",
};

const NEEDS_PERSON: PlanCheckFinding = {
	id: "f2",
	severity: "blocking",
	where: "the plan as a whole",
	summary:
		"this replaces a published API and nobody has said whether that is allowed",
	needsPerson: true,
	question: "Is breaking the published API acceptable here?",
};

const MINOR: PlanCheckFinding = {
	id: "f3",
	severity: "minor",
	where: "deliverable d2",
	summary: "the title could name the repository",
};

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
	readonly check?: readonly (PlanCheckResult | PlanCheckUnavailable)[] | null;
	readonly signal?: AbortSignal;
	readonly contextUsage?: ExitFlowDeps["contextUsage"];
	readonly publication?: ExitFlowDeps["publication"];
	readonly announce?: false;
	/** The posture the person asked for; the ceiling the run starts under. */
	readonly wanted?: ExitFlowDeps["wanted"];
}

function harness(options: HarnessOptions = {}) {
	const root = temp();
	const store = fakeStore(root);
	const ui = fakeUi(options.answer, options.after);
	const model = fakeComplete(options.script ?? []);
	const provider =
		options.client === null ? undefined : fakeClient(options.client ?? {});
	const check =
		options.check === null ? undefined : fakeCheck(options.check ?? [APPROVED]);
	const inputs: [string, string][] = [];
	const modes: ModeName[] = [];
	const announced: exitFlow.PlanAnnouncement[] = [];
	let clock = Date.UTC(2026, 8, 16, 12, 0, 0);
	const deps: ExitFlowDeps = {
		ui: ui.ui,
		wanted: options.wanted ?? "auto",
		setMode: (name) => {
			modes.push(name);
		},
		complete: model.complete,
		store: store.store,
		cwd: REPO,
		inspect: (candidate) => inspectPlan(candidate, cleanProbe),
		workflow: async () => provider?.client,
		publication: options.publication ?? (() => FULLY_EQUIPPED),
		inputPath: (slug) => join(root, `${slug}-input.json`),
		writeInput: (path, json) => inputs.push([path, json]),
		modelId: "anthropic/opus-5",
		thinkingLevel: "low",
		now: () => {
			clock += 1_000;
			return new Date(clock);
		},
		...(check ? { planCheck: check.check } : {}),
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
		model,
		check,
		inputs,
		modes,
		announced,
		provider,
		said: () => ui.said(),
		confirmation: (): string =>
			ui.titles().find((title) => title.startsWith(START_TITLE)) ?? "",
		evidence: (slug = "compose"): AuthoringEvidence =>
			JSON.parse(
				readFileSync(join(root, slug, AUTHORING_EVIDENCE_FILE), "utf8"),
			) as AuthoringEvidence,
		evidenceText: (slug = "compose"): string =>
			readFileSync(join(root, slug, AUTHORING_EVIDENCE_FILE), "utf8"),
	};
}

/**
 * The answers that walk the happy path: standard effort, start the run.
 *
 * Every one of them is given EXPLICITLY, because escape means none of them: the
 * recommended row is first in each table and the escape row is the safe way out,
 * and this path is the one where somebody said yes.
 */
const happyPath = (opened: Opened, _index = 0): Answer => {
	if (opened.title.startsWith(START_TITLE))
		return pick(opened.options, START_RUN);
	if (opened.title === EFFORT_TITLE) return pick(opened.options, "standard");
	return undefined;
};

// ── The sequence ─────────────────────────────────────────────────────────────

describe("the hand-off, from `/mode auto` to a run", () => {
	it("asks two dialogs for a two-deliverable plan and starts the run", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			answer: happyPath,
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome).toMatchObject({
			kind: "started",
			slug: "compose",
			runId: PLAN_RUN_ID,
			asked: 2,
		});
		// THE EFFORT DIAL AND THE CONFIRMATION. Nothing else is asked: the
		// description is agreed inside the confirmation, publication is derived,
		// the gates take their default, and the plan check is the harness's to act
		// on rather than a person's to walk.
		expect(h.ui.titles()).toEqual([EFFORT_TITLE, h.confirmation()]);
		expect(h.ui.opened.map((o) => o.kind)).toEqual(["select", "select"]);
		// The posture moves exactly once, and only once the run exists.
		expect(h.modes).toEqual(["auto"]);
		expect(h.check?.ran()).toBe(1);
		expect(h.inputs.length).toBe(1);
		// The harness started the plan's run itself, through the allowlisted
		// `startBuiltin`, with the input it just exported and the effort agreed.
		expect(h.provider?.plansStarted()).toEqual([
			{
				ref: `startBuiltin:${PLAN_WORKFLOW_REF}`,
				input: {
					input: JSON.parse(h.inputs[0]?.[1] as string),
					effort: "standard",
					// THE TARGET MODE'S CEILING: the run starts while the posture
					// switches, so it is bounded by where the person is going.
					ceiling: modeCeiling("auto"),
				},
			},
		]);
	});

	it("starts the run under the ceiling of the posture being switched to", async () => {
		// Plan mode's ceiling is read-only and this run writes to worktrees, so
		// bounding it by the posture the hand-off is LEAVING would refuse the run
		// the hand-off exists to start.
		for (const wanted of ["auto", "hack"] as const) {
			const h = harness({
				wanted,
				script: [DESCRIPTION, documentText()],
				answer: happyPath,
			});
			expect((await runExitFlow(h.deps)).kind).toBe("started");
			const started = h.provider?.plansStarted()[0]?.input as {
				ceiling?: unknown;
			};
			const ceiling = modeCeiling(wanted);
			expect([wanted, started.ceiling]).toEqual([wanted, ceiling]);
			// Hack is the posture whose whole meaning is that the restrictions are
			// off, so the start carries no ceiling at all.
			expect([wanted, started.ceiling === undefined]).toEqual([
				wanted,
				wanted === "hack",
			]);
			expect(h.modes).toEqual([wanted]);
		}
		expect(modeCeiling("plan")).toEqual({ workspaceModes: ["read-only"] });
	});

	it("shows the description, the plan, publication, the check and the gate", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			answer: happyPath,
			check: [{ verdict: "gaps", findings: [MINOR], notes: "Reads fine." }],
		});

		await runExitFlow(h.deps);

		const body = h.confirmation();
		expect(body.startsWith(`${START_TITLE}\n\n${DESCRIPTION}`)).toBe(true);
		expect(body).toContain(
			"`compose` — 2 deliverables, effort standard, gates ship.",
		);
		expect(body).toContain("  d1 — Deliverable one\n      impl: Do the work");
		expect(body).toContain("      read by contracts (tier standard)");
		expect(body).toContain("  d2 — Deliverable two, after d1");
		expect(body).toContain(FULLY_EQUIPPED.why);
		expect(body).toContain("Plan check: `gaps` — 1 minor.");
		expect(body).toContain(MINOR.summary);
		expect(body).toContain(
			"Starting it is the approval, and it works through the plan and stops at its `ship` decision.",
		);
	});

	it("offers the four answers, with starting first and escape committing to nothing", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			answer: happyPath,
		});
		await runExitFlow(h.deps);
		expect(h.ui.opened[1]?.options).toEqual([
			`${START_RUN} (default)`,
			START_EDIT,
			START_SWITCH,
			START_KEEP_PLANNING,
		]);
		expect(chosenOption(START_OPTIONS, undefined)).toBe("keep");
	});
});

describe("each answer to the one confirmation", () => {
	it("keeps planning on escape: nothing runs, nothing switches, the plan is stored", async () => {
		for (const answer of [undefined, "something else", START_KEEP_PLANNING]) {
			const h = harness({
				script: [DESCRIPTION, documentText()],
				answer: (o) =>
					o.title.startsWith(START_TITLE) ? answer : happyPath(o),
			});

			const outcome = await runExitFlow(h.deps);

			expect(outcome).toMatchObject({ kind: "back", slug: "compose" });
			expect(h.modes).toEqual([]);
			expect(h.store.saves.length).toBe(1);
			expect(h.provider?.plansStarted()).toEqual([]);
			expect(h.said()).toContain("still in plan mode");
			expect(h.said()).toContain("/plan run compose");
		}
	});

	it("switches and keeps the plan stored, without starting anything", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			answer: (o) =>
				o.title.startsWith(START_TITLE)
					? pick(o.options, START_SWITCH)
					: happyPath(o),
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome).toMatchObject({ kind: "stored", slug: "compose" });
		// THE POSTURE MOVES: the person asked for it and answered the question.
		expect(h.modes).toEqual(["auto"]);
		expect(h.provider?.plansStarted()).toEqual([]);
		expect(h.said()).toContain("Mode auto");
		expect(h.said()).toContain("/plan run compose");
	});

	it("edits the description in place and comes back to the same confirmation", async () => {
		const edited = `${"E".repeat(60)}.`;
		let edits = 0;
		const h = harness({
			script: [DESCRIPTION, documentText()],
			answer: (opened) => {
				if (opened.title === DESCRIPTION_EDITOR_TITLE)
					return edits++ === 0
						? "x".repeat(MAX_DESCRIPTION_LENGTH + 1)
						: edited;
				if (opened.title.startsWith(START_TITLE))
					return pick(opened.options, edits < 2 ? START_EDIT : START_RUN);
				return happyPath(opened);
			},
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("started");
		expect(h.said()).toContain(`past the ${MAX_DESCRIPTION_LENGTH}`);
		// Three confirmations, two editors, and the last confirmation carries the
		// edited text: the editor returns to the question rather than answering it.
		expect(h.ui.titles().filter((t) => t.startsWith(START_TITLE)).length).toBe(
			3,
		);
		expect(
			h.ui.titles().filter((t) => t === DESCRIPTION_EDITOR_TITLE).length,
		).toBe(2);
		expect(h.ui.titles().at(-1)).toContain(edited);
		// And the model was asked nothing again: the description is the
		// yardstick, not the document.
		expect(h.model.requests.length).toBe(2);
	});
});

// ── The effort dial ──────────────────────────────────────────────────────────

describe("the one dial a repository cannot answer", () => {
	it("offers the three efforts with `standard` first, and escapes to it", () => {
		expect(optionLabels(EFFORT_OPTIONS)).toEqual([
			"standard (default)",
			"cheap",
			"deep",
		]);
		expect(chosenOption(EFFORT_OPTIONS, undefined)).toBe("standard");
	});

	it("carries the chosen effort into the prompt, the plan and the run", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			answer: (o) =>
				o.title === EFFORT_TITLE ? pick(o.options, "deep") : happyPath(o),
		});

		await runExitFlow(h.deps);

		expect(h.model.requests[1]?.systemPrompt).toContain("effort deep");
		expect(h.store.saves[0]?.policy?.effort).toBe("deep");
		expect(h.confirmation()).toContain("effort deep");
		expect(h.provider?.plansStarted()[0]?.input).toMatchObject({
			effort: "deep",
		});
	});
});

describe("publication, derived rather than asked", () => {
	it("reads the repository, opens no dialog for it, and says so in both places", async () => {
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
				answer: happyPath,
			});
			await runExitFlow(h.deps);
			// The dials reach the model through the system prompt, which is where
			// a decision the author cannot see would otherwise be invisible.
			expect(h.model.requests[1]?.systemPrompt).toContain(
				`publication ${expected.mode}`,
			);
			// And they reach the person through the confirmation, never a dialog.
			expect(h.confirmation()).toContain(publication.why);
			expect(h.ui.titles()).toEqual([EFFORT_TITLE, h.confirmation()]);
		}
	});

	it("refuses a base branch Git would not accept, before anything is asked", async () => {
		const h = harness({
			publication: () => ({
				mode: "pr" as const,
				base: "no spaces here",
				why: "Publication: pull request onto `no spaces here`.",
			}),
			answer: happyPath,
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
			answer: happyPath,
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
				script: [DESCRIPTION, documentText()],
				answer: happyPath,
			});
			expect((await runExitFlow(h.deps)).kind).toBe("started");
			expect(h.model.requests.length).toBe(2);
		}
	});
});

// ── The description ──────────────────────────────────────────────────────────

describe("the description the harness asks for", () => {
	it("asks once, with the description prompt and no tools, and shows it back", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			answer: happyPath,
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("started");
		const first = h.model.requests[0];
		expect(first?.systemPrompt).toBe(DESCRIPTION_SYSTEM_PROMPT);
		expect(first?.messages).toEqual([
			{ role: "user", text: expect.stringContaining("Write the description") },
		]);
		// No dialog of its own: it is in the confirmation, which is where it is
		// agreed to, and it is what the plan check is told the plan is FOR.
		expect(h.confirmation()).toContain(DESCRIPTION);
		expect(h.check?.seen).toEqual([
			{ slug: "compose", description: DESCRIPTION },
		]);
	});

	it("re-asks with the previous answer and the problem, then takes the good one", async () => {
		const h = harness({
			script: ["Too short.", DESCRIPTION, documentText()],
			answer: happyPath,
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("started");
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

// ── Nothing to plan ──────────────────────────────────────────────────────────

describe("leaving plan mode with no plan in the conversation", () => {
	// THE MODEL IS STILL ASKED. The harness cannot know what is in a
	// conversation until it asks, so it asks — and when the answer is empty or
	// refused, the posture the person typed is what they get, with one sentence
	// saying why there is no plan behind it. NEVER A HANG, and never plan mode.
	it("switches with the reason shown when no description comes back", async () => {
		const h = harness({
			script: ["Short.", "Also short.", "Still short."],
			answer: happyPath,
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("switch-only");
		expect(h.model.requests.length).toBe(MAX_AUTHORING_ATTEMPTS);
		expect(h.modes).toEqual(["auto"]);
		expect(h.store.saves).toEqual([]);
		expect(h.said()).toContain(`after ${MAX_AUTHORING_ATTEMPTS} attempts`);
		expect(h.said()).toContain("Mode auto, with no plan stored");
		expect(h.said()).toContain("/mode plan");
		// The confirmation was never opened, so nothing is waiting on anybody.
		expect(h.ui.titles()).toEqual([EFFORT_TITLE]);
	});

	it("switches with the reason shown when no document comes back", async () => {
		const h = harness({
			script: [DESCRIPTION, BROKEN_EDGE, BROKEN_EDGE, BROKEN_EDGE],
			answer: happyPath,
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("switch-only");
		expect(h.store.saves).toEqual([]);
		expect(h.modes).toEqual(["auto"]);
		expect(h.said()).toContain(`after ${MAX_AUTHORING_ATTEMPTS} attempts`);
		expect(h.said()).toContain("nowhere");
		expect(h.said()).toContain("Mode auto, with no plan stored");
		expect(h.check?.ran()).toBe(0);
		// Three plan attempts on the record, and the description's one beside
		// them: the file is the whole story of this hand-off, not part of it.
		const evidence = h.evidence();
		expect(evidence.schemaVersion).toBe(AUTHORING_EVIDENCE_SCHEMA_VERSION);
		expect(evidence.attempts.map((a) => a.kind)).toEqual([
			"intent",
			"plan",
			"plan",
			"plan",
		]);
	});

	it("switches with a sanitised reason when the provider never answers", async () => {
		const secret = "https://api.example.invalid/v1?key=sk-live-1234";
		const h = harness({
			script: [
				{ failure: `connect ECONNREFUSED ${secret}` },
				{ failure: `connect ECONNREFUSED ${secret}` },
				{ failure: `connect ECONNREFUSED ${secret}` },
			],
			answer: happyPath,
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("switch-only");
		expect(h.modes).toEqual(["auto"]);
		expect(h.store.saves).toEqual([]);
		expect(h.said()).toContain(PROVIDER_FAILURE_PROBLEM);
		// The provider's own message never reaches the person or the record.
		expect(h.said()).not.toContain(secret);
		// Nothing named a slug, so there is nowhere beside a plan to write: the
		// evidence is a record ABOUT a plan, and there is no plan.
		expect(() => h.evidence()).toThrow();
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
		expect(prompt).toContain("gates ship");
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
				gates: "ship",
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

		expect(outcome.kind).toBe("started");
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

		expect((await runExitFlow(h.deps)).kind).toBe("started");
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
});

// ── The plan check ───────────────────────────────────────────────────────────

describe("the plan check, which the harness answers itself", () => {
	it("says so in the confirmation when it could not run, and never blocks", async () => {
		const reasons = [
			{ check: null, expected: NO_PLAN_CHECK_REASON },
			{
				check: [{ unavailable: "the subagent runtime refused the launch" }],
				expected: "the subagent runtime refused the launch",
			},
		] as const;
		for (const { check, expected } of reasons) {
			const h = harness({
				script: [DESCRIPTION, documentText()],
				answer: happyPath,
				check,
			});

			expect((await runExitFlow(h.deps)).kind).toBe("started");
			expect(h.confirmation()).toContain("Plan check: could not run — ");
			expect(h.confirmation()).toContain(expected);
		}
	});

	it("rewrites the document silently and checks again, with no dialog at all", async () => {
		const revised = documentText({ title: "Compose the catalogue, revised" });
		const h = harness({
			script: [DESCRIPTION, documentText(), revised],
			answer: happyPath,
			check: [
				{
					verdict: "blocked",
					findings: [BLOCKING, MINOR],
					notes: "It needs tests.",
				},
				APPROVED,
			],
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("started");
		// Still two dialogs. THE PERSON IS NOT WALKED THROUGH THE FINDINGS.
		expect(h.ui.titles()).toEqual([EFFORT_TITLE, h.confirmation()]);
		// Three requests: the description, the document, the rewrite — and the
		// rewrite is the SAME mini-conversation, with the findings appended.
		expect(h.model.requests.length).toBe(3);
		const rewrite = h.model.requests[2]?.messages ?? [];
		expect(rewrite[0]?.text).toBe(DOCUMENT_REQUEST);
		expect(rewrite[1]).toEqual({ role: "assistant", text: documentText() });
		expect(rewrite[2]?.role).toBe("user");
		expect(rewrite[2]?.text).toContain(BLOCKING.summary);
		expect(rewrite[2]?.text).toContain(MINOR.summary);
		expect(rewrite[2]?.text).toContain("It needs tests.");
		expect(h.check?.ran()).toBe(2);
		expect(h.store.saves.map((plan) => plan.title)).toEqual([
			"Compose the catalogue",
			"Compose the catalogue, revised",
		]);
		// The rewrite is on the record under its own name, and so are both checks.
		expect(h.evidence().attempts.map((a) => a.kind)).toEqual([
			"intent",
			"plan",
			"check",
			"revise",
			"check",
		]);
	});

	it("asks the person once for a finding the check says needs one", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			answer: (o) =>
				o.title.startsWith("The plan check")
					? pick(o.options, CHECK_PROCEED)
					: happyPath(o),
			check: [
				{ verdict: "blocked", findings: [NEEDS_PERSON, BLOCKING], notes: "" },
			],
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome).toMatchObject({ kind: "started", asked: 3 });
		// ONE extra dialog, and it carries only the finding a rewrite cannot
		// answer — the other blocking finding is not asked about.
		const asked = h.ui.titles().filter((t) => t.startsWith("The plan check"));
		expect(asked.length).toBe(1);
		expect(asked[0]).toContain(NEEDS_PERSON.summary);
		expect(asked[0]).toContain(NEEDS_PERSON.question as string);
		expect(asked[0]).not.toContain(BLOCKING.summary);
		expect(asked[0]).toContain("only you can answer");
		// And no rewrite was asked for: the model cannot answer it either.
		expect(h.model.requests.length).toBe(2);
		expect(h.check?.ran()).toBe(1);
	});

	it("goes back to the conversation when the person keeps planning", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			answer: (o) =>
				o.title.startsWith("The plan check")
					? pick(o.options, CHECK_KEEP_PLANNING)
					: happyPath(o),
			check: [{ verdict: "blocked", findings: [NEEDS_PERSON], notes: "" }],
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome).toMatchObject({ kind: "back", slug: "compose" });
		expect(h.modes).toEqual([]);
		expect(h.store.saves.length).toBe(1);
		// The confirmation was never reached: nothing was started and nothing
		// asked to be.
		expect(h.ui.titles().some((t) => t.startsWith(START_TITLE))).toBe(false);
	});

	it("asks the person once the rewrite bound is spent, and not before", async () => {
		const blocked: PlanCheckResult = {
			verdict: "blocked",
			findings: [BLOCKING],
			notes: "",
		};
		const h = harness({
			script: [
				DESCRIPTION,
				documentText(),
				documentText({ title: "Two" }),
				documentText({ title: "Three" }),
			],
			answer: (o) =>
				o.title.startsWith("The plan check")
					? pick(o.options, CHECK_PROCEED)
					: happyPath(o),
			check: [blocked, blocked, blocked],
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome.kind).toBe("started");
		expect(h.check?.ran()).toBe(MAX_PLAN_CHECK_REVISIONS + 1);
		const asked = h.ui.titles().filter((t) => t.startsWith("The plan check"));
		expect(asked.length).toBe(1);
		expect(asked[0]).toContain(
			`still blocks after ${MAX_PLAN_CHECK_REVISIONS} rewrites`,
		);
		expect(h.store.saves.map((plan) => plan.title)).toEqual([
			"Compose the catalogue",
			"Two",
			"Three",
		]);
	});

	it("goes back when a rewrite the check asked for never validates", async () => {
		const h = harness({
			script: [
				DESCRIPTION,
				documentText(),
				BROKEN_EDGE,
				BROKEN_EDGE,
				BROKEN_EDGE,
			],
			answer: happyPath,
			check: [{ verdict: "blocked", findings: [BLOCKING], notes: "" }],
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome).toMatchObject({ kind: "back", slug: "compose" });
		// The first plan is still stored; the rewrite never replaced it.
		expect(h.store.saves.length).toBe(1);
		expect(h.modes).toEqual([]);
		expect(h.said()).toContain(`after ${MAX_AUTHORING_ATTEMPTS} attempts`);
	});

	it("records the verdict and the counts, and none of the findings", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			answer: happyPath,
			check: [{ verdict: "gaps", findings: [MINOR], notes: "Reads fine." }],
		});

		await runExitFlow(h.deps);

		const check = h.evidence().attempts.find((a) => a.kind === "check");
		expect(check).toMatchObject({
			kind: "check",
			ok: true,
			verdict: "gaps",
			counts: { blocking: 0, major: 0, minor: 1 },
			problems: [],
		});
		const text = h.evidenceText();
		expect(text).not.toContain(MINOR.summary);
		expect(text).not.toContain("Reads fine.");
	});

	it("records an unavailable check as the one sentence it gave", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			answer: happyPath,
			check: [{ unavailable: "the reviewer timed out" }],
		});

		await runExitFlow(h.deps);

		expect(h.evidence().attempts.find((a) => a.kind === "check")).toMatchObject(
			{ ok: false, problems: ["the reviewer timed out"] },
		);
	});
});

describe("what the harness does with a check result", () => {
	const result = (findings: readonly PlanCheckFinding[]): PlanCheckResult => ({
		verdict: "blocked",
		findings,
		notes: "",
	});

	it("accepts anything with nothing blocking, whatever else it found", () => {
		expect(planCheck.planCheckDecision(result([MINOR]), 0)).toEqual({
			kind: "accept",
		});
		expect(planCheck.planCheckDecision(APPROVED, 0)).toEqual({
			kind: "accept",
		});
	});

	it("rewrites while the bound holds, then asks", () => {
		for (let round = 0; round < MAX_PLAN_CHECK_REVISIONS; round++)
			expect(planCheck.planCheckDecision(result([BLOCKING]), round)).toEqual({
				kind: "revise",
				findings: [BLOCKING],
			});
		expect(
			planCheck.planCheckDecision(result([BLOCKING]), MAX_PLAN_CHECK_REVISIONS),
		).toEqual({ kind: "ask", findings: [BLOCKING] });
	});

	it("asks straight away for a finding only a person can answer, and asks only that", () => {
		expect(
			planCheck.planCheckDecision(result([BLOCKING, NEEDS_PERSON, MINOR]), 0),
		).toEqual({ kind: "ask", findings: [NEEDS_PERSON] });
	});

	it("reads a reviewer's output strictly, and anything else not at all", () => {
		expect(
			planCheck.readPlanCheckResult({
				verdict: "approve",
				findings: [],
				notes: "fine",
			}),
		).toEqual({ verdict: "approve", findings: [], notes: "fine" });
		// A missing `notes` is an empty one; nothing else is tolerated.
		expect(
			planCheck.readPlanCheckResult({ verdict: "gaps", findings: [] }),
		).toEqual({ verdict: "gaps", findings: [], notes: "" });
		for (const bad of [
			undefined,
			"blocked",
			{ verdict: "ready", findings: [] },
			{ verdict: "approve" },
			{ verdict: "approve", findings: [{ id: "x" }] },
			{
				verdict: "approve",
				findings: [{ ...BLOCKING, severity: "critical" }],
			},
			{ verdict: "approve", findings: [{ ...BLOCKING, needsPerson: "yes" }] },
		])
			expect(planCheck.readPlanCheckResult(bad)).toBeUndefined();
	});

	it("is unavailable, with a reason, when a seat has no reviewer", async () => {
		await expect(
			planCheck.unavailablePlanCheck({} as Plan, ""),
		).resolves.toEqual({ unavailable: NO_PLAN_CHECK_REASON });
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
		expect(evidence.schemaVersion).toBe(2);
		expect(evidence.attempts.map((a) => [a.kind, a.ok])).toEqual([
			["intent", true],
			["plan", false],
			["plan", true],
			["check", true],
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

		expect(outcome.kind).toBe("started");
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
		// The run the HARNESS started, named, so the transcript can be used to
		// look it up — and said to be the harness's, not the conversation's.
		expect(h.announced[1]?.content).toContain(`Run started \`${PLAN_RUN_ID}\``);
		expect(h.announced[1]?.content).toContain("not by this conversation");
		// v7: starting it WAS the approval, so what the conversation is told is
		// where the run stops next, not where it will ask again.
		expect(h.announced[1]?.content).toContain(
			"it works through the plan and stops at its `ship` decision",
		);
		expect(h.announced[1]?.content).not.toContain("approve-plan");
		// NOTHING ELSE reaches the conversation: the requests, the retries, the
		// check's findings and the validators' complaints stay on the record, and
		// the two custom messages are the whole of it.
		expect(h.announced.length).toBe(2);
		expect(h.announced.map((m) => m.content).join("\n")).not.toContain(
			DOCUMENT_REQUEST,
		);
	});

	it("says so when the hand-off goes back instead", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			answer: (opened) =>
				opened.title.startsWith(START_TITLE)
					? pick(opened.options, START_KEEP_PLANNING)
					: happyPath(opened),
		});

		expect((await runExitFlow(h.deps)).kind).toBe("back");
		expect(h.announced.map((m) => m.content.includes("without a run"))).toEqual(
			[false, true],
		);
		expect(h.modes).toEqual([]);
	});
});

// ── The model is never steered ───────────────────────────────────────────────

describe("the hand-off never sends the session a user message", () => {
	/**
	 * Asserted over what the flow REACHES FOR, not over a recorder it might
	 * never have been handed: the deps object is the flow's whole outside world,
	 * so a steering channel would have to be read off it by name. The proxy
	 * records every property the module touches, on the path that used to end in
	 * a `sendUserMessage`, and on the path where the run refuses to start.
	 */
	const reads = async (options: HarnessOptions): Promise<readonly string[]> => {
		const h = harness(options);
		const touched = new Set<string>();
		const watched = new Proxy(h.deps, {
			get(target, key, receiver) {
				if (typeof key === "string") touched.add(key);
				return Reflect.get(target, key, receiver);
			},
		}) as ExitFlowDeps;
		await runExitFlow(watched);
		return [...touched];
	};

	it("reaches for no steering channel, on the run path or the refusal path", async () => {
		for (const options of [
			{ script: [DESCRIPTION, documentText()], answer: happyPath },
			{
				script: [DESCRIPTION, documentText()],
				answer: happyPath,
				client: {
					startBuiltin: async (): Promise<{ runId: string }> => {
						throw new Error("no runtime");
					},
				},
			},
		] satisfies HarnessOptions[]) {
			const touched = await reads(options);
			// The dep it used to read is gone, and so is every neighbour a
			// reinstated hand-off would arrive under.
			expect(touched).not.toContain("sendUserMessage");
			expect(touched).not.toContain("sendMessage");
			expect(touched).not.toContain("steer");
			// And the deps it does read are still read, so this is not a proxy
			// that saw nothing.
			expect(touched).toContain("announce");
			expect(touched).toContain("workflow");
			expect(touched).toContain("planCheck");
		}
	});
});

// ── A runtime that is not there, or says no ──────────────────────────────────

describe("the run that does not start", () => {
	it("ends with the plan stored and the posture asked for when there is no runtime", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			client: null,
			answer: happyPath,
		});

		const outcome = await runExitFlow(h.deps);

		expect(outcome).toMatchObject({ kind: "stored", slug: "compose" });
		expect(h.store.saves.length).toBe(1);
		expect(h.modes).toEqual(["auto"]);
		expect(h.said()).toContain("/plan run compose");
		// The check still ran: it needs no workflow runtime.
		expect(h.check?.ran()).toBe(1);
		// And the confirmation was never opened, because there is nothing to
		// start.
		expect(h.ui.titles()).toEqual([EFFORT_TITLE]);
	});

	it("keeps the plan and takes the posture when the runtime refuses the start", async () => {
		const h = harness({
			script: [DESCRIPTION, documentText()],
			answer: happyPath,
			client: {
				startBuiltin: async () => {
					throw Object.assign(new Error("plan-to-ship is not allowlisted"), {
						name: "WorkflowServiceError",
						code: "validation",
					});
				},
			},
		});

		const outcome = await runExitFlow(h.deps);

		// The person answered `Start the run` and the runtime said no: the plan is
		// stored, the posture is the one they asked for, and the cause is on
		// screen through the seam's sanitized notice.
		expect(outcome).toMatchObject({ kind: "stored", slug: "compose" });
		expect(h.modes).toEqual(["auto"]);
		expect(h.store.saves.length).toBe(1);
		expect(h.said()).toContain("Workflow runtime unavailable (validation)");
		expect(h.said()).toContain("plan-to-ship is not allowlisted");
		expect(h.said()).toContain("/plan run compose");
		// One custom message, and it does not claim a run.
		expect(h.announced.length).toBe(1);
		expect(h.announced[0]?.content).toContain("stored");
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
		const tables = optionTables({ "exit-flow": exitFlow });
		// The list is found, not written down, so a table added later is covered
		// by this test without anybody remembering to add it.
		expect(tables.map(([name]) => name).sort()).toEqual([
			"exit-flow.CHECK_OPTIONS",
			"exit-flow.EFFORT_OPTIONS",
			"exit-flow.START_OPTIONS",
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
		const both = optionTables({ "exit-flow": exitFlow }).filter(([, table]) =>
			table.some((option) => option.recommended && option.escape),
		);
		expect(both.map(([name]) => name)).toEqual(["exit-flow.EFFORT_OPTIONS"]);
	});

	it("never makes starting a run, or proceeding past a finding, the unanswered answer", () => {
		expect(chosenOption(START_OPTIONS, undefined)).toBe("keep");
		expect(chosenOption(CHECK_OPTIONS, undefined)).toBe("keep");
		expect(optionLabels(CHECK_OPTIONS)).toEqual([
			`${CHECK_PROCEED} (default)`,
			CHECK_KEEP_PLANNING,
		]);
	});
});

// ── The `/mode` hook ─────────────────────────────────────────────────────────

describe("the controller that straddles the posture change", () => {
	/** A controller whose flow is scripted, so the seam is what is under test. */
	function controller(outcome: exitFlow.ExitFlowOutcome) {
		const ran: exitFlow.ExitFlowDeps[] = [];
		const startedRuns: [string, string][] = [];
		const modes: ModeName[] = [];
		const subject = createModeExitController({
			setMode: (name) => modes.push(name),
			complete: () => async () => ({ ok: true, text: "" }),
			onStarted: (slug, runId) => startedRuns.push([slug, runId]),
			flow: async (deps) => {
				ran.push(deps);
				return outcome;
			},
		});
		return { subject, ran, startedRuns, modes };
	}

	const ctx = {
		hasUI: true,
		ui: fakeUi().ui,
	} as unknown as exitFlow.ModeExitContext;

	it("runs the hand-off only on the way out of plan mode, and only with dialogs", async () => {
		const c = controller({ kind: "keep-planning" });
		expect(await c.subject.hook("auto", "hack", ctx)).toBe("switch");
		expect(await c.subject.hook("plan", "plan", ctx)).toBe("switch");
		expect(
			await c.subject.hook("plan", "auto", {
				...ctx,
				hasUI: false,
			} as exitFlow.ModeExitContext),
		).toBe("switch");
		expect(c.ran).toEqual([]);
	});

	it("says `settled` for the three outcomes that moved the posture", async () => {
		for (const outcome of [
			{ kind: "switch-only", why: "nothing to plan" },
			{ kind: "stored", slug: "compose", why: "nothing started", asked: 2 },
			{ kind: "started", slug: "compose", runId: "r-1", asked: 2 },
		] satisfies exitFlow.ExitFlowOutcome[]) {
			const c = controller(outcome);
			expect(await c.subject.hook("plan", "auto", ctx)).toBe("settled");
			expect(c.subject.last()).toEqual(outcome);
		}
	});

	it("says `stay` for every outcome that left the seat in plan mode", async () => {
		for (const outcome of [
			{ kind: "keep-planning" },
			{ kind: "back", asked: 1 },
			{ kind: "aborted" },
			{ kind: "refused", problem: "no store" },
		] satisfies exitFlow.ExitFlowOutcome[]) {
			const c = controller(outcome);
			expect(await c.subject.hook("plan", "auto", ctx)).toBe("stay");
		}
	});

	it("names a started run, so the session narrates the one it started", async () => {
		const c = controller({
			kind: "started",
			slug: "compose",
			runId: "wfr-1",
			asked: 2,
		});
		await c.subject.hook("plan", "auto", ctx);
		expect(c.startedRuns).toEqual([["compose", "wfr-1"]]);
		// And nothing else does: a hand-off that started no run has no run to name.
		const quiet = controller({ kind: "keep-planning" });
		await quiet.subject.hook("plan", "auto", ctx);
		expect(quiet.startedRuns).toEqual([]);
	});

	it("switches and says why when the session has no model to ask", async () => {
		const notices: [string, string][] = [];
		const subject = createModeExitController({
			setMode: () => undefined,
			complete: () => undefined,
			flow: async () => {
				throw new Error("the flow must not run");
			},
		});
		expect(
			await subject.hook("plan", "auto", {
				hasUI: true,
				ui: {
					...fakeUi().ui,
					notify: (message: string, type?: string) =>
						notices.push([message, type ?? "info"]),
				},
			} as unknown as exitFlow.ModeExitContext),
		).toBe("switch");
		expect(notices[0]?.[0]).toContain("no model to write the plan with");
	});
});

// ── The prompts and the rendering ────────────────────────────────────────────

describe("the two system prompts", () => {
	it("say the model has no tools and starts nothing", () => {
		const document = renderDocumentSystemPrompt(
			{ effort: "deep", gates: "every-deliverable", publish: { mode: "none" } },
			DESCRIPTION,
		);
		for (const prompt of [DESCRIPTION_SYSTEM_PROMPT, document]) {
			expect(prompt).toContain("no tools");
			expect(prompt).toContain("nothing you write starts anything");
		}
		// The document prompt keeps the facts the old steer carried.
		expect(document).toContain("effort deep");
		expect(document).toContain("gates every-deliverable");
		expect(document).toContain("fresh context");
		expect(document).toContain("`tasks` are the work");
		// And the description prompt keeps its own.
		expect(DESCRIPTION_SYSTEM_PROMPT).toContain("two or three sentences");
		expect(DESCRIPTION_SYSTEM_PROMPT).toContain("Not a title");
		expect(DESCRIPTION_SYSTEM_PROMPT).toContain(String(MIN_DESCRIPTION_LENGTH));
		expect(DESCRIPTION_SYSTEM_PROMPT).toContain(String(MAX_DESCRIPTION_LENGTH));
	});
});

describe("renderPlanSummary", () => {
	it("names the work and who reads it, and derives no stages", () => {
		const plan = JSON.parse(documentText()) as Plan;
		const summary = renderPlanSummary(
			{ ...plan, repos: [], policy: { effort: "cheap", gates: "ship" } },
			"cheap",
			FULLY_EQUIPPED,
		);
		expect(summary).toContain("effort cheap, gates ship");
		expect(summary).toContain("impl: Do the work");
		expect(summary).toContain("read by contracts (tier standard)");
		expect(summary).not.toContain("verify-and-fix");
		expect(summary).not.toContain("review-fan-out");
	});

	it("says what a review that pins nothing means", () => {
		const plan = JSON.parse(
			documentText({
				deliverables: [
					{
						id: "d1",
						title: "One",
						tasks: [{ id: "impl", title: "Work" }],
						reviews: [{ lens: "contracts" }],
					},
				],
			}),
		) as Plan;
		expect(renderPlanSummary(plan, "standard", FULLY_EQUIPPED)).toContain(
			"read by contracts (effort dial decides)",
		);
	});
});
