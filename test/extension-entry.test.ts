import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type HumanAsker,
	type SeatHost,
	startSeat,
} from "../packages/maestro/src/extension.js";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0)
		rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function temp(name: string): string {
	const path = mkdtempSync(join(tmpdir(), name));
	dirs.push(path);
	return path;
}

function plan(slug: string, repository: string) {
	return {
		slug,
		title: "Workflow command plan",
		preflight: [],
		postflight: [],
		repos: [{ key: "app", path: repository }],
		deliverables: [
			{
				id: "app",
				title: "Update app",
				body: "Preserve the public contract.",
				after: [],
				reads: [],
				repo: "app",
				tasks: [{ id: "implement", title: "Implement the change" }],
			},
		],
	};
}

function host(model = { provider: "test", id: "implementer" }) {
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
		sendUserMessage: () => undefined,
	};
	return {
		pi,
		tools,
		notices,
		names: () => [...commands.keys()].sort(),
		run: (name: string, args = "") => {
			const command = commands.get(name);
			if (!command) throw new Error(`no /${name} registered`);
			return command.handler(args, {
				model,
				ui: {
					notify: (message: string, level: string) =>
						notices.push([level, message]),
				},
			});
		},
	};
}

describe("workflow-only extension entry", () => {
	it("registers only mode and run, and builds the small seat lazily", async () => {
		const h = host();
		const entry = startSeat(h.pi, {
			cwd: temp("maestro-cwd-"),
			agentDir: temp("maestro-agent-"),
		});

		expect(h.names()).toEqual(["mode", "run"]);
		expect(h.tools).toEqual([]);
		await h.run("mode");
		expect(h.tools.map(({ name }) => name).sort()).toEqual([
			"bash",
			"commit",
			"delete",
			"plan",
		]);
		expect(entry.currentMode()).toBe("plan");
	});

	it("keeps plan mode and does not launch when approval is refused", async () => {
		const cwd = temp("maestro-cwd-");
		const agentDir = temp("maestro-agent-");
		const h = host();
		const ask = vi.fn(async () => [
			{
				questionId: "workflow-plan-approval",
				value: "no",
				source: "human" as const,
			},
		]);
		const run = vi.fn(async (input: { asker: HumanAsker }) => {
			await input.asker.ask([]);
			return { status: "refused" as const, reason: "not-approved" as const };
		});
		const entry = startSeat(h.pi, {
			cwd,
			agentDir,
			asker: { ask },
			loadWorkflowPlanRunner: async () => ({ run }) as never,
		});
		entry.seat().store.savePlan(plan("refused", cwd));

		await h.run("mode", "auto");

		expect(ask).toHaveBeenCalledOnce();
		expect(entry.currentMode()).toBe("plan");
		expect(h.notices.at(-1)?.[1]).toMatch(/not approved/);
	});

	it("switches to auto only after approval and uses workflows for every run", async () => {
		const cwd = temp("maestro-cwd-");
		const h = host();
		let entry: ReturnType<typeof startSeat>;
		const observedModes: string[] = [];
		const run = vi.fn(
			async (input: { runId: string; onApproved?: () => void }) => {
				observedModes.push(entry.currentMode());
				input.onApproved?.();
				observedModes.push(entry.currentMode());
				return {
					status: "launched" as const,
					approval: "new" as const,
					record: {},
					launchResult: { runId: input.runId },
				};
			},
		);
		entry = startSeat(h.pi, {
			cwd,
			agentDir: temp("maestro-agent-"),
			asker: { ask: async () => [] },
			loadWorkflowPlanRunner: async () => ({ run }) as never,
		});
		entry.seat().store.savePlan(plan("approved", cwd));

		await h.run("mode", "auto");
		await h.run("run", "approved");

		expect(observedModes).toEqual(["plan", "auto", "auto", "auto"]);
		expect(run).toHaveBeenCalledTimes(2);
		expect(entry.currentMode()).toBe("auto");
	});

	it("refuses /run outside auto and reports valid modes", async () => {
		const h = host();
		const entry = startSeat(h.pi, {
			cwd: temp("maestro-cwd-"),
			agentDir: temp("maestro-agent-"),
		});
		entry.seat().store.savePlan(plan("waiting", "."));

		await h.run("run", "waiting");
		await h.run("mode", "yolo");

		expect(h.notices[0]?.[1]).toMatch(/only in auto mode/);
		expect(h.notices[1]?.[1]).toContain("plan, auto, hack");
	});
});
