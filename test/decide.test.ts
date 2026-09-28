// The decisions a run asks for, asked in the session that started it.
//
// Three dialogs and one tool, and what is under test in each is the same thing:
// the person decides, and the seat neither decides for them nor sends them
// somewhere else to decide. So every case here is either "what is on screen at
// the moment of deciding" or "what each answer actually did".
//
// What each answer DID is a call on the run — `decide`, `resume`, `stop` — so the
// fake client records them and the tests assert the call rather than a local
// effect. The distinction that matters most is at Ship: it records the checkpoint
// and publishes NOTHING, because publication follows the run's completion down
// the same path a decision made in pi-workflow's own widget takes. While the read
// client had no `decide`, Ship published around a checkpoint that stayed parked
// for ever, and "publishes nothing" below is the assertion that that is over.

import { describe, expect, it } from "vitest";
import {
	AUTO_INSPECT_SECTIONS,
	askFailure,
	askShip,
	autoPublish,
	bySeverity,
	createDecideDialogs,
	type DecideDeps,
	FAILURE_OPTIONS,
	GATE_INSPECT_SECTIONS,
	type GateDeliverable,
	NOTHING_PARKED,
	openedDialog,
	PUBLISH_LEAVE,
	PUBLISH_OPTIONS,
	PUBLISH_RETRY,
	PUBLISHED_HEADING,
	REPLAN,
	RETRY_TASK,
	readShipGate,
	readShipSummary,
	renderFailure,
	renderShipGate,
	replanMessage,
	residuals,
	SHIP_DIALOG_APPROVER,
	SHIP_LOOK,
	SHIP_NO,
	SHIP_OPTIONS,
	SHIP_YES,
	type ShipGateView,
	STOP_RUN,
} from "../packages/maestro/src/decide.js";
import type { ModeName } from "../packages/maestro/src/mode.js";
import type { Plan } from "../packages/maestro/src/plan.js";
import type { Publication } from "../packages/maestro/src/publish.js";
import { createShipDialogTool } from "../packages/maestro/src/ship-dialog-tool.js";
import { WORKFLOW_NOT_RESUMABLE } from "../packages/maestro/src/workflow-provider.js";

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

/** The three values a gate holds per deliverable, as `plan-to-ship` shapes them. */
const SUMMARY = {
	summary: "Added the catalogue and its four stages.",
	checkPassed: true,
};

const FINDINGS = {
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
};

const FIX = {
	checkPassed: true,
	findings: [
		{ id: "f1", outcome: "addressed" },
		{ id: "f2", outcome: "disputed", note: "the caller already resolved it" },
	],
};

/** A parked run, as `inspect(runId, {include: ["tasks","checkpoints"]})` gives it. */
function gateInspection() {
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
						"summary-api": SUMMARY,
						"findings-api": FINDINGS,
						"fix-api": FIX,
					},
				},
			},
		],
	};
}

/** A completed `gates: "none"` run, as `inspect(runId, {include: ["run","output"]})` gives it. */
function summaryInspection() {
	return {
		run: {
			runId: RUN,
			status: "completed",
			output: {
				shipped: true,
				shipSummary: {
					plan: { slug: SLUG },
					deliverables: [
						{ id: "api", summary: SUMMARY, findings: FINDINGS, fix: FIX },
					],
				},
			},
		},
	};
}

interface Decided {
	readonly runId: string;
	readonly taskKey: string;
	readonly options: {
		readonly decision: unknown;
		readonly approver: string;
		readonly reason?: string;
	};
}

interface Recorded {
	readonly titles: string[];
	readonly notices: [string, string][];
	readonly said: string[];
	readonly modes: ModeName[];
	readonly published: string[];
	readonly decided: Decided[];
	readonly resumed: [string, string][];
	readonly stopped: string[];
	readonly inspected: [string, unknown][];
	readonly deps: DecideDeps;
}

interface Script {
	/** One answer per dialog, by the option text it starts with. */
	readonly answers?: readonly (string | undefined)[];
	readonly typed?: string;
	readonly publish?: readonly (Publication | undefined)[];
	readonly plan?: Plan | undefined;
	readonly inspect?: () => unknown;
	readonly inspector?: (runId: string) => void;
	/** The runtime refuses this call, by its own sentence. */
	readonly decideFails?: string;
	readonly resumeFails?: string;
	readonly stopFails?: string;
	readonly inspectFails?: true;
}

