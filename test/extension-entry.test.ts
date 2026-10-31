import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createEventBus,
	type EventBus,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolveSessionModel } from "@vegardx/pi-subagent/session-model-provider";
import { afterEach, describe, expect, it } from "vitest";
import maestroExtension, {
	type SeatHost,
	seatToolBlockReason,
	startSeat,
} from "../packages/maestro/src/extension.js";
import type { ModeName } from "../packages/maestro/src/mode.js";
import type { Plan } from "../packages/maestro/src/plan.js";
import { planDigest } from "../packages/maestro/src/plan-input.js";
import {
	WORKFLOW_SERVICE_REQUEST_CHANNEL,
	WORKFLOW_SERVICE_REQUEST_SCHEMA,
	type WorkflowEventBus,
} from "../packages/maestro/src/workflow-provider.js";

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

function host() {
	const tools: { name: string }[] = [];
	const commands = new Map<
		string,
		{ handler(args: string, ctx: unknown): Promise<void> }
	>();
	const notices: [string, string][] = [];
	const pi: SeatHost = {
		registerTool: (tool) => tools.push(tool as { name: string }),
		registerCommand: (name, spec) =>
			commands.set(
				name,
				spec as { handler(args: string, ctx: unknown): Promise<void> },
			),
	};
	return {
		pi,
		tools,
		notices,
		names: () => [...commands.keys()].sort(),
		run: (name: string, args = "") => {
			const command = commands.get(name);
			if (!command) throw new Error(`no /${name} registered`);
			// No dialogs: `/mode` on a session that cannot be asked two questions
			// is the plain switch it always was, which is what this suite is
			// about. The exit itself is driven in test/exit-flow.test.ts.
			return command.handler(args, {
				model: { provider: "test", id: "model" },
				hasUI: false,
				ui: {
					confirm: async () => false,
					notify: (message: string, level: string) =>
						notices.push([level, message]),
				},
			});
		},
	};
}

describe("interactive seat extension entry", () => {
	it("blocks direct file mutation only in plan mode", () => {
		for (const tool of ["write", "edit", "delete"]) {
			expect(seatToolBlockReason("plan", tool)).toMatch(/read-only/);
			expect(seatToolBlockReason("auto", tool)).toBeUndefined();
			expect(seatToolBlockReason("hack", tool)).toBeUndefined();
		}
		expect(seatToolBlockReason("plan", "read")).toBeUndefined();
		expect(seatToolBlockReason("plan", "bash")).toBeUndefined();
	});
	it("registers mode while building direct-seat tools lazily", async () => {
		const h = host();
		const entry = startSeat(h.pi, {
			cwd: temp("maestro-cwd-"),
			agentDir: temp("maestro-agent-"),
		});

		expect(h.names()).toEqual(["mode", "plan"]);
		expect(h.tools).toEqual([]);
		await h.run("mode");
		// `plan` is absent on purpose: the seat starts in plan mode, which is the
		// conversation and does not hold the tool. See test/seat-modes.test.ts.
		expect(h.tools.map(({ name }) => name).sort()).toEqual(["bash", "delete"]);
		expect(entry.currentMode()).toBe("plan");
	});

	it("enters auto without coupling mode changes to workflow execution", async () => {
		const h = host();
		const entry = startSeat(h.pi, {
			cwd: temp("maestro-cwd-"),
			agentDir: temp("maestro-agent-"),
		});
		await h.run("mode", "auto");
		expect(entry.currentMode()).toBe("auto");
		expect(h.notices.at(-1)?.[1]).toMatch(/can write/);
	});

	it("registers /plan without building the seat until it is used", async () => {
		const h = host();
		startSeat(h.pi, {
			cwd: temp("maestro-cwd-"),
			agentDir: temp("maestro-agent-"),
		});
		expect(h.tools).toEqual([]);
		await h.run("plan", "list");
		expect(h.notices.at(-1)?.[1]).toContain("No stored plans");
	});

	it("prints the grammar for a /plan it does not understand", async () => {
		const h = host();
		startSeat(h.pi, {
			cwd: temp("maestro-cwd-"),
			agentDir: temp("maestro-agent-"),
		});
		await h.run("plan", "run arc sideways");
		expect(h.notices.at(-1)).toEqual([
			"warning",
			expect.stringContaining("`/plan run` takes exactly one slug"),
		]);
	});

	it("wires plan-mode mutation blocking through Pi's tool_call event", async () => {
		const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
		const commands = new Map<
			string,
			{ handler(args: string, ctx: unknown): Promise<void> }
		>();
		const api = {
			events: createEventBus(),
			on(event: string, handler: (...args: unknown[]) => unknown) {
				const registered = handlers.get(event) ?? [];
				registered.push(handler);
				handlers.set(event, registered);
			},
			registerTool() {},
			registerCommand(name: string, spec: unknown) {
				commands.set(
					name,
					spec as { handler(args: string, ctx: unknown): Promise<void> },
				);
			},
		} as unknown as ExtensionAPI;
		await maestroExtension(api);
		const toolCall = handlers.get("tool_call")?.[0];
		if (!toolCall) throw new Error("tool_call handler was not registered");

		for (const toolName of ["write", "edit", "delete"])
			expect(toolCall({ toolName }, {})).toMatchObject({ block: true });
		expect(toolCall({ toolName: "read" }, {})).toBeUndefined();

		await commands.get("mode")?.handler("auto", {
			ui: { notify() {} },
		});
		expect(toolCall({ toolName: "write" }, {})).toBeUndefined();
	});
});

