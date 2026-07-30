// The agent model: five kinds, and what follows from being one.
//
// Almost nothing here is authored. A kind determines what an agent may hold and
// how its caller relates to it, so an author cannot describe an incoherent
// agent — there is no combination of fields to get wrong, because there are
// barely any fields. The old model had fifteen kinds, each restating its own
// grants, its own prose and its own lifecycle, and they disagreed.
//
// PERSONAS ARE THE ONLY PROSE. A persona says what to look for. What an agent
// can call is generated from the tool declaration, never written next to it —
// prose that names a tool is prose that can drift from the grant, and a worker
// preamble that taught a `review` tool nobody had implemented is what that
// drift cost.

import type { Holder, ToolRegistry } from "./tool-registry.js";

/**
 * - `maestro`  the session the human drives. Never spawned: it is the thing
 *   that spawns, and a maestro that could produce a maestro would have no
 *   answer to who owns the run.
 * - `worker`   writes, inside its own worktree, to produce one deliverable.
 * - `explorer` reads and reports back: research before the work exists.
 * - `reviewer` reads and reports back: judgement after a diff exists.
 * - `advisor`  reads and stays available to be asked.
 */
export const AGENT_KINDS = [
	"maestro",
	"worker",
	"explorer",
	"reviewer",
	"advisor",
] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/**
 * How the caller relates to the agent. DERIVED from the kind, never authored —
 * this is the difference between the kinds, so letting an author set it
 * independently would let them write an explorer that is an advisor.
 *
 * The spawner switches on this rather than on kind: five kinds, three
 * mechanisms.
 */
export const RELATIONSHIPS = ["blocking", "consultable", "autonomous"] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

/** How wide. Intent only — never a model, never a count. */

const HOLDER_OF: Readonly<Record<AgentKind, Holder>> = {
	maestro: "maestro",
	worker: "worker",
	explorer: "read-only",
	reviewer: "read-only",
	advisor: "read-only",
};

const RELATIONSHIP_OF: Readonly<Record<AgentKind, Relationship>> = {
	// Nobody waits on the maestro; the human does.
	maestro: "autonomous",
	// Maestro launches it and gets on with the rest of the DAG. It reports
	// through its worktree and its hand-off, not by being awaited.
	worker: "autonomous",
	explorer: "blocking",
	reviewer: "blocking",
	advisor: "consultable",
};

/** What the kind is trusted with. The grant itself derives from this. */
export function holderOf(kind: AgentKind): Holder {
	return HOLDER_OF[kind];
}

export function relationshipOf(kind: AgentKind): Relationship {
	return RELATIONSHIP_OF[kind];
}

/** Whether an agent of this kind writes anything at all. */
export function isWriter(kind: AgentKind): boolean {
	return holderOf(kind) !== "read-only";
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

/**
 * Everything wrong with a request for an agent.
 *
 * The rule worth reading is the read-only one. An agent that reads and reports
 * needs someone to report to; `autonomous` means nobody is waiting, so its
 * findings go nowhere. That is not a hypothetical — a review panel once
 * produced six real findings, including a silent-pass bug, that reached a PR
 * body reading "(agent produced no summary)". Deriving the relationship from
 * the kind is what makes that combination unwritable.
 */
export function validateAgentSpec(spec: AgentSpec): string[] {
	const errors: string[] = [];

	if (!AGENT_KINDS.includes(spec.kind)) {
		errors.push(
			`unknown agent kind \`${spec.kind}\` (kinds are ${AGENT_KINDS.join(", ")})`,
		);
		return errors;
	}

	if (spec.kind === "maestro")
		errors.push(
			"a maestro is never spawned — it is the session that spawns, and a maestro producing a maestro leaves nobody owning the run",
		);

	if (!spec.persona.trim())
		errors.push(`a ${spec.kind} was requested with no persona`);

	// No `topology` check. It was a second vocabulary for fanning out —
	// validated here, and set by NOTHING: the real axis is `Delegation.fanOut`
	// plus model routing, which is what `delegate` actually reads. Two ways to
	// say one thing, one of which nobody could reach.

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
	 * - an unknown kind, or a persona for a maestro — there is nothing to spawn;
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
			if (persona.kind === "maestro")
				throw new AgentModelError(
					`persona \`${id}\` is for a maestro, which is never spawned`,
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