function recorder(script: Script = {}): Recorded {
	const titles: string[] = [];
	const notices: [string, string][] = [];
	const said: string[] = [];
	const modes: ModeName[] = [];
	const published: string[] = [];
	const decided: Decided[] = [];
	const resumed: [string, string][] = [];
	const stopped: string[] = [];
	const inspected: [string, unknown][] = [];
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
		decided,
		resumed,
		stopped,
		inspected,
		deps: {
			dialogs: createDecideDialogs(ui),
			client: {
				inspect: async (runId: string, options?: unknown) => {
					inspected.push([runId, options]);
					if (script.inspectFails) throw new Error("the run store is locked");
					return (script.inspect ?? (() => ({})))();
				},
				decide: async (
					runId: string,
					taskKey: string,
					options: Decided["options"],
				) => {
					if (script.decideFails) throw new Error(script.decideFails);
					decided.push({ runId, taskKey, options });
					return {};
				},
				resume: async (runId: string, options: { readonly taskId: string }) => {
					if (script.resumeFails) throw new Error(script.resumeFails);
					resumed.push([runId, options.taskId]);
					return {};
				},
				stop: async (runId: string) => {
					if (script.stopFails) throw new Error(script.stopFails);
					stopped.push(runId);
					return {};
				},
			},
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
	it("asks for the section that carries them", () => {
		// `"checkpoints"` is what puts `tasks[].checkpoint.inputs` on a lease-free
		// inspection. Asking for `"tasks"` alone returns everything except the thing
		// the dialog is for.
		expect(GATE_INSPECT_SECTIONS.include).toEqual(["tasks", "checkpoints"]);
		expect(AUTO_INSPECT_SECTIONS.include).toEqual(["run", "output"]);
	});

	it("reads every deliverable's summary, findings and fix answers", () => {
		const view = readShipGate(gateInspection(), RUN, SLUG);
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
			{ id: "f2", outcome: "disputed", note: "the caller already resolved it" },
		]);
		expect(api.checkPassed).toBe(true);
	});

	it("groups findings worst first, and drops no severity that has one", () => {
		const view = readShipGate(gateInspection(), RUN, SLUG);
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
		const view = readShipGate(gateInspection(), RUN, SLUG);
		expect(
			residuals(view?.deliverables[0] as GateDeliverable).map((f) => f.id),
		).toEqual(["f2", "f3"]);
	});

	// The fallback to task narrations is GONE: revision 22 carries the inputs, and a
	// second answer to "what did the gate show" that nothing would ever exercise is
	// worse than no answer at all.
	it("shows no deliverables for a gate whose inputs are absent", () => {
		const bare = {
			run: { runId: RUN },
			tasks: [
				{
					id: "t-gate",
					kind: "checkpoint",
					key: "ship",
					// `inputs` names producers; `checkpoint.inputs` is what carries values,
					// and an inspection asked without `"checkpoints"` has none.
					inputs: { "summary-api": "t-impl" },
				},
				{
					id: "t-impl",
					kind: "agent",
					narration: { stage: "implement-api", summary: "did the work" },
				},
			],
		};
		expect(readShipGate(bare, RUN, SLUG)?.deliverables).toEqual([]);
	});

	it("is nothing at all for a run that declares no ship checkpoint", () => {
		expect(
			readShipGate({ run: { runId: RUN }, tasks: [] }, RUN, SLUG),
		).toBeUndefined();
		expect(readShipGate(undefined, RUN, SLUG)).toBeUndefined();
	});

	// The same three values under different names, read into the same shape, so
	// they render through the same function.
	it("reads a `gates: none` run's shipSummary into the same shape", () => {
		const fromGate = readShipGate(gateInspection(), RUN, SLUG);
		const fromSummary = readShipSummary(summaryInspection(), RUN, SLUG);
		expect(fromSummary?.deliverables).toEqual(fromGate?.deliverables);
	});

	it("is nothing when a run committed no shipSummary", () => {
		expect(
			readShipSummary({ run: { runId: RUN, output: {} } }, RUN, SLUG),
		).toBeUndefined();
		expect(readShipSummary(undefined, RUN, SLUG)).toBeUndefined();
	});
});

describe("the gate, as the person deciding it reads it", () => {
	const rendered = (): string =>
		renderShipGate(readShipGate(gateInspection(), RUN, SLUG) as ShipGateView);

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

	// One rendering, two callers: a person comparing what auto shipped against what
	// ask would have asked about should be comparing two views of one thing.
	it("renders a receipt with a heading instead of a question", () => {
		const view = readShipSummary(
			summaryInspection(),
			RUN,
			SLUG,
		) as ShipGateView;
		const receipt = renderShipGate(view, PUBLISHED_HEADING);
		expect(receipt.startsWith(PUBLISHED_HEADING)).toBe(true);
		expect(receipt).not.toContain("Ship `compose`?");
		expect(receipt).not.toContain("parked at");
		// Same body, down to the residuals.
		expect(receipt).toContain(
			"residual (2, shipping with these): f2 [major], f3 [minor]",
		);
		expect(receipt).toContain("f2: the caller already resolved it");
	});
});

// ── The ship dialog ──────────────────────────────────────────────────────────