// ── The session's model, before the first turn ──────────────────────────────
//
// pi-subagent resolves `model: "inherit"` through the provider this extension
// registers. A run started from an extension at session start arrives before
// any turn, so the provider must answer from the `session_start` context until
// a turn context replaces it — and a new session must replace both.

describe("the session-model provider the extension registers", () => {
	function bus(): EventBus {
		const handlers = new Map<string, Set<(data: unknown) => void>>();
		return {
			emit(channel: string, data: unknown) {
				for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
			},
			on(channel: string, handler: (data: unknown) => void) {
				const set = handlers.get(channel) ?? new Set();
				handlers.set(channel, set);
				set.add(handler);
				return () => set.delete(handler);
			},
		} as unknown as EventBus;
	}

	function session(provider: string, id: string, thinkingLevel: string) {
		return {
			cwd: temp("maestro-model-cwd-"),
			model: { provider, id },
			thinkingLevel,
			isProjectTrusted: () => true,
			hasUI: false,
			ui: { notify() {} },
			sessionManager: { getSessionId: () => `${provider}-${id}` },
		};
	}

	async function loaded() {
		const events = bus();
		const handlers = new Map<
			string,
			Array<(event: unknown, ctx: unknown) => unknown>
		>();
		const api = {
			events,
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				const registered = handlers.get(event) ?? [];
				registered.push(handler);
				handlers.set(event, registered);
			},
			registerTool() {},
			registerCommand() {},
		} as unknown as ExtensionAPI;
		await maestroExtension(api);
		const fire = async (event: string, ctx: unknown) => {
			for (const handler of handlers.get(event) ?? [])
				await handler({ type: event }, ctx);
		};
		return { events, fire };
	}

	it("answers from the session_start context before any turn", async () => {
		const { events, fire } = await loaded();
		expect(resolveSessionModel(events)).toBeUndefined();
		await fire("session_start", session("anthropic", "opus-5", "high"));
		expect(resolveSessionModel(events)).toEqual({
			provider: "anthropic",
			id: "opus-5",
			thinking: "high",
		});
	});

	it("prefers the turn context once a turn has started", async () => {
		const { events, fire } = await loaded();
		await fire("session_start", session("anthropic", "opus-5", "high"));
		await fire("turn_start", session("openai", "sol", "low"));
		expect(resolveSessionModel(events)).toEqual({
			provider: "openai",
			id: "sol",
			thinking: "low",
		});
	});

	it("answers for the new session after another session_start", async () => {
		const { events, fire } = await loaded();
		await fire("session_start", session("anthropic", "opus-5", "high"));
		await fire("turn_start", session("openai", "sol", "low"));
		await fire("session_start", session("google", "gem", "medium"));
		expect(resolveSessionModel(events)).toEqual({
			provider: "google",
			id: "gem",
			thinking: "medium",
		});
	});
});

// ── One gate, two dialog owners ──────────────────────────────────────────────
//
// Pi's dialogs have no queue: opening one over another replaces it and the
// replaced promise never resolves. The exit flow has always deferred behind the
// seat's `DialogGate`; publication did not, which made the seat two owners of
// one screen with only one of them hearing `ui_prompt_start`. The seat now
// builds ONE gate and hands it to both, and this is the half that could not be
// proven anywhere else: the gate `notePromptStart` drives is the gate a
// publication dialog waits on.

