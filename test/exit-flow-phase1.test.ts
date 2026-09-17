// Phase 1 of the plan-mode exit and the description that follows it, driven
// through a fake UI.
//
// Phase 1 is two dialogs and one commit, and everything that can go wrong with
// it is a question about *what was left behind*: a mode that moved when nobody
// asked it to, a record written by a flow nobody finished, a record that
// outlived the session it names. So every case below asserts the same three
// facts after the fact — the posture, the record on disk, and what the model
// was told — rather than only the value the flow returned.
//
// The fake UI is the injected `ExitFlowUi` port, which is the whole point of
// injecting it: a dialog sequence is otherwise only testable by a human.

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	countSentences,
	intentProblem,
	PLAN_INTENT_TOOL,
} from "../packages/maestro/src/authoring.js";
import * as exitFlow from "../packages/maestro/src/exit-flow.js";
import {
	chosenOption,
	continueModeExit,
	derivePublication,
	EFFORT_OPTIONS,
	EFFORT_TITLE,
	EXIT_COMPILE,
	EXIT_KEEP_PLANNING,
	EXIT_START_OPTIONS,
	EXIT_START_TITLE,
	EXIT_SWITCH_ONLY,
	type ExitFlowUi,
	type ExitOption,
	FALLBACK_BASE_BRANCH,
	INTENT_AGREE,
	INTENT_BACK,
	INTENT_EDIT,
	INTENT_EDITOR_TITLE,
	INTENT_OPTIONS,
	INTENT_TITLE,
	intentDialogTitle,
	optionLabel,
	optionLabels,
	renderExitSteer,
	renderIntentSteer,
	runExitFlowPhase1,
	runIntentAgreement,
	submittedIntent,
} from "../packages/maestro/src/exit-flow.js";
import { type SeatHost, startSeat } from "../packages/maestro/src/extension.js";
import * as findings from "../packages/maestro/src/findings.js";
import type { ModeName } from "../packages/maestro/src/mode.js";
import { pendingExitFile } from "../packages/maestro/src/paths.js";
import {
	deletePendingExit,
	MAX_INTENT_LENGTH,
	PENDING_EXIT_SCHEMA_VERSION,
	type PendingExit,
	PendingExitError,
	readPendingExit,
	writePendingExit,
} from "../packages/maestro/src/pending-exit.js";

