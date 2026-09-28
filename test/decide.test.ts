// The decisions a run asks for, asked in the session that started it.
//
// Three dialogs and one tool, and what is under test in each is the same thing:
// the person decides, and the seat neither decides for them nor sends them
// somewhere else to decide. So every case here is either "what is on screen at
// the moment of deciding" or "what each answer actually did".
//
// The seam is tested BOTH WAYS on purpose. pi-workflow's service-provider client
// is a read client: it has no `decide`, no `resume`, no `stop`, and its lease-free
// inspection carries no verified checkpoint inputs. Each of those is a real gap
// today and a method `WorkflowService` already has, so the tests below run each
// answer against a client that has the method and against one that does not —
// and the second case asserts the sentence that names what pi-workflow must
// expose, because that sentence is what a person is shown.

import { describe, expect, it } from "vitest";
import {
	askFailure,
	askShip,
	autoPublish,
	bySeverity,
	createDecideDialogs,
	type DecideDeps,
	type DecideSeam,
	decideSeam,
	FAILURE_OPTIONS,
	type GateDeliverable,
	NARRATION_ONLY_NOTE,
	NOTHING_PARKED,
	openedDialog,
	PUBLISH_LEAVE,
	PUBLISH_OPTIONS,
	PUBLISH_RETRY,
	REPLAN,
	RETRY_TASK,
	readShipGate,
	renderFailure,
	renderShipGate,
	replanMessage,
	residuals,
	SHIP_DIALOG_SEAM,
	SHIP_LOOK,
	SHIP_NO,
	SHIP_OPTIONS,
	SHIP_YES,
	type ShipGateView,
	STOP_RUN,
	seamRefusal,
} from "../packages/maestro/src/decide.js";
import type { ModeName } from "../packages/maestro/src/mode.js";
import type { Plan } from "../packages/maestro/src/plan.js";
import type { Publication } from "../packages/maestro/src/publish.js";
import { createShipDialogTool } from "../packages/maestro/src/ship-dialog-tool.js";

const RUN = "wfr-plan-to-ship-7";
const SLUG = "compose";

const plan: Plan = {
	slug: SLUG,
	title: "Compose the catalogue",
	repos: [{ key: "wf", path: "/nowhere" }],
	deliverables: [
		{
			id: "api",
			title: "The API",
			after: [],
			reads: [],
			tasks: [{ id: "impl", title: "Do the work" }],
		},
	],
	policy: { gates: "ship", publish: { mode: "pr", base: "main" } },
};

const OK: Publication = {
	ok: true,
	commands: [],
	mode: "pr",
	branch: "maestro/compose-1",
	prUrl: "https://example.test/pr/1",
};

/**
 * A gate whose inputs are the run's own verified values.
 *
 * Exactly what `plan-to-ship` declares: `plan`, and one `summary-<id>`,
 * `findings-<id>` and `fix-<id>` per deliverable.
 */
function inspectionWithInputs() {
	return {
		run: { runId: RUN, status: "running" },
		tasks: [
			{
				id: "t-gate",
				kind: "checkpoint",
				key: "ship",
				taskKey: "compose/ship",
				checkpoint: {
					prompt: "Ship it?",
					inputs: {
						plan: { slug: SLUG },
						"summary-api": {
							summary: "Added the catalogue and its four stages.",
							checkPassed: true,
						},
						"findings-api": {
							verdict: "Two lenses agree the export surface is untested.",
							findings: [
								{
									id: "f1",
									severity: "blocking",
									lens: "contracts",
									where: "packages/x/index.ts",
									summary: "the export surface is untested",
									suggestion: "add a case per export",
								},
								{
									id: "f2",
									severity: "major",
									lens: "security",
									where: "packages/x/read.ts",
									summary: "the path is not resolved before it is read",
								},
								{
									id: "f3",
									severity: "minor",
									lens: "contracts",
									where: "README.md",
									summary: "the example is stale",
								},
							],
						},
						"fix-api": {
							checkPassed: true,
							findings: [
								{ id: "f1", outcome: "addressed" },
								{
									id: "f2",
									outcome: "disputed",
									note: "the caller already resolved it",
								},
							],
						},
					},
				},
			},
		],
	};
}

