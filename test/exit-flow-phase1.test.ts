// Phase 1 of the plan-mode exit, driven through a fake UI.
//
// The flow is six dialogs and one commit, and everything that can go wrong with
// it is a question about *what was left behind*: a mode that moved when the
// human said keep planning, a record written by a flow nobody finished, a
// record that outlived the session it names. So every case below asserts the
// same three facts after the fact — the posture, the record on disk, and what
// the model was told — rather than only the value the flow returned.
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
	BASE_BRANCH_TITLE,
	chosenOption,
	continueModeExit,
	EFFORT_OPTIONS,
	EFFORT_TITLE,
	EXIT_COMPILE,
	EXIT_KEEP_PLANNING,
	EXIT_START_OPTIONS,
	EXIT_START_TITLE,
	EXIT_SWITCH_ONLY,
	type ExitFlowUi,
	FALLBACK_BASE_BRANCH,
	GATE_OPTIONS,
	GATE_TITLE,
	INTENT_TITLE,
	lastUserLine,
	optionLabel,
	optionLabels,
	PUBLICATION_OPTIONS,
	PUBLICATION_TITLE,
	renderExitSteer,
	runExitFlowPhase1,
	type SessionEntryLike,
} from "../packages/maestro/src/exit-flow.js";
import { type SeatHost, startSeat } from "../packages/maestro/src/extension.js";
import type { ModeName } from "../packages/maestro/src/mode.js";
import { pendingExitFile } from "../packages/maestro/src/paths.js";
import {
	deletePendingExit,
	MAX_INTENT_LENGTH,
	PENDING_EXIT_SCHEMA_VERSION,
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
		editor: async () => {
			throw new Error("phase 1 opens no editor");
		},
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

function deps(
	h: Harness,
	ui: ExitFlowUi,
	extra: Partial<Parameters<typeof runExitFlowPhase1>[0]> = {},
) {
	return {
		ui,
		sessionId: SESSION,
		wanted: "auto" as ModeName,
		setMode: (name: ModeName) => {
			h.modes.push(name);
		},
		sendUserMessage: (content: string, options?: { deliverAs?: string }) => {
			h.steers.push([content, options?.deliverAs]);
		},
		entries: () => CONVERSATION,
		upstreamHead: () => "trunk",
		agentDir: h.agentDir,
		now: () => "2026-09-16T12:00:00.000Z",
		...extra,
	};
}

const CONVERSATION: readonly SessionEntryLike[] = [
	{ type: "message", message: { role: "user", content: "hello" } },
	{ type: "message", message: { role: "assistant", content: "hi" } },
	{
		type: "message",
		message: {
			role: "user",
			content: "Extract the exit flow\nand wire it into /mode",
		},
	},
	{ type: "message", message: { role: "user", content: "/mode auto" } },
];

/** The labels a human actually sees, for the happy path. */
const COMPILE_ANSWERS = {
	[EXIT_START_TITLE]: EXIT_COMPILE,
	[EFFORT_TITLE]: optionLabel(EFFORT_OPTIONS[1]!),
	[GATE_TITLE]: optionLabel(GATE_OPTIONS[1]!),
	[PUBLICATION_TITLE]: optionLabel(PUBLICATION_OPTIONS[2]!),
} as const;

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
		expect(fake.opened[0]?.options).toEqual([...EXIT_START_OPTIONS]);
	});

	it("treats escape as keeping planning, which is the documented hatch", async () => {
		const h = harness();
		const fake = fakeUi();

		const outcome = await runExitFlowPhase1(deps(h, fake.ui));

		expect(outcome).toEqual({ kind: "keep-planning" });
		expect(h.modes).toEqual([]);
		expect(fake.titles()).toEqual([EXIT_START_TITLE]);
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
				intent: "an exit nobody finished",
				createdAt: "2026-09-15T00:00:00.000Z",
			},
			h.agentDir,
		);
		const fake = fakeUi({
			answers: { [EXIT_START_TITLE]: EXIT_KEEP_PLANNING },
		});

		await runExitFlowPhase1(deps(h, fake.ui));

		// Keeping planning means no exit is in progress, and a record that says
		// otherwise would hold the `plan` tool open in plan mode indefinitely.
		expect(existsSync(pendingExitFile(SESSION, h.agentDir))).toBe(false);
	});
});

