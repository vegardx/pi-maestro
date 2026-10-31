import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { readLayeredExtensionConfig } from "@vegardx/pi-settings";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	describePolicyDeviations,
	readExecutionPolicySettings,
} from "../packages/maestro/src/execution-policy.js";
import maestroExtension from "../packages/maestro/src/extension.js";
import { createSeat } from "../packages/maestro/src/seat.js";

// An untrusted repository's `.pi/settings.json` must not loosen the plan-mode
// Bash ceiling. Pi's SettingsManager reads project settings unless it is told
// the project is untrusted, so the trust decision has to reach it.

let cwd: string;
let agentDir: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "maestro-trust-cwd-"));
	agentDir = mkdtempSync(join(tmpdir(), "maestro-trust-agent-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({
			extensionConfig: {
				maestro: {
					bash: { policy: { plan: { "workspace-write": "allow" } } },
				},
			},
		}),
	);
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

describe("project settings and project trust", () => {
	it("does not read an untrusted project's settings, and names what it skipped", () => {
		const layered = readLayeredExtensionConfig(cwd, agentDir, {
			projectTrusted: false,
		});
		expect(layered.project).toEqual({});
		expect(layered.merged.maestro).toBeUndefined();
		expect(layered.skippedProject).toEqual(["maestro"]);
	});

	it("reads a trusted project's settings and skips nothing", () => {
		const layered = readLayeredExtensionConfig(cwd, agentDir, {
			projectTrusted: true,
		});
		expect(layered.merged.maestro).toBeDefined();
		expect(layered.skippedProject).toEqual([]);
	});

	it("keeps the plan ceiling for an untrusted project that loosens it", () => {
		const policy = readExecutionPolicySettings(cwd, agentDir, {
			projectTrusted: false,
		});
		expect(policy.modes.plan["workspace-write"]).toBe("refuse");
		expect(
			describePolicyDeviations(cwd, agentDir, { projectTrusted: false }),
		).toEqual([
			"project maestro settings ignored: the project is not trusted, so only global settings apply",
		]);
	});

	it("applies a trusted project's loosening", () => {
		const policy = readExecutionPolicySettings(cwd, agentDir, {
			projectTrusted: true,
		});
		expect(policy.modes.plan["workspace-write"]).toBe("allow");
		expect(
			describePolicyDeviations(cwd, agentDir, { projectTrusted: true }),
		).toEqual(["plan.workspace-write: allow (default refuse)"]);
	});
});

describe("the seat's bash tool and project trust", () => {
	function context(trusted: boolean): ExtensionToolContext {
		return {
			cwd,
			isProjectTrusted: () => trusted,
			sessionManager: {
				getSessionId: () => "test",
				getSessionFile: () => undefined,
			},
			ui: { confirm: async () => false },
		} as unknown as ExtensionToolContext;
	}

	async function touch(trusted: boolean): Promise<unknown> {
		const seat = createSeat({ cwd, agentDir });
		const bash = seat.tools
			.definitionsFor("maestro")
			.find((tool) => tool.name === "bash");
		if (!bash) throw new Error("the seat holds no bash tool");
		expect(seat.mode().name).toBe("plan");
		return bash.execute(
			"bash-1",
			{ command: "touch marker" },
			undefined,
			undefined,
			context(trusted),
		);
	}

	it("refuses a plan-mode write an untrusted project's settings would allow", async () => {
		await expect(touch(false)).rejects.toThrow(/refused/);
		expect(existsSync(join(cwd, "marker"))).toBe(false);
	});

	it("runs it when the project is trusted", async () => {
		await touch(true);
		expect(existsSync(join(cwd, "marker"))).toBe(true);
	});
});

describe("the session's notice about skipped project settings", () => {
	async function sessionStartNotices(trusted: boolean): Promise<string[]> {
		const handlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
		const api = {
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				if (event === "session_start") handlers.push(handler);
			},
			registerTool() {},
			registerCommand() {},
		} as unknown as ExtensionAPI;
		await maestroExtension(api);
		const notices: string[] = [];
		const ctx = {
			cwd,
			isProjectTrusted: () => trusted,
			ui: { notify: (message: string) => notices.push(message) },
		};
		for (const handler of handlers) await handler({}, ctx);
		return notices;
	}

	it("warns once when an untrusted project's settings were skipped", async () => {
		expect(await sessionStartNotices(false)).toEqual([
			"This project is not trusted, so its settings for maestro were not read; global settings apply.",
		]);
	});

	it("says nothing for a trusted project", async () => {
		expect(await sessionStartNotices(true)).toEqual([]);
	});
});
