#!/usr/bin/env node
/**
 * Package-boundary linter.
 *
 * pi-maestro splits packages into two classes:
 *
 *   - Library packages (importable by anyone): contracts, core, settings,
 *     models, ui, git, github. These are the shared foundation.
 *   - Extension packages (NOT importable by sibling packages): ask,
 *     prompt-assist, subagents, commit, modes. Extensions talk to each other
 *     only through the capability registry + events — never by reaching into
 *     a sibling's module. A static value import bypasses that contract and
 *     runs the sibling's code regardless of whether it is enabled.
 *
 * Rule: forbid static *value* imports of an extension package from any other
 * package. `import type ... from "@vegardx/pi-<ext>"` is allowed because it
 * vanishes at runtime. Library imports are unrestricted.
 *
 * Exits non-zero on the first violation with a file:line pointer.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(ROOT, "packages");

const EXTENSION_PACKAGES = new Set([
	"ask",
	"prompt-assist",
	"subagents",
	"commit",
	"smart-compact",
	"modes",
]);

/**
 * @typedef {{ file: string, line: number, importPath: string, owner: string, target: string }} Violation
 */

function walk(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "dist") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			walk(full, out);
		} else if (
			entry.endsWith(".ts") &&
			!entry.endsWith(".d.ts") &&
			!entry.endsWith(".test.ts")
		) {
			out.push(full);
		}
	}
	return out;
}

function findOwningPackage(file) {
	const rel = file.slice(PACKAGES_DIR.length + 1);
	const slash = rel.indexOf("/");
	return slash > 0 ? rel.slice(0, slash) : null;
}

// `import`/`export ... from "@vegardx/pi-<name>"` where the modifier is NOT
// `type`. The optional `type` keyword is the thing we explicitly allow.
const STATIC_VALUE_IMPORT =
	/^\s*(?:import|export)\s+(?!type\b)[^"';]*from\s+["'](@vegardx\/pi-([^"'/]+)[^"']*)["']/gm;

function scan() {
	/** @type {Violation[]} */
	const violations = [];
	for (const file of walk(PACKAGES_DIR)) {
		const owner = findOwningPackage(file);
		if (!owner) continue;
		const src = readFileSync(file, "utf8");
		STATIC_VALUE_IMPORT.lastIndex = 0;
		let match;
		// biome-ignore lint/suspicious/noAssignInExpressions: regex iteration
		while ((match = STATIC_VALUE_IMPORT.exec(src)) !== null) {
			const importPath = match[1];
			const target = match[2];
			if (!EXTENSION_PACKAGES.has(target)) continue;
			if (target === owner) continue;
			const line = src.slice(0, match.index).split("\n").length;
			violations.push({ file, line, importPath, owner, target });
		}
	}
	return violations;
}

const violations = scan();
if (violations.length === 0) {
	process.exit(0);
}

console.error(`✗ ${violations.length} forbidden extension import(s) detected.`);
console.error(
	"  Extensions must talk via the capability registry + events, not static",
);
console.error(
	"  value imports. Use `import type` for type-only references, or resolve",
);
console.error("  the sibling at runtime through pi.capabilities.\n");
for (const v of violations) {
	const rel = v.file.slice(ROOT.length + 1);
	console.error(
		`  ${rel}:${v.line}  →  ${v.importPath}  (${v.owner} importing extension ${v.target})`,
	);
}
process.exit(1);
