import { describe, expect, it } from "vitest";
import {
	actionForAssessment,
	assessBashCommand,
	decideBashPolicy,
	dedicatedToolSuggestion,
	mergeCommandAssessments,
	shouldAuditCommand,
} from "../packages/maestro/src/bash-policy.js";
import { DEFAULT_EXECUTION_POLICY } from "../packages/maestro/src/execution-policy.js";
import { analyzeShellProgram } from "../packages/maestro/src/shell-program.js";

const effects = (command: string) => {
	const assessment = assessBashCommand(command).assessment;
	return assessment.effects ?? [];
};

describe("deterministic bash effects", () => {
	it.each([
		["git status --short", ["filesystem-read"]],
		["rg TODO src", ["filesystem-read"]],
		["touch marker", ["workspace-write"]],
		["touch /tmp/marker", ["host-write"]],
		["echo hi > notes.txt", ["workspace-write", "filesystem-read"]],
		["echo hi > /tmp/notes.txt", ["host-write", "filesystem-read"]],
		["cp /tmp/source ./dest", ["workspace-write"]],
		["git add src/a.ts", ["workspace-write"]],
		["git commit -m fix", ["workspace-write"]],
		["git -C /tmp/repo commit -m fix", ["host-write"]],
		["git reset --hard HEAD~1", ["workspace-write", "destructive"]],
		["git config --global user.email x", ["host-write"]],
		// `git init <path>` creates a repository wherever the path points, so the
		// path draws the same boundary `-C <path>` draws for everything else.
		["git init", ["workspace-write"]],
		["git init scratch", ["workspace-write"]],
		["git init --bare scratch.git", ["workspace-write"]],
		["git init /tmp/scratch", ["host-write"]],
		["git init ../scratch", ["host-write"]],
		["git -C /tmp/parent init scratch", ["host-write"]],
		// One word after `remote` separates listing the remotes from repointing
		// `origin`.
		["git remote add origin git@github.com:o/r.git", ["workspace-write"]],
		[
			"git remote set-url origin https://example.com/r.git",
			["workspace-write"],
		],
		["git remote remove origin", ["workspace-write"]],
		["git remote rename origin upstream", ["workspace-write"]],
		["git -C /tmp/repo remote add origin /tmp/r.git", ["host-write"]],
		["git remote", ["filesystem-read"]],
		["git remote -v", ["filesystem-read"]],
		["git remote show origin", ["filesystem-read"]],
		["git remote get-url origin", ["filesystem-read"]],
		["git push", ["remote-write"]],
		["npm test", ["code-execution"]],
		["kubectl get pods", ["remote-read"]],
		["kubectl apply -f deploy.yml", ["remote-write"]],
		["rm -rf dist", ["workspace-write", "destructive"]],
	])("classifies %s", (command, expected) => {
		expect(effects(command)).toEqual(expected);
	});

	it("accumulates effects across compound commands", () => {
		expect(effects("git status && touch marker")).toEqual([
			"filesystem-read",
			"workspace-write",
		]);
	});

	it.each([
		"git init /tmp/scratch",
		"git remote add origin git@github.com:o/r.git",
	])("resolves %s rather than calling the subcommand unknown", (command) => {
		const result = assessBashCommand(command);
		expect([...result.unresolved]).toEqual([]);
		expect(result.assessment.assessment).not.toBe("uncertain");
	});

	it("marks unknown executables unresolved instead of guessing read-only", () => {
		const result = assessBashCommand("acme status");
		expect(result.assessment.assessment).toBe("uncertain");
		expect(result.unresolved).toContain("unknown executable: acme");
	});

	it.each([
		"GIT_SSH_COMMAND='ssh -i key' git fetch",
		"GIT_EXTERNAL_DIFF=helper git diff",
		"GIT_PAGER=helper git log",
		"GIT_EDITOR=helper git commit",
		"PAGER=helper git log",
		"LESSOPEN=helper less file",
	])(
		"marks execution-affecting environment prefix unresolved: %s",
		(command) => {
			const result = assessBashCommand(command);
			expect(result.unresolved).toContain(
				"execution environment overrides command resolution",
			);
		},
	);

	it("recognizes remote reads without treating them as local filesystem reads", () => {
		expect(assessBashCommand("kubectl get pods").assessment).toMatchObject({
			assessment: "read-only",
		});
	});
});

