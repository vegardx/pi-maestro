// Bash intent classifier — determines what a bash command is trying to do
// and suggests better tools when available.
//
// Two-tier:
// 1. Fast path (regex): obvious read-only or obviously mutating
// 2. LLM path: ambiguous commands get classified by a model

import { type SpawnFn, spawnCleanPi } from "./lenses/index.js";

export interface BashIntent {
	readonly allowed: boolean;
	/** If not allowed, why. */
	readonly reason?: string;
	/** If the intent maps to a built-in tool, which one. */
	readonly suggestedTool?: string;
	/** Human-readable description of what the command does. */
	readonly intent?: string;
}

// ─── Fast path: obviously safe patterns ────────────────────────────────────

const CLEARLY_READONLY = new Set([
	"ls",
	"cat",
	"head",
	"tail",
	"wc",
	"find",
	"fd",
	"grep",
	"rg",
	"tree",
	"file",
	"stat",
	"du",
	"df",
	"which",
	"type",
	"echo",
	"printf",
	"date",
	"env",
	"printenv",
	"pwd",
	"whoami",
	"hostname",
	"uname",
]);

const READONLY_GIT_PATTERN =
	/^git\s+(?:status|diff|log|show|branch(?:\s+(?:--show-current|-vv|--list|-a|-r))?|rev-parse|remote\s+-v|ls-files|grep|describe|shortlog|blame|tag\s*$|tag\s+--list)\b/;

const READONLY_GH_PATTERN =
	/^gh\s+(?:pr\s+(?:view|list|checks|diff)|issue\s+(?:view|list)|repo\s+(?:view)|run\s+(?:view|list|watch)|api\s+.*--method\s+GET)\b/;

const READONLY_PACKAGE_PATTERN =
	/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|vitest|tsc|build)\b/;

const CLEARLY_MUTATING_PATTERNS: readonly RegExp[] = [
	/\b(rm|rmdir)\s+(-[rf]+\s+)?\//, // rm with absolute paths
	/\b(rm|rmdir)\s+-rf\b/, // rm -rf
	/(>|>>)\s*\S+/, // shell redirection writes
	/\bgit\s+(push|commit|reset\s+--hard|clean\s+-fd)\b/, // destructive git
	/\b(docker|podman)\s+(rm|rmi|system\s+prune)\b/, // container destruction
	/\b(drop|truncate|delete\s+from)\b/i, // SQL mutations
];

/**
 * Fast-path classification. Returns a definitive answer for obvious cases,
 * or null when the command is ambiguous and needs LLM classification.
 */
export function classifyBashFast(command: string): BashIntent | null {
	const trimmed = command.trim();
	if (!trimmed) return { allowed: true, intent: "empty command" };

	// Pipe chains: classify by first command (the data source)
	const firstCmd = trimmed.split(/\s*\|\s*/)[0].trim();
	const firstWord = firstCmd.split(/\s+/)[0];

	// ─── Redirect to better tools (fast deny with suggestion) ────────────

	// cat/head/tail/less → read tool
	if (/^(cat|head|tail|less|more|bat)\s/.test(trimmed)) {
		return {
			allowed: false,
			reason: "Use the read tool instead of cat/head/tail.",
			suggestedTool: "read",
			intent: "reading a file",
		};
	}

	// grep/rg/ag → grep tool
	if (/^(grep|rg|ag|ack)\s/.test(trimmed) && !/(\||>)/.test(trimmed)) {
		return {
			allowed: false,
			reason: "Use the grep tool instead of grep/rg.",
			suggestedTool: "grep",
			intent: "searching file contents",
		};
	}

	// find/fd → find tool
	if (/^(find|fd)\s/.test(trimmed) && !/-exec\b/.test(trimmed)) {
		return {
			allowed: false,
			reason: "Use the find tool instead of find/fd.",
			suggestedTool: "find",
			intent: "finding files",
		};
	}

	// ls → ls tool
	if (/^ls(\s|$)/.test(trimmed)) {
		return {
			allowed: false,
			reason: "Use the ls tool instead.",
			suggestedTool: "ls",
			intent: "listing directory",
		};
	}

	// curl/wget → webfetch tool
	if (/^(curl|wget)\s/.test(trimmed)) {
		return {
			allowed: false,
			reason: "Use the webfetch tool instead of curl/wget.",
			suggestedTool: "webfetch",
			intent: "fetching a URL",
		};
	}

	// ─── Clearly allowed (no better tool, genuinely needs bash) ──────────

	// Read-only git
	if (READONLY_GIT_PATTERN.test(trimmed)) {
		return { allowed: true, intent: "read-only git" };
	}

	// Read-only gh
	if (READONLY_GH_PATTERN.test(trimmed)) {
		return { allowed: true, intent: "read-only gh" };
	}

	// Read-only package commands (test, lint, etc.)
	if (READONLY_PACKAGE_PATTERN.test(trimmed)) {
		return { allowed: true, intent: "read-only package script" };
	}

	// Text processing without in-place edit
	if (/^(jq|yq|awk|sed)\s/.test(trimmed) && !/-i\b/.test(trimmed)) {
		return { allowed: true, intent: "text processing (no in-place edit)" };
	}

	// wc, file, stat, du, df, which, type, echo, printf, date, env, etc.
	if (CLEARLY_READONLY.has(firstWord)) {
		return { allowed: true, intent: `read-only: ${firstWord}` };
	}

	// ─── Clearly denied (destructive) ───────────────────────────────────

	// Clearly destructive
	for (const pattern of CLEARLY_MUTATING_PATTERNS) {
		if (pattern.test(trimmed)) {
			return {
				allowed: false,
				reason: "command is clearly destructive",
			};
		}
	}

	// Node/python/ruby running inline scripts — could be anything
	if (/^(node|python\d*|ruby|deno|bun)\s+(-e|--eval|-c)\b/.test(trimmed)) {
		return null; // ambiguous — needs LLM
	}

	// Ambiguous — needs LLM classification
	return null;
}

