// Modes: three facts, four coherent combinations, and nothing stored twice.
//
// The old model answered every new question about a mode by adding a field to
// it, so the answers drifted apart. Each case here is a question that used to
// need its own field and now falls out of the three facts.
//
// The third fact is the one `ask` came back for. `ask` and `auto` are the same
// permissions and differ only in what happens when a plan run ends, and the whole
// point of putting that in the table is that the difference is DERIVED — the gate
// policy, the ceiling and the exit list all read it, and none of them writes it
// down a second time.

import { describe, expect, it } from "vitest";
import {
	EXIT_MODES,
	MODE_NAMES,
	mode,
	modeCeiling,
	modeOf,
	modes,
	PLAN_EXIT_MODES,
	planGatesFor,
} from "../packages/maestro/src/mode.js";

describe("a mode is three facts", () => {
	it("names exactly the coherent combinations", () => {
		expect(
			modes().map((m) => [m.name, m.cwd, m.safeguards, m.publication]),
		).toEqual([
			["plan", "read", "on", "none"],
			["ask", "write", "on", "ask"],
			["auto", "write", "on", "auto"],
			["hack", "write", "reduced", "none"],
		]);
		expect(modes()).toHaveLength(MODE_NAMES.length);
	});

	it("has no read-only mode with reduced safeguards", () => {
		expect(modeOf("read", "reduced", "none")).toBeNull();
	});

	it("resolves a mode from its facts, not from a stored name", () => {
		expect(modeOf("write", "reduced", "none")?.name).toBe("hack");
		expect(modeOf("read", "on", "none")?.name).toBe("plan");
	});

	// The reason the third column exists. Two modes share every other fact, so a
	// derivation from two would have to pick one of them — which is exactly the
	// special case beside the table that this replaced.
	it("tells ask and auto apart by publication and by nothing else", () => {
		const ask = mode("ask");
		const auto = mode("auto");
		expect([ask.cwd, ask.safeguards]).toEqual([auto.cwd, auto.safeguards]);
		expect(modeOf("write", "on", "ask")?.name).toBe("ask");
		expect(modeOf("write", "on", "auto")?.name).toBe("auto");
	});

	it("gives ask and auto the same ceiling, and hack none", () => {
		expect(modeCeiling("ask")).toEqual(modeCeiling("auto"));
		expect(modeCeiling("ask")).toEqual({
			workspaceModes: ["read-only", "worktree"],
		});
		expect(modeCeiling("plan")).toEqual({ workspaceModes: ["read-only"] });
		expect(modeCeiling("hack")).toBeUndefined();
	});
});

describe("what the mode decides about the end of a run", () => {
	it("derives the gate policy from the publication fact", () => {
		expect(planGatesFor("ask")).toBe("ship");
		expect(planGatesFor("auto")).toBe("none");
	});

	it("gives plan and hack no gate policy, because they form no run", () => {
		expect(planGatesFor("plan")).toBeUndefined();
		expect(planGatesFor("hack")).toBeUndefined();
	});

	// Derived, not listed: a mode added to the table with a publication answer
	// becomes an exit that forms a run without anybody editing a second list.
	it("lists exactly the exit modes that form a run", () => {
		expect([...EXIT_MODES]).toEqual(["ask", "auto", "hack"]);
		expect([...PLAN_EXIT_MODES]).toEqual(["ask", "auto"]);
		for (const name of PLAN_EXIT_MODES)
			expect(planGatesFor(name)).not.toBeUndefined();
	});
});
