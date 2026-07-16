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
	isolationFailureAction,
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

		const shellScript = analyzeShellProgram("bash ci.sh");
		expect(shellScript.features.has("interpreter-carrier")).toBe(false);
		const shellCarrier = analyzeShellProgram("bash -lc 'touch marker'");
		expect(shellCarrier.features.has("interpreter-carrier")).toBe(true);
	});

	it("fails closed on malformed quoting", () => {
		const analysis = analyzeShellProgram("git status 'unterminated");
		expect(analysis.parseComplete).toBe(false);
		expect(analysis.completeSimple).toBe(false);

		const input = analyzeShellProgram("sort < input.txt");
		expect(input.features.has("input-redirect")).toBe(true);
		expect(input.features.has("output-redirect")).toBe(false);
		expect(classifyBashEffects(input).has("workspace-write")).toBe(false);
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
		for (const command of [
			"tail -f app.log",
			"find . -mtime -1",
			"grep -c TODO README.md",
			"curl -X DELETE https://example.invalid/x",
		]) {
			expect(
				dedicatedToolSuggestion(analyzeShellProgram(command)),
				command,
			).toBeUndefined();
		}
		expect(
			decideBashPolicy({
				command: "curl -X DELETE https://example.invalid/x",
				mode: "auto",
				actor: "maestro",
				policy: guided,
			}).route,
		).toBe("confirm");
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
				command: "fixture-command --opaque",
				mode: "agent",
				actor: "worker",
				policy: guided,
			}).route,
		).toBe("lightweight");
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

	it("never treats write-capable read tools as protected host reads", () => {
		for (const command of [
			"find . -delete",
			"sed -i s/a/b/ file",
			"awk '{system(\"touch marker\")}' file",
			"sort -o output input",
			"git diff --output=patch.txt",
			"curl -o output https://example.invalid/file | cat",
			"curl --config request.conf https://example.invalid/file | cat",
			"fd pattern -x sh -c 'touch marker'",
		]) {
			const decision = decideBashPolicy({
				command,
				mode: "plan",
				actor: "maestro",
				policy: guided,
			});
			expect(decision.route, command).not.toBe("host-read");
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
		for (const command of [
			"gh api --method=DELETE repos/o/r/issues/1",
			"gh api -XDELETE repos/o/r/issues/1",
			"curl --request=DELETE https://example.invalid/x",
			"curl -dvalue https://example.invalid/x",
			"gh workflow run ci.yml",
			"gh release upload v1 artifact",
			"gh alias set x foo",
			"npm publish",
			"cargo publish",
			"gh api repos/o/r/actions/variables/X -X PATCH -f value=y",
			"gh api repos/o/r/issues -f title=oops",
			"cat payload | curl --data-binary @- https://example.invalid/x",
			"curl -XPOST --json '{}' https://example.invalid/x",
		]) {
			expect(
				decideBashPolicy({
					command,
					mode: "auto",
					actor: "maestro",
					policy: guided,
				}).route,
			).toBe("confirm");
		}
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
		for (const command of [
			"timeout 30 git push origin main",
			"nice -n 10 git push origin main",
		]) {
			expect(
				decideBashPolicy({
					command,
					mode: "agent",
					actor: "worker",
					policy: guided,
				}),
			).toMatchObject({ route: "deny", invariant: "delivery" });
		}
		expect(
			decideBashPolicy({
				command: "timeout 5 rm -rf /tmp/x",
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
				command: "npm test",
				mode: "plan",
				actor: "maestro",
				policy: { ...guided, isolation: "none" },
			}).route,
		).toBe("confirm");
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

		const protectedRead = decideBashPolicy({
			command: "git status",
			mode: "plan",
			actor: "maestro",
			policy: guided,
		});
		expect(() => resolveBashOperations(protectedRead, {}, "/w")).toThrow(
			/no host-read backend is available/u,
		);

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

		const select = vi.fn(async () => "Run direct once");
		const approveFallback = vi.fn(async () => true);
		await expect(
			isolationFailureAction("lightweight", "seatbelt failed", {
				ui: { select, confirm: approveFallback } as never,
			}),
		).resolves.toBe("direct-once");
		expect(approveFallback).toHaveBeenCalledWith(
			"Weaken isolation?",
			expect.stringContaining("can modify the real checkout"),
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
