// No maestro command may shadow one of pi's builtin slash commands.
//
// pi drops a colliding extension command from autocomplete entirely — the user
// keeps typing the name and silently gets the builtin. That is how `/resume`
// shipped broken: the name is obvious for "run the plan", and nothing in our
// own checks knew it was taken.
//
// The builtin list lives in the installed pi package, so this test reads it
// from there rather than restating it — a restated copy would go stale exactly
// when it matters (pi adds a builtin that collides with one of ours).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PI_SLASH_COMMANDS = join(
	process.cwd(),
	"node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js",
);

/** Builtin command names, read out of pi's own BUILTIN_SLASH_COMMANDS. */
function builtinNames(): string[] {
	const source = readFileSync(PI_SLASH_COMMANDS, "utf8");
	const at = source.indexOf("BUILTIN_SLASH_COMMANDS =");
	expect(at, "pi's BUILTIN_SLASH_COMMANDS not found").toBeGreaterThan(-1);
	const block = source.slice(at, at + 20_000);
	return [
		...new Set(
			[...block.matchAll(/name:\s*"([a-z][a-z0-9-]*)"/g)].map((m) => m[1]),
		),
	];
}

/** Every command name maestro registers with a string literal. */
function maestroCommands(): string[] {
	const roots = ["packages/modes/src", "packages/settings/src"];
	const names = new Set<string>();
	for (const root of roots) {
		const dir = join(process.cwd(), root);
		for (const file of walk(dir)) {
			const source = readFileSync(file, "utf8");
			for (const m of source.matchAll(
				/registerCommand\(\s*"([a-z][a-z0-9-]*)"/g,
			))
				names.add(m[1]);
		}
	}
	return [...names];
}

function walk(dir: string): string[] {
	const { readdirSync, statSync } =
		require("node:fs") as typeof import("node:fs");
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
	}
	return out;
}

describe("command names", () => {
	it("finds pi's builtin list", () => {
		const builtins = builtinNames();
		expect(builtins.length).toBeGreaterThan(10);
		// Sanity: the one that actually bit us.
		expect(builtins).toContain("resume");
	});

	it("registers no command that shadows a pi builtin", () => {
		const builtins = new Set(builtinNames());
		const collisions = maestroCommands().filter((name) => builtins.has(name));
		expect(
			collisions,
			`these are dropped from autocomplete: ${collisions}`,
		).toEqual([]);
	});

	it("still registers the plan-running verb under a free name", () => {
		const names = maestroCommands();
		expect(names).toContain("run");
		expect(names).toContain("start");
		expect(names).not.toContain("resume");
	});
});