describe("the happy path", () => {
	it("asks exactly six dialogs, in order, each carrying the signal", async () => {
		const h = harness();
		const fake = fakeUi({
			answers: { ...COMPILE_ANSWERS, [BASE_BRANCH_TITLE]: "release" },
		});

		const outcome = await runExitFlowPhase1(
			deps(h, fake.ui, { signal: new AbortController().signal }),
		);

		expect(fake.titles()).toEqual([
			EXIT_START_TITLE,
			EFFORT_TITLE,
			GATE_TITLE,
			PUBLICATION_TITLE,
			BASE_BRANCH_TITLE,
			INTENT_TITLE,
		]);
		expect(fake.dialogs().every((d) => d.signal)).toBe(true);
		expect(outcome.kind === "compiled" && outcome.asked).toBe(6);
	});

	it("switches the posture, writes the record, and steers the model", async () => {
		const h = harness();
		const fake = fakeUi({
			answers: {
				...COMPILE_ANSWERS,
				[BASE_BRANCH_TITLE]: "release",
				[INTENT_TITLE]: "Ship the exit flow",
			},
		});

		const outcome = await runExitFlowPhase1(deps(h, fake.ui));

		expect(outcome.kind).toBe("compiled");
		if (outcome.kind !== "compiled") return;
		expect(h.modes).toEqual(["auto"]);
		expect(outcome.record).toEqual({
			schemaVersion: 1,
			sessionId: SESSION,
			policy: {
				effort: "standard",
				gates: "approve-plan+ship",
				publish: { mode: "pr", base: "release" },
			},
			intent: "Ship the exit flow",
			createdAt: "2026-09-16T12:00:00.000Z",
		});
		// The record on disk is the one phase 2 will read, so it is read back
		// through the same door rather than trusted from memory.
		expect(readPendingExit(SESSION, h.agentDir)).toEqual(outcome.record);
		expect(outcome.path).toBe(pendingExitFile(SESSION, h.agentDir));
		expect(h.steers).toEqual([[outcome.steer, "followUp"]]);
	});

	it("skips the base branch when nothing is published", async () => {
		const h = harness();
		const fake = fakeUi({
			answers: {
				...COMPILE_ANSWERS,
				[PUBLICATION_TITLE]: optionLabel(PUBLICATION_OPTIONS[0]!),
			},
		});

		const outcome = await runExitFlowPhase1(deps(h, fake.ui));

		expect(fake.titles()).toEqual([
			EXIT_START_TITLE,
			EFFORT_TITLE,
			GATE_TITLE,
			PUBLICATION_TITLE,
			INTENT_TITLE,
		]);
		expect(outcome.kind === "compiled" && outcome.asked).toBe(5);
		expect(
			outcome.kind === "compiled" && outcome.record.policy.publish,
		).toEqual({ mode: "none" });
	});

	it("records every effort, gate and publication the dialogs offer", async () => {
		for (const effort of EFFORT_OPTIONS)
			for (const gates of GATE_OPTIONS)
				for (const publication of PUBLICATION_OPTIONS) {
					const h = harness();
					const fake = fakeUi({
						answers: {
							[EXIT_START_TITLE]: EXIT_COMPILE,
							[EFFORT_TITLE]: optionLabel(effort),
							[GATE_TITLE]: optionLabel(gates),
							[PUBLICATION_TITLE]: optionLabel(publication),
							[BASE_BRANCH_TITLE]: "main",
							[INTENT_TITLE]: "one line",
						},
					});
					const outcome = await runExitFlowPhase1(deps(h, fake.ui));
					expect(outcome.kind === "compiled" && outcome.record.policy).toEqual({
						effort: effort.value,
						gates: gates.value,
						publish:
							publication.value === "none"
								? { mode: "none" }
								: { mode: publication.value, base: "main" },
					});
				}
	});
});

