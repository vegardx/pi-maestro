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
import { dirname, join, relative, resolve } from "node:path";
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

// ── 1b. Documented commands must be REGISTERED ───────────────────────────────
// The other direction, which nothing checked. `docs/usage.md` listed twenty
// commands of which three existed, and the README's quickstart was six dead
// commands out of seven — all under a green gate, because the contract only
// ever asked whether real things were written down, never whether written-down
// things were real.
//
// Commands from OUTSIDE this repo are named legitimately (pi's own builtins,
// git, npm), so a bare `/word` is not enough evidence. What is: a command
// presented as ours — in a table cell, a heading, or a fenced block — which is
// how every stale entry was written.
const OTHERS = new Set(["clear", "help", "resume", "compact", "exit", "quit"]);
// Dated records, not claims about today. `docs/design/*` and `docs/reviews/*`
// describe what was designed or reviewed at a point in time, and rewriting them
// to match the present would destroy the only account of why things changed.
// The rule is that CURRENT-STATE docs must be true.
const HISTORY = [join(ROOT, "docs", "design"), join(ROOT, "docs", "reviews")];
const claimed = new Map();
for (const [file, text] of corpus) {
	if (HISTORY.some((dir) => file.startsWith(dir))) continue;
	const lines = text.split("\n");
	let fenced = false;
	for (const [index, line] of lines.entries()) {
		if (line.trimStart().startsWith("```")) fenced = !fenced;
		const presented =
			fenced ||
			line.trimStart().startsWith("|") ||
			line.trimStart().startsWith("#");
		if (!presented) continue;
		for (const m of line.matchAll(/(?:^|[\s|`(])\/([a-z][a-z-]{1,})\b/g)) {
			const name = m[1];
			if (OTHERS.has(name) || commandNames.has(name)) continue;
			if (!claimed.has(name))
				claimed.set(name, `${relative(ROOT, file)}:${index + 1}`);
		}
	}
}
for (const [name, where] of [...claimed].sort()) {
	failures.push(
		`${where} presents /${name}, which nothing registers — a reader (or an agent) will try it`,
	);
}

// ── 2. Plan-facing tools must be documented ──────────────────────────────────
// Kept as an explicit list: tool `name:` fields are too generic to extract
// reliably. Update when a user-facing tool is added or renamed.
//
// Every entry must be a tool that actually exists. This list previously
// required the docs to mention `workflow` and `readiness`, neither of which is
// registered anywhere — so the contract was guaranteeing the docs stayed wrong
// rather than catching it.
// Maestro's whole tool surface, which is now small enough to name.
//
// Still a hand-written list, and that is a known weakness: it is a second place
// naming tools, which is the defect the tool registry exists to remove. It
// caught nothing when `deliverable`, `work`, `repo`, `research`, `dig` and
// `subagent` all ceased to exist — it only checks that each name APPEARS in the
// docs, never that the name is real. Deriving it from `ToolRegistry` would fix
// that; until then, this list has to be updated by hand when the surface moves.
const TOOLS = [
	"plan",
	"flight",
	"respond",
	"bash",
	"subagent",
	"commit",
	"finish",
];
for (const tool of TOOLS) {
	const re = new RegExp(`\`${tool}[\`( ]`);
	if (!re.test(corpusText)) {
		failures.push(`tool \`${tool}\` is not mentioned in the docs`);
	}
}

// ── 3. Dead vocabulary ───────────────────────────────────────────────────────
// `delegates` was once banned here, then unbanned when a tool briefly carried
// the name `delegate` — which is now renamed `subagent`, the word this system
// always meant. A dead vocabulary list has to be pruned when the vocabulary
// changes, or it starts enforcing the past.
const BANNED = [
	[/\bWorkGroup\b/, "WorkGroup (renamed to Deliverable)"],
	[/\bGroupExecutor\b/, "GroupExecutor (now DeliverableExecutor)"],
	[/\bgroupId\b/, "groupId (now deliverableId)"],
	[/\bgroup\(/, "group( tool call (now deliverable()"],
	[/\bwork groups\b/i, '"work groups" (now deliverables)'],
	[/\balternate slot\b/i, "model slots (replaced by tiers/profiles)"],
	[/\bslot="/, "slot= param (replaced by tiers/profiles)"],
	[/"profiles"/, '"profiles" config key (replaced by exact "presets")'],
	[/\bask mode\b/i, "ask mode (removed; modes are hack/plan/auto)"],
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
