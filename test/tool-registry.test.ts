// The invariant the rebuild exists for: a tool's name lives in exactly one
// place, so a grant, a description and an implementation cannot disagree.
//
// Every case here is a real defect this codebase shipped, not a hypothetical:
//   - `review` was granted in two lists and taught in four preamble sections,
//     and no tool of that name ever existed. A live worker never called it, no
//     error was raised, and code review did not happen.
//   - `createAgentTool` was written, exported, unit-tested and never
//     registered — four live drives could not author a reviewer.
//   - `panel` sat in a grant list with no implementation at all.

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
	type ToolDeclaration,
	ToolDeclarationError,
	ToolRegistry,
} from "../packages/maestro/src/tool-registry.js";

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

const read: ToolDeclaration = {
	definition: tool("read"),
	holders: ["maestro", "worker", "read-only"],
};
const commit: ToolDeclaration = {
	definition: tool("commit"),
	holders: ["worker"],
};

describe("a declaration must stand for something", () => {
	it("refuses a tool with no implementation behind the name", () => {
		// The `review` defect: a name granted, taught, and backed by nothing.
		const phantom = {
			definition: { name: "" },
			holders: ["worker"],
		} as unknown as ToolDeclaration;
		expect(() => ToolRegistry.declare([phantom])).toThrow(ToolDeclarationError);
		expect(() => ToolRegistry.declare([phantom])).toThrow(
			/no implementation to stand behind it/,
		);
	});

	it("refuses a tool no posture can hold", () => {
		// The same defect inverted, and just as dead: implemented, unreachable,
		// and invisible until someone goes looking. `createAgentTool` was this.
		expect(() =>
			ToolRegistry.declare([{ definition: tool("orphan"), holders: [] }]),
		).toThrow(/names no holder, so nothing can ever call it/);
	});

	it("refuses a duplicate name rather than letting load order decide", () => {
		expect(() =>
			ToolRegistry.declare([read, { ...read, holders: ["worker"] }]),
		).toThrow(/declared twice/);
	});

	it("refuses an unknown posture instead of granting nothing quietly", () => {
		expect(() =>
			ToolRegistry.declare([
				{
					definition: tool("odd"),
					holders: ["reviewer"] as never,
				},
			]),
		).toThrow(/unknown holder `reviewer`/);
	});
});

describe("grants derive from the declaration", () => {
	const registry = ToolRegistry.declare([read, commit]);

	it("gives each posture exactly what declared it", () => {
		expect(registry.grantsFor("read-only")).toEqual(["read"]);
		expect(registry.grantsFor("worker")).toEqual(["read", "commit"]);
		expect(registry.grantsFor("maestro")).toEqual(["read"]);
	});

	it("has no second list a phantom could hide in", () => {
		// There is no AGENT_TOOL_NAMES to add `review` to. The only way to be
		// granted is to be declared, and declaring requires an implementation.
		for (const holder of ["maestro", "worker", "read-only"] as const)
			for (const name of registry.grantsFor(holder))
				expect(registry.has(name)).toBe(true);
	});

	it("refuses to resolve a name nobody declared", () => {
		expect(() => registry.require("review")).toThrow(
			/no tool named `review` is declared/,
		);
		// The error names what DOES exist — the failure a phantom used to cause
		// was silence, so this one has to be legible.
		expect(() => registry.require("review")).toThrow(/declared: read, commit/);
	});
});

describe("the agent-facing description is generated, never written", () => {
	const registry = ToolRegistry.declare([read, commit]);

	it("lists exactly what the posture holds", () => {
		const described = registry.describeFor("read-only");
		expect(described).toContain("read");
		// A read-only agent is not told about `commit`, because it does not have
		// it. Prose and grant cannot disagree when one is built from the other.
		expect(described).not.toContain("commit");
	});

	it("says so plainly when a posture holds nothing", () => {
		const empty = ToolRegistry.declare([commit]);
		expect(empty.describeFor("read-only")).toContain("(none)");
	});

	it("prefers the tool's own prompt snippet over its long description", () => {
		const withSnippet: ToolDeclaration = {
			definition: defineTool({
				name: "work",
				label: "Work",
				description: "A long description meant for the tool picker.",
				promptSnippet: "work — the items on a deliverable.",
				parameters: Type.Object({}),
				async execute() {
					return {
						content: [{ type: "text" as const, text: "" }],
						details: {},
					};
				},
			}),
			holders: ["worker"],
		};
		expect(ToolRegistry.declare([withSnippet]).describeFor("worker")).toContain(
			"work — the items on a deliverable.",
		);
	});
});
