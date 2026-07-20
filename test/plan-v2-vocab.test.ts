// v2 plan vocabulary (cutover PR-2): resolution records, diversity edge
// records, envelopes — the shared types the plan module builds on.

import {
	DEFAULT_MAX_DEPTH,
	diversityRecordFor,
	NODE_AGENT_TYPES,
	PLAN_SCHEMA_VERSION_V2,
	validateDiversityRecord,
	validateNodeEnvelope,
	validateNodeResolution,
} from "@vegardx/pi-contracts";
import { describe, expect, it } from "vitest";

describe("vocabulary constants", () => {
	it("pins the version, the spawnable types, and the depth default", () => {
		expect(PLAN_SCHEMA_VERSION_V2).toBe(6);
		expect(NODE_AGENT_TYPES).toEqual(["worker", "explorer", "reviewer"]);
		expect(DEFAULT_MAX_DEPTH).toBe(3);
	});
});

describe("NodeResolution validation", () => {
	const BASE = {
		model: "sit-openai/gpt-5.6-sol",
		family: "openai",
		resolvedAt: "2026-07-20T17:00:00Z",
		generation: 0,
	};

	it("accepts the three source shapes with their required fields", () => {
		expect(
			validateNodeResolution({
				...BASE,
				source: "persona-tier",
				tier: "normal",
			}),
		).toEqual([]);
		expect(
			validateNodeResolution({ ...BASE, family: "", source: "inherit" }),
		).toEqual([]);
		expect(
			validateNodeResolution({
				...BASE,
				family: "",
				source: "session-fallback",
				fallbackReason: "tier normal is empty",
			}),
		).toEqual([]);
	});

	it("rejects tier-less persona-tier, reasonless fallback, tiered inherit", () => {
		expect(
			validateNodeResolution({ ...BASE, source: "persona-tier" }).join(" "),
		).toContain("must name their tier");
		expect(
			validateNodeResolution({ ...BASE, source: "session-fallback" }).join(" "),
		).toContain("fallbackReason");
		expect(
			validateNodeResolution({ ...BASE, source: "inherit", tier: "fast" }).join(
				" ",
			),
		).toContain("carry no tier");
	});
});

describe("diversity records", () => {
	it("flags same authored families, honors waivers, never flags unknowns", () => {
		const flagged = diversityRecordFor("openai", "openai", undefined, "t");
		expect(flagged.sameFamily).toBe(true);
		expect(flagged.waiver).toBeUndefined();

		const waived = diversityRecordFor(
			"openai",
			"openai",
			"only sol in EEA",
			"t",
		);
		expect(waived).toMatchObject({
			sameFamily: true,
			waiver: "only sol in EEA",
		});

		// Half an edge is not an edge: inherit/fallback resolutions carry
		// family "" and must never produce a same-family warning.
		expect(diversityRecordFor("", "openai", undefined, "t").sameFamily).toBe(
			false,
		);
		expect(diversityRecordFor("openai", "", undefined, "t").sameFamily).toBe(
			false,
		);
		// A waiver on a diverse edge is dropped, not recorded.
		expect(
			diversityRecordFor("openai", "anthropic", "unneeded", "t").waiver,
		).toBeUndefined();

		expect(validateDiversityRecord(flagged)).toEqual([]);
		expect(validateDiversityRecord({ sameFamily: "yes" }).join(" ")).toContain(
			"boolean",
		);
	});
});

describe("envelopes", () => {
	it("validates the two positive-integer caps", () => {
		expect(validateNodeEnvelope({ maxChildren: 6, maxConcurrent: 3 })).toEqual(
			[],
		);
		expect(validateNodeEnvelope({})).toEqual([]);
		expect(validateNodeEnvelope({ maxChildren: 0 }).join(" ")).toContain(
			"positive integer",
		);
		expect(validateNodeEnvelope({ maxConcurrent: 1.5 }).join(" ")).toContain(
			"positive integer",
		);
	});
});