describe("the defaults, which escape takes", () => {
	it("answers steps 2-6 with the documented default when they are escaped", async () => {
		const h = harness();
		const fake = fakeUi({ answers: { [EXIT_START_TITLE]: EXIT_COMPILE } });

		const outcome = await runExitFlowPhase1(deps(h, fake.ui));

		expect(outcome.kind === "compiled" && outcome.record).toMatchObject({
			policy: {
				effort: "standard",
				gates: "approve-plan+ship",
				publish: { mode: "pr", base: "trunk" },
			},
			// Step 6's default is the last thing the human said, minus the slash
			// command that opened the dialog.
			intent: "Extract the exit flow",
		});
	});

	it("marks exactly one default per table, and escape takes that one", () => {
		for (const options of [EFFORT_OPTIONS, GATE_OPTIONS, PUBLICATION_OPTIONS]) {
			const defaults = options.filter((option) => option.fallback);
			expect(defaults).toHaveLength(1);
			expect(chosenOption(options, undefined)).toBe(defaults[0]?.value);
			// An answer the table does not know is an escape too: a label that
			// cannot be resolved must not become a value nobody offered.
			expect(chosenOption(options, "something else")).toBe(defaults[0]?.value);
			for (const option of options)
				expect(chosenOption(options, optionLabel(option))).toBe(option.value);
		}
		expect(optionLabels(EFFORT_OPTIONS)).toEqual([
			"cheap",
			"standard (default)",
			"deep",
		]);
		expect(optionLabels(GATE_OPTIONS)).toEqual([
			"approve-plan only",
			"approve-plan + ship (default)",
			"every deliverable",
		]);
		expect(optionLabels(PUBLICATION_OPTIONS)).toEqual([
			"none",
			"branch",
			"pull request (default)",
		]);
	});

	it("falls back to `main` and says so when the repository tracks nothing", async () => {
		const h = harness();
		const fake = fakeUi({ answers: { [EXIT_START_TITLE]: EXIT_COMPILE } });

		const outcome = await runExitFlowPhase1(
			deps(h, fake.ui, { upstreamHead: () => null }),
		);

		expect(
			outcome.kind === "compiled" && outcome.record.policy.publish,
		).toEqual({ mode: "pr", base: FALLBACK_BASE_BRANCH });
		expect(
			fake.notices.some(
				([message, type]) =>
					type === "warning" && message.includes(FALLBACK_BASE_BRANCH),
			),
		).toBe(true);
	});

	it("says so rather than guessing when the conversation cannot be read", async () => {
		const h = harness();
		const fake = fakeUi({ answers: { [EXIT_START_TITLE]: EXIT_COMPILE } });

		const outcome = await runExitFlowPhase1(
			deps(h, fake.ui, { entries: undefined }),
		);

		expect(outcome.kind === "compiled" && outcome.record.intent).toBe("");
		expect(
			fake.notices.some(
				([message, type]) => type === "warning" && message.includes("empty"),
			),
		).toBe(true);
	});

	it("refuses a base branch Git would not accept, before anything is recorded", async () => {
		const h = harness();
		const fake = fakeUi({
			answers: { ...COMPILE_ANSWERS, [BASE_BRANCH_TITLE]: "no spaces here" },
		});

		const outcome = await runExitFlowPhase1(deps(h, fake.ui));

		expect(outcome.kind).toBe("refused");
		expect(h.modes).toEqual([]);
		expect(h.steers).toEqual([]);
		expect(existsSync(pendingExitFile(SESSION, h.agentDir))).toBe(false);
	});
});