const dirs: string[] = [];
afterEach(() => {
	for (const directory of dirs.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function temp(name: string): string {
	const path = mkdtempSync(join(tmpdir(), name));
	dirs.push(path);
	return path;
}

const SESSION = "session-01";

/** One dialog, as the fake saw it. */
interface Opened {
	readonly kind: "select" | "input" | "confirm" | "editor" | "notify";
	readonly title: string;
	readonly options?: readonly string[];
	readonly signal: boolean;
}

interface Script {
	/** Answers by dialog title; a title with no answer is an escape. */
	readonly answers?: Readonly<Record<string, string | undefined>>;
	/** Called after each dialog, so a test can abort mid-flow. */
	readonly after?: (opened: Opened, index: number) => void;
}

function fakeUi(script: Script = {}) {
	const opened: Opened[] = [];
	const notices: [string, string][] = [];
	const answer = async (
		kind: Opened["kind"],
		title: string,
		options: readonly string[] | undefined,
		opts: { signal?: AbortSignal } | undefined,
	): Promise<string | undefined> => {
		const entry: Opened = {
			kind,
			title,
			signal: Boolean(opts?.signal),
			...(options ? { options: [...options] } : {}),
		};
		opened.push(entry);
		script.after?.(entry, opened.length - 1);
		return script.answers?.[title];
	};
	const ui: ExitFlowUi = {
		select: (title, options, opts) => answer("select", title, options, opts),
		input: (title, _placeholder, opts) =>
			answer("input", title, undefined, opts),
		confirm: async () => {
			throw new Error("phase 1 asks no confirmations");
		},
		editor: (title, _prefill) => answer("editor", title, undefined, undefined),
		notify: (message, type) => {
			notices.push([message, type ?? "info"]);
		},
	};
	return {
		ui,
		opened,
		notices,
		/** Only the dialogs; a notification is not a question. */
		dialogs: () => opened.filter((o) => o.kind !== "notify"),
		titles: () => opened.filter((o) => o.kind !== "notify").map((o) => o.title),
		said: () => notices.map(([message]) => message).join("\n---\n"),
	};
}

interface Harness {
	readonly agentDir: string;
	readonly modes: ModeName[];
	readonly steers: [string, string | undefined][];
	mode(): ModeName;
}

function harness(): Harness {
	const agentDir = temp("maestro-agent-");
	const modes: ModeName[] = [];
	return {
		agentDir,
		modes,
		steers: [],
		mode: () => modes.at(-1) ?? "plan",
	};
}

/** A repository with an `origin` remote, `gh`, and a tracked `trunk`. */
const FULLY_EQUIPPED = derivePublication({
	originPresent: () => true,
	ghPresent: () => true,
	upstreamHead: () => "trunk",
});

function deps(
	h: Harness,
	ui: ExitFlowUi,
	extra: Partial<Parameters<typeof runExitFlowPhase1>[0]> = {},
) {
	return {
		ui,
		sessionId: SESSION,
		wanted: "auto" as const,
		setMode: (name: ModeName) => {
			h.modes.push(name);
		},
		sendUserMessage: (content: string, options?: { deliverAs?: string }) => {
			h.steers.push([content, options?.deliverAs]);
		},
		publication: () => FULLY_EQUIPPED,
		agentDir: h.agentDir,
		now: () => "2026-09-16T12:00:00.000Z",
		...extra,
	};
}

/** One option's label, by value, so a test never hard-codes the suffix. */
function labelFor<T>(table: readonly ExitOption<T>[], value: T): string {
	const found = table.find((option) => option.value === value);
	if (!found) throw new Error(`no option for ${JSON.stringify(value)}`);
	return optionLabel(found);
}

/** The labels a human actually sees, for the happy path. */
const COMPILE_ANSWERS = {
	[EXIT_START_TITLE]: labelFor(EXIT_START_OPTIONS, "compile"),
} as const;

/** Answering the description dialog with the option that agrees. */
const AGREE = labelFor(INTENT_OPTIONS, "agree");

describe("step 1 — the only question that can end the flow", () => {
	it("leaves the posture and writes nothing when the human keeps planning", async () => {
		const h = harness();
		const fake = fakeUi({
			answers: { [EXIT_START_TITLE]: EXIT_KEEP_PLANNING },
		});

		const outcome = await runExitFlowPhase1(deps(h, fake.ui));

		expect(outcome).toEqual({ kind: "keep-planning" });
		expect(h.modes).toEqual([]);
		expect(h.steers).toEqual([]);
		expect(existsSync(pendingExitFile(SESSION, h.agentDir))).toBe(false);
		expect(fake.titles()).toEqual([EXIT_START_TITLE]);
		// Compiling is first, because it is what somebody who typed `/mode auto`
		// after a planning conversation usually wants. It is NOT what escape
		// takes — see the escape case below.
		expect(fake.opened[0]?.options).toEqual([
			`${EXIT_COMPILE} (default)`,
			EXIT_SWITCH_ONLY,
			EXIT_KEEP_PLANNING,
		]);
	});

	it("treats escape as keeping planning, not as the recommended answer", async () => {
		const h = harness();
		const fake = fakeUi();

		const outcome = await runExitFlowPhase1(deps(h, fake.ui));

		// The first option compiles; escaping must not start an exit nobody
		// asked for, so it keeps planning and records nothing.
		expect(outcome).toEqual({ kind: "keep-planning" });
		expect(h.modes).toEqual([]);
		expect(existsSync(pendingExitFile(SESSION, h.agentDir))).toBe(false);
		expect(fake.titles()).toEqual([EXIT_START_TITLE]);
	});

	it("keeps planning on an answer the table does not recognise", async () => {
		const h = harness();
		const fake = fakeUi({ answers: { [EXIT_START_TITLE]: "something else" } });

		const outcome = await runExitFlowPhase1(deps(h, fake.ui));

		// A label this table cannot resolve is not evidence anybody picked
		// anything, so it takes the escape rather than the recommendation.
		expect(outcome).toEqual({ kind: "keep-planning" });
		expect(existsSync(pendingExitFile(SESSION, h.agentDir))).toBe(false);
	});

	it("switches with no record and no steer on `Just switch mode`", async () => {
		const h = harness();
		const fake = fakeUi({ answers: { [EXIT_START_TITLE]: EXIT_SWITCH_ONLY } });

		const outcome = await runExitFlowPhase1(deps(h, fake.ui));

		expect(outcome).toEqual({ kind: "switch-only" });
		expect(h.modes).toEqual(["auto"]);
		expect(h.steers).toEqual([]);
		expect(existsSync(pendingExitFile(SESSION, h.agentDir))).toBe(false);
		expect(fake.titles()).toEqual([EXIT_START_TITLE]);
	});

	it("drops a record left by an exit that never finished", async () => {
		const h = harness();
		writePendingExit(
			{
				schemaVersion: PENDING_EXIT_SCHEMA_VERSION,
				sessionId: SESSION,
				policy: { effort: "cheap" },
				wanted: "hack",
				createdAt: "2026-09-15T00:00:00.000Z",
			},
			h.agentDir,
		);
		const fake = fakeUi({
			answers: { [EXIT_START_TITLE]: EXIT_KEEP_PLANNING },
		});

		await runExitFlowPhase1(deps(h, fake.ui));

		// Keeping planning means no exit is in progress, and a record that says
		// otherwise would hold the exit's tools open in plan mode indefinitely.
		expect(existsSync(pendingExitFile(SESSION, h.agentDir))).toBe(false);
	});
});

describe("the happy path", () => {
	it("asks exactly two dialogs, in order, each carrying the signal", async () => {
		const h = harness();
		const fake = fakeUi({ answers: COMPILE_ANSWERS });

		const outcome = await runExitFlowPhase1(
			deps(h, fake.ui, { signal: new AbortController().signal }),
		);

		expect(fake.titles()).toEqual([EXIT_START_TITLE, EFFORT_TITLE]);
		expect(fake.dialogs().every((d) => d.signal)).toBe(true);
		expect(outcome.kind === "compiled" && outcome.asked).toBe(2);
	});

	it("records the answers and asks for the description, without moving the mode", async () => {
		const h = harness();
		const fake = fakeUi({
			answers: {
				...COMPILE_ANSWERS,
				[EFFORT_TITLE]: labelFor(EFFORT_OPTIONS, "deep"),
			},
		});

		const outcome = await runExitFlowPhase1(deps(h, fake.ui));

		expect(outcome.kind).toBe("compiled");
		if (outcome.kind !== "compiled") return;
		// THE POSTURE DOES NOT MOVE. It moves when the run starts, and nowhere
		// else on this path.
		expect(h.modes).toEqual([]);
		expect(outcome.record).toEqual({
			schemaVersion: 2,
			sessionId: SESSION,
			policy: {
				effort: "deep",
				gates: "approve-plan+ship",
				publish: { mode: "pr", base: "trunk" },
			},
			wanted: "auto",
			createdAt: "2026-09-16T12:00:00.000Z",
		});
		// No `intent` yet: it is agreed a model turn later, and its absence is
		// what holds the `plan` tool shut.
		expect(outcome.record.intent).toBeUndefined();
		// The record on disk is the one the next turn will read, so it is read
		// back through the same door rather than trusted from memory.
		expect(readPendingExit(SESSION, h.agentDir)).toEqual(outcome.record);
		expect(outcome.path).toBe(pendingExitFile(SESSION, h.agentDir));
		expect(h.steers).toEqual([[outcome.steer, "followUp"]]);
		expect(outcome.steer).toBe(renderIntentSteer());
	});

	it("takes `standard` when the effort dial is escaped", async () => {
		const h = harness();
		const fake = fakeUi({ answers: COMPILE_ANSWERS });

		const outcome = await runExitFlowPhase1(deps(h, fake.ui));

		expect(outcome.kind === "compiled" && outcome.record.policy).toEqual({
			effort: "standard",
			gates: "approve-plan+ship",
			publish: { mode: "pr", base: "trunk" },
		});
	});

	it("records every effort the dialog offers, against both postures", async () => {
		for (const effort of EFFORT_OPTIONS)
			for (const wanted of ["auto", "hack"] as const) {
				const h = harness();
				const fake = fakeUi({
					answers: {
						...COMPILE_ANSWERS,
						[EFFORT_TITLE]: optionLabel(effort),
					},
				});
				const outcome = await runExitFlowPhase1(deps(h, fake.ui, { wanted }));
				expect(
					outcome.kind === "compiled" && outcome.record.policy.effort,
				).toBe(effort.value);
				expect(outcome.kind === "compiled" && outcome.record.wanted).toBe(
					wanted,
				);
			}
	});
});

// ── Publication, derived ─────────────────────────────────────────────────────

describe("publication, read off the repository rather than asked", () => {
	it("derives the mode from the remote and `gh`, and the base from the upstream", () => {
		const cases: [boolean, boolean, string | null, string, string][] = [
			[true, true, "trunk", "pr", "trunk"],
			[true, false, "trunk", "branch", "trunk"],
			[false, true, "trunk", "none", "trunk"],
			[false, false, null, "none", FALLBACK_BASE_BRANCH],
			[true, true, null, "pr", FALLBACK_BASE_BRANCH],
		];
		for (const [origin, gh, upstream, mode, base] of cases) {
			const derived = derivePublication({
				originPresent: () => origin,
				ghPresent: () => gh,
				upstreamHead: () => upstream,
			});
			expect([origin, gh, upstream, derived.mode, derived.base]).toEqual([
				origin,
				gh,
				upstream,
				mode,
				base,
			]);
			// Every derivation says what it found, in the words the human reads.
			expect(derived.why.startsWith("Publication: ")).toBe(true);
		}
	});

	it("announces the derivation once, and records it as the policy's publish", async () => {
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
			const h = harness();
			const fake = fakeUi({ answers: COMPILE_ANSWERS });
			const outcome = await runExitFlowPhase1(
				deps(h, fake.ui, { publication: () => publication }),
			);
			expect(
				outcome.kind === "compiled" && outcome.record.policy.publish,
			).toEqual(expected);
			const announcements = fake.notices.filter(([message]) =>
				message.startsWith("Publication: "),
			);
			expect(announcements).toEqual([[publication.why, "info"]]);
			// No dialog was opened for it, which is the point.
			expect(fake.titles()).toEqual([EXIT_START_TITLE, EFFORT_TITLE]);
		}
	});

	it("refuses a base branch Git would not accept, before anything is recorded", async () => {
		const h = harness();
		const fake = fakeUi({ answers: COMPILE_ANSWERS });

		const outcome = await runExitFlowPhase1(
			deps(h, fake.ui, {
				publication: () => ({
					mode: "pr" as const,
					base: "no spaces here",
					why: "Publication: pull request onto `no spaces here`.",
				}),
			}),
		);

		expect(outcome.kind).toBe("refused");
		expect(h.modes).toEqual([]);
		expect(h.steers).toEqual([]);
		expect(existsSync(pendingExitFile(SESSION, h.agentDir))).toBe(false);
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
			// Exactly one of each, and the recommendation is FIRST — it is the
			// row a `select` highlights, so it is the row the person most likely
			// wants.
			expect([name, recommended.length]).toEqual([name, 1]);
			expect([name, escapes.length]).toEqual([name, 1]);
			expect([name, table[0]?.recommended]).toEqual([name, true]);
			// Only the recommendation is labelled, and it is the only one.
			expect([
				name,
				optionLabels(table).filter((label) => label.endsWith(" (default)")),
			]).toEqual([name, [optionLabel(table[0] as ExitOption<unknown>)]]);
			// An unanswered dialog resolves to the ESCAPE, never to the
			// recommendation — unless a table has deliberately made them the same
			// row, which only `EFFORT_OPTIONS` does and only because escaping
			// there commits to nothing.
			expect([name, chosenOption(table, undefined)]).toEqual([
				name,
				escapes[0]?.value,
			]);
			// An answer the table does not know is an escape too: a label that
			// cannot be resolved must not become a decision somebody is held to.
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
		// Every other table would be committing a person to something they did
		// not answer: starting a compile, agreeing a description, continuing
		// past a dirty tree, starting a reviewer, accepting a patch.
		expect(both.map(([name]) => name)).toEqual(["exit-flow.EFFORT_OPTIONS"]);
	});

	it("offers the three efforts with `standard` first, and escaping there is `standard`", () => {
		expect(optionLabels(EFFORT_OPTIONS)).toEqual([
			"standard (default)",
			"cheap",
			"deep",
		]);
		expect(chosenOption(EFFORT_OPTIONS, undefined)).toBe("standard");
	});
});

// ── The steers ───────────────────────────────────────────────────────────────

describe("the steers", () => {
	it("asks for the description through the tool, and for nothing else", () => {
		const steer = renderIntentSteer();
		expect(steer).toContain("two or three sentences");
		expect(steer).toContain("`plan_intent { summary }`");
		expect(steer).toContain("do not start a run");
		// Including one that would check the sentences it is about to write.
		expect(steer).toContain("no workflow, research or review");
		// The description is written from the conversation, not asked for.
		expect(steer).toContain("Do not ask me to write it for you");
		// Phase 1 does not ask for the plan.
		expect(steer).not.toContain("Call `plan` once");
	});

	it("quotes the exact policy block and licenses exactly one change to it", () => {
		const policy = {
			effort: "deep" as const,
			gates: "approve-plan+ship" as const,
			publish: { mode: "pr" as const, base: "trunk" },
		};
		const steer = renderExitSteer(policy);
		expect(steer).toContain(JSON.stringify(policy, null, 2));
		expect(steer).toContain("verbatim");
		expect(steer).toContain("`stages`");
		expect(steer).toContain("Call `plan` once");
		expect(steer).toContain("every-deliverable");
		expect(steer).toContain("a check after every deliverable");
		// The one line phase 1 used to add is gone: the description is agreed,
		// not recorded from a dialog, and it is not quoted back here.
		expect(steer).not.toContain("I recorded one line");
		expect(steer).toContain("do not start a run");
		// A run over its own plan is the one the model reached for anyway, so the
		// steer names it rather than leaving "a run" to be read as "the plan run".
		expect(steer).toContain("deep-review");
		expect(steer).toContain("a plan reviewed by its author is not reviewed");
		// The two fields the last plan got wrong, said before it writes them.
		expect(steer).toContain("`by.lens` is");
		expect(steer).toContain("^[a-z][a-z0-9-]{0,63}$");
		expect(steer).toContain("`by.model` is OPTIONAL");
		expect(steer).toContain("prefer `by.tier`");
	});

	it("keeps the record and prints the instruction when the host cannot steer", async () => {
		const h = harness();
		const fake = fakeUi({ answers: COMPILE_ANSWERS });

		const outcome = await runExitFlowPhase1(
			deps(h, fake.ui, { sendUserMessage: undefined }),
		);

		expect(outcome.kind).toBe("compiled");
		expect(existsSync(pendingExitFile(SESSION, h.agentDir))).toBe(true);
		const printed = fake.notices.find(([, type]) => type === "warning");
		expect(printed?.[0]).toContain("`plan_intent { summary }`");
	});
});

describe("a session replacement", () => {
	it("aborts mid-flow, drops the record, and leaves the posture alone", async () => {
		const h = harness();
		writePendingExit(
			{
				schemaVersion: PENDING_EXIT_SCHEMA_VERSION,
				sessionId: SESSION,
				policy: { effort: "cheap" },
				wanted: "auto",
				intent: "from an earlier exit",
				createdAt: "2026-09-15T00:00:00.000Z",
			},
			h.agentDir,
		);
		const controller = new AbortController();
		const fake = fakeUi({
			answers: COMPILE_ANSWERS,
			after: (_opened, index) => {
				if (index === 0) controller.abort();
			},
		});

		const outcome = await runExitFlowPhase1(
			deps(h, fake.ui, { signal: controller.signal }),
		);

		expect(outcome).toEqual({ kind: "aborted" });
		// One dialog opened; the second was never asked over a dead session.
		expect(fake.titles()).toEqual([EXIT_START_TITLE]);
		expect(h.modes).toEqual([]);
		expect(h.steers).toEqual([]);
		expect(existsSync(pendingExitFile(SESSION, h.agentDir))).toBe(false);
	});

	it("opens no dialog at all when the signal is already aborted", async () => {
		const h = harness();
		const controller = new AbortController();
		controller.abort();
		const fake = fakeUi({ answers: COMPILE_ANSWERS });

		const outcome = await runExitFlowPhase1(
			deps(h, fake.ui, { signal: controller.signal }),
		);

		expect(outcome).toEqual({ kind: "aborted" });
		expect(fake.dialogs()).toEqual([]);
	});
});

// ── The pending record ───────────────────────────────────────────────────────

describe("the pending record", () => {
	it("round-trips through write, read and delete", () => {
		const h = harness();
		const record = {
			schemaVersion: PENDING_EXIT_SCHEMA_VERSION,
			sessionId: SESSION,
			policy: { effort: "deep", publish: { mode: "branch", base: "main" } },
			wanted: "hack",
			intent: "We are doing a thing. It is worth doing.",
			createdAt: "2026-09-16T12:00:00.000Z",
		} as const;

		const path = writePendingExit(record, h.agentDir);
		expect(path).toBe(pendingExitFile(SESSION, h.agentDir));
		expect(readPendingExit(SESSION, h.agentDir)).toEqual(record);
		// Another session's record is not this one's.
		expect(readPendingExit("session-02", h.agentDir)).toBeNull();
		deletePendingExit(SESSION, h.agentDir);
		expect(readPendingExit(SESSION, h.agentDir)).toBeNull();
		// Deleting what is not there is the normal state, not an error.
		deletePendingExit(SESSION, h.agentDir);
	});

	it("carries the blind reviews already spent, and reads their absence as none", () => {
		// The count crosses model turns: *Revise with the model* ends phase 2
		// with the record open, and the `plan` call that answers the steer is
		// what reads it back. A record written before the field existed has had
		// no reviews, which is exactly what its absence says.
		const h = harness();
		const base: PendingExit = {
			schemaVersion: PENDING_EXIT_SCHEMA_VERSION,
			sessionId: SESSION,
			policy: { effort: "standard" },
			wanted: "auto",
			intent: "We are doing a thing. It is worth doing.",
			createdAt: "2026-09-16T12:00:00.000Z",
		};
		writePendingExit(base, h.agentDir);
		const none = readPendingExit(SESSION, h.agentDir);
		expect(none && "reviews" in none).toBe(false);
		expect(none?.reviews ?? 0).toBe(0);

		writePendingExit({ ...base, reviews: 2 }, h.agentDir);
		expect(readPendingExit(SESSION, h.agentDir)?.reviews).toBe(2);

		// Nothing this build could not read back is written.
		expect(() =>
			writePendingExit({ ...base, reviews: -1 }, h.agentDir),
		).toThrowError("`reviews`");
	});

	it("round-trips a record with no agreed description yet", () => {
		const h = harness();
		const record: PendingExit = {
			schemaVersion: PENDING_EXIT_SCHEMA_VERSION,
			sessionId: SESSION,
			policy: { effort: "standard" },
			wanted: "auto",
			createdAt: "2026-09-16T12:00:00.000Z",
		};
		writePendingExit(record, h.agentDir);
		const read = readPendingExit(SESSION, h.agentDir);
		expect(read).toEqual(record);
		expect(read && "intent" in read).toBe(false);
	});

	it("refuses every malformed record loudly rather than reading it as absent", () => {
		const h = harness();
		const path = pendingExitFile(SESSION, h.agentDir);
		mkdirSync(dirname(path), { recursive: true });
		const good = {
			schemaVersion: 2,
			sessionId: SESSION,
			policy: { effort: "standard" },
			wanted: "auto",
			intent: "We are doing a thing. It is worth doing.",
			createdAt: "2026-09-16T12:00:00.000Z",
		};
		const cases: [string, string][] = [
			["not readable JSON", "{ this is not json"],
			["not a JSON object", JSON.stringify([good])],
			// A v1 record: refused by version, with no compatibility reader. It
			// claims the posture already moved, which this build cannot check.
			[
				"schema",
				JSON.stringify({
					schemaVersion: 1,
					sessionId: SESSION,
					policy: { effort: "standard" },
					intent: "one line",
					createdAt: "2026-09-16T12:00:00.000Z",
				}),
			],
			["schema", JSON.stringify({ ...good, schemaVersion: 3 })],
			["names session", JSON.stringify({ ...good, sessionId: "other" })],
			["createdAt", JSON.stringify({ ...good, createdAt: "" })],
			["`wanted`", JSON.stringify({ ...good, wanted: "plan" })],
			["`wanted`", JSON.stringify({ ...good, wanted: undefined })],
			["`intent` is not a string", JSON.stringify({ ...good, intent: 7 })],
			[
				"past the",
				JSON.stringify({ ...good, intent: "x".repeat(MAX_INTENT_LENGTH + 1) }),
			],
			[
				"`policy` is not an object",
				JSON.stringify({ ...good, policy: "cheap" }),
			],
			[
				"`policy` is invalid",
				JSON.stringify({ ...good, policy: { effort: "enormous" } }),
			],
			// `reviews` is the bound the revise loop counts against, so a record
			// that says something other than a count of them is not readable.
			["`reviews`", JSON.stringify({ ...good, reviews: -1 })],
			["`reviews`", JSON.stringify({ ...good, reviews: 1.5 })],
			["`reviews`", JSON.stringify({ ...good, reviews: "two" })],
		];
		for (const [expected, body] of cases) {
			writeFileSync(path, body, "utf8");
			expect(() => readPendingExit(SESSION, h.agentDir)).toThrowError(
				PendingExitError,
			);
			expect(() => readPendingExit(SESSION, h.agentDir)).toThrowError(expected);
			// Every refusal names the file, because removing it is the fix.
			expect(() => readPendingExit(SESSION, h.agentDir)).toThrowError(
				"Delete the file",
			);
		}
		// And the good one still reads, so the cases above are about the damage
		// and not about the reader.
		writeFileSync(path, JSON.stringify(good), "utf8");
		expect(readPendingExit(SESSION, h.agentDir)?.wanted).toBe("auto");
	});

	it("refuses a session id that would escape the directory", () => {
		const h = harness();
		expect(() => readPendingExit("../../etc/passwd", h.agentDir)).toThrowError(
			PendingExitError,
		);
		expect(() => pendingExitFile("../escape")).toThrowError(
			"invalid session id",
		);
	});

	it("refuses to write what it could not read back", () => {
		const h = harness();
		const base = {
			schemaVersion: PENDING_EXIT_SCHEMA_VERSION,
			sessionId: SESSION,
			wanted: "auto" as const,
			createdAt: "2026-09-16T12:00:00.000Z",
		};
		expect(() =>
			writePendingExit(
				{ ...base, policy: { effort: "enormous" as never } },
				h.agentDir,
			),
		).toThrowError(PendingExitError);
		expect(() =>
			writePendingExit(
				{ ...base, policy: {}, intent: "x".repeat(MAX_INTENT_LENGTH + 1) },
				h.agentDir,
			),
		).toThrowError(PendingExitError);
		expect(() =>
			writePendingExit(
				{ ...base, wanted: "plan" as never, policy: {} },
				h.agentDir,
			),
		).toThrowError(PendingExitError);
		expect(existsSync(pendingExitFile(SESSION, h.agentDir))).toBe(false);
	});

	it("stops phase 1 loudly when the record for this session cannot be read", async () => {
		const h = harness();
		const path = pendingExitFile(SESSION, h.agentDir);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "{ not json", "utf8");
		const fake = fakeUi({ answers: COMPILE_ANSWERS });

		const outcome = await runExitFlowPhase1(deps(h, fake.ui));

		expect(outcome.kind).toBe("refused");
		expect(fake.dialogs()).toEqual([]);
		expect(h.modes).toEqual([]);
		expect(fake.notices.some(([, type]) => type === "error")).toBe(true);
		// Untouched: a record nobody can read is the human's to remove, and
		// overwriting it would hide whatever wrote it.
		expect(readFileSync(path, "utf8")).toBe("{ not json");
	});
});

// ── The agreed description ───────────────────────────────────────────────────

const SUMMARY =
	"We are extracting the plan-mode exit into its own module. " +
	"It is worth doing because the dialogs and the record drifted apart.";

describe("the `plan_intent` tool", () => {
	it("takes two or three sentences and refuses everything else", () => {
		expect(intentProblem(SUMMARY)).toBeUndefined();
		expect(intentProblem("One. Two. Three.")).toBeUndefined();
		expect(intentProblem("   ")).toContain("empty");
		expect(intentProblem("Only one sentence.")).toContain("1 sentence");
		expect(intentProblem("One. Two. Three. Four.")).toContain("4 sentences");
		expect(
			intentProblem(`${"x".repeat(MAX_INTENT_LENGTH)}. And more.`),
		).toContain("past the");
	});

	it("counts sentences by their terminators", () => {
		expect(countSentences("One. Two.")).toBe(2);
		expect(countSentences("One? Two! Three.")).toBe(3);
		expect(countSentences("No terminator")).toBe(1);
		expect(countSentences("")).toBe(0);
	});

	it("is a submitted result and nothing else that starts the dialog", () => {
		expect(
			submittedIntent({
				toolName: PLAN_INTENT_TOOL,
				details: { submitted: true, summary: SUMMARY },
			}),
		).toBe(SUMMARY);
		expect(
			submittedIntent({
				toolName: PLAN_INTENT_TOOL,
				isError: true,
				details: { submitted: true, summary: SUMMARY },
			}),
		).toBeUndefined();
		expect(
			submittedIntent({
				toolName: PLAN_INTENT_TOOL,
				details: { submitted: false, summary: SUMMARY },
			}),
		).toBeUndefined();
		expect(
			submittedIntent({
				toolName: "plan",
				details: { submitted: true, summary: SUMMARY },
			}),
		).toBeUndefined();
		expect(submittedIntent({ toolName: PLAN_INTENT_TOOL })).toBeUndefined();
	});
});

function pendingRecord(agentDir: string): PendingExit {
	const written: PendingExit = {
		schemaVersion: PENDING_EXIT_SCHEMA_VERSION,
		sessionId: SESSION,
		policy: {
			effort: "standard",
			gates: "approve-plan+ship",
			publish: { mode: "pr", base: "main" },
		},
		wanted: "auto",
		createdAt: "2026-09-16T12:00:00.000Z",
	};
	writePendingExit(written, agentDir);
	return written;
}

describe("the dialog that agrees the description", () => {
	it("shows the sentences, agrees to them, and asks for the plan", async () => {
		const h = harness();
		const record = pendingRecord(h.agentDir);
		const fake = fakeUi({ answers: { [intentDialogTitle(SUMMARY)]: AGREE } });

		const outcome = await runIntentAgreement({
			record,
			summary: SUMMARY,
			ui: fake.ui,
			agentDir: h.agentDir,
			sendUserMessage: (content, options) =>
				h.steers.push([content, options?.deliverAs]),
		});

		expect(outcome.kind).toBe("agreed");
		if (outcome.kind !== "agreed") return;
		expect(outcome.asked).toBe(1);
		// One dialog, and the sentences are in it: what is agreed to has to be
		// on screen at the moment of agreeing.
		expect(fake.titles()).toHaveLength(1);
		expect(fake.titles()[0]).toContain(INTENT_TITLE);
		expect(fake.titles()[0]).toContain(SUMMARY);
		expect(fake.opened[0]?.options).toEqual([
			`${INTENT_AGREE} (default)`,
			INTENT_EDIT,
			INTENT_BACK,
		]);
		// The record gains the description; nothing else about it moves.
		expect(readPendingExit(SESSION, h.agentDir)).toEqual({
			...record,
			intent: SUMMARY,
		});
		expect(h.steers).toEqual([[renderExitSteer(record.policy), "followUp"]]);
	});

	it("never agrees on escape, however it is highlighted", async () => {
		const h = harness();
		const record = pendingRecord(h.agentDir);
		const fake = fakeUi();

		const outcome = await runIntentAgreement({
			record,
			summary: SUMMARY,
			ui: fake.ui,
			agentDir: h.agentDir,
		});

		// *Agree* is first because it is the likely answer. Agreement is the one
		// thing here a human supplies and nothing else can — it becomes the
		// reviewer's yardstick and it opens the `plan` tool — so an unanswered
		// dialog goes back rather than committing to it.
		expect(outcome.kind).toBe("back");
		expect(readPendingExit(SESSION, h.agentDir)).toBeNull();
	});

	it("goes back on an answer the table does not recognise", async () => {
		const h = harness();
		const record = pendingRecord(h.agentDir);
		const fake = fakeUi({
			answers: { [intentDialogTitle(SUMMARY)]: "Agree, probably" },
		});

		const outcome = await runIntentAgreement({
			record,
			summary: SUMMARY,
			ui: fake.ui,
			agentDir: h.agentDir,
		});

		expect(outcome.kind).toBe("back");
		expect(readPendingExit(SESSION, h.agentDir)).toBeNull();
	});

	it("re-asks with the edited text, and discards an escaped editor", async () => {
		const h = harness();
		const record = pendingRecord(h.agentDir);
		const edited = "We are doing it differently. That is why.";
		let editorOpens = 0;
		const fake = fakeUi({
			after: () => undefined,
			answers: {},
		});
		// The script is stateful, so it is written here rather than as a map.
		const scripted: ExitFlowUi = {
			...fake.ui,
			select: async (title, options, opts) => {
				const answer = title.includes(edited) ? AGREE : INTENT_EDIT;
				await fake.ui.select(title, options, opts);
				return answer;
			},
			editor: async (title, prefill) => {
				editorOpens += 1;
				await fake.ui.editor(title, prefill);
				// The first editor is escaped, the second one rewrites it.
				return editorOpens === 1 ? undefined : edited;
			},
		};

		const outcome = await runIntentAgreement({
			record,
			summary: SUMMARY,
			ui: scripted,
			agentDir: h.agentDir,
		});

		expect(outcome.kind).toBe("agreed");
		expect(editorOpens).toBe(2);
		expect(
			fake.titles().filter((title) => title === INTENT_EDITOR_TITLE),
		).toHaveLength(2);
		expect(readPendingExit(SESSION, h.agentDir)?.intent).toBe(edited);
	});

	it("drops the record and stays in plan mode on `Back to the conversation`", async () => {
		const h = harness();
		const record = pendingRecord(h.agentDir);
		const fake = fakeUi();
		const scripted: ExitFlowUi = {
			...fake.ui,
			select: async (title, options, opts) => {
				await fake.ui.select(title, options, opts);
				return INTENT_BACK;
			},
		};

		const outcome = await runIntentAgreement({
			record,
			summary: SUMMARY,
			ui: scripted,
			agentDir: h.agentDir,
			sendUserMessage: (content) => h.steers.push([content, undefined]),
		});

		expect(outcome.kind).toBe("back");
		expect(readPendingExit(SESSION, h.agentDir)).toBeNull();
		expect(h.steers).toEqual([]);
		// One notice, naming the posture that was asked for and never given.
		expect(fake.said()).toContain("still in plan mode");
		expect(fake.said()).toContain("/mode auto");
		expect(fake.said()).not.toContain("/mode plan");
	});

	it("drops the record when the session is replaced under the dialog", async () => {
		const h = harness();
		const record = pendingRecord(h.agentDir);
		const controller = new AbortController();
		const fake = fakeUi({ after: () => controller.abort() });

		const outcome = await runIntentAgreement({
			record,
			summary: SUMMARY,
			ui: fake.ui,
			agentDir: h.agentDir,
			signal: controller.signal,
		});

		expect(outcome).toEqual({ kind: "aborted" });
		expect(readPendingExit(SESSION, h.agentDir)).toBeNull();
	});
});

// ── The `/mode` command, end to end through the seat ─────────────────────────

function seatHost(agentDir: string) {
	const commands = new Map<
		string,
		{ handler(args: string, ctx: unknown): Promise<void> }
	>();
	const steers: [string, string | undefined][] = [];
	let active = ["read"];
	const pi: SeatHost = {
		registerTool: () => {},
		registerCommand: (name, spec) =>
			commands.set(
				name,
				spec as { handler(args: string, ctx: unknown): Promise<void> },
			),
		sendUserMessage: (content, options) =>
			steers.push([content, options?.deliverAs]),
		getActiveTools: () => [...active],
		setActiveTools: (names) => {
			active = [...names];
		},
	};
	const entry = startSeat(pi, { agentDir, cwd: agentDir });
	entry.seat();
	// This fake's live tool set is readable from the start; Pi's is not until
	// the runtime is bound, which the extension signals from `session_start`.
	entry.runtimeBound();
	const session = {
		hasUI: true,
		sessionManager: { getSessionId: () => SESSION },
	};
	return {
		entry,
		steers,
		active: () => [...active],
		mode: (args: string, ui: ExitFlowUi) =>
			commands.get("mode")?.handler(args, { ui, ...session }),
		/** The same command in a session with no dialogs, which is the other host. */
		headlessMode: (args: string, ui: ExitFlowUi) =>
			commands.get("mode")?.handler(args, {
				ui,
				hasUI: false,
				sessionManager: session.sessionManager,
			}),
		toolResult: (event: unknown, ui: ExitFlowUi) =>
			entry.onToolResult(
				event as Parameters<typeof entry.onToolResult>[0],
				{ ui, ...session } as Parameters<typeof entry.onToolResult>[1],
			),
	};
}

describe("/mode auto, from plan mode", () => {
	it("runs phase 1, holds the posture, and opens `plan_intent` and not `plan`", async () => {
		const agentDir = temp("maestro-agent-");
		const host = seatHost(agentDir);
		const fake = fakeUi({ answers: COMPILE_ANSWERS });

		expect(host.active()).not.toContain("plan");
		await host.mode("auto", fake.ui);

		// The mode does NOT move: it moves when the run starts.
		expect(host.entry.currentMode()).toBe("plan");
		expect(host.entry.exitWindow()).toBe("intent");
		expect(host.active()).toContain(PLAN_INTENT_TOOL);
		expect(host.active()).not.toContain("plan");
		expect(host.steers).toEqual([[renderIntentSteer(), "followUp"]]);
		expect(readPendingExit(SESSION, agentDir)?.intent).toBeUndefined();
	});

	it("opens the `plan` window only once the description is agreed", async () => {
		const agentDir = temp("maestro-agent-");
		const host = seatHost(agentDir);
		await host.mode("auto", fakeUi({ answers: COMPILE_ANSWERS }).ui);
		expect(host.active()).not.toContain("plan");

		const agreeing = fakeUi({
			answers: { [intentDialogTitle(SUMMARY)]: AGREE },
		});
		await host.toolResult(
			{
				toolName: PLAN_INTENT_TOOL,
				isError: false,
				details: { submitted: true, summary: SUMMARY },
			},
			agreeing.ui,
		);
		await host.entry.exitSettled();

		expect(host.entry.exitWindow()).toBe("plan");
		expect(host.active()).toContain("plan");
		// Still plan mode, and the model has the plan steer.
		expect(host.entry.currentMode()).toBe("plan");
		expect(host.steers.at(-1)?.[0]).toContain("Call `plan` once");
		expect(readPendingExit(SESSION, agentDir)?.intent).toBe(SUMMARY);
	});

	it("returns from the tool_result hook before any dialog is answered", async () => {
		const agentDir = temp("maestro-agent-");
		const host = seatHost(agentDir);
		await host.mode("auto", fakeUi({ answers: COMPILE_ANSWERS }).ui);

		let answered = false;
		let opened = false;
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ui: ExitFlowUi = {
			select: async () => {
				opened = true;
				await held;
				answered = true;
				return AGREE;
			},
			input: async () => undefined,
			confirm: async () => false,
			editor: async () => undefined,
			notify: () => {},
		};

		await host.toolResult(
			{
				toolName: PLAN_INTENT_TOOL,
				isError: false,
				details: { submitted: true, summary: SUMMARY },
			},
			ui,
		);

		// The hook has returned. The dialog is open and unanswered, which is the
		// whole point: the model's tool call is not shown running for minutes.
		expect(opened).toBe(true);
		expect(answered).toBe(false);
		release?.();
		await host.entry.exitSettled();
		expect(answered).toBe(true);
		expect(host.entry.exitWindow()).toBe("plan");
	});

	it("leaves the posture where it was when the human keeps planning", async () => {
		const agentDir = temp("maestro-agent-");
		const host = seatHost(agentDir);
		const fake = fakeUi({
			answers: { [EXIT_START_TITLE]: EXIT_KEEP_PLANNING },
		});

		await host.mode("auto", fake.ui);

		expect(host.entry.currentMode()).toBe("plan");
		expect(host.entry.exitWindow()).toBe("none");
		expect(host.active()).not.toContain("plan");
		expect(host.active()).not.toContain(PLAN_INTENT_TOOL);
		expect(host.steers).toEqual([]);
		// The mode report is not printed either: nothing changed to report.
		expect(fake.notices).toEqual([]);
	});

	it("does not ask on the way back into plan mode, or between auto and hack", async () => {
		const agentDir = temp("maestro-agent-");
		const host = seatHost(agentDir);
		const fake = fakeUi({ answers: { [EXIT_START_TITLE]: EXIT_SWITCH_ONLY } });

		await host.mode("auto", fake.ui);
		expect(fake.titles()).toEqual([EXIT_START_TITLE]);

		const quiet = fakeUi();
		await host.mode("hack", quiet.ui);
		await host.mode("plan", quiet.ui);
		expect(quiet.dialogs()).toEqual([]);
		expect(host.entry.currentMode()).toBe("plan");
	});

	it("switches without dialogs when the session has no UI to ask with", async () => {
		const agentDir = temp("maestro-agent-");
		const host = seatHost(agentDir);
		const fake = fakeUi();

		// A headless session cannot be asked two questions, so it gets the switch
		// it asked for rather than two defaults nobody chose.
		await host.headlessMode("auto", fake.ui);

		expect(host.entry.currentMode()).toBe("auto");
		expect(fake.dialogs()).toEqual([]);
		expect(host.entry.exitWindow()).toBe("none");
		expect(host.steers).toEqual([]);
	});

	it("aborts an open flow when the session is replaced", async () => {
		const agentDir = temp("maestro-agent-");
		const host = seatHost(agentDir);
		const fake = fakeUi({
			answers: COMPILE_ANSWERS,
			after: (_opened, index) => {
				if (index === 0) host.entry.abortExitFlow();
			},
		});

		await host.mode("auto", fake.ui);

		expect(host.entry.currentMode()).toBe("plan");
		expect(host.entry.exitWindow()).toBe("none");
		expect(host.steers).toEqual([]);
	});
});

describe("the phase-2 seam", () => {
	it("is declared and reachable from a record with an agreed description", async () => {
		expect(
			await continueModeExit({
				record: {
					schemaVersion: PENDING_EXIT_SCHEMA_VERSION,
					sessionId: SESSION,
					policy: {},
					wanted: "auto",
					intent: SUMMARY,
					createdAt: "2026-09-16T12:00:00.000Z",
				},
				slug: "compose-catalogue",
				ui: fakeUi().ui,
			}),
		).toBeUndefined();
	});
});