// ─── LLM classification ────────────────────────────────────────────────────

const CLASSIFIER_PROMPT = `You are a bash command classifier. Given a command, determine:
1. Is it read-only (only reads data, no side effects)?
2. Could it be done with a built-in tool instead?

Built-in tools available:
- read(path) — read a file
- grep(pattern, path) — search file contents
- find(path, pattern) — find files
- ls(path) — list directory
- webfetch(url) — fetch a URL

Respond with ONLY a JSON object:
{"allowed": true/false, "reason": "why not allowed", "suggestedTool": "tool_name or null", "intent": "one-line description"}

If the command is read-only, set allowed=true.
If it mutates state (writes files, changes git state, installs packages, modifies system), set allowed=false with reason.
If a built-in tool would be better, set suggestedTool.`;

/**
 * Classify a bash command using an LLM. Used for ambiguous commands
 * that the fast path can't determine.
 */
export async function classifyBashWithLLM(
	command: string,
	opts?: { model?: string; cwd?: string; spawnFn?: SpawnFn },
): Promise<BashIntent> {
	const spawnFn = opts?.spawnFn ?? spawnCleanPi;
	const args = [
		"--mode",
		"json",
		"--system-prompt",
		CLASSIFIER_PROMPT,
		...(opts?.model ? ["--model", opts.model] : []),
		"-p",
		`Classify this bash command:\n\`\`\`\n${command}\n\`\`\``,
	];

	const result = await spawnFn(args, { cwd: opts?.cwd ?? process.cwd() });
	if (result.exitCode !== 0) {
		// LLM failed — fall back to blocking (safe default)
		return {
			allowed: false,
			reason: "classifier unavailable, blocking by default",
		};
	}

	try {
		const parsed = parseClassifierOutput(result.stdout);
		return parsed;
	} catch {
		return {
			allowed: false,
			reason: "classifier output unparseable, blocking by default",
		};
	}
}

function parseClassifierOutput(stdout: string): BashIntent {
	// Parse JSONL event stream — find the last assistant text
	let text = "";
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const obj = JSON.parse(trimmed);
			if (obj?.type === "message" && obj?.message?.role === "assistant") {
				const content = obj.message.content;
				if (Array.isArray(content)) {
					for (const block of content) {
						if (block.type === "text") text = block.text;
					}
				} else if (typeof content === "string") {
					text = content;
				}
			}
		} catch {}
	}

	if (!text) throw new Error("no assistant output");

	// Extract JSON from the text (might be wrapped in markdown fences)
	const jsonMatch = text.match(/\{[^}]+\}/);
	if (!jsonMatch) throw new Error("no JSON found");

	const parsed = JSON.parse(jsonMatch[0]);
	return {
		allowed: Boolean(parsed.allowed),
		reason: parsed.reason ?? undefined,
		suggestedTool: parsed.suggestedTool ?? undefined,
		intent: parsed.intent ?? undefined,
	};
}

// ─── Combined classifier ───────────────────────────────────────────────────

/**
 * Classify a bash command: fast path first, LLM fallback for ambiguous cases.
 * Returns the intent with allowed/blocked status and optional tool suggestion.
 */
export async function classifyBashIntent(
	command: string,
	opts?: { model?: string; cwd?: string; spawnFn?: SpawnFn },
): Promise<BashIntent> {
	// Fast path — no LLM needed
	const fast = classifyBashFast(command);
	if (fast !== null) return fast;

	// Ambiguous — ask the LLM
	return classifyBashWithLLM(command, opts);
}
