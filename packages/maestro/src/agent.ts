// The agent model: two kinds, and what follows from being one.
//
// A kind is the one honest bit: does it write? Everything else that used to
// hang off kind — five values, a relationship enum, a persona namespace — was
// either restating this bit or restating the persona. The three reader words
// (explorer, reviewer, advisor) live on in persona titles and prose; they
// stopped being system vocabulary because they selected nothing mechanical.
//
// There is no relationship enum any more. It said who waits on whom, and that
// is now structural: a writer is tracked by the run and reports over the
// socket; a read-only agent exists only as a held session in its caller's map,
// so "created" and "someone is waiting" are the same event. The enum was the
// fence around a combination — a reader nobody waits for — that is no longer
// writable, and a rule that cannot be violated is vocabulary waiting to drift.
//
// PERSONAS ARE THE ONLY PROSE. A persona says what to look for. What an agent
// can call is generated from the tool declaration, never written next to it —
// prose that names a tool is prose that can drift from the grant, and a worker
// preamble that taught a `review` tool nobody had implemented is what that
// drift cost.

import type { Holder, ToolRegistry } from "./tool-registry.js";

/**
 * - `worker`    writes, inside its own worktree, to produce one deliverable.
 *   Authored in the plan, spawned by the run — the plan is the spawn interface
 *   for writers. Kept in the vocabulary (rather than implied) because there is
 *   a future where the seat runs a worker directly through the subagent tool.
 * - `read-only` reads and reports to whoever is holding it. What it is FOR —
 *   research, review, standby advice — is its persona's job to say.
 */
export const AGENT_KINDS = ["worker", "read-only"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

const HOLDER_OF: Readonly<Record<AgentKind, Holder>> = {
	worker: "worker",
	"read-only": "read-only",
};

/** What the kind is trusted with. The grant itself derives from this. */
export function holderOf(kind: AgentKind): Holder {
	return HOLDER_OF[kind];
}

/** Whether an agent of this kind writes anything at all. */
export function isWriter(kind: AgentKind): boolean {
	return kind === "worker";
}

export class AgentModelError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentModelError";
	}
}

/** What a caller asks for. Two fields, because everything else follows. */
export interface AgentSpec {
	readonly kind: AgentKind;
	/** The persona id — the prose that says what to look for. */
	readonly persona: string;
}

/** Everything wrong with a request for an agent. */
export function validateAgentSpec(spec: AgentSpec): string[] {
	const errors: string[] = [];

	if (!AGENT_KINDS.includes(spec.kind)) {
		errors.push(
			`unknown agent kind \`${spec.kind}\` (kinds are ${AGENT_KINDS.join(", ")})`,
		);
		return errors;
	}

	if (!spec.persona.trim())
		errors.push(`a ${spec.kind} was requested with no persona`);

	return errors;
}

export interface Persona {
	readonly id: string;
	readonly kind: AgentKind;
	/** One line, for narration: "Started review of X with <title>". */
	readonly title: string;
	/**
	 * What to look for, and how to judge it. NOT what tools exist, NOT what to
	 * call — that is generated. See `PersonaCatalogue.declare`.
	 */
	readonly prose: string;
}

const BACKTICKED = /`([^`\n]+)`/g;

/**
 * The declared personas. Like the tool registry, construction is the
 * checkpoint: a catalogue that builds is one whose every persona names a real
 * kind and teaches nothing about tools.
 */
export class PersonaCatalogue {
	private readonly byId: ReadonlyMap<string, Persona>;

	private constructor(byId: ReadonlyMap<string, Persona>) {
		this.byId = byId;
	}

	/**
	 * Build the catalogue, or throw. Rejected at construction:
	 *
	 * - an unknown kind;
	 * - a duplicate id, or empty prose, which is a persona that says nothing;
	 * - prose that names a declared tool. This is the load-bearing one: the tool
	 *   list an agent sees is generated from the declaration, so a persona
	 *   restating it introduces a second copy that can go stale — and a persona
	 *   naming a tool its own holder cannot call teaches an agent to reach for
	 *   something that will never be there.
	 */
	static declare(
		personas: readonly Persona[],
		tools: ToolRegistry,
	): PersonaCatalogue {
		const byId = new Map<string, Persona>();
		for (const persona of personas) {
			const id = persona.id?.trim();
			if (!id) throw new AgentModelError("a persona has no id");
			if (byId.has(id))
				throw new AgentModelError(
					`persona \`${id}\` is declared twice — one would win, and which depends on load order`,
				);
			if (!AGENT_KINDS.includes(persona.kind))
				throw new AgentModelError(
					`persona \`${id}\` names unknown kind \`${persona.kind}\``,
				);
			if (!persona.prose.trim())
				throw new AgentModelError(
					`persona \`${id}\` has no prose — a persona that says nothing to look for is not a persona`,
				);

			const holder = holderOf(persona.kind);
			const held = new Set(tools.grantsFor(holder));
			for (const [, token] of persona.prose.matchAll(BACKTICKED)) {
				const name = token.trim();
				if (!tools.has(name)) continue;
				throw new AgentModelError(
					held.has(name)
						? `persona \`${id}\` names the tool \`${name}\`. The tool list is generated from the declaration and handed to the agent already — a persona says what to look for, never what to call.`
						: `persona \`${id}\` names the tool \`${name}\`, which a ${persona.kind} does not hold. It would be teaching an agent to reach for something that will never be there.`,
				);
			}

			byId.set(id, persona);
		}
		return new PersonaCatalogue(byId);
	}

	ids(): readonly string[] {
		return [...this.byId.keys()];
	}

	has(id: string): boolean {
		return this.byId.has(id);
	}

	/** Resolve a persona id, or throw. The only string→persona path. */
	require(id: string): Persona {
		const found = this.byId.get(id);
		if (!found)
			throw new AgentModelError(
				`no persona named \`${id}\` is declared (declared: ${this.ids().join(", ") || "none"})`,
			);
		return found;
	}

	/** Every persona a kind can be given, for authoring and for narration. */
	forKind(kind: AgentKind): readonly Persona[] {
		return [...this.byId.values()].filter((p) => p.kind === kind);
	}
}

/**
 * What an agent is actually started with: its persona's prose, then the tools
 * it holds, generated. Assembled in one place so the two halves cannot be
 * composed inconsistently by whoever happens to be spawning.
 */
export function brief(
	spec: AgentSpec,
	personas: PersonaCatalogue,
	tools: ToolRegistry,
	assignment: string,
): string {
	const errors = validateAgentSpec(spec);
	if (errors.length > 0) throw new AgentModelError(errors.join("; "));

	const persona = personas.require(spec.persona);
	if (persona.kind !== spec.kind)
		throw new AgentModelError(
			`persona \`${persona.id}\` is for a ${persona.kind}, not a ${spec.kind}`,
		);

	return [
		persona.prose.trim(),
		tools.describeFor(holderOf(spec.kind)),
		`## What you are doing\n\n${assignment.trim()}`,
	].join("\n\n");
}
