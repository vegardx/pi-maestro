import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { BashCorpusCall } from "../packages/modes/src/bash-corpus.js";
import {
	BASH_RULESET,
	classifyBashEffects,
	decideBashPolicy,
	dedicatedToolSuggestion,
	renderBashRuleset,
} from "../packages/modes/src/bash-policy.js";
import { auditBashShadowCorpus } from "../packages/modes/src/bash-policy-shadow.js";
import {
	authorizeBashDecision,
	isolationFailureAction,
	isolationFailureActionForActor,
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
		// This asserts WHICH base ops a route selects; the real-tree sandbox
		// wrapper (default-on) is orthogonal and covered in realtree-sandbox.test.
		process.env.MAESTRO_SANDBOX = "off";
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

		// host-read runs on the REAL filesystem. It used to fail closed here, and
		// was wired to the lightweight tier — which serves reads from a private
		// workspace copy with no `.git`, so `git status` in plan mode reported
		// "not a git repository" while the ls tool showed `.git` present. A read
		// guard may restrict what a command CHANGES, never what it SEES: the
		// route is only reached for exclusively-read effect sets, so there is
		// nothing to contain, and lying about the tree is the larger harm.
		const protectedRead = decideBashPolicy({
			command: "git status",
			mode: "plan",
			actor: "maestro",
			policy: guided,
		});
		expect(protectedRead.route).toBe("host-read");
		expect(
			resolveBashOperations(protectedRead, { direct: () => direct }, "/w"),
		).toBe(direct);
		// An injected backend still wins, for deployments that want one.
		const readBackend = { exec: async () => ({ exitCode: 0 }) };
		expect(
			resolveBashOperations(
				protectedRead,
				{ direct: () => direct, hostRead: () => readBackend },
				"/w",
			),
		).toBe(readBackend);

		// The old lightweight COPY tier is retired (B1): recon/plan writes run
		// in-place on the real tree through the same direct ops (profiled per
		// actor by the router), so the route no longer needs a separate backend
		// and no longer fails closed.
		const isolated = decideBashPolicy({
			command: "npm test",
			mode: "plan",
			actor: "maestro",
			policy: guided,
		});
		expect(isolated.route).toBe("lightweight");
		expect(
			resolveBashOperations(isolated, { direct: () => direct }, "/w"),
		).toBe(direct);

		const confirm = vi.fn(async () => true);
		await authorizeBashDecision(
			{
				...directDecision,
				actor: "maestro",
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

		const selectLightweight = vi.fn(async () => "Try Lightweight once");
		const approveLightweight = vi.fn(async () => true);
		await expect(
			isolationFailureAction("strong", "container unavailable", "confirm", {
				ui: {
					select: selectLightweight,
					confirm: approveLightweight,
				} as never,
			}),
		).resolves.toBe("lightweight");
		expect(approveLightweight).toHaveBeenCalledWith(
			"Use weaker isolation?",
			expect.stringContaining("not a VM"),
		);

		const select = vi.fn(async () => "Run direct once");
		const approveFallback = vi.fn(async () => true);
		await expect(
			isolationFailureAction("lightweight", "seatbelt failed", "confirm", {
				ui: { select, confirm: approveFallback } as never,
			}),
		).resolves.toBe("direct-once");
		expect(approveFallback).toHaveBeenCalledWith(
			"Weaken isolation?",
			expect.stringContaining("can modify the real checkout"),
		);

		const failClosedSelect = vi.fn(
			async (_title: string, _choices: string[]) =>
				"Cancel (policy is fail-closed)",
		);
		await expect(
			isolationFailureAction("lightweight", "seatbelt failed", "fail-closed", {
				ui: { select: failClosedSelect } as never,
			}),
		).resolves.toBe("cancel");
		expect(failClosedSelect.mock.calls[0]?.[1]).toEqual([
			"Cancel (policy is fail-closed)",
		]);
		delete process.env.MAESTRO_SANDBOX;
	});

	it.each([
		["worker", "fail-closed"],
		["worker", "confirm"],
		["reviewer", "fail-closed"],
		["reviewer", "confirm"],
	] as const)(
		"never prompts for %s isolation failures with fallback=%s",
		async (actor, fallback) => {
			const select = vi.fn();
			const confirm = vi.fn();
			await expect(
				isolationFailureActionForActor(
					actor,
					"lightweight",
					"sandbox collision",
					fallback,
					{ ui: { select, confirm } as never },
				),
			).rejects.toMatchObject({
				name: "BashRoutingError",
				code: "isolation-unavailable",
				actor,
				retryGuidance: expect.stringContaining("safe primitives"),
			});
			expect(select).not.toHaveBeenCalled();
			expect(confirm).not.toHaveBeenCalled();
		},
	);

	it("keeps host isolation failure approval interactive", async () => {
		const select = vi.fn(async () => "Run direct once");
		const confirm = vi.fn(async () => true);
		await expect(
			isolationFailureActionForActor(
				"maestro",
				"lightweight",
				"sandbox collision",
				"confirm",
				{ ui: { select, confirm } as never },
			),
		).resolves.toBe("direct-once");
		expect(select).toHaveBeenCalledOnce();
		expect(confirm).toHaveBeenCalledOnce();
	});

	it.each(["worker", "reviewer"] as const)(
		"never confirms approval routes for %s",
		async (actor) => {
			const confirm = vi.fn();
			await expect(
				authorizeBashDecision(
					{
						...decideBashPolicy({
							command: "fixture-command --opaque",
							mode: "agent",
							actor,
							policy: guided,
						}),
						route: "confirm",
					},
					{ ui: { confirm } as never },
					"fixture-command --opaque",
				),
			).rejects.toMatchObject({ code: "approval-required", actor });
			expect(confirm).not.toHaveBeenCalled();
		},
	);

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

describe("host git-config protection (Phase 4 rule 1)", () => {
	it("classifies global/system/file git config as host-config-write", () => {
		for (const command of [
			'git config --global user.name "X"',
			"git config --system core.editor vim",
			"git config --file /Users/dev/.gitconfig user.email x@y",
			"git config --file=~/.config/git/config user.name X",
		]) {
			expect(
				classifyBashEffects(analyzeShellProgram(command)).has(
					"host-config-write",
				),
				command,
			).toBe(true);
		}
	});

	it("non-identity repo-local git config stays ordinary worktree state", () => {
		const effects = classifyBashEffects(
			analyzeShellProgram("git config core.editor vim"),
		);
		expect(effects.has("host-config-write")).toBe(false);
		expect(effects.has("git-identity-write")).toBe(false);
		expect(effects.has("local-git")).toBe(true);
	});

	// A linked worktree has NO config of its own: `git config user.email x`
	// run inside one writes the shared <repo>/.git/config. The old rule called
	// this "ordinary worktree state" and the ruleset told agents to do it —
	// which is how `Test <test@example.com>` ended up authoring this repo.
	it("identity writes are their own effect, wherever they run", () => {
		for (const command of [
			'git config user.name "Maestro Agent"',
			"git config user.email agent@invented",
			"git config --unset user.email",
			'git config --replace-all user.name "X"',
		]) {
			expect(
				classifyBashEffects(analyzeShellProgram(command)).has(
					"git-identity-write",
				),
				command,
			).toBe(true);
		}
		// Reading identity is not writing it.
		for (const command of [
			"git config --get user.email",
			"git config --list",
		]) {
			expect(
				classifyBashEffects(analyzeShellProgram(command)).has(
					"git-identity-write",
				),
				command,
			).toBe(false);
		}
	});

	it("denies agent identity writes and points at the provided env", () => {
		for (const actor of ["worker", "reviewer"] as const) {
			const decision = decideBashPolicy({
				command: 'git config user.email "agent@invented"',
				mode: "auto",
				actor,
				policy: guided,
			});
			expect(decision.route, actor).toBe("deny");
			expect(decision.invariant).toBe("git-identity");
			expect(decision.reason).toContain("GIT_AUTHOR_");
		}
	});

	it("non-git writes addressing the global config files are caught", () => {
		for (const command of [
			"echo '[user]' > ~/.gitconfig",
			"sed -i '' 's/x/y/' /Users/dev/.config/git/config",
		]) {
			expect(
				classifyBashEffects(analyzeShellProgram(command)).has(
					"host-config-write",
				),
				command,
			).toBe(true);
		}
		// Pure reads stay reads.
		expect(
			classifyBashEffects(analyzeShellProgram("cat ~/.gitconfig")).has(
				"host-config-write",
			),
		).toBe(false);
	});

	it("denies agents and confirms the maestro (invariant host-config)", () => {
		for (const actor of ["worker", "reviewer"] as const) {
			const decision = decideBashPolicy({
				command: 'git config --global user.name "Maestro Agent"',
				mode: "auto",
				actor,
				policy: guided,
			});
			expect(decision.route, actor).toBe("deny");
			expect(decision.invariant).toBe("host-config");
			// The deny must NOT redirect them to a repo-local identity write.
			expect(decision.reason).not.toContain("REPO-LOCALLY");
		}
		const maestro = decideBashPolicy({
			command: 'git config --global user.name "Me"',
			mode: "auto",
			actor: "maestro",
			policy: guided,
		});
		expect(maestro.route).toBe("confirm");
		expect(maestro.invariant).toBe("host-config");
	});
});

describe("the visible bash ruleset (one source of truth)", () => {
	it("every row's id names an enforced invariant or guidance mechanism", () => {
		const enforced = new Set([
			"delivery",
			"host-config",
			"git-identity",
			"read-only",
			"worker-escalation",
			"tool-redirect",
		]);
		for (const row of BASH_RULESET) {
			expect(enforced.has(row.id), row.id).toBe(true);
			expect(row.applies.length).toBeGreaterThan(0);
			expect(row.rule.length).toBeGreaterThan(20);
			expect(row.why.length).toBeGreaterThan(10);
		}
	});

	it("renders actor-scoped rules for seeds", () => {
		const worker = renderBashRuleset("worker");
		expect(worker).toContain("Shell rules (enforced by the harness)");
		expect(worker).toContain("GIT_AUTHOR_");
		expect(worker).toContain("remote-write, privileged, or destructive");
		expect(worker).not.toContain("You are read-only");

		const reviewer = renderBashRuleset("reviewer");
		expect(reviewer).toContain("You are read-only");
		expect(reviewer).not.toContain("remote-write, privileged, or destructive");
	});
});