/**
 * The same gate on a view that carries NO verified inputs.
 *
 * Which is every lease-free inspection: `checkpoint.inputs` is artifact-backed.
 * The gate still names its inputs — `tasks[].inputs` maps each to its producing
 * task — and every projected task carries `narration.summary`, so the
 * deliverables and their summaries are real and the findings are honestly absent.
 */
function inspectionWithoutInputs() {
	return {
		run: { runId: RUN, status: "running" },
		tasks: [
			{
				id: "t-impl",
				kind: "agent",
				key: "implement-api",
				narration: {
					stage: "compose/implement-api",
					taskKind: "implement",
					deliverable: "api",
					summary: "Added the catalogue and its four stages.",
				},
			},
			{
				id: "t-gate",
				kind: "checkpoint",
				key: "ship",
				inputs: {
					plan: "t-refine",
					"summary-api": "t-impl",
					"findings-api": "t-synth",
					"fix-api": "t-fix",
				},
			},
		],
	};
}

interface Recorded {
	readonly titles: string[];
	readonly notices: [string, string][];
	readonly said: string[];
	readonly modes: ModeName[];
	readonly published: string[];
	readonly deps: DecideDeps;
}

interface Script {
	/** One answer per dialog, by the option text it starts with. */
	readonly answers?: readonly (string | undefined)[];
	readonly typed?: string;
	readonly seam?: DecideSeam;
	readonly publish?: readonly (Publication | undefined)[];
	readonly plan?: Plan | undefined;
	readonly inspect?: () => unknown;
	readonly inspector?: (runId: string) => void;
}

function recorder(script: Script = {}): Recorded {
	const titles: string[] = [];
	const notices: [string, string][] = [];
	const said: string[] = [];
	const modes: ModeName[] = [];
	const published: string[] = [];
	let asked = 0;
	let publishes = 0;
	const ui = {
		select: async (title: string, options: string[]) => {
			titles.push(title);
			const wanted = script.answers?.[asked++];
			if (wanted === undefined) return undefined;
			const found = options.find((option) => option.startsWith(wanted));
			if (!found)
				throw new Error(
					`no option starting with ${JSON.stringify(wanted)} in ${JSON.stringify(options)}`,
				);
			return found;
		},
		input: async (title: string) => {
			titles.push(title);
			return script.typed;
		},
		notify: (message: string, type?: string) => {
			notices.push([message, type ?? "info"]);
		},
	};
	return {
		titles,
		notices,
		said,
		modes,
		published,
		deps: {
			dialogs: createDecideDialogs(ui),
			client: { inspect: async () => (script.inspect ?? (() => ({})))() },
			...(script.seam ? { seam: script.seam } : {}),
			publish: async (_plan, runId) => {
				published.push(runId);
				return (script.publish ?? [OK])[publishes++];
			},
			plan: () => ("plan" in script ? script.plan : plan),
			say: (content) => said.push(content),
			setMode: (name) => modes.push(name),
			...(script.inspector ? { inspector: script.inspector } : {}),
		},
	};
}

// ── Reading the gate ─────────────────────────────────────────────────────────