const view = (): ShipGateView =>
	readShipGate(gateInspection(), RUN, SLUG) as ShipGateView;

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

	// THE DECISION IS THE WHOLE ACT, and this is the assertion that says so. Ship
	// writes the run's own checkpoint with the key the view carries — not a
	// hardcoded `ship`, because a checkpoint inside a fan-out is
	// `<namespace>/<key>`.
	it("decides the run's own ship checkpoint, and publishes nothing", async () => {
		const r = recorder({ answers: [SHIP_YES] });
		expect(await askShip(r.deps, view())).toEqual({ kind: "decided" });
		expect(r.decided).toEqual([
			{
				runId: RUN,
				taskKey: "compose/ship",
				options: { decision: { ship: true }, approver: SHIP_DIALOG_APPROVER },
			},
		]);
		// Publication follows the run's COMPLETION, down the announcement path a
		// widget decision takes. A dialog that published here would leave the run's
		// own checkpoint parked behind its own pull request.
		expect(r.published).toEqual([]);
		expect(r.said).toEqual([]);
		const said = r.notices.map(([message]) => message).join("\n");
		expect(said).toContain("is shipping");
		expect(said).toContain("on run `wfr-plan-to-ship-7`'s record");
		expect(said).toContain("publishes from its receipt");
	});

	it("names the dialog as the approver, and claims no source", async () => {
		const r = recorder({ answers: [SHIP_YES] });
		await askShip(r.deps, view());
		expect(r.decided[0]?.options.approver).toBe("human:maestro-ship-dialog");
		// `source: "service-provider"` is pi-workflow's to set, and a consumer that
		// claimed it would be claiming its own authority over the record.
		expect(r.decided[0]?.options).not.toHaveProperty("source");
	});

	it("decides `{ship:false}` with the reason typed, and publishes nothing", async () => {
		const r = recorder({
			answers: [SHIP_NO],
			typed: "the disputed finding is real",
		});
		expect(await askShip(r.deps, view())).toEqual({
			kind: "declined",
			reason: "the disputed finding is real",
		});
		expect(r.decided).toEqual([
			{
				runId: RUN,
				taskKey: "compose/ship",
				options: {
					decision: { ship: false, note: "the disputed finding is real" },
					approver: SHIP_DIALOG_APPROVER,
					reason: "the disputed finding is real",
				},
			},
		]);
		expect(r.published).toEqual([]);
	});

	it("takes `no reason given` rather than an empty note", async () => {
		const r = recorder({ answers: [SHIP_NO], typed: "   " });
		await askShip(r.deps, view());
		expect(r.decided[0]?.options.decision).toEqual({
			ship: false,
			note: "no reason given",
		});
	});

	// The runtime's own sentence, because it is the one that knows why: a key that
	// names no awaiting checkpoint, a value its schema refuses, a run that moved on.
	it("reports the runtime's refusal verbatim and changes nothing", async () => {
		const r = recorder({
			answers: [SHIP_YES],
			decideFails: "Workflow checkpoint is not awaiting a decision.",
		});
		const outcome = await askShip(r.deps, view());
		expect(outcome.kind).toBe("refused");
		const said = r.notices.map(([message]) => message).join("\n");
		expect(said).toContain("Workflow checkpoint is not awaiting a decision.");
		expect(said).toContain("Nothing is published");
		expect(r.published).toEqual([]);
	});

	it("keeps the typed reason when a refusal loses the decision", async () => {
		const r = recorder({
			answers: [SHIP_NO],
			typed: "not yet",
			decideFails: "Workflow run is already terminal.",
		});
		expect((await askShip(r.deps, view())).kind).toBe("refused");
		expect(r.notices.map(([message]) => message).join("\n")).toContain(
			"the reason you typed was: not yet",
		);
	});

	// The decision is not made by going to look at the run, so the dialog comes
	// straight back rather than closing on the way to the inspector.
	it("returns to the same dialog after Look first", async () => {
		const looked: string[] = [];
		const r = recorder({
			answers: [SHIP_LOOK, SHIP_YES],
			inspector: (runId) => looked.push(runId),
		});
		expect((await askShip(r.deps, view())).kind).toBe("decided");
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

	// An escape is a Look first, which loops — so escaping for ever is a dialog
	// nobody answered, never a decision nobody took.
	it("never decides anything on an unanswered dialog", async () => {
		const r = recorder({ answers: [undefined, SHIP_NO], typed: "no" });
		await askShip(r.deps, view());
		expect(r.decided.map((entry) => entry.options.decision)).toEqual([
			{ ship: false, note: "no" },
		]);
	});
});

// ── Auto publication ─────────────────────────────────────────────────────────

