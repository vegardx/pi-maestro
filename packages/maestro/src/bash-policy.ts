import {
	BASH_ACTIONS,
	type BashAction,
	type BashDecision,
	type BashEffect,
	type CommandAssessment,
	type DeterministicAssessment,
	type SuggestableTool,
} from "./bash-contracts.js";
import type { ExecutionPolicySettings } from "./execution-policy.js";
import type { ModeName } from "./mode.js";
import {
	analyzeShellProgram,
	type ShellProgramAnalysis,
} from "./shell-program.js";

const HOST_READ = new Set([
	"pwd",
	"ls",
	"wc",
	"file",
	"stat",
	"du",
	"df",
	"which",
	"type",
	"date",
	"printenv",
	"whoami",
	"id",
	"groups",
	"hostname",
	"uname",
	"true",
	"false",
]);
const FILE_READ = new Set(["cat", "head", "tail", "less", "more", "bat"]);
const SEARCH = new Set(["grep", "rg", "ag", "ack"]);
const FIND = new Set(["find", "fd"]);
const FILTERS = new Set(["jq", "sort", "uniq", "cut", "tr"]);
const WRITING_FILTERS = new Set(["awk", "sed", "yq"]);
const PACKAGE = new Set([
	"npm",
	"npx",
	"pnpm",
	"yarn",
	"bun",
	"deno",
	"cargo",
	"go",
	"make",
	"just",
]);
const LOCAL_WRITES = new Set([
	"cp",
	"mv",
	"mkdir",
	"touch",
	"ln",
	"install",
	"tee",
	"truncate",
	"patch",
]);
const DESTRUCTIVE = new Set(["rm", "rmdir", "shred"]);
const INTERPRETER =
	/^(?:sh|bash|zsh|dash|fish|node|deno|python\d*|ruby|perl|php|tsx|ts-node)$/u;
const GIT_READ = new Set([
	"status",
	"diff",
	"log",
	"show",
	"rev-parse",
	"remote",
	"ls-files",
	"grep",
	"describe",
	"shortlog",
	"blame",
	"cat-file",
	"for-each-ref",
	"merge-base",
	"name-rev",
]);
const GIT_WRITE = new Set([
	"add",
	"commit",
	"checkout",
	"switch",
	"restore",
	"merge",
	"rebase",
	"cherry-pick",
	"revert",
	"reset",
	"clean",
	"stash",
	"worktree",
	"branch",
	"tag",
	"update-ref",
	"apply",
	"am",
]);
const GH_READ = new Set(["view", "list", "status", "diff", "checks", "watch"]);
const GH_WRITE = new Set([
	"create",
	"edit",
	"delete",
	"close",
	"reopen",
	"merge",
	"review",
	"comment",
	"approve",
	"cancel",
	"rerun",
	"enable",
	"disable",
	"set-default",
	"fork",
	"sync",
	"upload",
	"set",
]);
const REMOTE_ADMIN = new Set([
	"kubectl",
	"helm",
	"terraform",
	"ansible",
	"aws",
	"gcloud",
	"az",
]);
const PRIVILEGED = new Set([
	"sudo",
	"doas",
	"launchctl",
	"systemctl",
	"service",
]);

export interface BashAssessmentInput {
	readonly command: string;
	readonly mode: ModeName;
	readonly policy: ExecutionPolicySettings;
	readonly availableTools?: ReadonlySet<string>;
	readonly confirmBash?: boolean;
}

export type { BashEffect, SuggestableTool } from "./bash-contracts.js";
export { SUGGESTABLE_TOOLS } from "./bash-contracts.js";

