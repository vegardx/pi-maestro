// Tools, declared once.
//
// THE DEFECT THIS EXISTS TO PREVENT. A tool's identity used to live in four
// unrelated places: the implementation, a grant list, the prose that taught it,
// and a docs check. Nothing reconciled them, so they drifted — and the drift was
// silent. `review` was granted in two lists and taught in four sections of the
// worker preamble, and no tool of that name has ever existed. A live worker
// session shows the result: it never called it, no error was raised, and code
// review simply did not happen. `createAgentTool` had the mirror defect —
// written, exported, unit-tested, never registered.
//
// So a declaration is the ONLY place a tool's name exists. Grants derive from
// it, the agent-facing description generates from it, and callers resolve
// through it. There is no second list to fall out of step with, because there is
// no second list.

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * What an agent is trusted with. Coarser than the agent kinds on purpose: five
 * kinds share three postures, and it is the posture that decides tool access.
 *
 * - `maestro`  the session the human drives; the only writer outside a worktree
 * - `worker`   writes, but only inside its own worktree
 * - `read-only` explorers, reviewers, advisors: read and report, never write
 */
export const HOLDERS = ["maestro", "worker", "read-only"] as const;
export type Holder = (typeof HOLDERS)[number];

export interface ToolDeclaration {
	/** The tool itself. Its `name` is the identity used everywhere else. */
	readonly definition: ToolDefinition;
	/**
	 * Postures that may hold this tool. Not a default and not a hint — a posture
	 * absent from this list cannot be granted the tool by any other route.
	 */
	readonly holders: readonly Holder[];
}

export class ToolDeclarationError extends Error {
	constructor(message: string) {
		super(`tool declaration: ${message}`);
		this.name = "ToolDeclarationError";
	}
}

const HOLDER_SET = new Set<string>(HOLDERS);

/**
 * The declared tool set. Construction is the checkpoint: a registry that builds
 * is a registry whose every tool is implemented and reachable, so downstream
 * code never has to wonder.
 */
export class ToolRegistry {
	private readonly byName: ReadonlyMap<string, ToolDeclaration>;

	private constructor(byName: ReadonlyMap<string, ToolDeclaration>) {
		this.byName = byName;
	}

	/**
	 * Build the registry, or throw. Rejected at construction:
	 *
	 * - a declaration with no implementation, or an unnamed one — the `review`
	 *   defect, where a name was granted and nothing stood behind it;
	 * - a tool no posture may hold — the same defect inverted, and just as dead:
	 *   implemented, unreachable, and invisible until someone goes looking;
	 * - a duplicate name — one implementation silently wins, and which one
	 *   depends on load order;
	 * - an unknown posture, which would otherwise grant nothing while reading
	 *   like it grants something;
	 * - a summary that opens with the tool's own name. `describeFor` prepends
	 *   the name, so such a summary renders as `- finish — finish — report…`.
	 *   Every one of them did. It is cosmetic until you remember that this text
	 *   is the ONLY description of its tools an agent gets, and that a brief
	 *   which reads like a formatting bug is a brief an agent trusts less.
	 *   Rejected rather than stripped: the name is the list's job, not the
	 *   summary's, and stripping would let the habit persist unseen.
	 */
	static declare(declarations: readonly ToolDeclaration[]): ToolRegistry {
		const byName = new Map<string, ToolDeclaration>();
		for (const declaration of declarations) {
			const name = declaration.definition?.name;
			if (!name || name.trim().length === 0)
				throw new ToolDeclarationError(
					"a declaration has no implementation to stand behind it",
				);
			if (byName.has(name))
				throw new ToolDeclarationError(
					`\`${name}\` is declared twice — one implementation would win, and which depends on load order`,
				);
			if (declaration.holders.length === 0)
				throw new ToolDeclarationError(
					`\`${name}\` names no holder, so nothing can ever call it`,
				);
			for (const holder of declaration.holders)
				if (!HOLDER_SET.has(holder))
					throw new ToolDeclarationError(
						`\`${name}\` names unknown holder \`${holder}\` (holders are ${HOLDERS.join(", ")})`,
					);
			if (summaryOf(declaration).toLowerCase().startsWith(`${name} `))
				throw new ToolDeclarationError(
					`\`${name}\`'s summary opens with its own name — \`describeFor\` already prepends it, so it renders as "- ${name} — ${name} — …". Say what it does, not what it is called.`,
				);
			byName.set(name, declaration);
		}
		return new ToolRegistry(byName);
	}

	/** Every declared name, in declaration order. */
	names(): readonly string[] {
		return [...this.byName.keys()];
	}

	has(name: string): boolean {
		return this.byName.has(name);
	}

	/**
	 * Resolve a name, or throw. This is the only way to turn a string into a
	 * tool, which is what stops a phantom name travelling any further.
	 */
	require(name: string): ToolDeclaration {
		const found = this.byName.get(name);
		if (!found)
			throw new ToolDeclarationError(
				`no tool named \`${name}\` is declared (declared: ${this.names().join(", ") || "none"})`,
			);
		return found;
	}

	/** The tools a posture holds — DERIVED, never authored alongside. */
	grantsFor(holder: Holder): readonly string[] {
		return [...this.byName.values()]
			.filter((d) => d.holders.includes(holder))
			.map((d) => d.definition.name);
	}

	definitionsFor(holder: Holder): readonly ToolDefinition[] {
		return [...this.byName.values()]
			.filter((d) => d.holders.includes(holder))
			.map((d) => d.definition);
	}

	/**
	 * The agent-facing tool list, generated. Personas never restate this: prose
	 * that names a tool is prose that can drift from the grant, which is the
	 * whole defect. Prompt prose says what to do; this says what the seat holds.
	 */
	describeFor(holder: Holder): string {
		const lines = [...this.byName.values()]
			.filter((d) => d.holders.includes(holder))
			.map((d) => `- ${d.definition.name} — ${summaryOf(d)}`);
		return lines.length > 0
			? `## Your tools\n\n${lines.join("\n")}`
			: "## Your tools\n\n(none)";
	}
}

/**
 * The one line an agent reads about a tool.
 *
 * `promptSnippet` when there is one, else the first sentence of the
 * description. Defined once so the check at declaration time and the text at
 * render time cannot disagree about which string is the summary — the mistake
 * this whole file exists to prevent, in miniature.
 */
function summaryOf(declaration: ToolDeclaration): string {
	return (
		declaration.definition.promptSnippet?.trim() ||
		firstSentence(declaration.definition.description)
	);
}

function firstSentence(text: string | undefined): string {
	const trimmed = (text ?? "").trim();
	if (trimmed.length === 0) return "(no description)";
	const stop = trimmed.search(/\.\s|\.$/);
	return stop === -1 ? trimmed : trimmed.slice(0, stop + 1);
}