describe("a `gates: none` run that completed", () => {
	it("publishes with no question at all, and posts the link", async () => {
		const r = recorder({ inspect: summaryInspection });
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

	// A run that shipped without asking still owes a person the account a gate
	// would have shown them, rendered the same way.
	it("says what was published, from the run's own shipSummary", async () => {
		const r = recorder({ inspect: summaryInspection });
		await autoPublish(r.deps, RUN, SLUG, "none");
		expect(r.inspected).toEqual([[RUN, AUTO_INSPECT_SECTIONS]]);
		const message = r.said.join("\n");
		expect(message).toContain(PUBLISHED_HEADING);
		expect(message).toContain("Added the catalogue and its four stages.");
		expect(message).toContain("blocking (1):");
		expect(message).toContain("disputed (1): f2");
		expect(message).toContain(
			"residual (2, shipping with these): f2 [major], f3 [minor]",
		);
	});

	// The account is a courtesy and the receipt publication reads is its own call,
	// so a run whose inspection cannot be read still publishes — it just says less.
	it("still publishes when the account cannot be read", async () => {
		const r = recorder({ inspectFails: true });
		expect((await autoPublish(r.deps, RUN, SLUG, "none")).kind).toBe(
			"published",
		);
		const message = r.said.join("\n");
		expect(message).toContain("https://example.test/pr/1");
		expect(message).not.toContain(PUBLISHED_HEADING);
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
		const r = recorder({
			answers: [PUBLISH_RETRY],
			publish: [failed, OK],
			inspect: summaryInspection,
		});
		expect((await autoPublish(r.deps, RUN, SLUG, "none")).kind).toBe(
			"published",
		);
		expect(r.published).toEqual([RUN, RUN]);
		expect(r.titles[0]).toContain("did not publish. Retry?");
		expect(r.titles[0]).toContain("`npm run check` failed on the host");
		expect(r.titles[0]).toContain("`maestro/compose-1` is in place");
		// Read once, before the first attempt: a retry is not a second reading.
		expect(r.inspected).toHaveLength(1);
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

	it("resumes that one task, leaving its dependents alone", async () => {
		const r = recorder({ answers: [RETRY_TASK] });
		expect(await askFailure(r.deps, failure)).toEqual({ kind: "retried" });
		expect(r.resumed).toEqual([[RUN, "t-impl"]]);
		expect(r.notices.map(([message]) => message).join("\n")).toContain(
			"its dependents are untouched",
		);
	});

	// `resume` re-attempts ONE task, so there has to be one. Resuming whatever task
	// happened to be last would be the seat choosing which failure to retry.
	it("refuses a retry for a run that failed as a whole", async () => {
		const r = recorder({ answers: [RETRY_TASK] });
		const outcome = await askFailure(r.deps, {
			runId: RUN,
			slug: SLUG,
			cause: "the run's budget was spent",
		});
		expect(outcome.kind).toBe("refused");
		expect(r.resumed).toEqual([]);
		expect(r.notices.map(([message]) => message).join("\n")).toContain(
			"failed as a whole rather than at one task",
		);
	});

	it("reports the runtime's own not-resumable refusal", async () => {
		const r = recorder({
			answers: [RETRY_TASK],
			resumeFails: WORKFLOW_NOT_RESUMABLE,
		});
		expect((await askFailure(r.deps, failure)).kind).toBe("refused");
		expect(r.notices.map(([message]) => message).join("\n")).toContain(
			"Workflow task is not resumable on this run.",
		);
	});

	it("cancels the run, and says the handoffs survive it", async () => {
		const r = recorder({ answers: [STOP_RUN] });
		expect(await askFailure(r.deps, failure)).toEqual({ kind: "stopped" });
		expect(r.stopped).toEqual([RUN]);
		const said = r.notices.map(([message]) => message).join("\n");
		expect(said).toContain("still in the repository's object store");
		expect(said).toContain("the runtime never applies one");
	});

	it("reports a refused stop rather than claiming the run ended", async () => {
		const r = recorder({
			answers: [STOP_RUN],
			stopFails: "Workflow run is already terminal.",
		});
		expect((await askFailure(r.deps, failure)).kind).toBe("refused");
		expect(r.notices.map(([message]) => message).join("\n")).toContain(
			"Workflow run is already terminal.",
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
		// It needs nothing of the runtime, which is why it is the escape.
		expect(r.resumed).toEqual([]);
		expect(r.stopped).toEqual([]);
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
				execute(...args: unknown[]): Promise<{ content: { text: string }[] }>;
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
				execute(...args: unknown[]): Promise<{ content: { text: string }[] }>;
			}
		).execute("id", {}, undefined, undefined, {});
		expect(result.content[0]?.text).toBe(NOTHING_PARKED);
		expect(result.content[0]?.text).toContain("`/mode ask`");
		expect(result.content[0]?.text).toContain("/plan ship <slug>");
	});
});
