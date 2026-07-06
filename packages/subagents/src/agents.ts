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
// full deliverable-worker. These are always available without any .pi/agents.
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
	},
	agent: {
		name: "agent",
		description: "Full deliverable agent, worktree-bound.",
		profile: "deliverable-worker",
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
