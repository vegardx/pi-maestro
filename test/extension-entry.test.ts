import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
			return command.handler(args, {
				model: { provider: "test", id: "model" },
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

		expect(h.names()).toEqual(["mode"]);
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
});
