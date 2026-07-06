import type { ModeName } from "@vegardx/pi-contracts";

export const PLAN_TOOL_NAMES = ["group", "task", "agent", "plan"] as const;

const READ_ONLY_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"websearch",
	"webfetch",
	"plan",
]);

const ALWAYS_ALLOWED_TOOLS = new Set(["ask", "suggest_next_prompt"]);

export interface ToolPolicyInput {
	readonly mode: ModeName;
	readonly availableTools: readonly string[];
	/** User/session tool set captured before modes narrows it. */
	readonly baselineTools?: readonly string[];
}

export function computeActiveTools(input: ToolPolicyInput): string[] {
	const available = new Set(input.availableTools);
	const baseline = input.baselineTools?.length
		? input.baselineTools.filter((t) => available.has(t))
		: input.availableTools;

	if (input.mode === "hack") return [...baseline];

	// plan + auto: read-only + plan tools + bash (gated by classifier) + always-allowed
	const allowed = new Set([
		...READ_ONLY_TOOLS,
		...PLAN_TOOL_NAMES,
		...ALWAYS_ALLOWED_TOOLS,
		"bash",
	]);
	return input.availableTools.filter((name) => allowed.has(name));
}

export interface BashClassification {
	readonly readOnly: boolean;
	readonly reason?: string;
}

const READONLY_FIRST_WORDS = new Set([
	"pwd",
	"ls",
	"find",
	"fd",
	"rg",
	"grep",
	"cat",
	"head",
	"tail",
	"wc",
	"git",
	"gh",
	"npm",
	"pnpm",
	"yarn",
	"bun",
]);

const REDIRECTION_WRITE = /(^|\s)(>|>>|2>|&>)\s*\S+/;

const MUTATING_PATTERNS: readonly RegExp[] = [
	/(^|\s)(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln)\b/,
	/(^|\s)(git)\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|branch|tag|stash|clean|worktree\s+add|worktree\s+remove)\b/,
	/(^|\s)(gh)\s+(pr\s+(create|merge|close|edit)|issue\s+(create|edit|close)|repo\s+(create|edit|delete)|api\s+.*(--method|-X)\s*(POST|PUT|PATCH|DELETE))\b/i,
	/(^|\s)(npm|pnpm|yarn|bun)\s+(install|i|add|remove|uninstall|update|ci|publish|version)\b/,
	/(^|\s)(sed)\s+.*\s-i(\s|$)/,
	/(^|\s)(perl|ruby|python\d*)\s+.*\s-(?:p?i|i)(\s|$)/,
];

const READONLY_GIT =
	/^git\s+(?:status\b|diff\b|log\b|show\b|branch\s*$|branch\s+(?:--show-current|-vv)\b|rev-parse\b|remote\s+-v\b|ls-files\b|grep\b|describe\b)/;
const READONLY_PACKAGE =
	/^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|check|lint|typecheck|vitest|tsc)\b/;
const READONLY_GH =
	/^gh\s+(pr\s+(view|list|checks)|issue\s+(view|list)|repo\s+view|run\s+(view|list|watch))\b/;

export function classifyBash(command: string): BashClassification {
	const trimmed = command.trim();
	if (!trimmed) return { readOnly: true };
	if (REDIRECTION_WRITE.test(trimmed)) {
		return { readOnly: false, reason: "command writes via shell redirection" };
	}
	if (READONLY_GIT.test(trimmed)) return { readOnly: true };
	if (READONLY_GH.test(trimmed)) return { readOnly: true };
	if (READONLY_PACKAGE.test(trimmed)) return { readOnly: true };
	for (const pattern of MUTATING_PATTERNS) {
		if (pattern.test(trimmed)) {
			return { readOnly: false, reason: "command appears to mutate state" };
		}
	}
	const first = trimmed.split(/\s+/, 1)[0] ?? "";
	if (READONLY_FIRST_WORDS.has(first)) return { readOnly: true };
	return {
		readOnly: false,
		reason: `\`${first}\` is not in the plan-mode read-only allowlist`,
	};
}

export function toolBlockedInPlanMode(toolName: string): string | null {
	if (toolName === "bash") return null;
	if (
		READ_ONLY_TOOLS.has(toolName) ||
		PLAN_TOOL_NAMES.includes(toolName as never)
	) {
		return null;
	}
	if (ALWAYS_ALLOWED_TOOLS.has(toolName)) return null;
	return `tool \`${toolName}\` is disabled in plan mode`;
}
