// v2 exec periphery (cutover PR-6): the contract collection cadence
// (extract → validate → ≤2 corrective steers → salvage → fail-visible
// fallback), spawn-time resolution records, and persona-aware seed heads.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Persona } from "@vegardx/pi-subagents";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ContractTransport,
	collectContract,
	personaSeedHead,
	resolveNodeModel,
} from "../packages/modes/src/plan/node-periphery.js";

const GOOD_BLOCK =
	'```pi-contract\n{ "contract": "verdict", "v": 1, "status": "complete", "payload": { "verdict": "pass", "reason": "clean" } }\n```';
const BAD_BLOCK =
	'```pi-contract\n{ "contract": "verdict", "v": 1, "status": "complete", "payload": { "verdict": "maybe" } }\n```';

function transport(
	replies: string[],
): ContractTransport & { steers: string[] } {
	const steers: string[] = [];
	let i = 0;
	return {
		steers,
		request: async () => replies[Math.min(i++, replies.length - 1)],
		steer: (content) => {
			steers.push(content);
		},
	};
}

describe("collectContract cadence", () => {
	const base = {
		contract: "verdict" as const,
		nodeId: "n",
		runId: "r",
		model: "prov/m",
		now: () => "t",
	};

	it("valid first block → extraction 'block', one attempt", async () => {
		const t = transport([GOOD_BLOCK]);
		const result = await collectContract({ ...base, transport: t });
		expect(result).toMatchObject({ extraction: "block", attempts: 1 });
		expect(result.envelope?.payload).toMatchObject({ verdict: "pass" });
		expect(t.steers).toEqual([]);
	});

	it("invalid block → corrective steer → retry-block on the fix", async () => {
		const t = transport([BAD_BLOCK, GOOD_BLOCK]);
		const result = await collectContract({ ...base, transport: t });
		expect(result).toMatchObject({ extraction: "retry-block", attempts: 2 });
		expect(t.steers).toHaveLength(1);
		expect(t.steers[0]).toContain("```pi-contract");
		expect(t.steers[0]).toContain("verdict must be pass|block");
		expect(result.diagnostics?.join(" ")).toContain("attempt 1");
	});

	it("incorrigible agent → salvage via the tolerant parser, status partial", async () => {
		const legacy = "long report…\nVERDICT: PASS";
		const t = transport([legacy, legacy, legacy]);
		const result = await collectContract({ ...base, transport: t });
		expect(result.extraction).toBe("salvage-parse");
		expect(result.attempts).toBe(3);
		expect(result.envelope).toMatchObject({
			status: "partial",
			payload: { verdict: "pass" },
		});
		expect(t.steers).toHaveLength(2); // exactly the spike's budget
	});

	it("dead agent with a transcript → salvage without any steers", async () => {
		const result = await collectContract({
			...base,
			raw: "…crashed mid-flight…\nVERDICT: request-changes\n- a.ts:1 — bug",
		});
		expect(result.extraction).toBe("salvage-parse");
		expect(result.envelope?.payload).toMatchObject({ verdict: "block" });
	});

	it("nothing parseable → fail-visible fallback (never fail-open)", async () => {
		const result = await collectContract({ ...base, raw: "gibberish only" });
		expect(result).toMatchObject({ extraction: "fallback", envelope: null });
		expect(result.raw).toBe("gibberish only");
	});

	it("a block carrying the WRONG contract id never validates through", async () => {
		const wrong =
			'```pi-contract\n{ "contract": "report", "v": 1, "status": "complete", "payload": { "answer": "x", "facts": [], "unknowns": [], "confidence": "low" } }\n```';
		const t = transport([wrong, wrong, wrong]);
		const result = await collectContract({ ...base, transport: t });
		expect(result.extraction).not.toBe("block");
		expect(result.diagnostics?.join(" ")).toContain("expected verdict");
	});
});

describe("resolveNodeModel → ledger record", () => {
	let cwd: string;
	let prevAgentDir: string | undefined;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "periph-resolve-"));
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(cwd, ".agent");
		mkdirSync(join(cwd, ".agent"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({
				models: {
					families: {
						OpenAI: {
							aliases: {
								Sol: {
									attach: ["prov/sol"],
									effort: "high",
									efforts: ["medium", "high"],
								},
							},
						},
					},
					rosters: { daily: { standard: ["OpenAI/Sol"] } },
					bindings: { main: { targets: ["prov/seat"], roster: "daily" } },
					// worker default is now empty (inherit); configure it so the
					// tier-resolution path under test can request `standard`.
					allowances: { worker: { tiers: ["standard"] } },
				},
			}),
		);
	});

	afterEach(() => {
		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		rmSync(cwd, { recursive: true, force: true });
	});

	function ctx(): ExtensionContext {
		return {
			cwd,
			model: { provider: "prov", id: "seat" },
			modelRegistry: {
				find: (provider: string, id: string) => ({
					provider,
					id,
					reasoning: true,
					thinkingLevelMap: {},
				}),
				getApiKeyAndHeaders: async () => ({
					ok: true,
					apiKey: "k",
					headers: {},
				}),
			},
		} as unknown as ExtensionContext;
	}

	it("inherit → source inherit, empty family, no tier", async () => {
		const { resolution } = await resolveNodeModel(ctx(), {
			node: { id: "n", agent: "worker", sessionGeneration: 2 },
			inherit: { modelId: "prov/parent", effort: "high" },
			now: () => "t",
		});
		expect(resolution).toMatchObject({
			model: "prov/parent",
			family: "",
			source: "inherit",
			effort: "high",
			generation: 2,
		});
		expect(resolution.tier).toBeUndefined();
	});

	it("tier → source persona-tier with catalog family on the record", async () => {
		const { resolution } = await resolveNodeModel(ctx(), {
			node: { id: "n", agent: "worker" },
			tier: "standard",
			now: () => "t",
		});
		expect(resolution).toMatchObject({
			model: "prov/sol",
			family: "OpenAI",
			tier: "standard",
			source: "persona-tier",
			effort: "high",
			generation: 0,
		});
	});

	it("exhausted tier → session-fallback with the reason recorded", async () => {
		const { resolution } = await resolveNodeModel(ctx(), {
			node: { id: "n", agent: "reviewer" },
			tier: "heavy", // empty in the catalog
			now: () => "t",
		});
		expect(resolution).toMatchObject({
			model: "prov/seat",
			source: "session-fallback",
		});
		expect(resolution.fallbackReason).toContain("empty");
	});
});

describe("persona seed head", () => {
	const persona: Persona = {
		name: "coder",
		agents: ["worker"],
		contract: "summary-and-diff",
		skills: ["repo-conventions"],
		prompt: "You are a focused implementer.",
		source: "bundled",
		path: "/x/coder.md",
	};

	it("prompt first, then the union of persona and node skills", () => {
		const head = personaSeedHead(persona, ["github", "repo-conventions"]);
		expect(head.indexOf("focused implementer")).toBeLessThan(
			head.indexOf("Loaded skills"),
		);
		expect(head.match(/repo-conventions/g)).toHaveLength(1); // deduped
		expect(head).toContain("- github");
		expect(head.trimEnd().endsWith("---")).toBe(true);
	});

	it("absent persona yields an empty head (spawn proceeds without one)", () => {
		expect(personaSeedHead(undefined, ["github"])).toBe("");
	});
});
