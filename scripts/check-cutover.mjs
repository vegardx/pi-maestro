#!/usr/bin/env node
/** Full-cutover terminology/dead-code audit beyond the user-doc drift checks. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, extensions, out = []) {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === ".git") continue;
		const path = join(dir, name);
		const stat = statSync(path);
		if (stat.isDirectory()) walk(path, extensions, out);
		else if (extensions.some((extension) => name.endsWith(extension)))
			out.push(path);
	}
	return out;
}

const files = [
	join(ROOT, "README.md"),
	...walk(join(ROOT, "docs"), [".md"]),
	...walk(join(ROOT, "packages"), [".ts"]),
];
const failures = [];
const banned = [
	[
		// The PRE-CUTOVER models.profiles format is removed; v2 deliberately
		// reclaims the key for seat→catalog bindings ({ catalog, targets? }) —
		// the v2 modules below own the shape distinction.
		/\bmodels\.profiles\b/g,
		"removed models.profiles key",
		new Set([
			"docs/models.md",
			"docs/settings.md",
			"docs/commands.md",
			"packages/models/src/profiles.ts",
			"packages/models/src/catalog.ts",
			"packages/models/src/v2-migration.ts",
			"packages/contracts/src/catalog.ts",
			// The v2 editor + scripted completions own the reclaimed key.
			"packages/settings/src/menu-catalogs.ts",
			"packages/settings/src/command.ts",
		]),
	],
	[/\breview panel\b/gi, "removed review-panel architecture", new Set()],
	[/\breviewer personas?\b/gi, "removed reviewer-persona taxonomy", new Set()],
	[
		/\bbroad role pools?\b/gi,
		"removed broad role-pool architecture",
		new Set(),
	],
	[
		/\bAgentRole\s*=\s*[^;]*delegate/gi,
		"removed delegate RPC identity",
		new Set(),
	],
];

for (const file of files) {
	const relative = file.slice(ROOT.length + 1);
	const text = readFileSync(file, "utf8");
	for (const [pattern, label, allow] of banned) {
		if (allow.has(relative)) continue;
		pattern.lastIndex = 0;
		for (const match of text.matchAll(pattern)) {
			const line = text.slice(0, match.index).split("\n").length;
			failures.push(
				`${relative}:${line} ${label}: ${JSON.stringify(match[0])}`,
			);
		}
	}
}

const retiredModules = [
	"packages/modes/src/panel.ts",
	"packages/modes/src/personas.ts",
	"packages/modes/src/review-tool.ts",
];
for (const relative of retiredModules) {
	try {
		const text = readFileSync(join(ROOT, relative), "utf8").trim();
		if (text !== "")
			failures.push(`${relative}: retired module regained executable content`);
	} catch {
		// Deletion is also a valid completed cutover.
	}
}

if (failures.length) {
	console.error("check-cutover: FAIL");
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log(`check-cutover: OK (${files.length} source/doc files audited)`);
