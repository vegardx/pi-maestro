import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import maestroExtension, {
	planStoredNotice,
	type SeatHost,
	seatToolBlockReason,
	startSeat,
} from "../packages/maestro/src/extension.js";

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
		expect(h.tools.map(({ name }) => name).sort()).toEqual([
			"bash",
			"delete",
			"plan",
		]);
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