describe("mode policy", () => {
	it("refuses recognized writes and code execution in plan", () => {
		for (const command of ["touch marker", "git commit -m x", "npm test"])
			expect(
				decideBashPolicy({
					command,
					mode: "plan",
					policy: DEFAULT_EXECUTION_POLICY,
				}).action,
			).toBe("refuse");
	});

	it("allows ordinary local work and confirms remote writes in auto", () => {
		expect(
			decideBashPolicy({
				command: "git commit -m x",
				mode: "auto",
				policy: DEFAULT_EXECUTION_POLICY,
			}).action,
		).toBe("allow");
		expect(
			decideBashPolicy({
				command: "git push",
				mode: "auto",
				policy: DEFAULT_EXECUTION_POLICY,
			}).action,
		).toBe("confirm");
	});

	it("uses the strongest configured action for multiple effects", () => {
		expect(
			actionForAssessment(
				"auto",
				{
					assessment: "effects",
					effects: ["workspace-write", "destructive"],
					confidence: "high",
					rationale: "test",
				},
				DEFAULT_EXECUTION_POLICY,
			),
		).toBe("confirm");
	});

	it("refuses unresolved read commands in plan when auditing is disabled", () => {
		const policy = {
			...DEFAULT_EXECUTION_POLICY,
			auditor: { ...DEFAULT_EXECUTION_POLICY.auditor, enabled: false },
		};
		const command = "find . -exec touch marker ;";
		expect(assessBashCommand(command).assessment.assessment).toBe("uncertain");
		expect(decideBashPolicy({ command, mode: "plan", policy }).action).toBe(
			"refuse",
		);
	});

	it("audits unresolved plan and auto commands, but not hack", () => {
		const unknown = assessBashCommand("acme status");
		expect(shouldAuditCommand("plan", unknown, DEFAULT_EXECUTION_POLICY)).toBe(
			true,
		);
		expect(shouldAuditCommand("auto", unknown, DEFAULT_EXECUTION_POLICY)).toBe(
			true,
		);
		expect(shouldAuditCommand("hack", unknown, DEFAULT_EXECUTION_POLICY)).toBe(
			false,
		);
	});
});

describe("assessment merging", () => {
	it("never removes deterministic effects", () => {
		const deterministic = assessBashCommand("touch marker && acme status");
		const merged = mergeCommandAssessments(deterministic, {
			assessment: "read-only",
			confidence: "high",
			rationale: "acme status is read-only",
		});
		expect(merged).toMatchObject({
			assessment: "effects",
			effects: ["workspace-write"],
		});
	});

	it("adds audited effects", () => {
		const deterministic = assessBashCommand("acme deploy");
		const merged = mergeCommandAssessments(deterministic, {
			assessment: "effects",
			effects: ["remote-write"],
			confidence: "high",
			rationale: "deploy changes remote state",
		});
		expect(merged).toMatchObject({
			assessment: "effects",
			effects: ["remote-write"],
		});
	});

	it("keeps established effects while uncertainty selects the fallback action", () => {
		const deterministic = assessBashCommand("git status && acme deploy");
		const merged = mergeCommandAssessments(deterministic, {
			assessment: "uncertain",
			confidence: "low",
			rationale: "unknown acme behavior",
		});
		expect(merged).toMatchObject({
			assessment: "uncertain",
			effects: ["filesystem-read"],
		});
		expect(actionForAssessment("auto", merged, DEFAULT_EXECUTION_POLICY)).toBe(
			"confirm",
		);
	});
});

describe("exact native-tool equivalents", () => {
	it.each([
		["cat README.md", "read"],
		["rg TODO src", "grep"],
		["find src -name '*.ts'", "find"],
		["ls packages", "ls"],
		["rm -rf dist", "delete"],
	])("maps %s to %s", (command, tool) => {
		expect(dedicatedToolSuggestion(analyzeShellProgram(command))).toBe(tool);
	});

	it("never splits compound shell automation", () => {
		expect(
			dedicatedToolSuggestion(analyzeShellProgram("cat a && cat b")),
		).toBeUndefined();
	});

	it("only steers to an available tool and allows confirmed shell bypass", () => {
		const base = {
			command: "cat README.md",
			mode: "auto" as const,
			policy: DEFAULT_EXECUTION_POLICY,
			availableTools: new Set(["read"]),
		};
		expect(decideBashPolicy(base)).toMatchObject({
			action: "refuse",
			suggestedTool: "read",
		});
		expect(decideBashPolicy({ ...base, confirmBash: true }).action).toBe(
			"confirm",
		);
	});
});
