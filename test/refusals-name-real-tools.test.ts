// A refusal may only name a tool the refused agent actually holds.
//
// This is the four-places defect wearing a different hat. A grant, an
// implementation and a description can be made to agree by construction —
// `ToolRegistry.declare` does that. A REFUSAL MESSAGE is a fourth place, and
// nothing bound it to the other three: `bash-policy` is prose, the registry is
// code, and they are joined by a bare string.
//
// A live drive found what that costs. Wiring the classifier made the policy
// refuse `git commit` with "Use the commit tool", and the rebuilt maestro
// declared no such tool — so every worker reached the end of its deliverable,
// could not record the work, and failed. Every unit test passed throughout,
// because each layer is correct on its own. `ship` was the same phantom in a
// second place.
//
// So this test reads the policy's own words back and holds them to the
// registry. Adding a refusal that names a tool nobody grants now fails here
// rather than on a live agent an hour into a plan.

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gateBash } from "../packages/maestro/src/bash-gate.js";
import { executionPolicyPreset } from "../packages/maestro/src/execution-policy.js";
import { startWorker } from "../packages/maestro/src/extension.js";
import { mode } from "../packages/maestro/src/mode.js";
import {
	describeReadOnlyTools,
	PI_BUILTINS,
	READ_ONLY_BUILTINS,
} from "../packages/maestro/src/spawn.js";

const SOURCES = ["bash-policy.ts"];

/**
 * The tools a worker really holds, read off the REAL entry point.
 *
 * Deliberately not a registry this file builds. The first draft did exactly
 * that, and removing `commit` from `extension.ts` did not fail a single test —
 * because the fixture still declared it. A test that constructs its own version
 * of the thing under test asserts on the fixture, which is how the phantom got
 * in. So this drives `startWorker` and collects what it actually registers.
 */
async function workerTools(): Promise<Set<string>> {
	const registered: string[] = [];
	const pi = {
		registerTool: (tool: unknown) =>
			registered.push((tool as { name: string }).name),
	};
	const started = startWorker(
		pi,
		{
			agentId: "worker-api",
			socketPath: join(tmpdir(), "nothing-listening.sock"),
			token: "t",
			depth: 1,
		},
		{ extensions: [] },
	);
	// Nothing is listening, so the handshake fails — and that is fine here:
	// registration is synchronous and has already happened.
	await started.catch(() => undefined);
	// pi's builtins are real tools an agent can call; they are simply not ours
	// to declare. A worker is launched with no `--tools` allowlist, so it gets
	// all of them.
	//
	// PI_BUILTINS, not READ_ONLY_BUILTINS. Unioning the read-only ALLOWLIST here
	// is what let this test pass over a refusal reading "Use the webfetch tool":
	// that list was hand-written and contained `webfetch` and `websearch`, which
	// pi does not define. A list that is simultaneously the configuration and
	// the test's notion of truth cannot catch its own errors — each role hides
	// the other's mistakes.
	return new Set([...registered, ...PI_BUILTINS]);
}

/**
 * Comment lines are dropped before matching.
 *
 * A refusal is a string an agent receives; a comment ABOUT a refusal is not.
 * Without this, the note explaining why `ship` was removed trips the check that
 * removing it satisfied — which is a false alarm, and false alarms are how a
 * guard ends up disabled. The narrow risk is a real refusal built on a line
 * that also holds a trailing comment; refusals here are plain returns.
 */
function code(text: string): string {
	return text
		.split("\n")
		.filter((line) => {
			const t = line.trim();
			return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
		})
		.join("\n");
}

function namedInRefusals(): { tool: string; where: string }[] {
	const found: { tool: string; where: string }[] = [];
	for (const file of SOURCES) {
		const text = code(
			readFileSync(join(process.cwd(), "packages/maestro/src", file), "utf8"),
		);
		for (const match of text.matchAll(/[Uu]se the ([a-z][a-z-]*) tool/g))
			found.push({ tool: match[1] as string, where: file });
	}
	return found;
}

describe("a refusal never names a tool that does not exist", () => {
	it("finds the refusals at all — this test is worthless if the regex misses", () => {
		// Pinned because the whole check is a string search. A refactor that
		// rewords every message would otherwise turn this file into a test that
		// passes by finding nothing.
		// One source now: `bash-classifier.ts` was deleted — it was unreachable
		// (zero callers) and its refusals taught an LLM to suggest `webfetch`,
		// which pi does not define. The pin stays, at the count that is true
		// today, so a refactor that reworded every refusal cannot turn this file
		// into a test that passes by finding nothing.
		const named = namedInRefusals();
		expect(named.length).toBeGreaterThanOrEqual(1);
		expect(named.map((n) => n.tool)).toContain("commit");
	});

	it("names only tools a worker actually holds", async () => {
		const held = await workerTools();
		const phantom = namedInRefusals().filter((n) => !held.has(n.tool));
		expect(phantom).toEqual([]);
	});

	it("gives a worker a real way to commit, since bash is not one", async () => {
		// The two halves of the same decision, asserted together: the classifier
		// refuses the shell path, so the granted path has to exist.
		const decision = gateBash({
			command: 'git commit -m "work"',
			holder: "worker",
			mode: mode("auto"),
			policy: executionPolicyPreset("guided"),
		});
		expect(decision.kind).toBe("deny");
		expect(decision.reason).toContain("commit tool");
		expect((await workerTools()).has("commit")).toBe(true);
	});

	it("names in READ_ONLY_BUILTINS every one a tool pi actually defines", () => {
		// The allowlist is passed to pi, which silently ignores names it does not
		// recognise — so a wish narrows an agent's tools with no error anywhere.
		// `websearch` and `webfetch` sat here for months doing exactly that.
		for (const name of READ_ONLY_BUILTINS)
			expect(PI_BUILTINS as readonly string[]).toContain(name);
	});

	it("promises a read-only agent only what it is launched with", () => {
		// Its brief used to come from `describeFor("read-only")` and named
		// `delegate`, which it neither registers nor is allowed to call.
		const brief = describeReadOnlyTools();
		for (const name of READ_ONLY_BUILTINS) expect(brief).toContain(name);
		expect(brief).not.toContain("delegate");
		expect(brief).not.toContain("bash");
	});

	it("does not tell a worker to ship, because shipping is the maestro's", () => {
		const decision = gateBash({
			command: "git push origin HEAD",
			holder: "worker",
			mode: mode("auto"),
			policy: executionPolicyPreset("guided"),
		});
		expect(decision.kind).toBe("deny");
		expect(decision.reason).not.toContain("ship tool");
		expect(decision.reason).toContain("maestro");
	});
});
