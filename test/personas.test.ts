import { describe, expect, it } from "vitest";
import {
	buildPersonaProfile,
	buildVerifierProfile,
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
import { mapProfileToInvocation } from "../packages/subagents/src/invocation.js";
import { resolveProfile } from "../packages/subagents/src/profiles.js";

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
	it("builds a read-only, isolated, inspectable spawn profile in the worktree", () => {
		const profile = buildPersonaProfile(
			{ name: "security-audit", persona: "security-audit" },
			{ cwd: "/wt" },
		);
		expect(profile).not.toBeNull();
		expect(profile?.cwd).toBe("/wt");
		expect(profile?.tools?.allow).toEqual([...PERSONA_TOOLS]);
		expect(profile?.tools?.allow).not.toContain("write");
		expect(profile?.session).toBe(true);
		// No transport selection here: the service default decides (headless
		// until tmux passes transport-failure tests; PI_MAESTRO_TRANSPORT=tmux
		// opts in process-wide).
		expect(profile?.transport).toBeUndefined();
		expect(profile?.role).toBe("reviewer");
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

describe("one-shot subagents are leaves", () => {
	// Reviewers, the verifier, and research children must never be able to
	// spawn: the depth cap is only the backstop; the structural guarantee is
	// that their profiles grant no spawn tool and isolate extensions, so the
	// subagents extension (the `subagent` tool) can never load in the child.
	const SPAWN_TOOLS = ["subagent", "agent", "task"];
	const ctx = { repoRoot: "/repo", parentDepth: 1 };

	const leafProfiles = () => [
		buildPersonaProfile(
			{ name: "security-audit", persona: "security-audit" },
			{ cwd: "/wt" },
		)!,
		buildVerifierProfile({ cwd: "/wt" }),
	];

	it("reviewer and verifier profiles grant no spawn capability", () => {
		for (const profile of leafProfiles()) {
			for (const tool of SPAWN_TOOLS) {
				expect(profile.tools?.allow).not.toContain(tool);
			}
			expect(profile.isolateExtensions).toBe(true);
			expect(profile.extraExtensions).toBeUndefined();
		}
	});

	it("their child invocation cannot load the subagents extension", () => {
		for (const profile of leafProfiles()) {
			const inv = mapProfileToInvocation(profile, ctx);
			// -ne drops every globally configured extension; with no -e the
			// child's namespace is exactly the builtins.
			expect(inv.args).toContain("-ne");
			expect(inv.args).not.toContain("-e");
			const tools = inv.args[inv.args.indexOf("--tools") + 1];
			for (const tool of SPAWN_TOOLS) {
				expect(tools.split(",")).not.toContain(tool);
			}
		}
	});

	it("the research builtin profile is isolated with no spawn tool", () => {
		// Research runs pass extraExtensions=[research-tools] on this profile —
		// isolation must survive that, and the default tool set must not spawn.
		const resolved = resolveProfile({
			profile: "research",
			extraExtensions: ["/repo/packages/research-tools/src/index.ts"],
		});
		expect(resolved.isolateExtensions).toBe(true);
		for (const tool of SPAWN_TOOLS) {
			expect(resolved.tools?.allow).not.toContain(tool);
		}
		expect(resolved.extraExtensions.some((e) => e.includes("subagents"))).toBe(
			false,
		);
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
