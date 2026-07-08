import { describe, expect, it } from "vitest";
import {
	buildPersonaProfile,
	getPersona,
	PERSONA_IDS,
	PERSONA_TOOLS,
	PERSONAS,
} from "../packages/modes/src/personas.js";

describe("persona registry", () => {
	it("ships the 8 starter personas with unique ids", () => {
		expect(PERSONAS).toHaveLength(8);
		expect(new Set(PERSONA_IDS).size).toBe(8);
		expect(PERSONA_IDS).toContain("security-audit");
		expect(PERSONA_IDS).toContain("simplification");
	});

	it("gates security/correctness/test-coverage; the rest are advisory", () => {
		const gating = PERSONAS.filter((p) => p.gating).map((p) => p.id);
		expect(gating).toEqual([
			"correctness-review",
			"security-audit",
			"test-coverage",
		]);
	});

	it("every persona defaults to the default slot (multi-model is plan-time)", () => {
		for (const p of PERSONAS) expect(p.slot).toBe("default");
	});

	it("each preamble carries the read-only contract + verdict line", () => {
		for (const p of PERSONAS) {
			expect(p.preamble).toContain("read-only");
			expect(p.preamble).toContain("VERDICT: PASS");
			expect(p.preamble).toContain("file:line");
		}
	});

	it("read-only tool set excludes write/edit", () => {
		expect(PERSONA_TOOLS).not.toContain("write");
		expect(PERSONA_TOOLS).not.toContain("edit");
		expect(PERSONA_TOOLS).toContain("read");
	});

	it("getPersona resolves by id", () => {
		expect(getPersona("security-audit")?.effort).toBe("high");
		expect(getPersona("documentation")?.effort).toBe("low");
		expect(getPersona("nope")).toBeUndefined();
	});
});

describe("buildPersonaProfile", () => {
	it("builds a read-only, isolated, one-shot spawn profile in the worktree", () => {
		const profile = buildPersonaProfile(
			{ name: "security-audit", persona: "security-audit" },
			{ cwd: "/wt" },
		);
		expect(profile).not.toBeNull();
		expect(profile?.cwd).toBe("/wt");
		expect(profile?.tools?.allow).toEqual([...PERSONA_TOOLS]);
		expect(profile?.tools?.allow).not.toContain("write");
		expect(profile?.session).toBe(false);
		expect(profile?.isolateExtensions).toBe(true);
		expect(profile?.thinking).toBe("high"); // persona default
		expect(profile?.appendSystemPrompt).toContain("VERDICT: PASS");
		expect(profile?.appendSystemPrompt).toContain("OWASP");
	});

	it("applies effort/focus/model overrides", () => {
		const profile = buildPersonaProfile(
			{
				name: "security-audit-alt",
				persona: "security-audit",
				effort: "medium",
				focus: "token refresh path",
				model: "openai/o3",
			},
			{ cwd: "/wt", model: "openai/o3" },
		);
		expect(profile?.thinking).toBe("medium");
		expect(profile?.model).toBe("openai/o3");
		expect(profile?.appendSystemPrompt).toContain("token refresh path");
	});

	it("returns null for an unknown persona", () => {
		expect(
			buildPersonaProfile({ name: "x", persona: "nope" }, { cwd: "/wt" }),
		).toBeNull();
	});
});
