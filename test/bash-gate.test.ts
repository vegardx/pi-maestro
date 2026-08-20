import type {
	BashOperations,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { gateBash, refusal } from "../packages/maestro/src/bash-gate.js";
import {
	createBashTool,
	createGatedBashOperations,
} from "../packages/maestro/src/bash-tool.js";
import { DEFAULT_EXECUTION_POLICY } from "../packages/maestro/src/execution-policy.js";
import { mode } from "../packages/maestro/src/mode.js";

function operations(
	named: "plan" | "auto" | "hack",
	confirm?: () => Promise<boolean>,
) {
	const ran: string[] = [];
	const direct: BashOperations = {
		exec: async (command) => {
			ran.push(command);
			return { exitCode: 0 };
		},
	};
	return {
		ran,
		ops: createGatedBashOperations({
			cwd: "/repo",
			mode: () => mode(named),
			policy: () => DEFAULT_EXECUTION_POLICY,
			direct,
			...(confirm ? { confirm: async () => confirm() } : {}),
		}),
	};
}

describe("mode-aware shell enforcement", () => {
	it("allows recognized reads in plan", async () => {
		const state = operations("plan");
		await state.ops.exec("git status --short", "/repo", { onData() {} });
		expect(state.ran).toEqual(["git status --short"]);
	});

	it.each(["touch marker", "echo x > marker", "git commit -m x", "npm test"])(
		"refuses %s in plan before host execution",
		async (command) => {
			const state = operations("plan");
			await expect(
				state.ops.exec(command, "/repo", { onData() {} }),
			).rejects.toThrow(/refused/);
			expect(state.ran).toEqual([]);
		},
	);

	it("confirms remote writes in auto", async () => {
		let asked = 0;
		const state = operations("auto", async () => {
			asked += 1;
			return true;
		});
		await state.ops.exec("git push", "/repo", { onData() {} });
		expect(asked).toBe(1);
		expect(state.ran).toEqual(["git push"]);
	});

	it("refuses confirmation routes when nobody can ask", async () => {
		const state = operations("auto");
		await expect(
			state.ops.exec("git push", "/repo", { onData() {} }),
		).rejects.toThrow(/nobody to ask/);
	});

	it("retains a refusal reason helper", () => {
		const decision = gateBash({
			command: "touch marker",
			mode: mode("plan"),
			policy: DEFAULT_EXECUTION_POLICY,
		});
		expect(refusal(decision)).toMatch(/plan policy refuses/);
	});
});

describe("registered bash tool", () => {
	it("extends Pi's schema with bounded intent and confirmed shell bypass", () => {
		const tool = createBashTool({
			cwd: "/repo",
			mode: () => mode("auto"),
			policy: () => DEFAULT_EXECUTION_POLICY,
		});
		const properties = (
			tool.parameters as { properties: Record<string, unknown> }
		).properties;
		expect(Object.keys(properties)).toEqual([
			"command",
			"timeout",
			"intent",
			"confirmBash",
		]);
	});

	it("binds confirmation to Pi's UI without forwarding intent", async () => {
		const ran: string[] = [];
		const asked: string[] = [];
		const tool = createBashTool({
			cwd: "/repo",
			mode: () => mode("auto"),
			policy: () => ({
				...DEFAULT_EXECUTION_POLICY,
				auditor: { ...DEFAULT_EXECUTION_POLICY.auditor, enabled: false },
			}),
			direct: {
				exec: async (command) => {
					ran.push(command);
					return { exitCode: 0 };
				},
			},
		});
		const ctx = {
			cwd: "/repo",
			sessionManager: {
				getSessionId: () => "test",
				getSessionFile: () => undefined,
			},
			ui: {
				confirm: async (_title: string, message: string) => {
					asked.push(message);
					return true;
				},
			},
		} as ExtensionContext;
		await tool.execute(
			"bash-1",
			{
				command: "git push",
				intent: "Publish the feature branch",
			},
			undefined,
			undefined,
			ctx,
		);
		expect(asked).toHaveLength(1);
		expect(ran).toEqual(["git push"]);
	});
});
