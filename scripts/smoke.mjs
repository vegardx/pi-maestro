#!/usr/bin/env node
/**
 * Bundle load smoke.
 *
 * Imports every extension entry in the root pi manifest through jiti — the
 * same `.ts`-at-runtime path pi uses. This catches module-load and
 * factory-construction throws (bad top-level code, missing imports, circular
 * deps) without needing a full pi host or credentials. It is the headless
 * stand-in for `pi -e .` in CI.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
// Spawn-only extensions: never in the manifest (the maestro session must not
// load them) but passed via -e to spawned children — same load path, so the
// smoke covers them too.
const SPAWN_ONLY = ["packages/research-tools/src/index.ts"];
const entries = [...(pkg.pi?.extensions ?? []), ...SPAWN_ONLY];
const jiti = createJiti(import.meta.url);

// /maestro is intentionally pinned to pi's core list primitives. This static
// smoke catches accidental regressions to a private cursor/matrix renderer.
const maestroMenuSource = readFileSync(
	join(ROOT, "packages/settings/src/menu.ts"),
	"utf8",
);
// The v1 preset/model-set screens are retired; the menu's remaining writes
// must still flow through the validated domain path, never raw file pokes.
if (!maestroMenuSource.includes("writeDomainValue")) {
	console.error(
		"  ✗ /maestro no longer writes through the validated domain path",
	);
	process.exit(1);
}
if (maestroMenuSource.includes("class ConfigMenuComponent")) {
	console.error(
		"  ✗ /maestro restored the removed bespoke ConfigMenuComponent",
	);
	process.exit(1);
}
console.log("  ✓ /maestro uses pinned core settings primitives");

let failed = 0;
for (const entry of entries) {
	const abs = join(ROOT, entry);
	try {
		await jiti.import(pathToFileURL(abs).href);
		console.log(`  ✓ ${entry}`);
	} catch (err) {
		failed++;
		console.error(`  ✗ ${entry}`);
		console.error(`    ${err?.stack ?? err}`);
	}
}

if (failed > 0) {
	console.error(`\n✗ ${failed} extension(s) failed to load.`);
	process.exit(1);
}
console.log(`\n✓ ${entries.length} extension(s) loaded cleanly.`);
process.exit(0);
