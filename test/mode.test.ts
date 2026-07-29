// Modes: two properties, three coherent combinations, and nothing stored twice.
//
// The old model answered every new question about a mode by adding a field to
// it, so the answers drifted apart. Each case here is a question that used to
// need its own field and now falls out of the two facts.

import { describe, expect, it } from "vitest";
import { AGENT_KINDS } from "../packages/maestro/src/agent.js";
import {
	MODE_NAMES,
	mayProduce,
	mode,
	modeForChild,
	modeOf,
	modes,
} from "../packages/maestro/src/mode.js";

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

describe("delegation is derived, never configured", () => {
	it("stops a read-only session producing something that writes", () => {
		// Otherwise "plan mode" means "cannot edit, but can ask someone else to",
		// which is not a restriction at all.
		expect(mayProduce(mode("plan"), "worker")).toMatch(/cannot write/);
	});

	it("leaves readers available while planning", () => {
		// Researching while planning is the point of planning.
		for (const kind of ["explorer", "reviewer", "advisor"] as const)
			expect(mayProduce(mode("plan"), kind)).toBeNull();
	});

	it("lets a writing session produce anything spawnable", () => {
		for (const name of ["auto", "hack"] as const)
			for (const kind of AGENT_KINDS)
				if (kind !== "maestro") expect(mayProduce(mode(name), kind)).toBeNull();
	});

	it("never produces a maestro", () => {
		for (const name of MODE_NAMES)
			expect(mayProduce(mode(name), "maestro")).toMatch(/never spawned/);
	});
});

describe("safeguards do not propagate", () => {
	it("gives a hack session's worker the same mode an auto session's gets", () => {
		// Relaxing safeguards is something a human does to their own seat for one
		// command they are watching. An unattended agent is a different thing:
		// a linked worktree SHARES the repository's config file, so `git config
		// user.email` inside one rewrites it for every worktree and for the user.
		// That has happened here twice, and both times a human was watching.
		expect(modeForChild(mode("hack"), "worker")).toEqual(
			modeForChild(mode("auto"), "worker"),
		);
		expect(modeForChild(mode("hack"), "worker").safeguards).toBe("on");
	});

	it("still gives a worker the write access it cannot work without", () => {
		expect(modeForChild(mode("auto"), "worker").cwd).toBe("write");
	});

	it("gives readers no write access at all", () => {
		for (const kind of ["explorer", "reviewer", "advisor"] as const)
			expect(modeForChild(mode("hack"), kind)).toEqual(mode("plan"));
	});

	it("refuses to describe a child it may not produce", () => {
		expect(() => modeForChild(mode("plan"), "worker")).toThrow(/cannot write/);
	});
});
