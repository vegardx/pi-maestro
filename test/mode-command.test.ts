// The posture axis: ONE `/mode` command, and `/plan` is an artifact command
// that never moves it.
//
// The structural assertions read source text (the pattern plan-naming.test.ts
// uses) because there is no RuntimeContext harness. They are cheap guards for
// invariants that are easy to violate by accident and expensive to notice.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_MODES } from "../packages/contracts/src/modes.js";
import { SWITCHABLE_MODES } from "../packages/modes/src/runtime/commands.js";

const source = (rel: string) =>
	readFileSync(join(process.cwd(), "packages/modes/src", rel), "utf8");

/** Lines that actually INVOKE the named function (definitions/types excluded). */
const callSites = (text: string, fn: string): string[] =>
	text
		.split("\n")
		.map((line) => line.trim())
		.filter(
			(line) =>
				line.includes(`await ${fn}(`) || line.includes(`await rt.${fn}(`),
		);

describe("switchable modes", () => {
	it("offers every mode except agent", () => {
		// `agent` is the internal worker posture — never a destination a human
		// picks. Everything else must be reachable, so adding a mode to ALL_MODES
		// and forgetting the picker fails here.
		expect([...SWITCHABLE_MODES].sort()).toEqual(
			ALL_MODES.filter((mode) => mode !== "agent")
				.slice()
				.sort(),
		);
	});
});

describe("/plan is an artifact command", () => {
	const commands = source("runtime/commands.ts");

	it("does not change posture", () => {
		// The plan is harness-owned: you can reopen one from any mode. Posture is
		// `/mode`'s job alone.
		const handler = commands.slice(
			commands.indexOf('pi.registerCommand("plan"'),
			commands.indexOf('pi.registerCommand("mode"'),
		);
		expect(handler).not.toContain("setMode");
		expect(handler).not.toContain("requestMode");
	});
});

describe("the posture surface", () => {
	const commands = source("runtime/commands.ts");

	it("registers /mode", () => {
		expect(commands).toContain('pi.registerCommand("mode"');
	});

	it("no longer registers /auto, /hack or /recon as their own commands", () => {
		expect(commands).not.toContain('for (const mode of ["hack", "auto"]');
		expect(commands).not.toContain('pi.registerCommand("recon"');
	});

	it("keeps mode changes operator-only", () => {
		// hack lifts every restriction; a spawned agent must never widen its own
		// posture, even if some internal path reaches the handler.
		const handler = commands.slice(
			commands.indexOf('pi.registerCommand("mode"'),
		);
		expect(handler.slice(0, 900)).toContain("isAgentMode()");
	});
});

describe("the live-worker guard", () => {
	const context = source("runtime/context.ts");
	const commands = source("runtime/commands.ts");

	it("guards the operator gesture and nothing else", () => {
		// Correction that shaped this design: plenty of INTERNAL mode changes are
		// correct while workers are live and must never prompt — /recover and
		// /restart force auto, the bash router widens to hack on an isolation
		// failure, onAllSettled returns to plan, agent boot writes mode directly.
		// So the guard belongs to the gesture, not to commitMode/setMode; pinning
		// the call sites is what keeps it from drifting down into the transition.
		expect(callSites(context, "guardPostureChange")).toEqual([
			'if (!(await guardPostureChange(ctx, "plan"))) return;', // returnToPlan
			"if (!(await rt.guardPostureChange(ctx, to))) return;", // cycle, forward
		]);
		expect(callSites(commands, "guardPostureChange")).toEqual([
			"if (!(await rt.guardPostureChange(ctx, target))) return;", // /mode
		]);
	});
});
