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
 *   5. No skill or current-state doc may name a `skills/<name>` directory
 *      this package does not ship, or any identifier from the fiction
 *      denylist — surfaces that were written down here but never existed.
 *
 * Exits non-zero listing every violation.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The repository root by default; an explicit argument lets the gate run against
// a fixture tree, which is how `test/check-docs.test.ts` proves the rules fire.
const ROOT = process.argv[2]
	? resolve(process.argv[2])
	: resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
const TOOLS = ["plan", "plan_intent", "bash", "delete"];
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

// ── 5. Skills and docs may not name things that do not exist ────────────────
// `skills/workflows/SKILL.md` and `skills/subagents/SKILL.md` described tools
// and sibling skills that never existed in any runtime — `workflow_dynamic`,
// `execution-router`, `workflow-guide`, `awaitTerminal`, `detach`, four named
// workflows — for as long as they were bundled, because nothing read `skills/`
// at all. Both are checks on the same class of defect as rule 1b: a name
// presented to an agent as real, which nothing can supply.
//
// The corpus is every skill file plus the current-state docs. `docs/design/`
// and `docs/reviews/` are dated records and keep their own vocabulary, exactly
// as in rule 1b.
const skillsDir = join(ROOT, "skills");
const skillNames = new Set(
	existsSync(skillsDir)
		? readdirSync(skillsDir).filter((name) =>
				statSync(join(skillsDir, name)).isDirectory(),
			)
		: [],
);
const skillFiles = existsSync(skillsDir)
	? [".md", ".json", ".yaml"].flatMap((ext) => walk(skillsDir, ext))
	: [];
const claimFiles = [
	...skillFiles,
	...docFiles.filter((f) => !HISTORY.some((dir) => f.startsWith(dir))),
];

// Every identifier here was asserted as a real surface by a bundled skill and
// has zero implementation in any package this repo depends on. Add an entry
// when a fiction is found; remove one only when the thing ships.
const FICTION = [
	[
		/\bworkflow_dynamic\b/,
		"workflow_dynamic — no such tool; a dynamic run is workflow_propose, a human /workflow approve, then workflow_run dynamic:<sha256>",
	],
	[/\bexecution-router\b/, "the execution-router skill, which does not exist"],
	[
		/\bworkflow-guide\b/,
		"the workflow-guide skill, which does not exist; authoring is workflow-authoring, shipped by @vegardx/pi-workflow",
	],
	[
		/\bawaitTerminal\b/,
		"awaitTerminal — no such parameter; workflow_run takes { ref, input } and returns immediately",
	],
	[
		/`detach[`:]|\bdetach:\s*true\b/,
		"detach — no such parameter; there is no background workflow execution",
	],
	// `deep-review` left this list when it shipped: it is a real definition in
	// `@vegardx/pi-workflow/workflows`, so denying the name would now be the
	// gate enforcing the past. The rest stay named because nothing supplies
	// them. `plan-review` was never listed and must not be added: it is on the
	// exit path and lands with the runtime that owns it.
	[
		/\b(?:deep-research|spec-review|impact-review)\b/,
		"a named workflow that does not exist; the plan hand-off runs plan-to-ship",
	],
];

for (const file of claimFiles) {
	const text = readFileSync(file, "utf8");
	const where = (index) =>
		`${relative(ROOT, file)}:${text.slice(0, index).split("\n").length}`;
	for (const m of text.matchAll(/(?<![\w./-])skills\/([a-z][a-z0-9-]*)/g)) {
		if (skillNames.has(m[1])) continue;
		failures.push(
			`${where(m.index)} names skills/${m[1]}, which this package does not ship`,
		);
	}
	for (const [re, why] of FICTION) {
		const m = text.match(re);
		if (m) failures.push(`${where(m.index)} names ${why}`);
	}
}

// ── 6. Readiness is not preflight ─────────────────────────────────────────
// Two steps, two processes, one word between them. THIS repository's step is
// **readiness**: the repositories a stored plan names exist, are working-tree
// roots, are clean, have the base branch, and `gh` is present when a pull
// request was asked for. `preflight` is `@vegardx/pi-subagent`'s word for the
// launch-plan compile of a delegated attempt. A doc that calls the first one
// preflight sends a reader (or an agent) looking for it in the wrong package.
//
// The word is allowed in exactly one place: the section that exists to say it
// is not ours. Anywhere else in the current-state docs or the skills it is a
// failure, and `docs/design/` and `docs/reviews/` keep their own vocabulary as
// in rules 1b and 5.
const PREFLIGHT_SECTION = "Readiness is not preflight";
for (const file of claimFiles) {
	const text = readFileSync(file, "utf8");
	let heading = "";
	let fenced = false;
	for (const [index, line] of text.split("\n").entries()) {
		if (line.trimStart().startsWith("```")) fenced = !fenced;
		if (!fenced && line.startsWith("#"))
			heading = line.replace(/^#+\s*/, "").trim();
		if (heading === PREFLIGHT_SECTION) continue;
		if (/\bpreflight\b/i.test(line)) {
			failures.push(
				`${relative(ROOT, file)}:${index + 1} calls readiness "preflight" — preflight is @vegardx/pi-subagent's launch-plan compile, and this step is readiness`,
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
	`check-docs: OK (${commandNames.size} commands, ${TOOLS.length} tools, ${corpus.size} docs, ${skillNames.size} skills)`,
);