const CONTRACT = JSON.parse(
	readFileSync(
		join(
			dirname(fileURLToPath(import.meta.url)),
			"fixtures",
			"pi-workflow-runtime-contract.json",
		),
		"utf8",
	),
) as unknown;

function shipPlanDocument(repo: string): Plan {
	return {
		slug: "demo",
		title: "Demo plan",
		repos: [{ key: "main", path: repo }],
		policy: { publish: { mode: "branch", base: "main" } },
		deliverables: [
			{ id: "first", title: "First", after: [], reads: [], tasks: [] },
		],
	};
}

/** A bus with pi-workflow's provider on it, answering with `client`. */
function busWith(client: Record<string, unknown>): WorkflowEventBus {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const bus: WorkflowEventBus = {
		emit(channel, data) {
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
		on(channel, handler) {
			const set = handlers.get(channel) ?? new Set();
			handlers.set(channel, set);
			set.add(handler);
			return () => set.delete(handler);
		},
	};
	// One provider object, because discovery runs twice around `acquire` and
	// compares the two by identity.
	const provider = {
		contract: structuredClone(CONTRACT),
		acquire: async () => ({
			list: async () => [],
			validate: async () => ({ valid: true, workflow: {} }),
			project: async () => ({ fits: true }),
			startBuiltin: async () => ({ runId: "r" }),
			// Revision 22: `CLIENT_METHODS` requires all three, because the seat's
			// three dialogs are those calls. A stub without them is refused at
			// discovery, which is the point of requiring rather than duck-typing them.
			decide: async () => ({}),
			resume: async () => ({}),
			stop: async () => ({}),
			...client,
		}),
	};
	bus.on(WORKFLOW_SERVICE_REQUEST_CHANNEL, (data) => {
		const request = data as
			| { schema?: unknown; respond?: (provider: unknown) => void }
			| undefined;
		if (request?.schema !== WORKFLOW_SERVICE_REQUEST_SCHEMA) return;
		request.respond?.(provider);
	});
	return bus;
}

// ── The ceiling, at the one start a person types ─────────────────────────────
//
// THE SEAT NO LONGER REFUSES A RUN BY TOOL NAME. It passes the posture's ceiling
// with the start, and the runtime refuses a definition that needs more than the
// ceiling allows — naming both. This is that refusal arriving as a warning, and
// the ceiling the seat actually sent.

describe("/plan run under the mode's ceiling", () => {
	function storedPlan(repo: string): Plan {
		return {
			slug: "demo",
			title: "Demo plan",
			repos: [{ key: "main", path: repo }],
			deliverables: [
				{
					id: "first",
					title: "First",
					after: [],
					reads: [],
					tasks: [{ id: "impl", title: "Do it" }],
				},
			],
		} as unknown as Plan;
	}

	/**
	 * pi-workflow's own refusal, verbatim.
	 *
	 * Its `ceilingRefusalMessage` builds this for `workflow_run` and
	 * `startBuiltin` alike, and it names BOTH sides — what the definition needs
	 * and what the host allows — because a message that named one would leave a
	 * person guessing which to change.
	 */
	const REFUSAL =
		"plan-to-ship needs a worktree workspace; the host ceiling allows read-only.";

	function seatWithRuntime(
		mode: ModeName,
		extras: {
			readonly live?: () => ExtensionContext | undefined;
			readonly sendMessage?: SeatHost["sendMessage"];
		} = {},
	) {
		const repo = temp("maestro-repo-");
		execFileSync("git", ["init", "--quiet"], { cwd: repo, stdio: "ignore" });
		execFileSync(
			"git",
			["commit", "--allow-empty", "-m", "initial", "--no-gpg-sign"],
			{
				cwd: repo,
				stdio: "ignore",
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "t",
					GIT_AUTHOR_EMAIL: "t@example.invalid",
					GIT_COMMITTER_NAME: "t",
					GIT_COMMITTER_EMAIL: "t@example.invalid",
				},
			},
		);
		const starts: { input: unknown; effort?: string; ceiling?: unknown }[] = [];
		const bus = busWith({
			inspect: async () => ({}),
			runs: async () => ({ runs: [], total: 0 }),
			observe: () => () => {},
			startBuiltin: async (
				_ref: string,
				options: { input: unknown; effort?: string; ceiling?: unknown },
			) => {
				starts.push(options);
				const ceiling = options.ceiling as
					| { workspaceModes?: string[] }
					| undefined;
				if (!ceiling?.workspaceModes?.includes("worktree"))
					throw Object.assign(new Error(REFUSAL), {
						name: "WorkflowServiceError",
						code: "validation",
					});
				return { runId: "wfr-1" };
			},
		});
		const h = host();
		const entry = startSeat(
			{
				...h.pi,
				events: bus,
				...(extras.sendMessage ? { sendMessage: extras.sendMessage } : {}),
			},
			{
				cwd: repo,
				agentDir: temp("maestro-agent-"),
				sessionId: () => "session-1",
				...(extras.live ? { live: extras.live } : {}),
			},
		);
		entry.seat().store.savePlan(storedPlan(repo));
		entry.seat().setMode(mode);
		return { entry, h, starts, repo };
	}

	// The runtime is never even asked from plan mode now, and the reason has
	// moved: `/plan run` decides how the run ENDS, and plan mode decides no
	// ending — so the seat refuses by name before it starts anything, rather than
	// sending a start the ceiling makes the runtime refuse a moment later. The
	// ceiling is still what bounds a launch; it is no longer the only thing that
	// would have stopped this one.
	it("refuses from plan mode by naming the modes that decide an ending", async () => {
		const s = seatWithRuntime("plan");
		await s.h.run("plan", "run demo");
		expect(s.starts).toEqual([]);
		const said = s.h.notices.map(([, message]) => message).join("\n");
		expect(said).toContain("mode plan decides none");
		expect(said).toContain("start it from ask or auto");
		// Nothing about a tool name, because nothing refused a tool.
		expect(said).not.toContain("workflow_run");
	});

	it("refuses from hack for the same reason", async () => {
		const s = seatWithRuntime("hack");
		await s.h.run("plan", "run demo");
		expect(s.starts).toEqual([]);
		expect(s.h.notices.map(([, message]) => message).join("\n")).toContain(
			"mode hack decides none",
		);
	});

	it("starts in ask with the ship gate, under a worktree ceiling", async () => {
		const s = seatWithRuntime("ask");
		await s.h.run("plan", "run demo");
		expect(s.starts.map((start) => start.ceiling)).toEqual([
			{ workspaceModes: ["read-only", "worktree"] },
		]);
		// The gates are WRITTEN onto the stored plan, because `planDigest` covers
		// the document and publication checks that digest against the stored bytes.
		expect(s.entry.seat().store.loadPlan("demo")?.policy?.gates).toBe("ship");
		const sent = s.starts[0]?.input as
			| { plan?: { policy?: { gates?: string } } }
			| undefined;
		expect(sent?.plan?.policy?.gates).toBe("ship");
		const said = s.h.notices.map(([, message]) => message).join("\n");
		expect(said).toContain("Started `demo`");
		expect(said).toContain("from mode ask");
		expect(said).toContain("stops at its `ship` decision");
	});

	it("starts in auto with no ship gate at all", async () => {
		const s = seatWithRuntime("auto");
		await s.h.run("plan", "run demo");
		expect(s.starts.map((start) => start.ceiling)).toEqual([
			{ workspaceModes: ["read-only", "worktree"] },
		]);
		expect(s.entry.seat().store.loadPlan("demo")?.policy?.gates).toBe("none");
		const said = s.h.notices.map(([, message]) => message).join("\n");
		expect(said).toContain("from mode auto");
		expect(said).toContain("published when it is done");
	});

	// The ship watcher exists for a decision made outside this session's prompt,
	// and it proves `{"ship": true}` from the run's own `ship` checkpoint. A run
	// started from auto declares NO such checkpoint, so asking it to prove one
	// would report "declares no `ship` checkpoint" about every single auto run —
	// a warning naming `/plan ship` at the exact moment the seat is publishing the
	// run itself. So the seat says which runs are its own to publish.
	it("claims an auto run as one it publishes itself, and a ship-gated one not", async () => {
		const ask = seatWithRuntime("ask");
		await ask.h.run("plan", "run demo");
		expect(ask.entry.publishesItself("wfr-1")).toBe(false);

		const auto = seatWithRuntime("auto");
		await auto.h.run("plan", "run demo");
		expect(auto.entry.publishesItself("wfr-1")).toBe(true);
		// And a run this seat never started is not its to claim either way.
		expect(auto.entry.publishesItself("somebody-elses-run")).toBe(false);
	});

	// The dial went with schema 8: nothing beside the input's plan travels, so
	// there is no second opinion about how hard a role thinks.
	it("sends no effort to the runtime", async () => {
		const s = seatWithRuntime("auto");
		await s.h.run("plan", "run demo");
		expect(s.starts.map((start) => start.effort)).toEqual([undefined]);
		expect(Object.keys(s.starts[0]?.input as object).sort()).toEqual([
			"plan",
			"planDigest",
		]);
	});

	// pi-workflow 4 and 5 fail a run whose required task failed with "A required
	// workflow task did not complete: <stage>. <cause>", and the task's
	// `narration.cause` is that same closed-vocabulary sentence. The run's reason
	// itself is on no view the seat reads — the run summary carries `status` only
	// — so what reaches a person is the task's stage and cause, which together
	// are the whole of that reason.
	describe("a run that failed at a required task", () => {
		const CAUSE =
			"The delegated run failed: timeout (origin service, retry manual).";

		it("says the task and its cause in the narration and the failure dialog", async () => {
			const titles: string[] = [];
			const posted: [string, string | undefined][] = [];
			const ctx = {
				hasUI: true,
				ui: {
					select: (title: string) => {
						titles.push(title);
						return new Promise<undefined>(() => {});
					},
					input: async () => undefined,
					confirm: async () => false,
					notify() {},
				},
			} as unknown as ExtensionContext;
			const s = seatWithRuntime("ask", {
				live: () => ctx,
				sendMessage: (message, options) =>
					posted.push([message.content, options?.deliverAs]),
			});
			await s.h.run("plan", "run demo");

			// The two appends pi-workflow's own timed-out-verifier test journals, in
			// its order: the task fails by name, then the run fails on it.
			const narration = {
				stage: "check-d0",
				taskKind: "check",
				deliverable: "d0",
				cause: CAUSE,
			} as const;
			let listener: ((observation: unknown) => void) | undefined;
			const unnarrate = s.entry.narrateRuns({
				observe: (handler: (observation: unknown) => void) => {
					listener = handler;
					return () => {};
				},
				inspect: async () => ({
					run: { runId: "wfr-1", status: "failed" },
					tasks: [{ id: "t-verify", status: "failed", narration }],
				}),
				resume: async () => ({}),
				stop: async () => ({}),
			} as never);
			listener?.({
				runId: "wfr-1",
				status: "running",
				sequence: 41,
				task: {
					taskId: "t-verify",
					status: "failed",
					outcome: "failed",
					narration,
				},
			});
			listener?.({ runId: "wfr-1", status: "failed", sequence: 42 });
			for (let turn = 0; turn < 10 && titles.length === 0; turn += 1)
				await new Promise((resolve) => setTimeout(resolve, 0));
			unnarrate();

			expect(posted).toEqual([
				[
					[
						`demo · d0 · check check-d0 — no summary`,
						`  cause: ${CAUSE}`,
						"demo · run `wfr-1` ended `failed` without stopping at a gate. Tell the person where the work stands and what, if anything, is left to do by hand.",
						"",
						"Tell the person what failed and what it means for the rest of the plan. A dialog is open about it: retry that task, stop the run, or go back to planning.",
					].join("\n"),
					"followUp",
				],
			]);
			expect(titles).toEqual([
				[
					"`demo` — check-d0 of `d0` failed. What now?",
					"",
					CAUSE,
					"",
					"Run `wfr-1`. Retrying re-runs that one task; stopping cancels the run and leaves every handoff it already made; re-planning takes you back to plan mode with where this got to, so the conversation plans from here.",
				].join("\n"),
			]);
		});
	});

	// pi-workflow 5's review loop: the seat speaks at `normalize-<d>` and
	// `resume-<d>`, from what the run's own inspection proves about the review
	// tasks, and never from the words the normalize model or the resumed
	// implementer returned.
	describe("narration of the review loop, through the seat", () => {
		it("speaks at normalize and at resume, with a turn each, from the journal", async () => {
			const posted: [string, string | undefined, boolean | undefined][] = [];
			const s = seatWithRuntime("ask", {
				sendMessage: (message, options) =>
					posted.push([
						message.content,
						options?.deliverAs,
						options?.triggerTurn,
					]),
			});
			await s.h.run("plan", "run demo");
			const tasks = [
				{
					id: "t-r1",
					status: "completed",
					narration: {
						stage: "review-d0/correctness",
						taskKind: "review",
						deliverable: "d0",
					},
				},
				{
					id: "t-r2",
					status: "failed",
					narration: {
						stage: "review-d0/security",
						taskKind: "review",
						deliverable: "d0",
					},
				},
				{
					id: "t-n",
					status: "completed",
					narration: {
						stage: "normalize-d0",
						taskKind: "normalize",
						deliverable: "d0",
						summary: '{merges: [["c1", "c2"]]}',
					},
				},
				{
					id: "t-s",
					status: "completed",
					narration: {
						stage: "resume-d0",
						taskKind: "resume",
						deliverable: "d0",
						summary: "I answered everything",
					},
				},
			];
			let listener: ((observation: unknown) => void) | undefined;
			const unnarrate = s.entry.narrateRuns({
				observe: (handler: (observation: unknown) => void) => {
					listener = handler;
					return () => {};
				},
				inspect: async () => ({ run: { runId: "wfr-1" }, tasks }),
			} as never);
			const settle = (index: number, sequence: number) => {
				const task = tasks[index] as (typeof tasks)[number];
				listener?.({
					runId: "wfr-1",
					status: "running",
					sequence,
					task: {
						taskId: task.id,
						status: "completed",
						narration: {
							stage: task.narration.stage,
							taskKind: task.narration.taskKind,
							deliverable: task.narration.deliverable,
						},
					},
				});
			};
			settle(2, 10);
			for (let turn = 0; turn < 10 && posted.length === 0; turn += 1)
				await new Promise((resolve) => setTimeout(resolve, 0));
			settle(3, 11);
			for (let turn = 0; turn < 10 && posted.length < 2; turn += 1)
				await new Promise((resolve) => setTimeout(resolve, 0));
			unnarrate();

			expect(posted.map(([, deliverAs, turn]) => [deliverAs, turn])).toEqual([
				["followUp", true],
				["followUp", true],
			]);
			expect(posted[0]?.[0]).toContain(
				"demo · d0 · normalize normalize-d0 — 1 of 2 reviewers reported; security did not, and is counted in no agreement.",
			);
			expect(posted[1]?.[0]).toContain(
				"demo · d0 · resume resume-d0 — The implementer was resumed in its own session with the check report and the findings of 1 reviewer",
			);
			for (const [content] of posted) {
				expect(content).not.toContain("merges");
				expect(content).not.toContain("I answered everything");
				expect(content).toContain("Look first lists them");
			}
		});
	});
});

