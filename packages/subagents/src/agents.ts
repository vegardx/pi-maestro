// Agent definitions: a named, reusable spawn recipe. The main agent's delegate
// tool resolves an agent name to its spawn profile + system-prompt addendum.
// Built-ins cover the common roles; projects add their own as markdown files
// with YAML-ish frontmatter under .pi/agents/.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface AgentDefinition {
	readonly name: string;
	readonly description?: string;
	/** Spawn profile this agent runs under (see BUILTIN_PROFILES). */
	readonly profile: string;
	readonly model?: string;
	/** Prepended to the child's system prompt (the markdown body). */
	readonly appendSystemPrompt?: string;
}

// Built-in roles. explore/plan/review are read-only (restricted); agent is a
// full deliverable-agent. These are always available without any .pi/agents.
export const BUILTIN_AGENTS: Readonly<Record<string, AgentDefinition>> = {
	explore: {
		name: "explore",
		description: "Read-only codebase exploration.",
		profile: "restricted",
	},
	plan: {
		name: "plan",
		description: "Read-only planning and analysis.",
		profile: "restricted",
	},
	review: {
		name: "review",
		description: "Read-only review of changes.",
		profile: "restricted",
		// Without a contract this role reviews by mood: 13 consecutive
		// "final final" ship-gate rounds in one session, each finding brand-new
		// blockers (go-rewrite dogfood, 2026-07-11). Severity is anchored, the
		// verdict must follow from it, and re-reviews verify prior findings
		// instead of re-hunting.
		appendSystemPrompt: `You are a read-only code reviewer. Read the change (git diff/log/show plus surrounding code), then report NUMBERED findings, each with file:line, a severity, the failing scenario, and a concrete fix.

Severity is a CONTRACT, not a mood:
- critical: must not ship — data loss, security hole, crash, silently wrong results.
- major: blocks ship — a real defect a user or caller would hit.
- minor: advisory — style, polish, nice-to-have. Minors NEVER justify BLOCK.
End with \`VERDICT: PASS\` or \`VERDICT: BLOCK\` — BLOCK iff at least one critical/major finding. Then a fenced json block: {"findings": [{"severity": "critical|major|minor", "category": "<kebab-theme>", "file": "path", "line": 123, "claim": "what should hold", "actual": "what happens"}]}.

Convergence duty — this is what makes review terminate:
- If your prompt lists PRIOR findings with resolutions, FIRST verify each one is addressed (verified / still-open, with evidence). Do not reword old findings into new ones.
- On a re-review, raise a NEW finding only if it is critical/major AND introduced since the prior round (or provably missed and severe). Scope does not grow on re-review.
- Never re-litigate findings marked waived or wont-fix.
- If asked to review the same change a third time or more, say so: recommend shipping with the remaining minors documented, or escalating the sticking points to a human — more rounds will not converge.

Your ENTIRE final message is the report; it is consumed programmatically.`,
	},
	agent: {
		name: "agent",
		description: "Full deliverable agent, worktree-bound.",
		profile: "deliverable-agent",
	},
	general: {
		name: "general",
		description:
			"General-purpose delegate for tasks with no specialized agent. " +
			"Read-only; pick model/effort per call (action: models lists the " +
			"whitelist); web: true adds websearch/webfetch/context7.",
		profile: "general",
		appendSystemPrompt:
			"You are a general-purpose delegate agent working for a maestro. Do " +
			"exactly the task in your prompt — nothing else. You are read-only: " +
			"never modify files. Your ENTIRE final message is your deliverable; " +
			"it is consumed programmatically. Be factual and complete; no " +
			"preamble, no offers to help further.",
	},
};

interface Frontmatter {
	readonly fields: Record<string, string>;
	readonly body: string;
}

/** Parse `---`-delimited key:value frontmatter; everything after is the body. */
export function parseFrontmatter(markdown: string): Frontmatter {
	const text = markdown.replace(/^\uFEFF/, "");
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { fields: {}, body: text.trim() };

	const fields: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
		if (!kv) continue;
		fields[kv[1].trim()] = stripQuotes(kv[2].trim());
	}
	return { fields, body: match[2].trim() };
}

function stripQuotes(s: string): string {
	if (
		(s.startsWith('"') && s.endsWith('"')) ||
		(s.startsWith("'") && s.endsWith("'"))
	) {
		return s.slice(1, -1);
	}
	return s;
}

/** Build an AgentDefinition from one markdown file's content. */
export function parseAgentDefinition(
	markdown: string,
	fallbackName: string,
): AgentDefinition {
	const { fields, body } = parseFrontmatter(markdown);
	return {
		name: fields.name || fallbackName,
		description: fields.description || undefined,
		profile: fields.profile || "restricted",
		model: fields.model || undefined,
		appendSystemPrompt: body || undefined,
	};
}

/**
 * Discover agents: built-ins overlaid by any `.pi/agents/*.md` files (a project
 * file with the same name wins). Missing directory => just the built-ins.
 */
export function discoverAgents(
	agentsDir: string,
): Record<string, AgentDefinition> {
	const out: Record<string, AgentDefinition> = { ...BUILTIN_AGENTS };
	if (!existsSync(agentsDir)) return out;

	for (const entry of readdirSync(agentsDir)) {
		if (!entry.endsWith(".md")) continue;
		try {
			const content = readFileSync(join(agentsDir, entry), "utf8");
			const def = parseAgentDefinition(content, basename(entry, ".md"));
			out[def.name] = def;
		} catch {
			// Skip an unreadable/garbage agent file rather than failing discovery.
		}
	}
	return out;
}
