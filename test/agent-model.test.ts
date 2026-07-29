// The agent model: what a kind decides, so an author cannot decide it wrongly.
//
// The old model had fifteen kinds, each restating its own grants, its own
// preamble prose and its own lifecycle — and they disagreed. Every case here
// closes one of the ways they disagreed.

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
	AGENT_KINDS,
	AgentModelError,
	type AgentSpec,
	brief,
	holderOf,
	isWriter,
	type Persona,
	PersonaCatalogue,
	relationshipOf,
	validateAgentSpec,
} from "../packages/maestro/src/agent.js";
import { ToolRegistry } from "../packages/maestro/src/tool-registry.js";

function tool(name: string, description = `The ${name} tool. Does a thing.`) {
	return defineTool({
		name,
		label: name,
		description,
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "" }], details: {} };
		},
	});
}

const tools = ToolRegistry.declare([
	{ definition: tool("read"), holders: ["maestro", "worker", "read-only"] },
	{ definition: tool("commit"), holders: ["worker"] },
]);

const persona = (over: Partial<Persona> = {}): Persona => ({
	id: "security-review",
	kind: "reviewer",
	title: "Security review",
	prose: "Look for authentication that is checked in one path and not another.",
	...over,
});

const catalogue = () => PersonaCatalogue.declare([persona()], tools);

describe("a kind decides what follows from it", () => {
	it("maps five kinds onto three postures", () => {
		expect(AGENT_KINDS.map(holderOf)).toEqual([
			"maestro",
			"worker",
			"read-only",
			"read-only",
			"read-only",
		]);
	});

	it("maps five kinds onto three mechanisms", () => {
		// The spawner switches on this, not on kind — which is what stops a sixth
		// kind from needing a sixth branch in the launcher.
		expect(AGENT_KINDS.map(relationshipOf)).toEqual([
			"autonomous",
			"autonomous",
			"blocking",
			"blocking",
			"consultable",
		]);
	});

	it("knows which kinds write", () => {
		expect(AGENT_KINDS.filter(isWriter)).toEqual(["maestro", "worker"]);
	});

	it("gives no way to author a read-only agent nobody waits for", () => {
		// The bug this whole rebuild started from: a review panel produced six
		// real findings that reached a PR body reading "(agent produced no
		// summary)". `autonomous` means nobody is waiting, so a read-only agent
		// that were autonomous would report into nothing. There is no field to
		// set, so the combination cannot be written.
		for (const kind of AGENT_KINDS)
			if (holderOf(kind) === "read-only")
				expect(relationshipOf(kind)).not.toBe("autonomous");
	});
});

describe("requesting an agent", () => {
	it("refuses to spawn a maestro", () => {
		expect(
			validateAgentSpec({ kind: "maestro", persona: "anything" }),
		).toContainEqual(expect.stringContaining("never spawned"));
	});

	it("refuses a request with no persona", () => {
		expect(
			validateAgentSpec({ kind: "reviewer", persona: "  " }),
		).toContainEqual(expect.stringContaining("no persona"));
	});

	it("accepts a blocking reader fanning out", () => {
		expect(
			validateAgentSpec({
				kind: "reviewer",
				persona: "security-review",
				topology: "fan-out",
			}),
		).toEqual([]);
	});

	it("refuses to fan out something nobody is waiting on", () => {
		// Fanning out means several answers normalised into one before the caller
		// continues. With nothing waiting, there is nothing to normalise into.
		for (const kind of ["worker", "advisor"] as const)
			expect(
				validateAgentSpec({ kind, persona: "p", topology: "fan-out" }),
			).toContainEqual(expect.stringContaining("cannot fan out"));
	});

	it("defaults to one agent", () => {
		expect(
			validateAgentSpec({ kind: "explorer", persona: "codebase-research" }),
		).toEqual([]);
	});
});