describe("publication dialogs on the seat's own gate", () => {
	it("defers a publication dialog until an outstanding foreign prompt closes", async () => {
		const repo = temp("maestro-repo-");
		const document = shipPlanDocument(repo);
		const digest = planDigest(document);
		const selected: string[] = [];
		// Two completed runs carry this digest, so publication has to ask which —
		// a dialog reached before any command is run, which is the point.
		const bus = busWith({
			inspect: async () => ({
				run: { runId: "run-1", status: "completed" },
				receipt: { planDigest: digest },
				tasks: [
					{
						key: "implement-first",
						kind: "agent",
						handoff: {
							subagentRunId: "sr-1",
							subagentAttemptId: "at-1",
							baselineHead: "a".repeat(64),
							handoffCommit: "1".repeat(64),
							sha256: "b".repeat(64),
							bytes: 1024,
						},
					},
				],
			}),
			runs: async () => ({
				runs: ["run-1", "run-2"].map((runId) => ({
					runId,
					definitionName: "plan-to-ship",
					status: "completed",
				})),
				total: 2,
			}),
			observe: () => () => {},
		});
		const h = host();
		const entry = startSeat(
			{ ...h.pi, events: bus },
			{ cwd: repo, agentDir: temp("maestro-agent-") },
		);
		entry.seat();
		const ctx = {
			hasUI: true,
			ui: {
				confirm: async () => false,
				select: async (title: string) => {
					selected.push(title);
					return undefined;
				},
				notify() {},
			},
		} as unknown as ExtensionContext;

		entry.notePromptStart();
		const publishing = entry.publish(document, ctx);
		// Two full turns of the event loop: discovery, the run listing and both
		// inspections have all settled by now, so what is holding the dialog back
		// is the gate and nothing else.
		for (let turn = 0; turn < 2; turn += 1)
			await new Promise((resolve) => setTimeout(resolve, 0));
		expect(selected).toEqual([]);

		entry.notePromptEnd();
		const published = await publishing;
		expect(selected).toEqual(["Which run of `demo` is being published?"]);
		// Escaping the deferred dialog still stops publication, with nothing run.
		expect(published.ok).toBe(false);
		expect(published.commands).toEqual([]);
	});
});