describe("the last user line", () => {
	it("takes the first line of the last thing the human said", () => {
		expect(lastUserLine(CONVERSATION)).toBe("Extract the exit flow");
	});

	it("reads structured content and skips everything that is not a user text", () => {
		expect(
			lastUserLine([
				{ type: "message", message: { role: "user", content: "earlier" } },
				{ type: "thinking_level_change" },
				{
					type: "message",
					message: {
						role: "user",
						content: [
							{ type: "image", data: "…" },
							{ type: "text", text: "  Compose the catalogue  \nmore" },
						],
					},
				},
				{ type: "message", message: { role: "assistant", content: "later" } },
			]),
		).toBe("Compose the catalogue");
	});

	it("is empty rather than invented when there is nothing usable", () => {
		expect(lastUserLine([])).toBe("");
		expect(
			lastUserLine([
				{ type: "message", message: { role: "user", content: "/mode auto" } },
				{ type: "message", message: { role: "user", content: "   " } },
			]),
		).toBe("");
	});

	it("bounds the line at what the record will hold", () => {
		const long = "x".repeat(MAX_INTENT_LENGTH * 2);
		expect(
			lastUserLine([
				{ type: "message", message: { role: "user", content: long } },
			]),
		).toHaveLength(MAX_INTENT_LENGTH);
	});
});

