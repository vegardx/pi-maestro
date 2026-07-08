import { describe, expect, it } from "vitest";
import {
	buildPersonaProfile,
	getPersona,
	PERSONA_IDS,
	PERSONA_TOOLS,
	PERSONAS,
	panelTopologyGaps,
} from "../packages/modes/src/personas.js";
import type {
	Deliverable,
	SubAgentSpec,
} from "../packages/modes/src/schema.js";

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
		// The harness names the persona deterministically (not inferred prose).
		expect(profile?.appendSystemPrompt).toContain(
			'You are the "security-audit" reviewer',
		);
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

describe("panelTopologyGaps", () => {
	const deliv = (
		id: string,
		mode: "full" | "read-only",
		subAgents: SubAgentSpec[],
	): Deliverable =>
		({
			id,
			title: id.toUpperCase(),
			worker: { mode },
			subAgents,
			tasks: [],
		}) as unknown as Deliverable;

	it("flags a code-changing deliverable with no reviewers", () => {
		const gaps = panelTopologyGaps([deliv("auth", "full", [])]);
		expect(gaps).toHaveLength(1);
		expect(gaps[0]).toContain("no reviewers");
	});

	it("flags reviewers present but none required", () => {
		const gaps = panelTopologyGaps([
			deliv("auth", "full", [{ name: "s", persona: "simplification" }]),
		]);
		expect(gaps[0]).toContain("none are required");
	});

	it("flags a gating persona that isn't marked required", () => {
		const gaps = panelTopologyGaps([
			deliv("auth", "full", [
				{ name: "sec", persona: "security-audit" }, // gating but not required
				{ name: "corr", persona: "correctness-review", required: true },
			]),
		]);
		expect(gaps.some((g) => g.includes("gating persona"))).toBe(true);
	});

	it("passes a well-formed panel and ignores read-only deliverables", () => {
		const gaps = panelTopologyGaps([
			deliv("auth", "full", [
				{ name: "sec", persona: "security-audit", required: true },
			]),
			deliv("docs", "read-only", []), // no code change → no reviewer needed
		]);
		expect(gaps).toEqual([]);
	});
});
