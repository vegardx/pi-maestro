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

/**
 * The packages the manifest actually loads.
 *
 * A collision matters between extensions that load TOGETHER — that is what
 * "one becomes unreachable depending on load order" means. A package outside
 * the manifest loads beside nothing and can collide with nothing.
 *
 * That commit has happened: `packages/maestro` is in the manifest and `modes`
 * and `subagents` are deleted, so it is now the only loaded package defining
 * tools at all. This check earns its keep for the next one to arrive.
 */
function loadedPackages(): Set<string> {
	const manifest = JSON.parse(
		readFileSync(join(process.cwd(), "package.json"), "utf8"),
	) as { pi?: { extensions?: string[] } };
	return new Set(
		(manifest.pi?.extensions ?? []).map(
			(entry) => entry.split("/")[1] as string,
		),
	);
}

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
	const loaded = loadedPackages();
	for (const file of walk(PACKAGES)) {
		const owner = file.slice(PACKAGES.length + 1).split("/")[0] as string;
		if (!loaded.has(owner)) continue;
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
		// Sanity: tools from the workflow seat and the ask extension.
		expect(names.has("plan")).toBe(true);
		expect(names.has("respond")).toBe(true);
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

	it("keeps the workflow seat surface singular", () => {
		const names = toolNames();
		expect(names.get("plan")).toEqual(["maestro"]);
		expect(names.get("commit")).toEqual(["maestro"]);
		expect(names.has("subagent")).toBe(false);
		expect(names.has("finish")).toBe(false);
	});
});