describe("the gate's inputs, as this seat reads them", () => {
	it("reads every deliverable's summary, findings and fix answers", () => {
		const view = readShipGate(inspectionWithInputs(), RUN, SLUG);
		expect(view?.sourced).toBe("inputs");
		expect(view?.taskKey).toBe("compose/ship");
		expect(view?.deliverables).toHaveLength(1);
		const api = view?.deliverables[0] as GateDeliverable;
		expect(api.id).toBe("api");
		expect(api.summary).toBe("Added the catalogue and its four stages.");
		expect(api.verdict).toContain("Two lenses agree");
		expect(api.findings.map((finding) => finding.id)).toEqual([
			"f1",
			"f2",
			"f3",
		]);
		expect(api.fixes).toEqual([
			{ id: "f1", outcome: "addressed" },
			{
				id: "f2",
				outcome: "disputed",
				note: "the caller already resolved it",
			},
		]);
		expect(api.checkPassed).toBe(true);
	});

	it("groups findings worst first, and drops no severity that has one", () => {
		const view = readShipGate(inspectionWithInputs(), RUN, SLUG);
		expect(
			bySeverity(view?.deliverables[0]?.findings ?? []).map(
				([severity, group]) => [severity, group.length],
			),
		).toEqual([
			["blocking", 1],
			["major", 1],
			["minor", 1],
		]);
	});

	// The one derived list, and the reason it is derived: a residual is a finding
	// the run is shipping WITH, and an UNANSWERED finding appears in neither the
	// findings-by-outcome list nor the fix report.
	it("derives the residuals: disputed, out of scope, and never answered", () => {
		const view = readShipGate(inspectionWithInputs(), RUN, SLUG);
		expect(
			residuals(view?.deliverables[0] as GateDeliverable).map((f) => f.id),
		).toEqual(["f2", "f3"]);
	});

	it("falls back to each task's narration when a view carries no inputs", () => {
		const view = readShipGate(inspectionWithoutInputs(), RUN, SLUG);
		expect(view?.sourced).toBe("narration");
		expect(view?.taskKey).toBe("ship");
		expect(view?.deliverables).toEqual([
			{
				id: "api",
				summary: "Added the catalogue and its four stages.",
				findings: [],
				fixes: [],
			},
		]);
	});

	it("is nothing at all for a run that declares no ship checkpoint", () => {
		expect(
			readShipGate({ run: { runId: RUN }, tasks: [] }, RUN, SLUG),
		).toBeUndefined();
		expect(readShipGate(undefined, RUN, SLUG)).toBeUndefined();
	});
});

describe("the gate, as the person deciding it reads it", () => {
	const rendered = (): string =>
		renderShipGate(
			readShipGate(inspectionWithInputs(), RUN, SLUG) as ShipGateView,
		);

	it("puts the summary, the findings by severity and the fix report on screen", () => {
		const text = rendered();
		expect(text).toContain("Ship `compose`?");
		expect(text).toContain("parked at its `compose/ship` decision");
		expect(text).toContain("Added the catalogue and its four stages.");
		expect(text).toContain("review: Two lenses agree");
		expect(text).toContain("blocking (1):");
		expect(text).toContain(
			"f1 (contracts) at packages/x/index.ts — the export surface is untested",
		);
		expect(text).toContain("suggested: add a case per export");
		expect(text).toContain("major (1):");
		expect(text).toContain("minor (1):");
		expect(text).toContain("fix report:");
		expect(text).toContain("addressed (1): f1");
		expect(text).toContain("disputed (1): f2");
		expect(text).toContain("f2: the caller already resolved it");
		expect(text).toContain("the fixer reported the project's check passing");
	});

	// A dispute a person cannot read is not a dispute, so every note is shown in
	// full rather than counted.
	it("names what the run would ship with, and labels it as that", () => {
		expect(rendered()).toContain(
			"residual (2, shipping with these): f2 [major], f3 [minor]",
		);
	});

	it("says nothing was left over when the fixer answered everything", () => {
		expect(
			renderShipGate({
				runId: RUN,
				slug: SLUG,
				taskKey: "ship",
				sourced: "inputs",
				deliverables: [
					{
						id: "api",
						summary: "done",
						findings: [
							{ id: "f1", severity: "blocking", summary: "one thing" },
						],
						fixes: [{ id: "f1", outcome: "addressed" }],
					},
				],
			}),
		).toContain("residual: nothing — every finding was addressed");
	});

	// "No findings" and "the findings are in a view this seat cannot reach" are
	// different facts about the same run, and presenting the second as the first
	// would be the seat vouching for a review nobody showed it.
	it("says so when it is reading narration rather than the gate's own inputs", () => {
		const text = renderShipGate(
			readShipGate(inspectionWithoutInputs(), RUN, SLUG) as ShipGateView,
		);
		expect(text).toContain(NARRATION_ONLY_NOTE);
		expect(text).toContain("artifact-backed");
		expect(text).toContain("findings: none");
	});
});

