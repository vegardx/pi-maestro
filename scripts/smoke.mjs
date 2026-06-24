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
const entries = pkg.pi?.extensions ?? [];
const jiti = createJiti(import.meta.url);

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