export function assessBashCommand(command: string): DeterministicAssessment {
	const analysis = analyzeShellProgram(command);
	const effects = new Set<BashEffect>();
	const unresolved = new Set<string>();
	if (command.trim() === "") effects.add("filesystem-read");
	if (!analysis.parseComplete)
		unresolved.add("shell syntax was not fully parsed");
	if (analysis.features.has("output-redirect")) effects.add("workspace-write");
	if (
		analysis.features.has("substitution") ||
		analysis.features.has("opaque-dispatch") ||
		analysis.features.has("git-extensibility")
	)
		unresolved.add("shell dispatch or expansion has unresolved effects");

	for (const part of analysis.commands) {
		const executable = part.executable;
		if (!executable) {
			unresolved.add("command executable is missing");
			continue;
		}
		if (hasExecutionEnvironmentOverride(part.environment))
			unresolved.add("execution environment overrides command resolution");
		if (
			HOST_READ.has(executable) ||
			FILE_READ.has(executable) ||
			SEARCH.has(executable)
		)
			effects.add("filesystem-read");
		else if (FIND.has(executable)) assessFind(part.args, effects, unresolved);
		else if (FILTERS.has(executable)) effects.add("filesystem-read");
		else if (WRITING_FILTERS.has(executable))
			assessWritingFilter(executable, part.args, effects, unresolved);
		else if (executable === "echo" || executable === "printf")
			effects.add("filesystem-read");
		else if (LOCAL_WRITES.has(executable)) effects.add("workspace-write");
		else if (DESTRUCTIVE.has(executable)) {
			effects.add("workspace-write");
			effects.add("destructive");
		} else if (PACKAGE.has(executable)) assessPackage(part.args, effects);
		else if (INTERPRETER.test(executable)) effects.add("code-execution");
		else if (executable === "git") assessGit(part.args, effects, unresolved);
		else if (executable === "gh") assessGh(part.args, effects, unresolved);
		else if (executable === "curl" || executable === "wget")
			assessHttp(part.args, effects);
		else if (
			PRIVILEGED.has(executable) ||
			part.wrappers.some((w) => w === "sudo" || w === "doas")
		) {
			effects.add("privileged");
			effects.add("host-write");
		} else if (REMOTE_ADMIN.has(executable))
			assessRemoteAdmin(executable, part.args, effects, unresolved);
		else if (["docker", "podman"].includes(executable)) {
			effects.add("code-execution");
			effects.add("host-write");
		} else if (["ssh", "scp", "rsync"].includes(executable))
			unresolved.add(
				`${executable} remote effects are not statically established`,
			);
		else unresolved.add(`unknown executable: ${executable}`);
	}

	return {
		assessment: assessmentFromEffects(effects, unresolved),
		unresolved: [...unresolved],
	};
}

function assessmentFromEffects(
	effects: ReadonlySet<BashEffect>,
	unresolved: ReadonlySet<string>,
): CommandAssessment {
	if (effects.size === 0 && unresolved.size > 0)
		return {
			assessment: "uncertain",
			confidence: "low",
			rationale: [...unresolved].join("; "),
		};
	if (effects.size === 0 || onlyReadEffects(effects))
		return {
			assessment: "read-only",
			...(effects.size > 0
				? {
						effects: [...effects] as ("filesystem-read" | "remote-read")[],
					}
				: {}),
			confidence: unresolved.size > 0 ? "medium" : "high",
			rationale:
				unresolved.size > 0
					? [...unresolved].join("; ")
					: "recognized read-only command",
		};
	return {
		assessment: "effects",
		effects: [...effects],
		confidence: unresolved.size > 0 ? "medium" : "high",
		rationale: `recognized effects: ${[...effects].join(", ")}`,
	};
}

export function mergeCommandAssessments(
	deterministic: DeterministicAssessment,
	audit: CommandAssessment | null,
): CommandAssessment {
	if (!audit) return deterministic.assessment;
	const effects = new Set<BashEffect>(deterministic.assessment.effects ?? []);
	if (audit.assessment === "effects")
		for (const effect of audit.effects) effects.add(effect);
	if (audit.assessment === "uncertain")
		return {
			assessment: "uncertain",
			...(effects.size > 0 ? { effects: [...effects] } : {}),
			confidence: "low",
			rationale: `${deterministic.assessment.rationale}; audit remained uncertain: ${audit.rationale}`,
		};
	if (effects.size > 0)
		return {
			assessment: "effects",
			effects: [...effects],
			confidence: audit.confidence,
			rationale: `${deterministic.assessment.rationale}; ${audit.rationale}`,
		};
	return audit;
}

