// No two extensions may register the same tool name.
//
// This shipped broken and cost three live drives to find. `modes` registered a
// plan-structure tool named "agent" (add/update/ensemble a support agent on a
// deliverable) while `subagents` registered a runtime tool with the SAME name
// (run/batch/spawn/…). One shadowed the other, so a forming turn calling
// `agent(action="add", deliverableId=…)` hit a schema with no "add" action,
// failed validation, and the model moved on — silently authoring no reviewers
// at all. Nothing warned; the plans just came back thinner than asked for.
//
// A duplicate name is always a bug: one of the two tools becomes unreachable,
// and which one depends on extension load order.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGES = join(process.cwd(), "packages");

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "dist") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
	}
	return out;
}

/** Every `name: "…"` that sits inside a tool definition, keyed by package. */
function toolNames(): Map<string, string[]> {
	const byName = new Map<string, string[]>();
	for (const file of walk(PACKAGES)) {
		const source = readFileSync(file, "utf8");
		// defineTool/registerTool bodies open with `name: "…"`; the surrounding
		// call is on a nearby line, so anchor on the tool-shaped pair.
		for (const match of source.matchAll(
			/(?:defineTool|registerTool)\s*\(\s*\{[\s\S]{0,200}?name:\s*"([a-z][a-z0-9_-]*)"/g,
		)) {
			const pkg = file.slice(PACKAGES.length + 1).split("/")[0];
			const owners = byName.get(match[1]) ?? [];
			if (!owners.includes(pkg)) owners.push(pkg);
			byName.set(match[1], owners);
		}
	}
	return byName;
}

describe("tool names", () => {
	it("finds the tool definitions at all", () => {
		const names = toolNames();
		expect(names.size).toBeGreaterThan(5);
		// Sanity: two tools we know exist, in different packages.
		expect(names.has("deliverable")).toBe(true);
		expect(names.has("subagent")).toBe(true);
	});

	it("registers no tool name from two different packages", () => {
		const collisions = [...toolNames().entries()]
			.filter(([, owners]) => owners.length > 1)
			.map(([name, owners]) => `${name} (${owners.join(" + ")})`);
		expect(
			collisions,
			`one of each pair is unreachable depending on load order: ${collisions}`,
		).toEqual([]);
	});

	it("keeps plan authoring distinct from the runtime subagent API", () => {
		// modes once defined a plan-structure tool named "agent" alongside the
		// subagents runtime tool of the same name. It was never registered, so
		// nothing shadowed anything — but registering it would have collided.
		// Authoring lives on `deliverable`; spawning lives on `subagent`, whose
		// name no longer competes with a PlanNode's `agent:` field either.
		const names = toolNames();
		expect(names.get("deliverable")).toEqual(["modes"]);
		expect(names.get("subagent")).toEqual(["subagents"]);
	});
});