describe("the steer", () => {
	it("quotes the exact policy block and asks for stages where they are implied", async () => {
		const h = harness();
		const fake = fakeUi({
			answers: {
				...COMPILE_ANSWERS,
				[BASE_BRANCH_TITLE]: "main",
				[INTENT_TITLE]: "Ship the exit flow",
			},
		});

		const outcome = await runExitFlowPhase1(deps(h, fake.ui));
		expect(outcome.kind).toBe("compiled");
		if (outcome.kind !== "compiled") return;

		// The bytes the model is told to copy are the bytes that were recorded.
		expect(outcome.steer).toContain(
			JSON.stringify(outcome.record.policy, null, 2),
		);
		expect(outcome.steer).toContain("verbatim");
		expect(outcome.steer).toContain("`stages`");
		expect(outcome.steer).toContain("Ship the exit flow");
		expect(outcome.steer).toContain("Call `plan` once");
		// Phase 1 asks for a document and nothing else: no run, no approval.
		expect(outcome.steer).toContain("do not start a run");
	});

	it("omits the intent line rather than quoting an empty one", () => {
		const steer = renderExitSteer({ effort: "cheap" }, "");
		expect(steer).not.toContain("I recorded one line");
		expect(renderExitSteer({ effort: "cheap" }, "why")).toContain(
			"I recorded one line",
		);
	});

	it("keeps the record and prints the instruction when the host cannot steer", async () => {
		const h = harness();
		const fake = fakeUi({ answers: { [EXIT_START_TITLE]: EXIT_COMPILE } });

		const outcome = await runExitFlowPhase1(
			deps(h, fake.ui, { sendUserMessage: undefined }),
		);

		expect(outcome.kind).toBe("compiled");
		expect(existsSync(pendingExitFile(SESSION, h.agentDir))).toBe(true);
		const printed = fake.notices.find(([, type]) => type === "warning");
		expect(printed?.[0]).toContain("Call `plan` once");
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
				intent: "from an earlier exit",
				createdAt: "2026-09-15T00:00:00.000Z",
			},
			h.agentDir,
		);
		const controller = new AbortController();
		const fake = fakeUi({
			answers: COMPILE_ANSWERS,
			after: (_opened, index) => {
				if (index === 2) controller.abort();
			},
		});

		const outcome = await runExitFlowPhase1(
			deps(h, fake.ui, { signal: controller.signal }),
		);

		expect(outcome).toEqual({ kind: "aborted" });
		// Three dialogs opened; the fourth was never asked over a dead session.
		expect(fake.titles()).toEqual([EXIT_START_TITLE, EFFORT_TITLE, GATE_TITLE]);
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

describe("the pending record", () => {
	it("round-trips through write, read and delete", () => {
		const h = harness();
		const record = {
			schemaVersion: PENDING_EXIT_SCHEMA_VERSION,
			sessionId: SESSION,
			policy: { effort: "deep", publish: { mode: "branch", base: "main" } },
			intent: "one line",
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

	it("refuses every malformed record loudly rather than reading it as absent", () => {
		const h = harness();
		const path = pendingExitFile(SESSION, h.agentDir);
		mkdirSync(dirname(path), { recursive: true });
		const good = {
			schemaVersion: 1,
			sessionId: SESSION,
			policy: { effort: "standard" },
			intent: "one line",
			createdAt: "2026-09-16T12:00:00.000Z",
		};
		const cases: [string, string][] = [
			["not readable JSON", "{ this is not json"],
			["not a JSON object", JSON.stringify([good])],
			["schema", JSON.stringify({ ...good, schemaVersion: 2 })],
			["names session", JSON.stringify({ ...good, sessionId: "other" })],
			["createdAt", JSON.stringify({ ...good, createdAt: "" })],
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
		expect(readPendingExit(SESSION, h.agentDir)?.intent).toBe("one line");
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
			intent: "one line",
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
	return {
		entry,
		steers,
		active: () => [...active],
		mode: (args: string, ui: ExitFlowUi) =>
			commands.get("mode")?.handler(args, {
				ui,
				hasUI: true,
				sessionManager: {
					getSessionId: () => SESSION,
					getBranch: () => CONVERSATION,
				},
			}),
		/** The same command in a session with no dialogs, which is the other host. */
		headlessMode: (args: string, ui: ExitFlowUi) =>
			commands.get("mode")?.handler(args, {
				ui,
				hasUI: false,
				sessionManager: {
					getSessionId: () => SESSION,
					getBranch: () => CONVERSATION,
				},
			}),
	};
}

describe("/mode auto, from plan mode", () => {
	it("runs phase 1, and the plan tool follows the record", async () => {
		const agentDir = temp("maestro-agent-");
		const host = seatHost(agentDir);
		const fake = fakeUi({
			answers: {
				...COMPILE_ANSWERS,
				[PUBLICATION_TITLE]: optionLabel(PUBLICATION_OPTIONS[0]!),
				[INTENT_TITLE]: "Ship the exit flow",
			},
		});

		expect(host.active()).not.toContain("plan");
		await host.mode("auto", fake.ui);

		expect(host.entry.currentMode()).toBe("auto");
		expect(host.entry.pendingExit()).toBe(true);
		expect(host.active()).toContain("plan");
		expect(host.steers).toHaveLength(1);
		expect(host.steers[0]?.[1]).toBe("followUp");
		expect(readPendingExit(SESSION, agentDir)?.intent).toBe(
			"Ship the exit flow",
		);
	});

	it("leaves the posture where it was when the human keeps planning", async () => {
		const agentDir = temp("maestro-agent-");
		const host = seatHost(agentDir);
		const fake = fakeUi({
			answers: { [EXIT_START_TITLE]: EXIT_KEEP_PLANNING },
		});

		await host.mode("auto", fake.ui);

		expect(host.entry.currentMode()).toBe("plan");
		expect(host.entry.pendingExit()).toBe(false);
		expect(host.active()).not.toContain("plan");
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

		// A headless session cannot be asked six questions, so it gets the switch
		// it asked for rather than six defaults nobody chose.
		await host.headlessMode("auto", fake.ui);

		expect(host.entry.currentMode()).toBe("auto");
		expect(fake.dialogs()).toEqual([]);
		expect(host.entry.pendingExit()).toBe(false);
		expect(host.steers).toEqual([]);
	});

	it("aborts an open flow when the session is replaced", async () => {
		const agentDir = temp("maestro-agent-");
		const host = seatHost(agentDir);
		const fake = fakeUi({
			answers: COMPILE_ANSWERS,
			after: (_opened, index) => {
				if (index === 1) host.entry.abortExitFlow();
			},
		});

		await host.mode("auto", fake.ui);

		expect(host.entry.currentMode()).toBe("plan");
		expect(host.entry.pendingExit()).toBe(false);
		expect(host.steers).toEqual([]);
	});
});

describe("the phase-2 seam", () => {
	it("is declared and empty — phase 1 ships without phase 2", async () => {
		expect(
			await continueModeExit({
				record: {
					schemaVersion: PENDING_EXIT_SCHEMA_VERSION,
					sessionId: SESSION,
					policy: {},
					intent: "",
					createdAt: "2026-09-16T12:00:00.000Z",
				},
				slug: "compose-catalogue",
				ui: fakeUi().ui,
			}),
		).toBeUndefined();
	});
});