export function shouldAuditCommand(
	mode: ModeName,
	deterministic: DeterministicAssessment,
	policy: ExecutionPolicySettings,
): boolean {
	if (
		!policy.auditor.enabled ||
		mode === "hack" ||
		deterministic.unresolved.length === 0
	)
		return false;
	const action = actionForAssessment(mode, deterministic.assessment, policy);
	return (
		action === "allow" || deterministic.assessment.assessment === "uncertain"
	);
}

export function decideBashPolicy(
	input: BashAssessmentInput,
	assessment = assessBashCommand(input.command).assessment,
): BashDecision {
	const action = actionForAssessment(input.mode, assessment, input.policy);
	const suggestion = dedicatedToolSuggestion(
		analyzeShellProgram(input.command),
	);
	const available =
		suggestion && (input.availableTools?.has(suggestion) ?? false)
			? suggestion
			: undefined;
	if (action === "refuse")
		return {
			action,
			assessment,
			reason: `${input.mode} policy refuses ${describeAssessment(assessment)}`,
		};
	if (
		available &&
		input.policy.exactToolEquivalent === "redirect" &&
		!input.confirmBash
	)
		return {
			action: "refuse",
			assessment,
			reason: `Use the ${available} tool for this complete simple equivalent. Retry with confirmBash: true to request the shell form.`,
			suggestedTool: available,
		};
	if (available && input.confirmBash && action === "allow")
		return {
			action: "confirm",
			assessment,
			reason: `A dedicated ${available} tool is available; confirm the shell form`,
			suggestedTool: available,
		};
	return {
		action,
		assessment,
		reason:
			action === "confirm"
				? `Confirm ${describeAssessment(assessment)}`
				: describeAssessment(assessment),
		...(available ? { suggestedTool: available } : {}),
	};
}

export function actionForAssessment(
	mode: ModeName,
	assessment: CommandAssessment,
	policy: ExecutionPolicySettings,
): BashAction {
	if (assessment.assessment === "uncertain")
		return policy.modes[mode].uncertain;
	const effects =
		assessment.assessment === "read-only"
			? (assessment.effects ?? (["filesystem-read"] as const))
			: assessment.effects;
	return effects
		.map((effect) => policy.modes[mode][effect])
		.reduce(strongerAction, "allow");
}

function strongerAction(left: BashAction, right: BashAction): BashAction {
	return BASH_ACTIONS.indexOf(left) > BASH_ACTIONS.indexOf(right)
		? left
		: right;
}

function describeAssessment(assessment: CommandAssessment): string {
	if (assessment.assessment === "read-only")
		return "recognized read-only command";
	if (assessment.assessment === "uncertain")
		return `command with uncertain effects: ${assessment.rationale}`;
	return assessment.effects.join(", ");
}

export function dedicatedToolSuggestion(
	analysis: ShellProgramAnalysis,
): SuggestableTool | undefined {
	if (!analysis.completeSimple) return undefined;
	const command = analysis.commands[0];
	if (!command?.executable) return undefined;
	if (
		["cat", "head", "tail", "less", "more", "bat"].includes(
			command.executable,
		) &&
		noFlags(command.args)
	)
		return "read";
	if (SEARCH.has(command.executable) && exactSearchArgs(command.args))
		return "grep";
	if (FIND.has(command.executable) && exactFindArgs(command.args))
		return "find";
	if (command.executable === "ls" && noFlags(command.args)) return "ls";
	if (command.executable === "rm" || command.executable === "rmdir")
		return "delete";
	return undefined;
}