// ── The seam ─────────────────────────────────────────────────────────────────

describe("what the read client cannot do, named rather than worked around", () => {
	it("finds nothing on a client that is only a read client", () => {
		expect(decideSeam({ inspect: async () => ({}) })).toEqual({});
		expect(decideSeam(undefined)).toEqual({});
		expect(decideSeam(null)).toEqual({});
	});

	it("finds each method the day pi-workflow exposes it", () => {
		const client = {
			inspect: async () => ({}),
			decide: async () => ({}),
			resume: async () => ({}),
			stop: async () => ({}),
		};
		expect(Object.keys(decideSeam(client)).sort()).toEqual([
			"decide",
			"resume",
			"stop",
		]);
	});

	it("names the method and the view, because that is what a person is shown", () => {
		expect(SHIP_DIALOG_SEAM.decide).toContain(
			"decide(runId, taskKey, {value})",
		);
		expect(SHIP_DIALOG_SEAM.resume).toContain("resume(runId, {taskId})");
		expect(SHIP_DIALOG_SEAM.stop).toContain("stop(runId)");
		expect(SHIP_DIALOG_SEAM.inputs).toContain("artifact-backed");
		expect(seamRefusal("decide", "Recording it")).toContain("Recording it");
		expect(seamRefusal("decide", "x")).toContain(
			"Nothing about the run changed.",
		);
	});
});

// ── The ship dialog ──────────────────────────────────────────────────────────

const view = (): ShipGateView =>
	readShipGate(inspectionWithInputs(), RUN, SLUG) as ShipGateView;

