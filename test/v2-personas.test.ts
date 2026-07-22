// Personas-as-skills: frontmatter parsing, load-time registration validation
// (agents/contract are harness ids — typos fail at load, never at spawn),
// three-layer precedence (bundled → user → project, shadowing by name), and
// the bundled playbooks themselves loading clean.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	bundledPersonasDir,
	loadPersonas,
	parsePersonaFrontmatter,
	personasForAgent,
} from "../packages/subagents/src/personas.js";

let cwd: string;
let agentDir: string;

function writePersona(dir: string, file: string, content: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, file), content);
}

const MINIMAL = (name: string, agents = "[worker]") =>
	`---\nname: ${name}\nagents: ${agents}\ncontract: summary-and-diff\n---\n\nYou are ${name}.\n`;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "personas-"));
	agentDir = join(cwd, "agent-home");
	mkdirSync(agentDir, { recursive: true });
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("frontmatter parsing", () => {
	it("parses scalar and inline-array fields, strips the body", () => {
		const parsed = parsePersonaFrontmatter(
			"---\nname: coder\nagents: [worker, explorer]\nskills: [a, b]\n---\nThe prompt.",
		);
		expect(parsed?.fields.name).toBe("coder");
		expect(parsed?.fields.agents).toEqual(["worker", "explorer"]);
		expect(parsed?.fields.skills).toEqual(["a", "b"]);
		expect(parsed?.body).toBe("The prompt.");
	});

	it("returns null without a frontmatter fence", () => {
		expect(parsePersonaFrontmatter("just a prompt")).toBeNull();
	});
});

describe("load-time validation", () => {
	it("rejects unknown agent types, contracts, and mismatched pairs", () => {
		const dir = join(cwd, ".pi", "personas");
		writePersona(
			dir,
			"bad-agent.md",
			"---\nagents: [caller]\ncontract: verdict\n---\nprompt\n",
		);
		writePersona(
			dir,
			"bad-contract.md",
			"---\nagents: [worker]\ncontract: nope\n---\nprompt\n",
		);
		writePersona(
			dir,
			"mismatch.md",
			"---\nagents: [worker]\ncontract: findings\n---\nprompt\n",
		);
		writePersona(
			dir,
			"empty-body.md",
			"---\nagents: [worker]\ncontract: summary-and-diff\n---\n\n",
		);
		const registry = loadPersonas({
			cwd,
			agentDir,
			bundledDir: join(cwd, "no-bundled"),
		});
		expect(registry.personas.size).toBe(0);
		expect(registry.errors).toHaveLength(4);
		expect(registry.errors.join(" ")).toContain("unknown agent type caller");
		expect(registry.errors.join(" ")).toContain("contract must be one of");
		expect(registry.errors.join(" ")).toContain(
			"not valid for agent type worker",
		);
		expect(registry.errors.join(" ")).toContain("body");
	});

	it("a bad persona never hides the good ones", () => {
		const dir = join(cwd, ".pi", "personas");
		writePersona(dir, "good.md", MINIMAL("good"));
		writePersona(dir, "broken.md", "no frontmatter at all");
		const registry = loadPersonas({
			cwd,
			agentDir,
			bundledDir: join(cwd, "no-bundled"),
		});
		expect(registry.personas.has("good")).toBe(true);
		expect(registry.errors).toHaveLength(1);
	});
});

describe("precedence", () => {
	it("project shadows user shadows bundled, by name", () => {
		const bundled = join(cwd, "bundled");
		writePersona(bundled, "coder.md", MINIMAL("coder"));
		writePersona(bundled, "researcher.md", MINIMAL("researcher"));
		writePersona(
			join(agentDir, "personas"),
			"coder.md",
			`---\nname: coder\nagents: [worker]\ncontract: summary-and-diff\n---\nUser variant.\n`,
		);
		writePersona(
			join(cwd, ".pi", "personas"),
			"coder.md",
			`---\nname: coder\nagents: [worker]\ncontract: summary-and-diff\n---\nProject variant.\n`,
		);
		const registry = loadPersonas({ cwd, agentDir, bundledDir: bundled });
		expect(registry.personas.get("coder")?.source).toBe("project");
		expect(registry.personas.get("coder")?.prompt).toBe("Project variant.");
		expect(registry.personas.get("researcher")?.source).toBe("bundled");
	});
});

describe("bundled playbooks", () => {
	it("all load clean and register the expected roster", () => {
		const registry = loadPersonas({
			cwd,
			agentDir,
			bundledDir: bundledPersonasDir(),
		});
		expect(registry.errors).toEqual([]);
		expect([...registry.personas.keys()].sort()).toEqual([
			"advisor",
			"coder",
			"debugger",
			"generalist",
			"integrator",
			"plan-review",
			"researcher",
			"reviewer",
		]);
		expect(personasForAgent(registry, "worker").map((p) => p.name)).toEqual([
			"coder",
			"debugger",
			"generalist",
			"integrator",
		]);
		expect(personasForAgent(registry, "explorer").map((p) => p.name)).toEqual([
			"researcher",
		]);
		expect(personasForAgent(registry, "reviewer").map((p) => p.name)).toEqual([
			"plan-review",
			"reviewer",
		]);
		// The gate persona carries the gate contract; ordinary reviews carry findings.
		expect(registry.personas.get("plan-review")?.contract).toBe(
			"plan-gate-report",
		);
		expect(registry.personas.get("reviewer")?.contract).toBe("findings");
		// Situated voice: personas never narrate the environment.
		for (const persona of registry.personas.values()) {
			expect(persona.prompt).not.toMatch(/you receive|you will receive/i);
		}
	});
});
