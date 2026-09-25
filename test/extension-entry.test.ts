import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import maestroExtension, {
	type SeatHost,
	seatToolBlockReason,
	startSeat,
} from "../packages/maestro/src/extension.js";
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
			expect.stringContaining("unknown effort `sideways`"),
		]);
	});

	it("wires plan-mode mutation blocking through Pi's tool_call event", async () => {
		const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
		const commands = new Map<
			string,
			{ handler(args: string, ctx: unknown): Promise<void> }
		>();
		const api = {
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

	function seatWithRuntime(mode: "plan" | "auto") {
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
			{ ...h.pi, events: bus },
			{
				cwd: repo,
				agentDir: temp("maestro-agent-"),
				sessionId: () => "session-1",
			},
		);
		entry.seat().store.savePlan(storedPlan(repo));
		entry.seat().setMode(mode);
		return { entry, h, starts, repo };
	}

	it("is refused in plan mode by the runtime's sentence, not by the seat", async () => {
		const s = seatWithRuntime("plan");
		await s.h.run("plan", "run demo");
		// The seat sent the posture it is in, in pi-subagent's vocabulary.
		expect(s.starts.map((start) => start.ceiling)).toEqual([
			{ workspaceModes: ["read-only"] },
		]);
		// And the refusal a person reads is the runtime's own, naming the need and
		// the bound, through the provider seam's sanitized warning.
		const said = s.h.notices.map(([, message]) => message).join("\n");
		expect(said).toContain("Workflow runtime unavailable (validation)");
		expect(said).toContain("needs a worktree workspace");
		expect(said).toContain("the host ceiling allows read-only");
		expect(said).toContain("/plan run");
		// Nothing about a tool name, because nothing refused a tool.
		expect(said).not.toContain("workflow_run");
	});

	it("starts in auto, where the ceiling allows a worktree", async () => {
		const s = seatWithRuntime("auto");
		await s.h.run("plan", "run demo");
		expect(s.starts.map((start) => start.ceiling)).toEqual([
			{ workspaceModes: ["read-only", "worktree"] },
		]);
		const said = s.h.notices.map(([, message]) => message).join("\n");
		expect(said).toContain("Started `demo`");
		expect(said).toContain("`wfr-1`");
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