describe("the ship dialog, and what each answer does", () => {
	it("offers Ship first and escapes to looking, which commits to nothing", () => {
		expect(SHIP_OPTIONS.map((option) => option.text)).toEqual([
			SHIP_YES,
			SHIP_NO,
			SHIP_LOOK,
		]);
		expect(SHIP_OPTIONS[0]?.recommended).toBe(true);
		expect(SHIP_OPTIONS.filter((option) => option.escape)).toHaveLength(1);
		expect(SHIP_OPTIONS.at(-1)?.value).toBe("look");
	});

	it("records the decision and publishes when the runtime has `decide`", async () => {
		const decided: unknown[] = [];
		const r = recorder({
			answers: [SHIP_YES],
			seam: {
				decide: async (runId, taskKey, options) => {
					decided.push([runId, taskKey, options.value]);
					return {};
				},
			},
		});
		const outcome = await askShip(r.deps, view());
		expect(outcome).toEqual({ kind: "published", publication: OK });
		expect(decided).toEqual([[RUN, "compose/ship", { ship: true }]]);
		expect(r.published).toEqual([RUN]);
		// The pull request's link lands in the conversation, with a turn.
		expect(r.said.join("\n")).toContain("https://example.test/pr/1");
	});

	// `/plan ship` publishes without a proved gate because typing it IS the
	// decision; answering this dialog is the same decision in the same session.
	// What is NOT allowed is doing it silently: the notice names the gap.
	it("publishes through the same path `/plan ship` takes when it cannot decide", async () => {
		const r = recorder({ answers: [SHIP_YES] });
		expect((await askShip(r.deps, view())).kind).toBe("published");
		expect(r.published).toEqual([RUN]);
		const said = r.notices.map(([message]) => message).join("\n");
		expect(said).toContain("decide(runId, taskKey, {value})");
		expect(said).toContain("the same path `/plan ship` takes");
		expect(said).toContain("stays parked");
	});

	it("records `{ship:false}` with the reason typed, when it can", async () => {
		const decided: unknown[] = [];
		const r = recorder({
			answers: [SHIP_NO],
			typed: "the disputed finding is real",
			seam: {
				decide: async (_runId, _taskKey, options) => {
					decided.push(options.value);
					return {};
				},
			},
		});
		expect(await askShip(r.deps, view())).toEqual({
			kind: "declined",
			reason: "the disputed finding is real",
		});
		expect(decided).toEqual([
			{ ship: false, note: "the disputed finding is real" },
		]);
		// Nothing was published, which is the whole point of the answer.
		expect(r.published).toEqual([]);
	});

	// There is no honest local substitute for writing `{"ship": false}` into a
	// durable decision record, so nothing pretends the run moved.
	it("refuses Don't ship by name when it cannot record one, and keeps the reason", async () => {
		const r = recorder({ answers: [SHIP_NO], typed: "not yet" });
		const outcome = await askShip(r.deps, view());
		expect(outcome.kind).toBe("refused");
		const said = r.notices.map(([message]) => message).join("\n");
		expect(said).toContain('Recording `{"ship": false}`');
		expect(said).toContain("Reason kept here: not yet");
		expect(r.published).toEqual([]);
	});

	it("takes `no reason given` rather than an empty note", async () => {
		const decided: unknown[] = [];
		const r = recorder({
			answers: [SHIP_NO],
			typed: "   ",
			seam: {
				decide: async (_r, _t, options) => {
					decided.push(options.value);
					return {};
				},
			},
		});
		await askShip(r.deps, view());
		expect(decided).toEqual([{ ship: false, note: "no reason given" }]);
	});

	// The decision is not made by going to look at the run, so the dialog comes
	// straight back rather than closing on the way to the inspector.
	it("returns to the same dialog after Look first", async () => {
		const looked: string[] = [];
		const r = recorder({
			answers: [SHIP_LOOK, SHIP_YES],
			inspector: (runId) => looked.push(runId),
		});
		expect((await askShip(r.deps, view())).kind).toBe("published");
		expect(looked).toEqual([RUN]);
		expect(
			r.titles.filter((title) => title.startsWith("Ship `compose`?")),
		).toHaveLength(2);
	});

	it("names `/workflow` when there is no inspector to open", async () => {
		const r = recorder({ answers: [SHIP_LOOK, SHIP_YES] });
		await askShip(r.deps, view());
		expect(r.notices.map(([message]) => message).join("\n")).toContain(
			"`/workflow wfr-plan`",
		);
	});

	// An escape is a Look first, which loops — so escaping forever is a dialog
	// nobody answered, never a publication nobody asked for.
	it("never publishes on an unanswered dialog", async () => {
		const r = recorder({ answers: [undefined, SHIP_NO], typed: "no" });
		await askShip(r.deps, view());
		expect(r.published).toEqual([]);
	});

	it("refuses when no stored plan matches the run's slug", async () => {
		const r = recorder({ answers: [SHIP_YES], plan: undefined });
		const outcome = await askShip(r.deps, view());
		expect(outcome.kind).toBe("refused");
		expect(r.published).toEqual([]);
		expect(r.notices.map(([message]) => message).join("\n")).toContain(
			"No stored plan `compose`",
		);
	});
});

// ── Auto publication ─────────────────────────────────────────────────────────

