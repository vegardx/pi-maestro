// Phase 2 of the plan-mode exit, driven through a fake UI, a fake workflow
// runtime and a fake audited Bash.
//
// Phase 1 is six questions and one commit. Phase 2 is the half with a plan in
// it, and everything that can go wrong with it is a question about *what was
// left behind*: a record that outlived the exit, a plan rewritten by a dialog
// nobody answered, a run started by a flow that was supposed to stop, a review
// that opened a dialog over somebody else's prompt. So the cases below assert
// the same four facts after the fact — the outcome, the record on disk, the
// plan in the store, and exactly which dialogs were opened — rather than only
// the value the flow returned.
//
// Nothing here touches a repository, a workflow runtime or a shell. Readiness'
// view of the world, the plan store, the provider and the Bash runner are all
// injected, which is the whole reason they are ports.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	COMPILED_APPROVE,
	COMPILED_EDIT,
	COMPILED_REVIEW,
	COMPILED_TITLE,
	createDialogGate,
	DIRTY_BACK,
	EDITOR_TITLE,
	EXIT_COMPILE,
	EXIT_START_TITLE,
	type ExitFlowPhase2,
	type ExitFlowUi,
	LENS_INCLUDE,
	LENS_SKIP,
	PLAN_REVIEW_REF,
	runExitFlowPhase1,
	runExitFlowPhase2,
	START_RUN_TITLE,
	storedSlug,
} from "../packages/maestro/src/exit-flow.js";
import {
	FINDING_ACCEPT,
	FINDING_DISMISS,
	type Finding,
} from "../packages/maestro/src/findings.js";
import { pendingExitFile } from "../packages/maestro/src/paths.js";
import {
	PENDING_EXIT_SCHEMA_VERSION,
	type PendingExit,
	readPendingExit,
	writePendingExit,
} from "../packages/maestro/src/pending-exit.js";
import {
	inspectPlan,
	type Plan,
	type RepoProbe,
	validatePlan,
} from "../packages/maestro/src/plan.js";
import { PLAN_WORKFLOW_REF } from "../packages/maestro/src/plan-command.js";
import { compileStageDocument } from "../packages/maestro/src/stage-document.js";
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
	const path = mkdtempSync(join(tmpdir(), "maestro-exit2-"));
	dirs.push(path);
	return path;
}

const SESSION = "session-phase2";
const REPO = "/nowhere/pi-workflow";

// ── The fakes ────────────────────────────────────────────────────────────────

interface Opened {
	readonly kind: "select" | "input" | "confirm" | "editor";
	readonly title: string;
	readonly options?: readonly string[];
	readonly signal: boolean;
}

type Answer = string | boolean | undefined;

/** The label in `options` that contains `text`; the fake answers with labels. */
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