function assessFind(
	args: readonly string[],
	effects: Set<BashEffect>,
	unresolved: Set<string>,
): void {
	effects.add("filesystem-read");
	if (
		hasOption(args, ["-x", "--exec", "-X", "--exec-batch", "-exec", "-execdir"])
	)
		unresolved.add("find executes another command");
	if (
		args.some((arg) =>
			["-delete", "-fprint", "-fprint0", "-fls", "-fprintf"].includes(arg),
		)
	) {
		effects.add("workspace-write");
		if (args.includes("-delete")) effects.add("destructive");
	}
}

function assessWritingFilter(
	executable: string,
	args: readonly string[],
	effects: Set<BashEffect>,
	unresolved: Set<string>,
): void {
	effects.add("filesystem-read");
	if (
		args.some(
			(arg) =>
				arg === "-i" || arg.startsWith("-i") || arg.startsWith("--in-place"),
		)
	)
		effects.add("workspace-write");
	else unresolved.add(`${executable} program effects are not fully parsed`);
}

function assessPackage(
	args: readonly string[],
	effects: Set<BashEffect>,
): void {
	effects.add("code-execution");
	if (
		args.some((arg) =>
			["publish", "unpublish", "deprecate", "yank"].includes(arg.toLowerCase()),
		)
	)
		effects.add("remote-write");
}