describe("personas are the only prose, and they never name a tool", () => {
	it("refuses prose naming a tool the kind cannot call", () => {
		// The `review` defect in its exact shape: a preamble teaching a worker to
		// call something it did not have. Here a reviewer is taught to `commit`.
		expect(() =>
			PersonaCatalogue.declare(
				[persona({ prose: "When you are satisfied, `commit` the fix." })],
				tools,
			),
		).toThrow(/does not hold/);
	});

	it("refuses prose restating a tool the kind DOES hold", () => {
		// Not a bug today, but a second copy of the grant that can go stale — and
		// the generated list already told the agent.
		expect(() =>
			PersonaCatalogue.declare(
				[persona({ prose: "Use `read` to open the diff." })],
				tools,
			),
		).toThrow(/generated from the declaration/);
	});

	it("leaves ordinary backticked prose alone", () => {
		expect(() =>
			PersonaCatalogue.declare(
				[
					persona({
						prose: "Check that `main` is the base and `package.json` parses.",
					}),
				],
				tools,
			),
		).not.toThrow();
	});

	it("refuses a persona that says nothing to look for", () => {
		expect(() =>
			PersonaCatalogue.declare([persona({ prose: "  " })], tools),
		).toThrow(/says nothing to look for/);
	});

	it("refuses a persona for a maestro", () => {
		expect(() =>
			PersonaCatalogue.declare([persona({ kind: "maestro" })], tools),
		).toThrow(/never spawned/);
	});

	it("refuses a duplicate rather than letting load order decide", () => {
		expect(() =>
			PersonaCatalogue.declare([persona(), persona({ title: "Other" })], tools),
		).toThrow(/declared twice/);
	});

	it("refuses to resolve a persona nobody declared", () => {
		expect(() => catalogue().require("deep-research")).toThrow(
			/no persona named `deep-research`/,
		);
		expect(() => catalogue().require("deep-research")).toThrow(
			/declared: security-review/,
		);
	});

	it("lists what a kind can be given", () => {
		const c = PersonaCatalogue.declare(
			[persona(), persona({ id: "codebase-research", kind: "explorer" })],
			tools,
		);
		expect(c.forKind("reviewer").map((p) => p.id)).toEqual(["security-review"]);
		expect(c.forKind("advisor")).toEqual([]);
	});
});

describe("the brief is assembled, never composed by the caller", () => {
	const spec: AgentSpec = { kind: "reviewer", persona: "security-review" };

	it("puts the persona's prose next to a generated tool list", () => {
		const text = brief(
			spec,
			catalogue(),
			tools,
			"Review the diff on feat/api.",
		);
		expect(text).toContain("authentication that is checked in one path");
		expect(text).toContain("## Your tools");
		expect(text).toContain("- read —");
		// A reviewer is read-only, so it is never told about `commit` — the same
		// declaration decides both what it holds and what it is told it holds.
		expect(text).not.toContain("commit");
		expect(text).toContain("Review the diff on feat/api.");
	});

	it("refuses a persona belonging to another kind", () => {
		expect(() =>
			brief({ ...spec, kind: "explorer" }, catalogue(), tools, "Go look"),
		).toThrow(/is for a reviewer, not a explorer/);
	});

	it("refuses to brief an agent that should not exist", () => {
		// A matching persona, so the ONLY thing wrong is the topology — otherwise
		// this would throw on the kind mismatch and pass without ever exercising
		// the rule it names.
		const withAdvisor = PersonaCatalogue.declare(
			[
				persona(),
				persona({
					id: "standby",
					kind: "advisor",
					prose: "Answer what you are asked, from what you can see.",
				}),
			],
			tools,
		);
		expect(() =>
			brief(
				{ kind: "advisor", persona: "standby", topology: "fan-out" },
				withAdvisor,
				tools,
				"Stand by",
			),
		).toThrow(/cannot fan out/);
		expect(() =>
			brief(
				{ kind: "advisor", persona: "standby" },
				withAdvisor,
				tools,
				"Stand by",
			),
		).not.toThrow(AgentModelError);
	});
});