function fakeStore(initial: Plan) {
	let current = initial;
	const saves: Plan[] = [];
	return {
		saves,
		current: () => current,
		store: {
			loadPlan: (slug: string): Plan | null =>
				slug === current.slug ? current : null,
			savePlan: (plan: Plan): void => {
				// The real store's rule, with the real validator: nothing invalid
				// reaches disk, and the exit flow has to survive being told so.
				const errors = validatePlan(plan, cleanProbe);
				if (errors.length > 0)
					throw new Error(
						`refusing to save an invalid plan:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
					);
				current = plan;
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
	readonly validate?: () => Promise<never>;
	readonly project?: () => Promise<never>;
}

function fakeClient(options: FakeClientOptions = {}) {
	const calls: { ref: string; input: unknown }[] = [];
	let round = 0;
	const client: WorkflowReadClient = {
		list: async () => [],
		validate:
			options.validate ??
			(async (ref: string, input?: unknown) => {
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
			}),
		project:
			options.project ??
			(async (ref: string, input: unknown) => {
				calls.push({ ref: `project:${ref}`, input });
				return PROJECTION;
			}),
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

// ── The fixtures ─────────────────────────────────────────────────────────────

/** `count` deliverables, each with one review task the plan already tiered. */
function tieredPlan(count: number): Plan {
	return {
		slug: "compose",
		title: "Compose the catalogue",
		repos: [{ key: "wf", path: REPO }],
		policy: {
			effort: "standard",
			gates: "approve-plan+ship",
			publish: { mode: "pr", base: "main" },
		},
		deliverables: Array.from({ length: count }, (_, index) => ({
			id: `d${index + 1}`,
			title: `Deliverable ${index + 1}`,
			after: [],
			reads: [],
			tasks: [
				{ id: "impl", title: "Do the work" },
				{
					id: "rev",
					title: "Review it",
					by: { lens: "contracts", tier: "standard" as const },
				},
			],
		})),
	};
}

function record(agentDir: string): PendingExit {
	const written: PendingExit = {
		schemaVersion: PENDING_EXIT_SCHEMA_VERSION,
		sessionId: SESSION,
		policy: {
			effort: "standard",
			gates: "approve-plan+ship",
			publish: { mode: "pr", base: "main" },
		},
		intent: "Ship the component catalogue",
		createdAt: "2026-09-16T10:00:00.000Z",
	};
	writePendingExit(written, agentDir);
	return written;
}

interface HarnessOptions {
	readonly plan?: Plan;
	readonly answer?: (opened: Opened, index: number) => Answer;
	readonly after?: (opened: Opened, index: number) => void;
	readonly client?: FakeClientOptions | null;
	readonly world?: ExitFlowPhase2["readiness"];
	readonly signal?: AbortSignal;
	readonly gate?: ExitFlowPhase2["gate"];
}

function harness(options: HarnessOptions = {}) {
	const agentDir = temp();
	const plan = options.plan ?? tieredPlan(3);
	const store = fakeStore(plan);
	const ui = fakeUi(options.answer, options.after);
	const provider =
		options.client === null ? undefined : fakeClient(options.client ?? {});
	const bash = fakeBash();
	const steers: string[] = [];
	const inputs: [string, string][] = [];
	const deps: ExitFlowPhase2 = {
		record: record(agentDir),
		slug: plan.slug,
		ui: ui.ui,
		agentDir,
		store: store.store,
		bash: bash.bash,
		readiness: options.world ?? readyWorld,
		inspect: (candidate) => inspectPlan(candidate, cleanProbe),
		workflow: async () => provider?.client,
		sendUserMessage: (content) => steers.push(content),
		inputPath: (slug) => join(agentDir, `${slug}-input.json`),
		writeInput: (path, json) => inputs.push([path, json]),
		...(options.signal ? { signal: options.signal } : {}),
		...(options.gate ? { gate: options.gate } : {}),
	};
	return {
		agentDir,
		deps,
		ui,
		store,
		bash,
		steers,
		inputs,
		provider,
		said: () => ui.said(),
		recordExists: () =>
			readPendingExit(SESSION, agentDir) !== null ||
			// `readPendingExit` throws rather than answering for a record it
			// cannot believe; the file's absence is what this asserts.
			false,
		recordPath: () => pendingExitFile(SESSION, agentDir),
	};
}

/** The answers that walk the happy path: include everything, review, start. */
const happyPath = (opened: Opened): Answer => {
	if (opened.kind === "confirm" && opened.title === START_RUN_TITLE)
		return true;
	if (opened.kind === "select" && opened.title === COMPILED_TITLE)
		return pick(opened.options, COMPILED_REVIEW);
	return undefined;
};

// ── The trigger ──────────────────────────────────────────────────────────────

describe("the tool_result that starts phase 2", () => {
	it("is a `plan` call that says it stored, and nothing else", () => {
		expect(
			storedSlug({ toolName: "plan", details: { stored: true, slug: "x" } }),
		).toBe("x");
		expect(
			storedSlug({
				toolName: "plan",
				isError: true,
				details: { stored: true, slug: "x" },
			}),
		).toBeUndefined();
		expect(
			storedSlug({ toolName: "plan", details: { stored: false, slug: "x" } }),
		).toBeUndefined();
		expect(
			storedSlug({ toolName: "bash", details: { stored: true, slug: "x" } }),
		).toBeUndefined();
		expect(storedSlug({ toolName: "plan" })).toBeUndefined();
	});
});

// ── The count ────────────────────────────────────────────────────────────────

describe("how many dialogs a plan is worth", () => {
	it("asks exactly eleven across both phases for a three-deliverable tiered plan", async () => {
		const agentDir = temp();
		// One live session across both halves, so every dialog in the count is
		// also a dialog a session replacement would have closed.
		const live = new AbortController();
		const ui = fakeUi((opened) => {
			// Phase 1: compile. Everything else takes its printed default.
			if (opened.title === EXIT_START_TITLE) return EXIT_COMPILE;
			return happyPath(opened);
		});
		const phase1 = await runExitFlowPhase1({
			ui: ui.ui,
			sessionId: SESSION,
			wanted: "auto",
			setMode: () => {},
			agentDir,
			entries: () => [
				{
					type: "message",
					message: { role: "user", content: "Ship the catalogue" },
				},
			],
			upstreamHead: () => "main",
			sendUserMessage: () => {},
			signal: live.signal,
		});
		expect(phase1.kind).toBe("compiled");
		if (phase1.kind !== "compiled") return;
		// 1 what now, 2 effort, 3 gates, 4 publication, 5 base branch, 6 intent.
		expect(phase1.asked).toBe(6);

		const plan = tieredPlan(3);
		const store = fakeStore(plan);
		const provider = fakeClient();
		const phase2 = await runExitFlowPhase2({
			record: phase1.record,
			slug: plan.slug,
			ui: ui.ui,
			agentDir,
			store: store.store,
			readiness: readyWorld,
			inspect: (candidate) => inspectPlan(candidate, cleanProbe),
			workflow: async () => provider.client,
			sendUserMessage: () => {},
			inputPath: () => join(agentDir, "input.json"),
			writeInput: () => {},
			signal: live.signal,
		});
		expect(phase2.kind).toBe("handed-off");
		if (phase2.kind !== "handed-off") return;
		// 8 once per deliverable (each has exactly one seeded lens), 12 the
		// compiled document, 18 the confirmation. 7 asks nothing on a ready
		// machine, 9 nothing because the plan tiered every lens, 10 nothing
		// because no lens is heavy, 13 nothing because nobody edited, 14 and 17
		// are notifications, 15 nothing because the review found nothing.
		expect(phase2.asked).toBe(5);
		expect(ui.opened.length).toBe(11);
		// And every one of them carried the abort signal.
		expect(
			ui.opened
				.filter((opened) => opened.kind !== "editor")
				.every((o) => o.signal),
		).toBe(true);
	});
});

// ── The happy path ───────────────────────────────────────────────────────────

describe("the run request", () => {
	it("hands the model the call, deletes the record, and exports the input", async () => {
		const h = harness({ answer: happyPath });
		const outcome = await runExitFlowPhase2(h.deps);
		expect(outcome.kind).toBe("handed-off");
		expect(h.steers).toHaveLength(1);
		expect(h.steers[0]).toContain(
			`"ref": ${JSON.stringify(PLAN_WORKFLOW_REF)}`,
		);
		expect(h.steers[0]).toContain("workflow_run");
		expect(h.steers[0]).toContain("approve-plan");
		expect(h.inputs).toHaveLength(1);
		expect(JSON.parse(h.inputs[0]?.[1] ?? "{}")).toMatchObject({
			effort: "standard",
			plan: { slug: "compose" },
		});
		expect(readPendingExit(SESSION, h.agentDir)).toBeNull();
	});

	it("sends the blind reviewer the plan, the compiled graph and the intent", async () => {
		const h = harness({ answer: happyPath });
		await runExitFlowPhase2(h.deps);
		const started = h.provider?.started() ?? [];
		expect(started).toHaveLength(1);
		expect(started[0]?.ref).toBe(`runBuiltin:${PLAN_REVIEW_REF}`);
		const input = started[0]?.input as {
			plan: Plan;
			planDigest: string;
			intent: string;
			compiled: unknown;
			projection: unknown;
			effort: string;
		};
		expect(input.intent).toBe("Ship the component catalogue");
		expect(input.compiled).toEqual(compileStageDocument(h.store.current()));
		// Passed through exactly as the runtime returned it, `budget` included.
		expect(input.projection).toBe(PROJECTION);
		expect(input.planDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(input.effort).toBe("standard");
	});

	it("leaves the stored plan alone when every dialog is escaped", async () => {
		const before = tieredPlan(2);
		const h = harness({
			plan: before,
			answer: (opened) =>
				opened.kind === "confirm" && opened.title === START_RUN_TITLE
					? true
					: undefined,
		});
		const outcome = await runExitFlowPhase2(h.deps);
		expect(outcome.kind).toBe("handed-off");
		// Escape at 8 keeps the seed, and the seed is what the plan already
		// compiles to, so nothing is written and the digest does not move.
		expect(h.store.saves).toHaveLength(0);
		expect(h.store.current()).toEqual(before);
	});
});

// ── Step 7: readiness ────────────────────────────────────────────────────────

describe("readiness", () => {
	it("creates a missing repository through the audited Bash, once confirmed", async () => {
		const present = new Set<string>();
		const h = harness({
			world: {
				exists: (path) => present.has(path),
				probe: cleanProbe,
				refExists: () => true,
				ghPresent: () => true,
			},
			answer: (opened) => {
				if (opened.kind === "confirm" && opened.title.startsWith("Create")) {
					present.add(REPO);
					return true;
				}
				return happyPath(opened);
			},
		});
		const outcome = await runExitFlowPhase2(h.deps);
		expect(outcome.kind).toBe("handed-off");
		expect(h.bash.commands[0]).toBe(`git init ${REPO}`);
		expect(h.bash.commands[1]).toContain("commit --allow-empty");
		// `publish.mode` is `pr`, so the remote is wired by `gh repo create`.
		expect(h.bash.commands[2]).toContain("gh repo create");
	});

	it("runs nothing and goes back when creation is declined", async () => {
		const h = harness({
			world: { ...readyWorld, exists: () => false },
			answer: () => undefined,
		});
		const outcome = await runExitFlowPhase2(h.deps);
		expect(outcome.kind).toBe("back");
		expect(h.bash.commands).toEqual([]);
		expect(readPendingExit(SESSION, h.agentDir)).toBeNull();
	});

	it("continues past a dirty tree by default and goes back when told to", async () => {
		const dirty = {
			...readyWorld,
			probe: () => ({ root: REPO, resolved: REPO, dirty: true }),
		};
		const escaped = harness({ world: dirty, answer: happyPath });
		expect((await runExitFlowPhase2(escaped.deps)).kind).toBe("handed-off");
		expect(
			escaped.ui.titles().some((title) => title.includes("uncommitted")),
		).toBe(true);

		const back = harness({
			world: dirty,
			answer: (opened) =>
				opened.title.includes("uncommitted")
					? pick(opened.options, DIRTY_BACK)
					: happyPath(opened),
		});
		const outcome = await runExitFlowPhase2(back.deps);
		expect(outcome.kind).toBe("back");
		expect(back.steers).toEqual([]);
		expect(readPendingExit(SESSION, back.agentDir)).toBeNull();
	});

	it("reports what it cannot ask about, all of it at once", async () => {
		const h = harness({
			world: { ...readyWorld, refExists: () => false, ghPresent: () => false },
			answer: happyPath,
		});
		await runExitFlowPhase2(h.deps);
		const warnings = h.ui.notices
			.filter(([, type]) => type === "warning")
			.map(([message]) => message)
			.join("\n");
		expect(warnings).toContain("does not resolve");
		expect(warnings).toContain("`gh` is not on PATH");
	});
});

// ── Step 8: the lenses ───────────────────────────────────────────────────────

describe("the review lenses", () => {
	it("drops a lens the human skips, and writes the plan that remains", async () => {
		const h = harness({
			plan: tieredPlan(1),
			answer: (opened) =>
				opened.title.includes("contracts") && opened.kind === "select"
					? pick(opened.options, LENS_SKIP)
					: happyPath(opened),
		});
		const outcome = await runExitFlowPhase2(h.deps);
		expect(outcome.kind).toBe("handed-off");
		expect(h.store.saves).toHaveLength(1);
		const stages = h.store.current().deliverables[0]?.stages;
		expect(stages?.map((stage) => stage.use)).toEqual([
			"implement",
			"verify-and-fix",
		]);
	});

	it("offers the standard lenses only where the plan named none", async () => {
		const plan: Plan = {
			...tieredPlan(1),
			deliverables: [
				{
					id: "d1",
					title: "Deliverable 1",
					after: [],
					reads: [],
					tasks: [{ id: "impl", title: "Do the work" }],
				},
			],
		};
		const h = harness({
			plan,
			answer: (opened) =>
				opened.kind === "select" && opened.title.includes("`contracts` lens")
					? pick(opened.options, LENS_INCLUDE)
					: happyPath(opened),
		});
		await runExitFlowPhase2(h.deps);
		const asked = h.ui.titles().filter((title) => title.includes("lens?"));
		expect(asked).toHaveLength(3);
		// Included, and then asked what it is worth — the plan pinned nothing.
		expect(h.ui.titles().some((t) => t.includes("worth on"))).toBe(true);
		const review = h.store
			.current()
			.deliverables[0]?.stages?.find((stage) => stage.use === "review-fan-out");
		expect(review).toMatchObject({
			use: "review-fan-out",
			lenses: [{ id: "contracts", tier: "standard" }],
		});
	});

	it("asks about a cross-family reviewer only where a lens is heavy", async () => {
		const heavy: Plan = {
			...tieredPlan(1),
			deliverables: [
				{
					id: "d1",
					title: "Deliverable 1",
					after: [],
					reads: [],
					tasks: [
						{ id: "impl", title: "Do the work" },
						{
							id: "rev",
							title: "Review it",
							by: { lens: "contracts", tier: "heavy" },
						},
					],
				},
			],
		};
		const h = harness({
			plan: heavy,
			answer: (opened) =>
				opened.title.startsWith("A cross-family") ? true : happyPath(opened),
		});
		await runExitFlowPhase2(h.deps);
		expect(
			h.ui.titles().filter((t) => t.startsWith("A cross-family")),
		).toHaveLength(1);
		const review = h.store
			.current()
			.deliverables[0]?.stages?.find((stage) => stage.use === "review-fan-out");
		expect(review).toMatchObject({
			lenses: [{ id: "contracts", diverse: true }],
		});

		// The same plan with a standard lens is never asked.
		const standard = harness({ plan: tieredPlan(1), answer: happyPath });
		await runExitFlowPhase2(standard.deps);
		expect(
			standard.ui.titles().some((t) => t.startsWith("A cross-family")),
		).toBe(false);
	});
});

// ── Step 12 and 13: the compiled document ────────────────────────────────────

describe("the compiled document", () => {
	it("shows the graph and the projection before it asks anything about them", async () => {
		const h = harness({ answer: happyPath });
		await runExitFlowPhase2(h.deps);
		expect(h.said()).toContain("Compiled run — effort standard");
		expect(h.said()).toContain("Projected: 9 tasks");
	});

	it("takes the blind review when the dialog is escaped", async () => {
		const h = harness({
			answer: (opened) =>
				opened.kind === "confirm" && opened.title === START_RUN_TITLE
					? true
					: undefined,
		});
		const outcome = await runExitFlowPhase2(h.deps);
		expect(outcome.kind).toBe("handed-off");
		// Escape at 12 is `Review it blind`, which is what the label says.
		expect(h.provider?.started()).toHaveLength(1);
	});

	it("writes an edit back into the plan and shows the document again", async () => {
		let edited = false;
		const h = harness({
			plan: tieredPlan(1),
			answer: (opened) => {
				if (opened.kind === "select" && opened.title === COMPILED_TITLE)
					return edited
						? pick(opened.options, COMPILED_APPROVE)
						: pick(opened.options, COMPILED_EDIT);
				if (opened.kind === "editor") {
					edited = true;
					const document = compileStageDocument(tieredPlan(1));
					return JSON.stringify({
						...document,
						deliverables: [
							{
								id: "d1",
								stages: [
									{ use: "implement", id: "implement" },
									{ use: "verify-and-fix", id: "verify", maxRounds: 3 },
								],
							},
						],
					});
				}
				if (opened.kind === "confirm" && opened.title === START_RUN_TITLE)
					return true;
				return undefined;
			},
		});
		const outcome = await runExitFlowPhase2(h.deps);
		expect(outcome.kind).toBe("handed-off");
		expect(h.ui.titles().filter((t) => t === EDITOR_TITLE)).toHaveLength(1);
		expect(h.ui.titles().filter((t) => t === COMPILED_TITLE)).toHaveLength(2);
		expect(
			h.store.current().deliverables[0]?.stages?.map((stage) => stage.use),
		).toEqual(["implement", "verify-and-fix"]);
		// 3 verify rounds is 2 fix rounds, back in the plan's own vocabulary.
		expect(h.store.current().deliverables[0]?.stages?.[1]).toMatchObject({
			maxRounds: 2,
		});
	});

	it("discards an escaped editor and changes nothing", async () => {
		let asked = 0;
		const h = harness({
			answer: (opened) => {
				if (opened.kind === "select" && opened.title === COMPILED_TITLE)
					return ++asked === 1
						? pick(opened.options, COMPILED_EDIT)
						: pick(opened.options, COMPILED_APPROVE);
				if (opened.kind === "confirm" && opened.title === START_RUN_TITLE)
					return true;
				return undefined;
			},
		});
		await runExitFlowPhase2(h.deps);
		expect(h.store.saves).toHaveLength(0);
	});

	it("rejects an edit that is not a compiled document and keeps the plan", async () => {
		let asked = 0;
		const h = harness({
			answer: (opened) => {
				if (opened.kind === "select" && opened.title === COMPILED_TITLE)
					return ++asked === 1
						? pick(opened.options, COMPILED_EDIT)
						: pick(opened.options, COMPILED_APPROVE);
				if (opened.kind === "editor") return "{ not json";
				if (opened.kind === "confirm" && opened.title === START_RUN_TITLE)
					return true;
				return undefined;
			},
		});
		await runExitFlowPhase2(h.deps);
		expect(h.store.saves).toHaveLength(0);
		expect(h.said()).toContain("The edited document was not read");
	});
});

// ── Steps 15 to 17: the findings walk ────────────────────────────────────────

const blocking = (patch?: Finding["patch"]): Finding => ({
	id: "missing-verify",
	severity: "blocking",
	kind: "gap",
	where: "/deliverables/0/title",
	what: "The first deliverable does not say what it ships",
	...(patch ? { patch } : {}),
});

const RETITLE = {
	op: "replace",
	path: "/deliverables/0/title",
	value: "Ship the catalogue properly",
} as const;

describe("the findings walk", () => {
	it("applies an accepted patch, re-validates it, stores it, and re-reviews once", async () => {
		const h = harness({
			plan: tieredPlan(1),
			client: {
				reviews: [
					{ verdict: "blocked", findings: [blocking(RETITLE)] },
					{ verdict: "ready", findings: [] },
				],
			},
			answer: (opened) => {
				if (opened.kind === "select" && opened.title.startsWith("Blocking"))
					return pick(opened.options, FINDING_ACCEPT);
				return happyPath(opened);
			},
		});
		const outcome = await runExitFlowPhase2(h.deps);
		expect(outcome.kind).toBe("handed-off");
		expect(h.store.current().deliverables[0]?.title).toBe(
			"Ship the catalogue properly",
		);
		// Recompiled and re-reviewed exactly once; 12 was not asked again.
		expect(h.provider?.started()).toHaveLength(2);
		expect(h.ui.titles().filter((t) => t === COMPILED_TITLE)).toHaveLength(1);
	});

	it("re-asks without the accept option when the patch would invalidate the plan", async () => {
		const seen: (readonly string[] | undefined)[] = [];
		const h = harness({
			plan: tieredPlan(1),
			client: {
				reviews: [
					{
						verdict: "blocked",
						findings: [
							blocking({
								op: "replace",
								path: "/deliverables/0/id",
								value: "NOT A SLUG",
							}),
						],
					},
				],
			},
			answer: (opened) => {
				if (opened.kind === "select" && opened.title.startsWith("Blocking")) {
					seen.push(opened.options);
					return seen.length === 1
						? pick(opened.options, FINDING_ACCEPT)
						: pick(opened.options, FINDING_DISMISS);
				}
				if (opened.title.startsWith("Why is this")) return "the id is fine";
				return happyPath(opened);
			},
		});
		const outcome = await runExitFlowPhase2(h.deps);
		expect(outcome.kind).toBe("handed-off");
		expect(h.store.saves).toHaveLength(0);
		expect(seen).toHaveLength(2);
		expect(seen[0]?.some((option) => option.startsWith(FINDING_ACCEPT))).toBe(
			true,
		);
		// Asked again, and no longer offered as something that works.
		expect(seen[1]?.some((option) => option.startsWith(FINDING_ACCEPT))).toBe(
			false,
		);
		expect(h.said()).toContain("the plan would stop validating");
	});

	it("re-asks when a patch does not apply at all", async () => {
		const seen: (readonly string[] | undefined)[] = [];
		const h = harness({
			plan: tieredPlan(1),
			client: {
				reviews: [
					{
						verdict: "blocked",
						findings: [
							blocking({ op: "replace", path: "/nowhere/9", value: 1 }),
						],
					},
				],
			},
			answer: (opened) => {
				if (opened.kind === "select" && opened.title.startsWith("Blocking")) {
					seen.push(opened.options);
					return seen.length === 1
						? pick(opened.options, FINDING_ACCEPT)
						: pick(opened.options, FINDING_DISMISS);
				}
				if (opened.title.startsWith("Why is this")) return "not a real place";
				return happyPath(opened);
			},
		});
		await runExitFlowPhase2(h.deps);
		expect(seen).toHaveLength(2);
		expect(h.said()).toContain("could not be applied");
	});

	it("does not dismiss a finding on an empty reason", async () => {
		let reasons = 0;
		const h = harness({
			plan: tieredPlan(1),
			client: {
				reviews: [{ verdict: "blocked", findings: [blocking(RETITLE)] }],
			},
			answer: (opened) => {
				if (opened.kind === "select" && opened.title.startsWith("Blocking"))
					return pick(opened.options, FINDING_DISMISS);
				if (opened.title.startsWith("Why is this"))
					return ++reasons === 1 ? "   " : "it is covered by the gate";
				return happyPath(opened);
			},
		});
		const outcome = await runExitFlowPhase2(h.deps);
		expect(outcome.kind).toBe("handed-off");
		expect(reasons).toBe(2);
		expect(
			h.ui.titles().filter((title) => title.startsWith("Blocking")),
		).toHaveLength(2);
		expect(h.said()).toContain("a dismissal needs a reason");
		// Dismissed, not accepted: the plan is untouched and the run is offered.
		expect(h.store.saves).toHaveLength(0);
		expect(h.provider?.started()).toHaveLength(1);
	});

	it("goes back to the conversation on escape, with the findings printed", async () => {
		const h = harness({
			plan: tieredPlan(1),
			client: {
				reviews: [{ verdict: "blocked", findings: [blocking(RETITLE)] }],
			},
			answer: (opened) =>
				opened.kind === "select" && opened.title.startsWith("Blocking")
					? undefined
					: happyPath(opened),
		});
		const outcome = await runExitFlowPhase2(h.deps);
		expect(outcome.kind).toBe("back");
		expect(h.steers).toEqual([]);
		expect(h.said()).toContain("missing-verify");
		expect(h.said()).toContain("/mode plan");
		expect(readPendingExit(SESSION, h.agentDir)).toBeNull();
		// 18 was never asked.
		expect(h.ui.titles()).not.toContain(START_RUN_TITLE);
	});

	it("ends the loop when a second review still blocks", async () => {
		const h = harness({
			plan: tieredPlan(1),
			client: {
				reviews: [
					{ verdict: "blocked", findings: [blocking(RETITLE)] },
					{
						verdict: "blocked",
						findings: [
							{ ...blocking(), id: "still-blocked", what: "Still not enough" },
						],
					},
				],
			},
			answer: (opened) => {
				if (opened.kind === "select" && opened.title.startsWith("Blocking"))
					return pick(opened.options, FINDING_ACCEPT);
				return happyPath(opened);
			},
		});
		const outcome = await runExitFlowPhase2(h.deps);
		expect(outcome.kind).toBe("back");
		expect(h.provider?.started()).toHaveLength(2);
		expect(h.said()).toContain("The second blind review still blocks");
		expect(h.said()).toContain("still-blocked");
		// The accepted patch stays: it was applied and stored before the second
		// review, and a review that still blocks does not undo it.
		expect(h.store.current().deliverables[0]?.title).toBe(
			"Ship the catalogue properly",
		);
		expect(h.steers).toEqual([]);
		expect(readPendingExit(SESSION, h.agentDir)).toBeNull();
	});

	it("never opens a dialog for a major or minor finding", async () => {
		const h = harness({
			plan: tieredPlan(1),
			client: {
				reviews: [
					{
						verdict: "gaps",
						findings: [
							{
								id: "budget-tight",
								severity: "major",
								kind: "budget",
								where: "/policy",
								what: "The budget is tight for a deep run",
							},
							{
								id: "naming",
								severity: "minor",
								kind: "ambiguity",
								where: "/deliverables/0/title",
								what: "The title could be clearer",
							},
						],
					},
				],
			},
			answer: happyPath,
		});
		const outcome = await runExitFlowPhase2(h.deps);
		expect(outcome.kind).toBe("handed-off");
		expect(h.ui.titles().some((title) => title.startsWith("Blocking"))).toBe(
			false,
		);
		const info = h.ui.notices
			.filter(([, type]) => type === "info")
			.map(([message]) => message)
			.join("\n");
		expect(info).toContain("budget-tight");
		expect(info).toContain("naming");
	});
});

// ── Step 18 ──────────────────────────────────────────────────────────────────

describe("the last question", () => {
	it("stores and runs nothing when it is declined", async () => {
		const h = harness({
			answer: (opened) =>
				opened.kind === "confirm" && opened.title === START_RUN_TITLE
					? false
					: undefined,
		});
		const outcome = await runExitFlowPhase2(h.deps);
		expect(outcome.kind).toBe("stored");
		expect(h.steers).toEqual([]);
		expect(h.inputs).toEqual([]);
		expect(h.said()).toContain("/plan run compose");
		expect(readPendingExit(SESSION, h.agentDir)).toBeNull();
	});
});

// ── The provider fallbacks ───────────────────────────────────────────────────

describe("a workflow runtime that is not there", () => {
	it("ends cleanly with the plan stored when the compile step cannot reach it", async () => {
		const h = harness({ client: null, answer: happyPath });
		const outcome = await runExitFlowPhase2(h.deps);
		expect(outcome.kind).toBe("stored");
		expect(h.said()).toContain("/plan run compose");
		// Nothing past step 11 was asked.
		expect(h.ui.titles()).not.toContain(COMPILED_TITLE);
		expect(h.ui.titles()).not.toContain(START_RUN_TITLE);
		expect(readPendingExit(SESSION, h.agentDir)).toBeNull();
	});

	it("ends cleanly when validation or projection refuses", async () => {
		for (const refusing of [
			{ validate: async () => Promise.reject(new Error("no such workflow")) },
			{ project: async () => Promise.reject(new Error("cannot project")) },
		] as FakeClientOptions[]) {
			const h = harness({ client: refusing, answer: happyPath });
			const outcome = await runExitFlowPhase2(h.deps);
			expect(outcome.kind).toBe("stored");
			expect(h.said()).toContain("/plan run");
			expect(readPendingExit(SESSION, h.agentDir)).toBeNull();
		}
	});

	it("offers `Approve as is` when only the reviewer is out of reach", async () => {
		const options: (readonly string[] | undefined)[] = [];
		const h = harness({
			client: {
				runBuiltin: async () => {
					throw Object.assign(new Error("not on the allowlist"), {
						name: "WorkflowServiceError",
						code: "validation",
					});
				},
			},
			answer: (opened) => {
				if (opened.kind === "select" && opened.title === COMPILED_TITLE) {
					options.push(opened.options);
					return options.length === 1
						? pick(opened.options, COMPILED_REVIEW)
						: pick(opened.options, COMPILED_APPROVE);
				}
				if (opened.kind === "confirm" && opened.title === START_RUN_TITLE)
					return true;
				return undefined;
			},
		});
		const outcome = await runExitFlowPhase2(h.deps);
		expect(outcome.kind).toBe("handed-off");
		expect(h.said()).toContain("Approve as is");
		expect(options).toHaveLength(2);
		// Back at 12, and the option that cannot work is not offered again.
		expect(options[1]?.some((o) => o.startsWith(COMPILED_REVIEW))).toBe(false);
		expect(options[1]?.some((o) => o.startsWith(COMPILED_APPROVE))).toBe(true);
	});

	it("treats a timed-out or unreadable review as an unreachable reviewer", async () => {
		for (const view of [
			{ runId: "r", status: "running", timedOut: true as const },
			{ runId: "r", status: "failed", output: { nope: true } },
		]) {
			const h = harness({
				client: { awaitRun: async () => view },
				answer: (opened) => {
					if (opened.kind === "select" && opened.title === COMPILED_TITLE)
						return opened.options?.some((o) => o.startsWith(COMPILED_REVIEW))
							? pick(opened.options, COMPILED_REVIEW)
							: pick(opened.options, COMPILED_APPROVE);
					if (opened.kind === "confirm" && opened.title === START_RUN_TITLE)
						return true;
					return undefined;
				},
			});
			const outcome = await runExitFlowPhase2(h.deps);
			expect(outcome.kind).toBe("handed-off");
			expect(h.said()).toContain("Approve as is");
		}
	});
});

// ── The discipline ───────────────────────────────────────────────────────────

describe("the dialog discipline", () => {
	it("opens nothing while another extension's prompt is on screen", async () => {
		const gate = createDialogGate();
		gate.promptStart();
		const h = harness({ gate, answer: happyPath });
		const running = runExitFlowPhase2(h.deps);
		// Several turns of the event loop, which is more than enough for a flow
		// that was going to open a dialog.
		for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(h.ui.opened).toEqual([]);
		gate.promptEnd();
		const outcome = await running;
		expect(outcome.kind).toBe("handed-off");
		expect(h.ui.opened.length).toBeGreaterThan(0);
	});

	it("aborts and drops the record when the session is replaced", async () => {
		const controller = new AbortController();
		const h = harness({
			signal: controller.signal,
			answer: happyPath,
			after: (_opened, index) => {
				if (index === 0) controller.abort();
			},
		});
		const outcome = await runExitFlowPhase2(h.deps);
		expect(outcome.kind).toBe("aborted");
		expect(h.ui.opened).toHaveLength(1);
		expect(h.steers).toEqual([]);
		expect(h.store.saves).toHaveLength(0);
		expect(readPendingExit(SESSION, h.agentDir)).toBeNull();
	});

	it("refuses by name when the plan it was told about is not there", async () => {
		const h = harness({ answer: happyPath });
		const outcome = await runExitFlowPhase2({ ...h.deps, slug: "missing" });
		expect(outcome.kind).toBe("refused");
		expect(h.ui.notices.some(([, type]) => type === "error")).toBe(true);
		expect(readPendingExit(SESSION, h.agentDir)).toBeNull();
	});
});
