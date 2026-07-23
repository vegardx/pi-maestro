import type { ModeName } from "@vegardx/pi-contracts";
import type { ExecutionPolicySettings } from "./settings.js";
import {
	analyzeShellProgram,
	type ShellProgramAnalysis,
} from "./shell-program.js";

export type BashActor = "maestro" | "worker" | "reviewer";
export type BashEffect =
	| "host-read"
	| "workspace-read"
	| "workspace-write"
	| "repository-code"
	| "local-git"
	| "delivery"
	| "github-read"
	| "remote-read"
	| "remote-write"
	| "privileged"
	| "destructive"
	| "host-config-write"
	| "git-identity-write"
	| "unknown";
export type BashRoute =
	| "direct"
	| "host-read"
	| "lightweight"
	| "strong"
	| "confirm"
	| "deny";
export type BashGuidance = "redirect" | "advisory" | "none";

export interface BashPolicyInput {
	readonly command: string;
	readonly mode: ModeName;
	readonly actor: BashActor;
	readonly policy: ExecutionPolicySettings;
}

export interface BashPolicyDecision {
	readonly analysis: ShellProgramAnalysis;
	readonly actor: BashActor;
	readonly mode: ModeName;
	readonly effects: ReadonlySet<BashEffect>;
	readonly route: BashRoute;
	readonly reason: string;
	readonly confidence: "low" | "medium" | "high";
	readonly guidance: BashGuidance;
	readonly suggestedTool?: string;
	readonly invariant?:
		| "delivery"
		| "worker-escalation"
		| "read-only"
		| "host-config"
		| "git-identity";
}

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
	"hostname",
	"uname",
	"true",
	"false",
]);
const FILE_READ = new Set(["cat", "head", "tail", "less", "more", "bat"]);
const SEARCH = new Set(["grep", "rg", "ag", "ack"]);
const FIND = new Set(["find", "fd"]);
const TEXT_FILTER = new Set([
	"jq",
	"yq",
	"awk",
	"sed",
	"sort",
	"uniq",
	"cut",
	"tr",
]);
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
const GIT_LOCAL = new Set([
	"add",
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
const GIT_DELIVERY = new Set(["commit", "push", "send-email"]);
const GH_MUTATIONS = new Set([
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
	"login",
	"logout",
	"refresh",
]);
const GH_READS = new Set([
	"view",
	"list",
	"status",
	"diff",
	"checks",
	"watch",
	"ready",
]);
const PACKAGE_REMOTE_MUTATIONS = new Set([
	"publish",
	"unpublish",
	"deprecate",
	"yank",
]);
const PRIVILEGED = new Set([
	"sudo",
	"doas",
	"launchctl",
	"systemctl",
	"service",
	"kubectl",
	"helm",
	"terraform",
	"ansible",
	"aws",
	"gcloud",
	"az",
	"docker",
	"podman",
	"ssh",
	"scp",
	"rsync",
]);

/** Exact simple equivalents only. Compound shell automation is never split. */
export function dedicatedToolSuggestion(
	analysis: ShellProgramAnalysis,
): string | undefined {
	if (!analysis.completeSimple) return undefined;
	const command = analysis.commands[0];
	if (!command?.executable) return undefined;
	if (command.executable === "cat" && noFlags(command.args)) return "read";
	if (
		["head", "tail", "less", "more", "bat"].includes(command.executable) &&
		noFlags(command.args)
	)
		return "read";
	if (SEARCH.has(command.executable) && exactSearchArgs(command.args))
		return "grep";
	if (FIND.has(command.executable) && exactFindArgs(command.args))
		return "find";
	if (
		(command.executable === "curl" || command.executable === "wget") &&
		isReadOnlyHttp(command.args)
	)
		return "webfetch";
	if (command.executable === "ls" && noFlags(command.args)) return "ls";
	// Deletion redirects to the delete tool (always-trash, recoverable) — with
	// or without flags, so `rm -rf dist` is caught too. `shred` is left alone:
	// redirecting a secure-erase to a recoverable trash would defeat its intent.
	if (command.executable === "rm" || command.executable === "rmdir")
		return "delete";
	return undefined;
}

function noFlags(args: readonly string[]): boolean {
	return args.every((arg) => !arg.startsWith("-"));
}

function exactSearchArgs(args: readonly string[]): boolean {
	const unsupported = new Set([
		"-c",
		"--count",
		"--count-matches",
		"-l",
		"--files-with-matches",
		"-L",
		"--files-without-match",
		"-o",
		"--only-matching",
	]);
	return !args.some((arg) => unsupported.has(arg));
}

function exactFindArgs(args: readonly string[]): boolean {
	return !args.some(
		(arg) =>
			arg.startsWith("-") &&
			!["-name", "-path", "-type", "-maxdepth", "-mindepth"].includes(arg),
	);
}

export function classifyBashEffects(
	analysis: ShellProgramAnalysis,
): ReadonlySet<BashEffect> {
	const effects = new Set<BashEffect>();
	if (analysis.source.trim() === "") {
		effects.add("host-read");
		return effects;
	}
	if (!analysis.parseComplete) effects.add("unknown");
	if (analysis.features.has("output-redirect")) effects.add("workspace-write");
	if (
		analysis.features.has("substitution") ||
		analysis.features.has("interpreter-carrier") ||
		analysis.features.has("opaque-dispatch") ||
		analysis.features.has("git-extensibility")
	)
		effects.add("unknown");

	for (const command of analysis.commands) {
		if (hasExecutionEnvironmentOverride(command.environment))
			effects.add("unknown");
		const executable = command.executable;
		if (!executable) {
			effects.add("unknown");
			continue;
		}
		if (HOST_READ.has(executable)) effects.add("host-read");
		else if (FILE_READ.has(executable) || SEARCH.has(executable))
			effects.add("workspace-read");
		else if (FIND.has(executable)) classifyFind(command.args, effects);
		else if (TEXT_FILTER.has(executable))
			classifyTextFilter(executable, command.args, effects);
		else if (executable === "echo" || executable === "printf")
			effects.add("host-read");
		else if (LOCAL_WRITES.has(executable)) effects.add("workspace-write");
		else if (DESTRUCTIVE.has(executable)) {
			effects.add("workspace-write");
			effects.add("destructive");
		} else if (PACKAGE.has(executable))
			classifyPackage(executable, command.args, effects);
		else if (isInterpreter(executable)) {
			effects.add("repository-code");
			effects.add("workspace-write");
		} else if (executable === "git") classifyGit(command.args, effects);
		else if (executable === "gh") classifyGh(command.args, effects);
		else if (executable === "curl" || executable === "wget")
			classifyHttp(command.args, effects);
		else if (
			PRIVILEGED.has(executable) ||
			command.wrappers.some(
				(wrapper) => wrapper === "sudo" || wrapper === "doas",
			)
		) {
			effects.add("privileged");
			effects.add("remote-write");
		} else effects.add("unknown");

		// Cross-cutting: any non-git touch of ~/.gitconfig or ~/.config/git
		// with write-ish effects is a host-config write — the developer's
		// REAL machine config (agents share HOME). `git config --global` is
		// classified inside classifyGit; this catches echo/sed/tee paths.
		if (
			referencesHostGitConfig(command.args) &&
			hasAny(effects, ["workspace-write", "destructive", "unknown"])
		) {
			effects.add("host-config-write");
		}
	}
	return effects;
}

export function decideBashPolicy(input: BashPolicyInput): BashPolicyDecision {
	const analysis = analyzeShellProgram(input.command);
	const effects = classifyBashEffects(analysis);
	const suggestedTool = dedicatedToolSuggestion(analysis);
	const guidance = guidanceFor(input, suggestedTool);
	const base = {
		analysis,
		actor: input.actor,
		mode: input.mode,
		effects,
		guidance,
		...(suggestedTool ? { suggestedTool } : {}),
	};

	// Hack is the explicit operator authorisation boundary. Nothing in command
	// classification can turn it into a prompt or denial.
	if (input.mode === "hack")
		return {
			...base,
			route: "direct",
			reason: "Hack explicitly authorizes direct host execution",
			confidence: "high",
		};

	if (guidance === "redirect" && suggestedTool) {
		return {
			...base,
			route: "deny",
			reason: `Use the ${suggestedTool} tool for this complete simple equivalent`,
			confidence: "high",
		};
	}
	if (effects.has("delivery")) {
		return {
			...base,
			route: "deny",
			reason: deliveryReason(input.command),
			confidence: "high",
			invariant: "delivery",
		};
	}
	if (
		input.actor === "reviewer" &&
		hasAny(effects, [
			"workspace-write",
			"repository-code",
			"local-git",
			"remote-write",
			"privileged",
			"destructive",
			"unknown",
		])
	) {
		return {
			...base,
			route: "deny",
			reason:
				"Read-only reviewer cannot run commands with writes, repository code, or uncertain effects",
			confidence: "high",
			invariant: "read-only",
		};
	}
	if (effects.has("git-identity-write") && input.actor !== "maestro") {
		return {
			...base,
			route: "deny",
			reason:
				"Your commit identity is already provided by the harness " +
				"(GIT_AUTHOR_*/GIT_COMMITTER_* in your environment) — commit " +
				"without setting it. A worktree has no config of its own, so " +
				"this would rewrite the developer's shared repository config.",
			confidence: "high",
			invariant: "git-identity",
		};
	}
	if (effects.has("host-config-write")) {
		if (input.actor !== "maestro") {
			return {
				...base,
				route: "deny",
				reason:
					"Global git-config writes land in the developer's real HOME " +
					"(agents share it). Identity is already in your environment; " +
					"for anything else, ask.",
				confidence: "high",
				invariant: "host-config",
			};
		}
		return {
			...base,
			route: "confirm",
			reason:
				"This writes the machine-global git config; confirm it is an " +
				"explicit operator request",
			confidence: "high",
			invariant: "host-config",
		};
	}
	if (
		input.actor === "worker" &&
		hasAny(effects, ["remote-write", "privileged", "destructive"])
	) {
		return {
			...base,
			route: "deny",
			reason:
				"Worker cannot approve consequential effects; ask the parent maestro to perform it or use Hack explicitly",
			confidence: "high",
			invariant: "worker-escalation",
		};
	}
	if (effects.has("privileged")) return privilegedRoute(input, base);
	if (effects.has("remote-write") || effects.has("destructive"))
		return consequentialRoute(
			input,
			base,
			"Command likely has consequential external or destructive effects",
		);
	if (effects.has("github-read")) {
		if (input.policy.githubReads === "confirm" && input.actor === "maestro")
			return {
				...base,
				route: "confirm",
				reason: "Policy requires confirmation for apparent GitHub reads",
				confidence: "medium",
			};
		return {
			...base,
			route: "direct",
			reason: "Apparent GitHub read",
			confidence: "medium",
		};
	}

	if (
		input.mode === "recon" ||
		input.mode === "plan" ||
		input.actor === "reviewer"
	) {
		// The configured direct route is checked FIRST. It used to sit behind the
		// pure-read branch, which meant `modeRoutes: "direct"` could never apply
		// to the very commands it exists for — every read was routed to
		// host-read regardless of the setting, and the escape hatch was dead.
		if (input.policy.modeRoutes === "direct" && !effects.has("unknown"))
			return {
				...base,
				route: "direct",
				reason: "Configured direct research route",
				confidence: "medium",
			};
		if (only(effects, ["host-read", "workspace-read", "remote-read"]))
			return {
				...base,
				route: "host-read",
				reason: "Narrow read command is eligible for protected host execution",
				confidence: "high",
			};
		if (hasAny(effects, ["repository-code", "workspace-write", "local-git"]))
			return {
				...base,
				route: isolationRoute(input.policy),
				reason:
					"Research command may execute repository code or write workspace state",
				confidence: "high",
			};
	}

	if (effects.has("unknown")) return unknownRoute(input, base);
	if (
		input.policy.consequential === "confirm-mutations" &&
		hasAny(effects, ["workspace-write", "local-git", "repository-code"]) &&
		input.actor === "maestro"
	) {
		return {
			...base,
			route: "confirm",
			reason: "Policy confirms mutating Bash commands",
			confidence: "high",
		};
	}
	return {
		...base,
		route: "direct",
		reason:
			input.actor === "worker"
				? "Expected worker worktree activity"
				: "Expected local workspace activity",
		confidence: "high",
	};
}

function guidanceFor(
	input: BashPolicyInput,
	suggestion: string | undefined,
): BashGuidance {
	if (!suggestion || input.policy.toolGuidance === "off") return "none";
	if (input.mode === "hack" || input.policy.toolGuidance === "advisory")
		return "advisory";
	return "redirect";
}

function classifyFind(args: readonly string[], effects: Set<BashEffect>): void {
	effects.add("workspace-read");
	if (hasOption(args, ["-x", "--exec", "-X", "--exec-batch"]))
		effects.add("unknown");
	if (
		args.some((arg) =>
			["-delete", "-fprint", "-fprint0", "-fls", "-fprintf"].includes(arg),
		)
	) {
		effects.add("workspace-write");
		if (args.includes("-delete")) effects.add("destructive");
	}
}

function classifyTextFilter(
	executable: string,
	args: readonly string[],
	effects: Set<BashEffect>,
): void {
	effects.add("workspace-read");
	if (executable === "awk" || executable === "sed" || executable === "yq") {
		// These languages/options can execute commands or write files from their
		// program text. Route them conservatively unless a real sandbox owns them.
		effects.add("unknown");
	}
	if (
		(executable === "sort" && hasOption(args, ["-o", "--output"])) ||
		((executable === "sed" || executable === "yq") &&
			args.some(
				(arg) =>
					arg === "-i" || arg.startsWith("-i") || arg.startsWith("--in-place"),
			))
	)
		effects.add("workspace-write");
}

function classifyPackage(
	executable: string,
	args: readonly string[],
	effects: Set<BashEffect>,
): void {
	effects.add("repository-code");
	effects.add("workspace-write");
	const normalized = args.map((arg) => arg.toLowerCase());
	if (
		normalized.some((arg) => PACKAGE_REMOTE_MUTATIONS.has(arg)) ||
		(executable === "npm" &&
			normalized.some((arg) => ["dist-tag", "owner", "access"].includes(arg)))
	)
		effects.add("remote-write");
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

function classifyGit(args: readonly string[], effects: Set<BashEffect>): void {
	const subcommand = gitSubcommand(args);
	if (!subcommand) {
		effects.add("unknown");
		return;
	}
	if (subcommand === "config") {
		// Global/system/file-addressed config writes land in the DEVELOPER'S
		// real HOME (spawned agents share it) — the incident that motivated
		// this rule overwrote the machine-global git identity.
		if (
			args.some(
				(arg) =>
					arg === "--global" ||
					arg === "--system" ||
					arg === "--file" ||
					arg.startsWith("--file="),
			)
		) {
			effects.add("host-config-write");
		} else if (writesIdentityKey(args)) {
			// A linked worktree has no config of its own: this write lands in
			// the SHARED <repo>/.git/config and re-authors the developer's own
			// checkout. Not worktree-local state, whatever the cwd suggests.
			effects.add("git-identity-write");
		} else {
			effects.add("local-git");
			effects.add("workspace-write");
		}
		return;
	}
	if (GIT_DELIVERY.has(subcommand)) effects.add("delivery");
	else if (GIT_READ.has(subcommand)) {
		effects.add("workspace-read");
		if (args.some((arg) => arg === "--output" || arg.startsWith("--output=")))
			effects.add("workspace-write");
	} else if (GIT_LOCAL.has(subcommand)) {
		effects.add("local-git");
		effects.add("workspace-write");
		if (
			(subcommand === "reset" && args.includes("--hard")) ||
			subcommand === "clean"
		)
			effects.add("destructive");
	} else effects.add("unknown");
}

/** Read forms of `git config` — these inspect, they don't set. */
const GIT_CONFIG_READ_FLAGS = new Set([
	"--get",
	"--get-all",
	"--get-regexp",
	"--get-urlmatch",
	"--list",
	"-l",
	"--edit",
	"-e",
]);

/**
 * True when `git config` SETS or UNSETS a `user.*` key: an identity write.
 * A set is the key plus a value; `--unset`/`--replace-all` count regardless.
 */
function writesIdentityKey(args: readonly string[]): boolean {
	if (args.some((arg) => GIT_CONFIG_READ_FLAGS.has(arg))) return false;
	const positional = args
		.slice(args.indexOf("config") + 1)
		.filter((arg) => !arg.startsWith("-"))
		.map((arg) => arg.replace(/^['"]|['"]$/g, ""));
	const key = positional[0];
	if (!key || !/^user\./i.test(key)) return false;
	const unsetting = args.some(
		(arg) => arg === "--unset" || arg === "--unset-all",
	);
	return unsetting || positional.length >= 2;
}

/** Args that address the developer's real git config (shared HOME). */
function referencesHostGitConfig(args: readonly string[]): boolean {
	return args.some((arg) => {
		const value = arg.replace(/^['"]|['"]$/g, "");
		return (
			value.endsWith("/.gitconfig") ||
			value === "~/.gitconfig" ||
			value.includes("/.config/git/") ||
			value.endsWith("/.config/git")
		);
	});
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
		if (arg.startsWith("-")) continue;
		return arg;
	}
	return undefined;
}

function classifyGh(args: readonly string[], effects: Set<BashEffect>): void {
	const lower = args.map((arg) => arg.toLowerCase());
	if (lower[0] === "api") {
		const method = optionValue(lower.slice(1), ["-x", "--method"]);
		const hasBody = hasOption(lower.slice(1), [
			"-f",
			"--field",
			"-F",
			"--raw-field",
			"--input",
		]);
		const apparentGraphqlRead =
			lower[1] === "graphql" &&
			method === undefined &&
			!lower.some((arg) => /\bmutation\b/u.test(arg));
		if (
			(method && method !== "get" && method !== "head") ||
			(hasBody && !apparentGraphqlRead)
		)
			effects.add("remote-write");
		else effects.add("github-read");
		return;
	}
	const verb = lower[1];
	if (lower[0] === "workflow" && verb === "run") {
		effects.add("remote-write");
		return;
	}
	if (lower[0] === "pr" && (verb === "create" || verb === "merge")) {
		effects.add("delivery");
		return;
	}
	if (verb && GH_READS.has(verb)) {
		effects.add("github-read");
		return;
	}
	if (verb && GH_MUTATIONS.has(verb)) {
		effects.add("remote-write");
		return;
	}
	// Unknown extension/alias/subcommand behavior must never inherit read auth.
	effects.add("unknown");
}

function classifyHttp(args: readonly string[], effects: Set<BashEffect>): void {
	if (hasOption(args, ["-K", "--config"])) effects.add("unknown");
	if (isReadOnlyHttp(args)) effects.add("remote-read");
	else effects.add("remote-write");
	if (hasLocalHttpOutput(args)) effects.add("workspace-write");
}

function isReadOnlyHttp(args: readonly string[]): boolean {
	const method = optionValue(args, ["-X", "--request"]);
	const hasBody = hasOption(args, [
		"-d",
		"--data",
		"--data-raw",
		"--data-binary",
		"--data-urlencode",
		"--upload-file",
		"-T",
		"-F",
		"--form",
		"--form-string",
		"--json",
		"--post-data",
		"--post-file",
	]);
	return (!method || method === "get" || method === "head") && !hasBody;
}

function hasLocalHttpOutput(args: readonly string[]): boolean {
	return hasOption(args, [
		"-o",
		"--output",
		"-O",
		"--output-document",
		"-P",
		"--directory-prefix",
	]);
}

function optionValue(
	args: readonly string[],
	names: readonly string[],
): string | undefined {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		for (const name of names) {
			if (arg === name) return args[index + 1]?.toLowerCase();
			if (arg.startsWith(`${name}=`))
				return arg.slice(name.length + 1).toLowerCase();
			if (name.length === 2 && arg.startsWith(name) && arg.length > 2)
				return arg.slice(2).toLowerCase();
		}
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

function privilegedRoute(
	input: BashPolicyInput,
	base: Omit<BashPolicyDecision, "route" | "reason" | "confidence">,
): BashPolicyDecision {
	if (input.actor === "worker")
		return {
			...base,
			route: "deny",
			reason: "Privileged commands require parent or Hack escalation",
			confidence: "high",
			invariant: "worker-escalation",
		};
	if (
		input.policy.privilegedRemote === "deny" ||
		input.policy.privilegedRemote === "hack-only"
	)
		return {
			...base,
			route: "deny",
			reason: "Privileged remote administration is restricted to Hack",
			confidence: "high",
		};
	return {
		...base,
		route: "confirm",
		reason: "Confirm privileged remote administration",
		confidence: "high",
	};
}

function consequentialRoute(
	input: BashPolicyInput,
	base: Omit<BashPolicyDecision, "route" | "reason" | "confidence">,
	reason: string,
): BashPolicyDecision {
	if (input.actor === "worker")
		return {
			...base,
			route: "deny",
			reason: `${reason}; escalate to the parent maestro or Hack`,
			confidence: "high",
			invariant: "worker-escalation",
		};
	if (input.policy.consequential === "allow")
		return {
			...base,
			route: "direct",
			reason: `${reason}; explicitly allowed by policy`,
			confidence: "high",
		};
	return { ...base, route: "confirm", reason, confidence: "high" };
}

function unknownRoute(
	input: BashPolicyInput,
	base: Omit<BashPolicyDecision, "route" | "reason" | "confidence">,
): BashPolicyDecision {
	if (input.actor === "worker")
		return {
			...base,
			route: isolationRoute(input.policy),
			reason:
				"Unknown worker command requires configured isolation; escalate to the parent maestro or Hack when unavailable",
			confidence: "low",
			invariant: "worker-escalation",
		};
	if (input.policy.unknowns === "deny")
		return {
			...base,
			route: "deny",
			reason: "Command effects could not be determined",
			confidence: "low",
		};
	if (input.policy.unknowns === "confirm")
		return {
			...base,
			route: "confirm",
			reason: "Confirm command with unknown effects",
			confidence: "low",
		};
	return {
		...base,
		route: isolationRoute(input.policy),
		reason: "Unknown command is routed to configured isolation",
		confidence: "low",
	};
}

function isolationRoute(
	policy: ExecutionPolicySettings,
): "lightweight" | "strong" | "confirm" {
	if (policy.isolation === "strong") return "strong";
	if (policy.isolation === "lightweight") return "lightweight";
	// None is explicit but still requires a mode-aware confirmation at the
	// execution boundary; it is never an invisible fallback.
	return "confirm";
}

function deliveryReason(command: string): string {
	if (/\bgit\s+(?:[^;&|\n]*\s)?commit\b/u.test(command))
		return "Use the commit tool; Bash commits bypass the reviewed staging route";
	return "Use the ship tool; Bash delivery bypasses the reviewed shipping route";
}

function isInterpreter(executable: string): boolean {
	return /^(?:node|deno|python\d*|ruby|perl|php|tsx|ts-node)$/u.test(
		executable,
	);
}

function hasAny(
	effects: ReadonlySet<BashEffect>,
	values: readonly BashEffect[],
): boolean {
	return values.some((value) => effects.has(value));
}

function only(
	effects: ReadonlySet<BashEffect>,
	allowed: readonly BashEffect[],
): boolean {
	const set = new Set(allowed);
	return effects.size > 0 && [...effects].every((effect) => set.has(effect));
}

// ─── The visible ruleset (one source of truth, rendered into seeds) ──────────
//
// Vegard's Phase-4 rule (2026-07-20): the deny/allow table is DATA — the same
// rows the deterministic fastpath enforces are rendered into every agent's
// seed as its guiding ruleset, so agents self-avoid instead of discovering
// walls by collision. Each row's `id` names the enforcement invariant (or
// guidance mechanism) that backs it; a row without an enforcer is a lie and
// the ruleset test rejects it.

export interface BashRulesetRow {
	/** Names the enforcing invariant/mechanism in decideBashPolicy. */
	readonly id:
		| "delivery"
		| "host-config"
		| "git-identity"
		| "read-only"
		| "worker-escalation"
		| "tool-redirect";
	readonly applies: readonly BashActor[];
	/** Imperative guidance, agent-facing. */
	readonly rule: string;
	/** One-line rationale (why the wall exists). */
	readonly why: string;
}

export const BASH_RULESET: readonly BashRulesetRow[] = [
	{
		id: "delivery",
		applies: ["worker", "reviewer"],
		rule:
			"Never run `git commit`, `git push`, or `gh pr ...` from bash — " +
			"commit through the `commit` tool; pushing and PRs are the " +
			"maestro's lifecycle.",
		why: "Delivery is harness-owned so every shipped change is audited.",
	},
	{
		id: "host-config",
		applies: ["maestro", "worker", "reviewer"],
		rule:
			"Never write machine-global git config: no `git config --global` " +
			"or `--system` or `--file`, no edits to `~/.gitconfig` or " +
			"`~/.config/git/*`.",
		why: "Agents share the developer's real HOME; a global write pollutes their machine.",
	},
	{
		id: "git-identity",
		applies: ["worker", "reviewer"],
		rule:
			"Never set `user.name` or `user.email` anywhere — not globally, and " +
			"not in your worktree. Your commit identity is already in your " +
			"environment (GIT_AUTHOR_*/GIT_COMMITTER_*); just commit. If git " +
			"still asks who you are, say so instead of configuring it.",
		why:
			"A linked worktree has no config of its own — a write there lands " +
			"in the developer's shared repository config and re-authors their checkout.",
	},
	{
		id: "read-only",
		applies: ["reviewer"],
		rule:
			"You are read-only: no file writes, no repository-code execution, " +
			"no git mutations. Report findings instead of fixing.",
		why: "Review evidence must come from the work as-is.",
	},
	{
		id: "worker-escalation",
		applies: ["worker"],
		rule:
			"No remote-write, privileged, or destructive commands (installs " +
			"outside the worktree, sudo, rm -rf outside your tree, network " +
			"mutations). Ask your supervisor instead.",
		why: "Consequential effects need an accountable approver.",
	},
	{
		id: "tool-redirect",
		applies: ["maestro", "worker", "reviewer"],
		rule:
			"Prefer the dedicated tool when one exists (read/grep/find/task/" +
			"commit); trivially-equivalent bash may be denied with a pointer.",
		why: "Dedicated tools carry policy and observability bash cannot.",
	},
];

/** Render the enforced shell ruleset for one actor (seed material). */
export function renderBashRuleset(actor: BashActor): string {
	const rows = BASH_RULESET.filter((row) => row.applies.includes(actor));
	if (rows.length === 0) return "";
	const lines = rows.map((row) => `- ${row.rule}\n  (${row.why})`);
	return `## Shell rules (enforced by the harness)\n\n${lines.join("\n")}`;
}
