import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { assessBashCommand } from "../packages/maestro/src/bash-policy.js";
import {
	buildCommandAuditPrompt,
	COMMAND_AUDITOR_SYSTEM_PROMPT,
	createCommandAuditor,
	parseCommandAuditResponse,
	parseCommandAuditTurn,
	runCommandProbe,
	validCommandProbe,
} from "../packages/maestro/src/command-auditor.js";
import { DEFAULT_EXECUTION_POLICY } from "../packages/maestro/src/execution-policy.js";
import { analyzeShellProgram } from "../packages/maestro/src/shell-program.js";

describe("command auditor prompt", () => {
	it("separates effect assessment from mode policy", () => {
		expect(COMMAND_AUDITOR_SYSTEM_PROMPT).toContain(
			"Do not decide whether a command should run",
		);
		expect(COMMAND_AUDITOR_SYSTEM_PROMPT).toContain(
			"must never remove or downgrade",
		);
		expect(COMMAND_AUDITOR_SYSTEM_PROMPT).toContain("acme --help");
		expect(COMMAND_AUDITOR_SYSTEM_PROMPT).toContain(
			"Do not generalize that exception",
		);
		expect(COMMAND_AUDITOR_SYSTEM_PROMPT).toContain("acme status");
	});

	it("treats intent as context rather than authority", () => {
		const command = "git reset --hard HEAD~1";
		const prompt = buildCommandAuditPrompt({
			command,
			intent: "Inspect the previous commit",
			deterministic: assessBashCommand(command),
			analysis: analyzeShellProgram(command),
			probeCwd: "/repo",
			repository: { name: "repo", cwd: "." },
		});
		expect(prompt).toContain("Inspect the previous commit");
		expect(prompt).toContain("destructive");
	});
});

describe("bounded command probes", () => {
	it("parses a probe only when the current pass permits one", () => {
		const text =
			'{"assessment":"probe","argv":["acme","deploy","--help"],"rationale":"inspect deploy semantics"}';
		expect(parseCommandAuditTurn(text, true)).toMatchObject({
			assessment: "probe",
			argv: ["acme", "deploy", "--help"],
		});
		expect(parseCommandAuditTurn(text, false)).toBeNull();
	});

	it.each([
		[["acme", "--help"], true],
		[["acme", "--version"], true],
		[["acme", "deploy", "--help"], true],
		[["acme", "help", "deploy"], true],
		[["other", "--help"], false],
		[["acme", "deploy"], false],
		[["acme", "--delete"], false],
	])("validates probe argv %j", (argv, expected) => {
		expect(
			validCommandProbe(
				{ assessment: "probe", argv, rationale: "test" },
				analyzeShellProgram("acme deploy --target prod"),
			),
		).toBe(expected);
	});

	it("rejects shell structure and explicit repository-local executables", () => {
		for (const command of ["acme deploy && true", "./acme deploy"])
			expect(
				validCommandProbe(
					{
						assessment: "probe",
						argv: [command.startsWith("./") ? "./acme" : "acme", "--help"],
						rationale: "test",
					},
					analyzeShellProgram(command),
				),
			).toBe(false);
	});

	it("rejects a bare PATH executable that resolves inside the workspace", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "maestro-local-probe-"));
		const executable = join(cwd, "acme");
		writeFileSync(executable, "#!/bin/sh\necho help\n");
		chmodSync(executable, 0o755);
		const previous = process.env.PATH;
		process.env.PATH = `${cwd}:${previous ?? ""}`;
		try {
			await expect(
				runCommandProbe(
					{
						assessment: "probe",
						argv: ["acme", "--help"],
						rationale: "inspect help",
					},
					cwd,
				),
			).rejects.toThrow("resolves inside the workspace");
		} finally {
			if (previous === undefined) delete process.env.PATH;
			else process.env.PATH = previous;
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("auditor probe loop", () => {
	it("permits distinct probes until a final assessment", async () => {
		const responses = [
			'{"assessment":"probe","argv":["acme","--version"],"rationale":"identify version"}',
			'{"assessment":"probe","argv":["acme","status","--help"],"rationale":"inspect status"}',
			'{"assessment":"read-only","effects":["remote-read"],"confidence":"high","rationale":"status only reads"}',
		];
		const complete = vi.fn(async () => {
			const text = responses.shift() ?? "";
			return {
				role: "assistant",
				content: [{ type: "text", text }],
				stopReason: "stop",
				usage: {},
				timestamp: Date.now(),
			} as unknown as Awaited<
				ReturnType<ExtensionContext["modelRegistry"]["complete"]>
			>;
		});
		const model = {
			provider: "test",
			id: "auditor",
			api: "openai-completions",
			maxTokens: 100_000,
		} as Model<Api>;
		const ctx = {
			modelRegistry: {
				find: () => model,
				complete,
			},
		} as unknown as ExtensionContext;
		const runProbe = vi.fn(async (request: { argv: readonly string[] }) => ({
			argv: request.argv,
			exitCode: 0,
			stdout: "help",
			stderr: "",
			truncated: false,
		}));
		const command = "acme status";
		const outcome = await createCommandAuditor(
			ctx,
			{
				...DEFAULT_EXECUTION_POLICY.auditor,
				model: "test/auditor",
			},
			{ runProbe },
		)({
			command,
			intent: "Inspect status",
			deterministic: assessBashCommand(command),
			analysis: analyzeShellProgram(command),
			probeCwd: "/repo",
			repository: { name: "repo", cwd: "." },
		});

		expect(outcome).toMatchObject({
			assessment: { assessment: "read-only", effects: ["remote-read"] },
			modelId: "test/auditor",
			probes: 2,
		});
		expect(runProbe).toHaveBeenCalledTimes(2);
		expect(complete).toHaveBeenCalledTimes(3);
	});
});

describe("strict auditor response", () => {
	it.each([
		[
			'{"assessment":"read-only","confidence":"high","rationale":"status only"}',
			"read-only",
		],
		[
			'{"assessment":"effects","effects":["remote-write"],"confidence":"medium","rationale":"deploys"}',
			"effects",
		],
		[
			'{"assessment":"uncertain","confidence":"low","rationale":"unknown CLI"}',
			"uncertain",
		],
	])("parses %s", (text, assessment) => {
		expect(parseCommandAuditResponse(text)?.assessment).toBe(assessment);
	});

	it.each([
		"not json",
		'```json\n{"assessment":"read-only","confidence":"high","rationale":"x"}\n```',
		'{"assessment":"effects","effects":["unknown"],"confidence":"high","rationale":"x"}',
		'{"assessment":"uncertain","confidence":"high","rationale":"x"}',
		'{"assessment":"effects","effects":[],"confidence":"high","rationale":"x"}',
	])("rejects malformed or out-of-contract output", (text) => {
		expect(parseCommandAuditResponse(text)).toBeNull();
	});
});