function assessGit(
	args: readonly string[],
	effects: Set<BashEffect>,
	unresolved: Set<string>,
): void {
	const subcommand = gitSubcommand(args);
	if (!subcommand) {
		unresolved.add("git subcommand is missing");
		return;
	}
	if (subcommand === "config") {
		if (
			args.some(
				(arg) =>
					arg === "--global" ||
					arg === "--system" ||
					arg === "--file" ||
					arg.startsWith("--file="),
			)
		)
			effects.add("host-write");
		else if (
			args.some((arg) =>
				["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(arg),
			)
		)
			effects.add("filesystem-read");
		else effects.add("workspace-write");
		return;
	}
	if (GIT_READ.has(subcommand)) effects.add("filesystem-read");
	else if (subcommand === "push" || subcommand === "send-email") {
		effects.add("remote-write");
		if (
			subcommand === "push" &&
			args.some((arg) =>
				["-f", "--force", "--force-with-lease"].some(
					(flag) => arg === flag || arg.startsWith(`${flag}=`),
				),
			)
		)
			effects.add("destructive");
	} else if (["fetch", "pull"].includes(subcommand)) {
		effects.add("remote-read");
		effects.add("workspace-write");
	} else if (GIT_WRITE.has(subcommand)) {
		effects.add("workspace-write");
		if (
			(subcommand === "reset" && args.includes("--hard")) ||
			subcommand === "clean"
		)
			effects.add("destructive");
	} else unresolved.add(`unknown git subcommand: ${subcommand}`);
}

function assessGh(
	args: readonly string[],
	effects: Set<BashEffect>,
	unresolved: Set<string>,
): void {
	const lower = args.map((arg) => arg.toLowerCase());
	if (lower[0] === "api") {
		const method = optionValue(lower.slice(1), ["-x", "--method"]);
		const body = hasOption(lower.slice(1), [
			"-f",
			"--field",
			"-F",
			"--raw-field",
			"--input",
		]);
		if ((method && !["get", "head"].includes(method)) || body)
			effects.add("remote-write");
		else effects.add("remote-read");
		return;
	}
	const verb = lower[1];
	if (lower[0] === "workflow" && verb === "run")
		return void effects.add("remote-write");
	if (verb && GH_READ.has(verb)) effects.add("remote-read");
	else if (verb && GH_WRITE.has(verb)) {
		effects.add("remote-write");
		if (verb === "merge" || verb === "delete") effects.add("destructive");
	} else unresolved.add("unknown gh operation");
}

function assessHttp(args: readonly string[], effects: Set<BashEffect>): void {
	const method = optionValue(args, ["-X", "--request"]);
	const body = hasOption(args, [
		"-d",
		"--data",
		"--data-raw",
		"--data-binary",
		"--upload-file",
		"-T",
		"-F",
		"--form",
		"--json",
	]);
	effects.add(
		(!method || ["get", "head"].includes(method)) && !body
			? "remote-read"
			: "remote-write",
	);
	if (
		hasOption(args, [
			"-o",
			"--output",
			"-O",
			"--output-document",
			"-P",
			"--directory-prefix",
		])
	)
		effects.add("workspace-write");
}

function assessRemoteAdmin(
	executable: string,
	args: readonly string[],
	effects: Set<BashEffect>,
	unresolved: Set<string>,
): void {
	const words = args.map((arg) => arg.toLowerCase());
	if (executable === "terraform") {
		effects.add("code-execution");
		if (words.includes("plan")) {
			effects.add("workspace-write");
			effects.add("remote-read");
		} else if (
			words.some((word) => ["apply", "destroy", "import"].includes(word))
		) {
			effects.add("remote-write");
			if (words.includes("destroy")) effects.add("destructive");
		} else unresolved.add("terraform operation is not classified");
		return;
	}
	if (
		words.some((word) =>
			["get", "list", "describe", "show", "logs", "status"].includes(word),
		)
	)
		effects.add("remote-read");
	else if (
		words.some((word) => ["delete", "destroy", "terminate"].includes(word))
	) {
		effects.add("remote-write");
		effects.add("destructive");
	} else if (
		words.some((word) =>
			["apply", "create", "update", "set", "patch", "deploy", "run"].includes(
				word,
			),
		)
	)
		effects.add("remote-write");
	else unresolved.add(`${executable} operation is not classified`);
}

function hasExecutionEnvironmentOverride(
	environment: Readonly<Record<string, string>>,
): boolean {
	return Object.keys(environment).some((key) =>
		/^(?:PATH|BASH_ENV|ENV|SHELLOPTS|NODE_OPTIONS|PYTHONPATH|RUBYOPT|PERL5OPT|LD_|DYLD_|GIT_CONFIG)/u.test(
			key,
		),
	);
}
function onlyReadEffects(effects: ReadonlySet<BashEffect>): boolean {
	return [...effects].every(
		(effect) => effect === "filesystem-read" || effect === "remote-read",
	);
}
function noFlags(args: readonly string[]): boolean {
	return args.every((arg) => !arg.startsWith("-"));
}
function exactSearchArgs(args: readonly string[]): boolean {
	return !args.some((arg) =>
		[
			"-c",
			"--count",
			"--count-matches",
			"-l",
			"--files-with-matches",
			"-L",
			"--files-without-match",
			"-o",
			"--only-matching",
		].includes(arg),
	);
}
function exactFindArgs(args: readonly string[]): boolean {
	return !args.some(
		(arg) =>
			arg.startsWith("-") &&
			!["-name", "-path", "-type", "-maxdepth", "-mindepth"].includes(arg),
	);
}
function gitSubcommand(args: readonly string[]): string | undefined {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (
			[
				"-C",
				"--git-dir",
				"--work-tree",
				"--namespace",
				"-c",
				"--config-env",
			].includes(arg)
		) {
			index += 1;
			continue;
		}
		if (!arg.startsWith("-")) return arg;
	}
	return undefined;
}
function optionValue(
	args: readonly string[],
	names: readonly string[],
): string | undefined {
	for (let index = 0; index < args.length; index += 1)
		for (const name of names) {
			const arg = args[index] ?? "";
			if (arg === name) return args[index + 1]?.toLowerCase();
			if (arg.startsWith(`${name}=`))
				return arg.slice(name.length + 1).toLowerCase();
			if (name.length === 2 && arg.startsWith(name) && arg.length > 2)
				return arg.slice(2).toLowerCase();
		}
	return undefined;
}
function hasOption(args: readonly string[], names: readonly string[]): boolean {
	return args.some((arg) =>
		names.some(
			(name) =>
				arg === name ||
				arg.startsWith(`${name}=`) ||
				(name.length === 2 && arg.startsWith(name) && arg.length > 2),
		),
	);
}
