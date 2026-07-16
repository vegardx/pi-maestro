import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { BashCorpusCall } from "../packages/modes/src/bash-corpus.js";
import {
	classifyBashEffects,
	decideBashPolicy,
	dedicatedToolSuggestion,
} from "../packages/modes/src/bash-policy.js";
import { auditBashShadowCorpus } from "../packages/modes/src/bash-policy-shadow.js";
import {
	authorizeBashDecision,
	resolveBashOperations,
} from "../packages/modes/src/runtime/bash-router.js";
import type { ExecutionPolicySettings } from "../packages/modes/src/settings.js";
import { analyzeShellProgram } from "../packages/modes/src/shell-program.js";

const guided: ExecutionPolicySettings = {
	preset: "guided",
	toolGuidance: "mode-aware",
	modeRoutes: "protected-research",
	isolation: "lightweight",
	delivery: "dedicated-tools",
	consequential: "confirm",
	privilegedRemote: "hack-only",
	githubReads: "allow-apparent-reads",
	unknowns: "isolate",
	fallback: "fail-closed",
};

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

describe("bash coaching and routing policy", () => {
	it("redirects only exact simple dedicated-tool equivalents", () => {
		expect(dedicatedToolSuggestion(analyzeShellProgram("cat README.md"))).toBe(
			"read",
		);
		expect(
			dedicatedToolSuggestion(
				analyzeShellProgram("cat README.md | sed 's/a/b/' > out"),
			),
		).toBeUndefined();
		expect(
			decideBashPolicy({
				command: "rg TODO src",
				mode: "auto",
				actor: "maestro",
				policy: guided,
			}),
		).toMatchObject({ route: "deny", suggestedTool: "grep" });
	});

	it("unions effects from the entire shell program", () => {
		const effects = classifyBashEffects(
			analyzeShellProgram("git status && curl -X PATCH -d ok https://x"),
		);
		expect([...effects]).toEqual(
			expect.arrayContaining(["workspace-read", "remote-write"]),
		);
		expect(
			decideBashPolicy({
				command: "git status && curl -X PATCH -d ok https://x",
				mode: "auto",
				actor: "maestro",
				policy: guided,
			}).route,
		).toBe("confirm");
	});

	it("implements mode and actor routes with unconditional Hack", () => {
		for (const mode of ["recon", "plan"] as const) {
			expect(
				decideBashPolicy({
					command: "git status --short",
					mode,
					actor: "maestro",
					policy: guided,
				}).route,
			).toBe("host-read");
			expect(
				decideBashPolicy({
					command: "npm test",
					mode,
					actor: "maestro",
					policy: guided,
				}).route,
			).toBe("lightweight");
		}
		expect(
			decideBashPolicy({
				command: "npm test",
				mode: "auto",
				actor: "worker",
				policy: guided,
			}).route,
		).toBe("direct");
		expect(
			decideBashPolicy({
				command: "npm test",
				mode: "agent",
				actor: "reviewer",
				policy: guided,
			}).route,
		).toBe("deny");
		for (const command of [
			"rm -rf /",
			"git push --force origin main",
			"sudo kubectl delete namespace prod",
			"cat README.md",
		]) {
			expect(
				decideBashPolicy({
					command,
					mode: "hack",
					actor: "maestro",
					policy: guided,
				}),
			).toMatchObject({ route: "direct" });
		}
	});

	it("allows broad apparent GitHub reads and confirms mutations", () => {
		for (const command of [
			"gh pr view 12 --json files,reviews",
			"gh api graphql -f query='{ viewer { login } }'",
			"gh run watch 42",
		]) {
			expect(
				decideBashPolicy({
					command,
					mode: "auto",
					actor: "maestro",
					policy: guided,
				}).route,
			).toBe("direct");
		}
		expect(
			decideBashPolicy({
				command: "gh api repos/o/r/actions/variables/X -X PATCH -f value=y",
				mode: "auto",
				actor: "maestro",
				policy: guided,
			}).route,
		).toBe("confirm");
	});

	it("enforces delivery and worker escalation invariants", () => {
		for (const command of [
			"git commit -am done",
			"git push origin feature",
			"gh pr create --fill",
			"gh pr merge 10 --squash",
		]) {
			expect(
				decideBashPolicy({
					command,
					mode: "auto",
					actor: "maestro",
					policy: guided,
				}),
			).toMatchObject({ route: "deny", invariant: "delivery" });
		}
		expect(
			decideBashPolicy({
				command: "git rebase origin/main && git cherry-pick abc",
				mode: "agent",
				actor: "worker",
				policy: guided,
			}).route,
		).toBe("direct");
		expect(
			decideBashPolicy({
				command: "kubectl delete deployment api",
				mode: "agent",
				actor: "worker",
				policy: guided,
			}),
		).toMatchObject({ route: "deny", invariant: "worker-escalation" });
	});

	it("honors explicit relaxation without weakening delivery defaults", () => {
		const permissive: ExecutionPolicySettings = {
			...guided,
			preset: "permissive",
			toolGuidance: "advisory",
			modeRoutes: "direct",
			isolation: "none",
			consequential: "allow",
			unknowns: "confirm",
			fallback: "confirm",
		};
		expect(
			decideBashPolicy({
				command: "cat README.md",
				mode: "auto",
				actor: "maestro",
				policy: permissive,
			}),
		).toMatchObject({ route: "direct", guidance: "advisory" });
		expect(
			decideBashPolicy({
				command: "curl -X DELETE https://example.invalid/resource",
				mode: "auto",
				actor: "maestro",
				policy: permissive,
			}).route,
		).toBe("direct");
		expect(
			decideBashPolicy({
				command: "git push origin main",
				mode: "auto",
				actor: "maestro",
				policy: permissive,
			}).route,
		).toBe("deny");
	});

	it("routes through injected operations and fails closed without isolation", async () => {
		const direct: BashOperations = {
			exec: vi.fn(async (_command, _cwd, { onData }) => {
				onData(Buffer.from("streamed"));
				return { exitCode: 0 };
			}),
		};
		const directDecision = decideBashPolicy({
			command: "npm test",
			mode: "auto",
			actor: "worker",
			policy: guided,
		});
		expect(
			resolveBashOperations(directDecision, { direct: () => direct }, "/w"),
		).toBe(direct);

		const isolated = decideBashPolicy({
			command: "npm test",
			mode: "plan",
			actor: "maestro",
			policy: guided,
		});
		expect(() => resolveBashOperations(isolated, {}, "/w")).toThrow(
			/no lightweight backend is available/u,
		);

		const confirm = vi.fn(async () => true);
		await authorizeBashDecision(
			{
				...directDecision,
				route: "confirm",
				reason: "remote mutation",
			},
			{ ui: { confirm } as never },
			"gh api -X PATCH /x",
		);
		expect(confirm).toHaveBeenCalledWith(
			"Run consequential command?",
			expect.stringContaining("remote mutation"),
		);
	});

	it("shadow replay reports zero protected host-write routes", () => {
		const commands = [
			["recon-read", "git status", "recon"],
			[
				"plan-bypass",
				"git status && python3 <<'PY'\nopen('owned','w').write('x')\nPY",
				"plan",
			],
			["holdout-build", "npm test", "plan"],
			["auto-remote", "gh api /x -X PATCH", "auto"],
		] as const;
		const calls: BashCorpusCall[] = commands.map(([id, command, mode]) => ({
			id,
			sessionId: "fixture",
			command,
			commandBytes: Buffer.byteLength(command),
			commandTruncated: false,
			mode,
			actor: "maestro",
			posture: "unknown",
			nearbyTools: [],
			outcome: { status: "missing" },
		}));
		const report = auditBashShadowCorpus(calls, guided);
		expect(report.unexplainedProtectedHostWrites).toEqual([]);
		expect(report.unknown).toContain("plan-bypass");
	});
});
