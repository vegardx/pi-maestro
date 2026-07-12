#!/usr/bin/env node
/**
 * Docs-drift linter.
 *
 * The docs have died three times after code renames (group→deliverable,
 * slots→tiers, delegates→subagents) because nothing tied them to the code.
 * This gate makes the cheapest classes of rot mechanical:
 *
 *   1. Every command the code registers must be documented: each literal
 *      `registerCommand("x", ...)` in packages must appear as `/x` somewhere
 *      in README.md or docs/. (Dynamically registered names are not
 *      extracted and thus not checked.)
 *   2. Every user-facing LLM tool named in the modes package must be
 *      mentioned in the docs corpus.
 *   3. Dead vocabulary from replaced designs must not appear in the corpus
 *      (the group model, model slots/presets, the removed ask mode).
 *   4. Relative markdown links in the corpus must resolve to real files.
 *
 * Exits non-zero listing every violation.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, ext, out = []) {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name.startsWith(".")) continue;
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) walk(p, ext, out);
		else if (name.endsWith(ext)) out.push(p);
	}
	return out;
}

// ── The docs corpus ──────────────────────────────────────────────────────────
const docFiles = [join(ROOT, "README.md"), ...walk(join(ROOT, "docs"), ".md")];
const corpus = new Map(docFiles.map((f) => [f, readFileSync(f, "utf8")]));
const corpusText = [...corpus.values()].join("\n");

const failures = [];

// ── 1. Registered commands must be documented ────────────────────────────────
const commandNames = new Set();
for (const file of walk(join(ROOT, "packages"), ".ts")) {
	const src = readFileSync(file, "utf8");
	for (const m of src.matchAll(/registerCommand\(\s*"([a-z][a-z-]*)"/g)) {
		commandNames.add(m[1]);
	}
}
for (const name of [...commandNames].sort()) {
	if (!corpusText.includes(`/${name}`)) {
		failures.push(`command /${name} is registered but undocumented`);
	}
}

// ── 2. Plan-facing tools must be documented ──────────────────────────────────
// Kept as an explicit list: tool `name:` fields are too generic to extract
// reliably. Update when a user-facing tool is added or renamed.
const TOOLS = [
	"deliverable",
	"task",
	"agent",
	"plan",
	"research",
	"dig",
	"review",
];
for (const tool of TOOLS) {
	const re = new RegExp(`\`${tool}[\`( ]`);
	if (!re.test(corpusText)) {
		failures.push(`tool \`${tool}\` is not mentioned in the docs`);
	}
}

// ── 3. Dead vocabulary ───────────────────────────────────────────────────────
const BANNED = [
	[/\bWorkGroup\b/, "WorkGroup (renamed to Deliverable)"],
	[/\bGroupExecutor\b/, "GroupExecutor (now DeliverableExecutor)"],
	[/\bgroupId\b/, "groupId (now deliverableId)"],
	[/\bgroup\(/, "group( tool call (now deliverable()"],
	[/\bwork groups\b/i, '"work groups" (now deliverables)'],
	[/\balternate slot\b/i, "model slots (replaced by tiers/profiles)"],
	[/\bslot="/, "slot= param (replaced by tiers/profiles)"],
	[/"presets"/, '"presets" config key (replaced by "profiles")'],
	[/\bask mode\b/i, "ask mode (removed; modes are hack/plan/auto)"],
	[/\bdelegates\b/i, "delegates (replaced by subagents/research)"],
];
for (const [file, text] of corpus) {
	for (const [re, why] of BANNED) {
		const m = text.match(re);
		if (m) {
			const line = text.slice(0, m.index).split("\n").length;
			failures.push(
				`${file.slice(ROOT.length + 1)}:${line} dead vocabulary: ${why}`,
			);
		}
	}
}

// ── 4. Relative markdown links resolve ───────────────────────────────────────
for (const [file, text] of corpus) {
	for (const m of text.matchAll(/\]\(([^)#\s]+\.md)(#[^)]*)?\)/g)) {
		const target = m[1];
		if (/^[a-z]+:\/\//.test(target)) continue;
		if (!existsSync(resolve(dirname(file), target))) {
			failures.push(
				`${file.slice(ROOT.length + 1)} links to missing file ${target}`,
			);
		}
	}
}

if (failures.length > 0) {
	console.error("check-docs: FAIL");
	for (const f of failures) console.error(`  - ${f}`);
	process.exit(1);
}
console.log(
	`check-docs: OK (${commandNames.size} commands, ${TOOLS.length} tools, ${corpus.size} docs)`,
);
