#!/usr/bin/env node
/**
 * Feature-flag self-gating contract.
 *
 * Every extension listed in the root pi manifest must be killable: an
 * operator can disable a whole extension (`PI_EXT_<NAME>=off` /
 * `extensionConfig.<name>.enabled=false`) or a single feature
 * (`PI_DISABLE="<flag.path>"`) and the extension must register nothing for
 * the disabled surface. The runtime enforcement lives in
 * `@vegardx/pi-core`'s `defineExtension`; the per-extension assertion is
 * added to this check as each extension adopts it.
 *
 * Today this verifies the structural half of the contract — every manifest
 * entry resolves to a real file and every extension package is wired into
 * the manifest — so the pipeline is in place from the first commit. The
 * behavioural half (env-disable produces zero registrations) lands with
 * core.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_PACKAGES = [
	"ask",
	"prompt-assist",
	"subagents",
	"commit",
	"modes",
];

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const entries = pkg.pi?.extensions ?? [];
const errors = [];

for (const entry of entries) {
	if (!existsSync(join(ROOT, entry))) {
		errors.push(`manifest entry does not exist: ${entry}`);
	}
}

const expected = EXTENSION_PACKAGES.map((n) => `packages/${n}/src/index.ts`);
for (const want of expected) {
	if (!entries.includes(want)) {
		errors.push(`extension package not wired into manifest: ${want}`);
	}
}
for (const got of entries) {
	if (!expected.includes(got)) {
		errors.push(`manifest lists a non-extension entry: ${got}`);
	}
}

if (errors.length > 0) {
	console.error("✗ feature-flag contract (structural) failed:");
	for (const e of errors) console.error(`  - ${e}`);
	process.exit(1);
}

console.log(
	`feature-flag contract: ${entries.length} extension entr${
		entries.length === 1 ? "y" : "ies"
	} wired; behavioural gating check pending core.`,
);
process.exit(0);
