// v2 personas-as-skills: a persona is a markdown file — frontmatter for the
// machine (agent-type registration, contract, always-loaded skills), body as
// the system prompt in situated voice. Personas are PURE behavior: no tools,
// no models, no workspace opinions — those derive from the agent type.
//
// Three layers, later shadowing earlier BY NAME:
//   bundled  packages/subagents/personas/*.md   (ships with the harness)
//   user     <agentDir>/personas/*.md           (~/.config/pi/agent)
//   project  <cwd>/.pi/personas/*.md
//
// Registration is the join between free prose and enforcement: `agents:` and
// `contract:` must reference harness-owned ids, checked at LOAD time — a
// typo'd persona is skipped with a visible error, never discovered at spawn.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CONTRACT_IDS,
	type ContractId,
	SPAWNABLE_AGENT_TYPES,
	type SpawnableAgentType,
} from "@vegardx/pi-contracts";

export type PersonaSource = "bundled" | "user" | "project";

export interface Persona {
	readonly name: string;
	/** Agent types this persona may run on. */
	readonly agents: readonly SpawnableAgentType[];
	/** The return contract its runs fulfill. */
	readonly contract: ContractId;
	/** Skills always loaded with this persona (unioned with the plan node's). */
	readonly skills: readonly string[];
	/** The system prompt (the markdown body, frontmatter stripped). */
	readonly prompt: string;
	readonly source: PersonaSource;
	readonly path: string;
}

export interface PersonaRegistry {
	readonly personas: ReadonlyMap<string, Persona>;
	/** Load-time failures (bad frontmatter, unknown ids) — fail-visible. */
	readonly errors: readonly string[];
}

/** Which contracts each agent type's personas may declare. */
export const CONTRACTS_BY_AGENT: Readonly<
	Record<SpawnableAgentType, readonly ContractId[]>
> = {
	worker: ["summary-and-diff"],
	explorer: ["report"],
	reviewer: ["findings", "plan-gate-report"],
	advisor: ["report"],
};

const AGENT_SET = new Set<string>(SPAWNABLE_AGENT_TYPES);
const CONTRACT_SET = new Set<string>(CONTRACT_IDS);

/** The bundled personas shipped with the harness. */
export function bundledPersonasDir(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "personas");
}

function userPersonasDir(agentDir?: string): string {
	const base =
		agentDir ??
		process.env.PI_CODING_AGENT_DIR ??
		join(homedir(), ".config", "pi", "agent");
	return join(base, "personas");
}

interface Frontmatter {
	readonly fields: Record<string, string | string[]>;
	readonly body: string;
}

/**
 * Minimal frontmatter parser: `key: value` and `key: [a, b]` lines between
 * `---` fences. Deliberately tiny — persona frontmatter is four known keys,
 * not general YAML.
 */
export function parsePersonaFrontmatter(raw: string): Frontmatter | null {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return null;
	const fields: Record<string, string | string[]> = {};
	for (const line of match[1].split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const colon = trimmed.indexOf(":");
		if (colon <= 0) return null;
		const key = trimmed.slice(0, colon).trim();
		const value = trimmed.slice(colon + 1).trim();
		if (value.startsWith("[") && value.endsWith("]")) {
			fields[key] = value
				.slice(1, -1)
				.split(",")
				.map((item) => item.trim())
				.filter((item) => item.length > 0);
		} else {
			fields[key] = value;
		}
	}
	return { fields, body: match[2].trim() };
}

function parsePersona(
	path: string,
	source: PersonaSource,
): { persona?: Persona; error?: string } {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (cause) {
		return {
			error: `${path}: unreadable (${cause instanceof Error ? cause.message : String(cause)})`,
		};
	}
	const parsed = parsePersonaFrontmatter(raw);
	if (!parsed)
		return { error: `${path}: missing or malformed --- frontmatter` };
	const { fields, body } = parsed;
	const name =
		typeof fields.name === "string" && fields.name.length > 0
			? fields.name
			: basename(path).replace(/\.md$/, "");
	const agentsRaw = Array.isArray(fields.agents)
		? fields.agents
		: typeof fields.agents === "string" && fields.agents
			? [fields.agents]
			: [];
	if (agentsRaw.length === 0)
		return { error: `${path}: agents registration is required` };
	for (const agent of agentsRaw) {
		if (!AGENT_SET.has(agent))
			return {
				error: `${path}: unknown agent type ${agent} (spawnable types: ${SPAWNABLE_AGENT_TYPES.join(", ")})`,
			};
	}
	const agents = agentsRaw as SpawnableAgentType[];
	const contract = fields.contract;
	if (typeof contract !== "string" || !CONTRACT_SET.has(contract))
		return {
			error: `${path}: contract must be one of ${CONTRACT_IDS.join(", ")}`,
		};
	for (const agent of agents) {
		if (!CONTRACTS_BY_AGENT[agent].includes(contract as ContractId))
			return {
				error: `${path}: contract ${contract} is not valid for agent type ${agent} (allowed: ${CONTRACTS_BY_AGENT[agent].join(", ")})`,
			};
	}
	const skills = Array.isArray(fields.skills)
		? fields.skills
		: typeof fields.skills === "string" && fields.skills
			? [fields.skills]
			: [];
	if (!body) return { error: `${path}: persona body (the prompt) is empty` };
	return {
		persona: {
			name,
			agents,
			contract: contract as ContractId,
			skills,
			prompt: body,
			source,
			path,
		},
	};
}

function loadLayer(
	dir: string,
	source: PersonaSource,
	into: Map<string, Persona>,
	errors: string[],
): void {
	if (!existsSync(dir)) return;
	let entries: string[];
	try {
		entries = readdirSync(dir).filter((entry) => entry.endsWith(".md"));
	} catch {
		return;
	}
	for (const entry of entries.sort()) {
		const { persona, error } = parsePersona(join(dir, entry), source);
		if (error) errors.push(error);
		// Later layers shadow earlier ones by name — that is the point.
		else if (persona) into.set(persona.name, persona);
	}
}

export interface LoadPersonasOptions {
	readonly cwd: string;
	readonly agentDir?: string;
	/** Override the bundled dir (tests). */
	readonly bundledDir?: string;
}

/** Load all three layers. Bad files are skipped with visible errors. */
export function loadPersonas(opts: LoadPersonasOptions): PersonaRegistry {
	const personas = new Map<string, Persona>();
	const errors: string[] = [];
	loadLayer(
		opts.bundledDir ?? bundledPersonasDir(),
		"bundled",
		personas,
		errors,
	);
	loadLayer(userPersonasDir(opts.agentDir), "user", personas, errors);
	loadLayer(join(opts.cwd, ".pi", "personas"), "project", personas, errors);
	return { personas, errors };
}

/** Personas registered for an agent type, in name order. */
export function personasForAgent(
	registry: PersonaRegistry,
	agent: SpawnableAgentType,
): readonly Persona[] {
	return [...registry.personas.values()]
		.filter((persona) => persona.agents.includes(agent))
		.sort((a, b) => a.name.localeCompare(b.name));
}
