// The agent model: two kinds, and what follows from being one.
//
// The old model had fifteen kinds, then five, each restating grants, prose and
// lifecycle — and they disagreed. What survives is the one honest bit (does it
// write?) plus personas as the single prose system. There is no relationship
// enum to test any more: who waits on whom is structural — a writer is tracked
// by the run, and a read-only agent exists only as a held session in its
// caller's map, so a reader nobody waits for cannot be constructed.

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
	AGENT_KINDS,
	type AgentSpec,
	brief,
	holderOf,
	isWriter,
	type Persona,
	PersonaCatalogue,
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
	kind: "read-only",
	title: "Security review",
	prose: "Look for authentication that is checked in one path and not another.",
	...over,
});

const catalogue = () => PersonaCatalogue.declare([persona()], tools);

describe("a kind is the one honest bit", () => {
	it("has exactly two values", () => {
		// The three reader words (explorer, reviewer, advisor) selected nothing
		// mechanical — same tools, same launch, same limits — so they live on in
		// persona titles, not here. The maestro is not a kind: it is the seat,
		// never spawned, so there is nothing to name.
		expect(AGENT_KINDS).toEqual(["worker", "read-only"]);
	});

	it("maps kinds onto holders one to one", () => {
		expect(AGENT_KINDS.map(holderOf)).toEqual(["worker", "read-only"]);
	});

	it("knows which kind writes", () => {
		expect(AGENT_KINDS.filter(isWriter)).toEqual(["worker"]);
	});
});

describe("requesting an agent", () => {
	it("refuses an unknown kind by naming the two that exist", () => {
		expect(
			validateAgentSpec({ kind: "reviewer" as never, persona: "x" }),
		).toContainEqual(expect.stringContaining("kinds are worker, read-only"));
	});

	it("refuses a request with no persona", () => {
		expect(
			validateAgentSpec({ kind: "read-only", persona: "  " }),
		).toContainEqual(expect.stringContaining("no persona"));
	});

	it("defaults to one agent", () => {
		expect(
			validateAgentSpec({ kind: "read-only", persona: "codebase-research" }),
		).toEqual([]);
	});
});

describe("personas are the only prose, and they never name a tool", () => {
	it("refuses prose naming a tool the kind cannot call", () => {
		// The `review` defect in its exact shape: a preamble teaching a reader to
		// call something it did not have. Here a reader is taught to `commit`.
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

	it("refuses a persona for a kind that does not exist", () => {
		expect(() =>
			PersonaCatalogue.declare([persona({ kind: "advisor" as never })], tools),
		).toThrow(/unknown kind/);
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
			[persona(), persona({ id: "the-coder", kind: "worker" })],
			tools,
		);
		expect(c.forKind("read-only").map((p) => p.id)).toEqual([
			"security-review",
		]);
		expect(c.forKind("worker").map((p) => p.id)).toEqual(["the-coder"]);
	});
});

describe("the brief is assembled, never composed by the caller", () => {
	const spec: AgentSpec = { kind: "read-only", persona: "security-review" };

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
		// A reader is never told about `commit` — the same declaration decides
		// both what it holds and what it is told it holds.
		expect(text).not.toContain("commit");
		expect(text).toContain("Review the diff on feat/api.");
	});

	it("refuses a persona belonging to the other kind", () => {
		// This is where "a writer's persona cannot be smuggled into a reader"
		// lives now that the plan has no agent field to check.
		expect(() =>
			brief({ ...spec, kind: "worker" }, catalogue(), tools, "Go build"),
		).toThrow(/is for a read-only, not a worker/);
	});
});
