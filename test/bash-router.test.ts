import { describe, expect, it } from "vitest";
import { analyzeShellProgram } from "../packages/modes/src/shell-program.js";

describe("shell program analysis", () => {
	it("recognizes only a whole simple command as simple", () => {
		const simple = analyzeShellProgram("git status --short");
		expect(simple.completeSimple).toBe(true);
		expect(simple.commands[0]).toMatchObject({
			executable: "git",
			args: ["status", "--short"],
		});

		for (const command of [
			"git status && rm -rf build",
			"git status | tee output.txt",
			"git status > output.txt",
			"printf '%s' \"$(touch marker)\"",
			"(git status)",
		]) {
			expect(analyzeShellProgram(command).completeSimple, command).toBe(false);
		}
	});

	it("marks heredoc interpreter payloads and every chain command", () => {
		const analysis = analyzeShellProgram(
			"git status && python3 <<'PY'\nfrom pathlib import Path\nPath('owned').touch()\nPY",
		);
		expect([...analysis.features]).toEqual(
			expect.arrayContaining(["chain", "heredoc", "interpreter-carrier"]),
		);
		expect(analysis.commands.map((command) => command.executable)).toEqual(
			expect.arrayContaining(["git", "python3"]),
		);
		expect(analysis.completeSimple).toBe(false);
	});

	it("exposes prefixes, wrappers, carriers, git extensibility and dispatch", () => {
		const prefixed = analyzeShellProgram(
			"CI=1 env FOO=bar sh -c 'touch marker'",
		);
		expect([...prefixed.features]).toEqual(
			expect.arrayContaining([
				"environment-prefix",
				"wrapper",
				"interpreter-carrier",
			]),
		);
		expect(prefixed.commands[0]?.executable).toBe("sh");

		const git = analyzeShellProgram(
			"git -C . -c alias.inspect='!touch marker' inspect",
		);
		expect(git.features.has("git-extensibility")).toBe(true);
		expect(git.commands[0]?.opaque).toBe(true);

		const dispatcher = analyzeShellProgram("find . -exec rm {} +");
		expect(dispatcher.features.has("opaque-dispatch")).toBe(true);
	});

	it("fails closed on malformed quoting", () => {
		const analysis = analyzeShellProgram("git status 'unterminated");
		expect(analysis.parseComplete).toBe(false);
		expect(analysis.completeSimple).toBe(false);
	});
});
