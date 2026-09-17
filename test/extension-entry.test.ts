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
	planStoredNotice,
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
	const steers: string[] = [];
	const pi: SeatHost = {
		registerTool: (tool) => tools.push(tool as { name: string }),
		registerCommand: (name, spec) =>
			commands.set(
				name,
				spec as { handler(args: string, ctx: unknown): Promise<void> },
			),
		sendUserMessage: (content) => steers.push(content),
	};
	return {
		pi,
		tools,
		notices,
		steers,
		names: () => [...commands.keys()].sort(),
		run: (name: string, args = "") => {
			const command = commands.get(name);
			if (!command) throw new Error(`no /${name} registered`);
			return command.handler(args, {
				model: { provider: "test", id: "model" },
				hasUI: true,
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

	it("says a stored plan is runnable, and in plan mode how to leave", () => {
		const stored = {
			toolName: "plan",
			isError: false,
			details: { stored: true, slug: "arc" },
		};
		expect(planStoredNotice(stored, "plan")).toContain(
			"/plan run arc [cheap|standard|deep]",
		);
		expect(planStoredNotice(stored, "plan")).toContain("approve-plan");
		expect(planStoredNotice(stored, "plan")).toContain("/mode auto");
		// The notice states the permission, not an invitation: a run is allowed
		// from plan mode when the human asks for one, and never to check the plan.
		expect(planStoredNotice(stored, "plan")).toContain(
			"allowed from plan mode when you ask",
		);
		expect(planStoredNotice(stored, "plan")).toContain(
			"permission, not an invitation",
		);
		// A posture that can already write does not need the exit offered.
		expect(planStoredNotice(stored, "auto")).not.toContain("/mode auto");

		// Nothing to celebrate when nothing was stored.
		expect(
			planStoredNotice(
				{ toolName: "plan", isError: false, details: { stored: false } },
				"plan",
			),
		).toBeUndefined();
		expect(
			planStoredNotice({ ...stored, isError: true }, "plan"),
		).toBeUndefined();
		expect(
			planStoredNotice({ ...stored, toolName: "bash" }, "plan"),
		).toBeUndefined();
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

		// The other half of the plan-mode contract: a stored plan is the posture's
		// only completion point, so the human is told it is runnable.
		const toolResult = handlers.get("tool_result")?.[0];
		if (!toolResult) throw new Error("tool_result handler was not registered");
		const said: string[] = [];
		toolResult(
			{
				toolName: "plan",
				isError: false,
				details: { stored: true, slug: "arc" },
			},
			{ ui: { notify: (message: string) => said.push(message) } },
		);
		expect(said.at(-1)).toContain("/plan run arc");
		expect(said.at(-1)).toContain("/mode auto");

		await commands.get("mode")?.handler("auto", {
			ui: { notify() {} },
		});
		expect(toolCall({ toolName: "write" }, {})).toBeUndefined();

		said.length = 0;
		toolResult(
			{
				toolName: "plan",
				isError: false,
				details: { stored: true, slug: "arc" },
			},
			{ ui: { notify: (message: string) => said.push(message) } },
		);
		expect(said.at(-1)).not.toContain("/mode auto");
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
			runBuiltin: async () => ({ runId: "r", status: "running" }),
			awaitRun: async () => ({ runId: "r", status: "completed" }),
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