describe("a `gates: none` run that completed", () => {
	it("publishes with no question at all, and posts the link", async () => {
		const r = recorder();
		expect(await autoPublish(r.deps, RUN, SLUG, "none")).toEqual({
			kind: "published",
			publication: OK,
		});
		// NO DIALOG. The approval was given when the person answered `Start the
		// run?` from auto, and the confirmation said so in as many words.
		expect(r.titles).toEqual([]);
		expect(r.said.join("\n")).toContain("https://example.test/pr/1");
		expect(r.said.join("\n")).toContain("is published from run");
	});

	it("refuses every gate policy but `none`, by name", async () => {
		for (const gates of ["ship", "every-deliverable"] as const) {
			const r = recorder();
			expect(await autoPublish(r.deps, RUN, SLUG, gates)).toEqual({
				kind: "skipped",
				why: `plan \`${SLUG}\` is gated \`${gates}\`, so its ship decision is asked rather than assumed`,
			});
			expect(r.published).toEqual([]);
		}
	});

	it("offers Retry publication or Leave it when it fails", async () => {
		const failed: Publication = {
			ok: false,
			stoppedAt: "check",
			reason: "publication: `npm run check` failed on the host",
			commands: [],
			mode: "pr",
			branch: "maestro/compose-1",
		};
		const r = recorder({ answers: [PUBLISH_RETRY], publish: [failed, OK] });
		expect((await autoPublish(r.deps, RUN, SLUG, "none")).kind).toBe(
			"published",
		);
		expect(r.published).toEqual([RUN, RUN]);
		expect(r.titles[0]).toContain("did not publish. Retry?");
		expect(r.titles[0]).toContain("`npm run check` failed on the host");
		expect(r.titles[0]).toContain("`maestro/compose-1` is in place");
	});

	it("leaves it, and names the manual fallback", async () => {
		const failed: Publication = {
			ok: false,
			stoppedAt: "push",
			reason: "publication: the push was refused",
			commands: [],
			mode: "pr",
		};
		const r = recorder({ answers: [PUBLISH_LEAVE], publish: [failed] });
		expect(await autoPublish(r.deps, RUN, SLUG, "none")).toEqual({
			kind: "left",
			reason: "publication: the push was refused",
		});
		expect(r.notices.map(([message]) => message).join("\n")).toContain(
			"/plan ship compose",
		);
	});

	it("escapes to leaving it, so a retry is never something nobody asked for", async () => {
		const failed: Publication = {
			ok: false,
			stoppedAt: "push",
			reason: "nope",
			commands: [],
			mode: "pr",
		};
		const r = recorder({ answers: [undefined], publish: [failed] });
		expect((await autoPublish(r.deps, RUN, SLUG, "none")).kind).toBe("left");
		expect(PUBLISH_OPTIONS.at(-1)?.value).toBe("leave");
		expect(r.published).toEqual([RUN]);
	});

	it("says so, and publishes nothing, when no stored plan matches", async () => {
		const r = recorder({ plan: undefined });
		expect((await autoPublish(r.deps, RUN, SLUG, "none")).kind).toBe("skipped");
		expect(r.published).toEqual([]);
		expect(r.notices.map(([message]) => message).join("\n")).toContain(
			"/workflow wfr-plan",
		);
	});
});

// ── The failure dialog ───────────────────────────────────────────────────────

const failure = {
	runId: RUN,
	slug: SLUG,
	taskId: "t-impl",
	stage: "compose/implement-api",
	deliverable: "api",
	cause: "the check exited 1 and the fixer had no rounds left",
};

