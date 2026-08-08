// Modes: two properties, three coherent combinations, and nothing stored twice.
//
// The old model answered every new question about a mode by adding a field to
// it, so the answers drifted apart. Each case here is a question that used to
// need its own field and now falls out of the two facts.

import { describe, expect, it } from "vitest";
import { MODE_NAMES, modeOf, modes } from "../packages/maestro/src/mode.js";

describe("a mode is two facts", () => {
	it("names exactly the coherent combinations", () => {
		expect(modes().map((m) => [m.name, m.cwd, m.safeguards])).toEqual([
			["plan", "read", "on"],
			["auto", "write", "on"],
			["hack", "write", "off"],
		]);
		expect(modes()).toHaveLength(MODE_NAMES.length);
	});

	it("has no read-only mode with the safeguards off", () => {
		// Missing on purpose. With the classifier off, bash can rewrite anything,
		// so a read-only session with no safeguards is read-only in name only —
		// which is the forcing bug this system actually shipped. A mode that lies
		// about what it permits is worse than one that does not exist.
		expect(modeOf("read", "off")).toBeNull();
	});

	it("resolves a mode from its facts, not from a stored name", () => {
		expect(modeOf("write", "off")?.name).toBe("hack");
		expect(modeOf("read", "on")?.name).toBe("plan");
	});
});