describe("a task or a run that failed", () => {
	it("puts the cause and what each answer does on screen", () => {
		const text = renderFailure(failure);
		expect(text).toContain("`compose` — compose/implement-api of `api` failed");
		expect(text).toContain(failure.cause);
		expect(text).toContain("Retrying re-runs that one task");
		expect(text).toContain("stopping cancels the run");
		expect(text).toContain("re-planning takes you back to plan mode");
		// A whole-run failure is about the run, not about a task of it.
		expect(renderFailure({ runId: RUN, slug: SLUG, cause: "x" })).toContain(
			"the run failed",
		);
	});

	// Re-plan is the escape because it is the one answer that always works: it
	// needs nothing of the runtime, and cancelling somebody's run is a commitment
	// an unanswered dialog must not make.
	it("offers retry first and escapes to re-planning", () => {
		expect(FAILURE_OPTIONS.map((option) => option.text)).toEqual([
			RETRY_TASK,
			STOP_RUN,
			REPLAN,
		]);
		expect(FAILURE_OPTIONS[0]?.recommended).toBe(true);
		expect(FAILURE_OPTIONS.at(-1)?.escape).toBe(true);
	});

	it("resumes that one task when the runtime has `resume`", async () => {
		const resumed: unknown[] = [];
		const r = recorder({
			answers: [RETRY_TASK],
			seam: {
				resume: async (runId, options) => {
					resumed.push([runId, options?.taskId]);
					return {};
				},
			},
		});
		expect(await askFailure(r.deps, failure)).toEqual({ kind: "retried" });
		expect(resumed).toEqual([[RUN, "t-impl"]]);
	});

	it("names what pi-workflow must expose when it cannot retry", async () => {
		const r = recorder({ answers: [RETRY_TASK] });
		expect((await askFailure(r.deps, failure)).kind).toBe("refused");
		expect(r.notices.map(([message]) => message).join("\n")).toContain(
			"resume(runId, {taskId})",
		);
	});

	it("cancels the run when the runtime has `stop`", async () => {
		const stopped: string[] = [];
		const r = recorder({
			answers: [STOP_RUN],
			seam: {
				stop: async (runId) => {
					stopped.push(runId);
					return {};
				},
			},
		});
		expect(await askFailure(r.deps, failure)).toEqual({ kind: "stopped" });
		expect(stopped).toEqual([RUN]);
		expect(r.notices.map(([message]) => message).join("\n")).toContain(
			"still in the repository's object store",
		);
	});

	it("names what pi-workflow must expose when it cannot stop", async () => {
		const r = recorder({ answers: [STOP_RUN] });
		expect((await askFailure(r.deps, failure)).kind).toBe("refused");
		expect(r.notices.map(([message]) => message).join("\n")).toContain(
			"stop(runId)",
		);
	});

	it("re-plans into plan mode with where the run got to", async () => {
		const r = recorder({ answers: [REPLAN] });
		expect(await askFailure(r.deps, failure)).toEqual({ kind: "replanned" });
		expect(r.modes).toEqual(["plan"]);
		const carried = r.said.join("\n");
		expect(carried).toContain("Re-planning `compose` after run");
		expect(carried).toContain("compose/implement-api");
		expect(carried).toContain(failure.cause);
		expect(carried).toContain("nothing was published");
	});

	it("re-plans on an unanswered dialog, which changes nothing about the run", async () => {
		const r = recorder({ answers: [undefined] });
		expect((await askFailure(r.deps, failure)).kind).toBe("replanned");
		expect(replanMessage({ runId: RUN, slug: SLUG, cause: "x" })).toContain(
			"The run itself failed, not one task of it.",
		);
	});
});

// ── `plan_ship_dialog` ───────────────────────────────────────────────────────

describe("the one tool the ship decision has", () => {
	const tool = (port: {
		parked(): boolean;
		open(): { slug: string; runId: string } | undefined;
	}) => createShipDialogTool(port);

	it("says in its own description that it decides nothing", () => {
		const definition = tool({
			parked: () => true,
			open: () => ({ slug: SLUG, runId: RUN }),
		});
		expect(definition.name).toBe("plan_ship_dialog");
		expect(definition.description).toContain("DECIDES NOTHING");
		expect(definition.description).toContain("the person answers the dialog");
		expect(definition.description).toContain("parked");
	});

	it("opens the dialog and reports what it was about", async () => {
		const opens: number[] = [];
		const definition = tool({
			parked: () => true,
			open: () => {
				opens.push(1);
				return { slug: SLUG, runId: RUN };
			},
		});
		const result = await (
			definition as unknown as {
				execute(...args: unknown[]): Promise<{
					content: { text: string }[];
				}>;
			}
		).execute("id", {}, undefined, undefined, {});
		expect(opens).toHaveLength(1);
		expect(result.content[0]?.text).toBe(openedDialog(SLUG, RUN));
		expect(result.content[0]?.text).toContain("you decide nothing here");
	});

	// Refused BY NAME rather than opening an empty dialog: a session with no parked
	// run has nothing to ship, and a dialog asking about nothing is worse than a
	// sentence saying so.
	it("refuses by name when nothing is parked", async () => {
		const definition = tool({ parked: () => false, open: () => undefined });
		const result = await (
			definition as unknown as {
				execute(...args: unknown[]): Promise<{
					content: { text: string }[];
				}>;
			}
		).execute("id", {}, undefined, undefined, {});
		expect(result.content[0]?.text).toBe(NOTHING_PARKED);
		expect(result.content[0]?.text).toContain("`/mode ask`");
		expect(result.content[0]?.text).toContain("/plan ship <slug>");
	});
});
