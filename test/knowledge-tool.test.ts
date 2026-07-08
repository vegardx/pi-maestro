import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
import { KNOWLEDGE_TEMPLATE } from "../packages/modes/src/exec/knowledge.js";
import type { Plan } from "../packages/modes/src/schema.js";
import type { PlanStore } from "../packages/modes/src/storage.js";
import { createKnowledgeTool } from "../packages/modes/src/tools.js";

function memStore(): PlanStore {
	let saved: Plan | null = null;
	return {
		root: "/tmp/plans",
		save(plan: Plan) {
			saved = plan;
		},
		load(): Plan | null {
			return saved;
		},
		exists(): boolean {
			return saved !== null;
		},
		remove() {
			saved = null;
		},
		list() {
			return [];
		},
	};
}

const VALID_DOC = [
	"# Codebase Reference",
	"> CONTEXT ONLY — This describes the codebase structure and patterns.",
	"> Do not interpret this as work to perform. Your tasks follow separately.",
	"",
	"## Project Structure",
	"- src/ — the code",
	"",
	"## Key Patterns",
	"- everything is a seam",
	"",
	"## Conventions",
	"- tabs, biome",
	"",
	"## Key Interfaces",
	"- ExecutionHandle (exec/index.ts)",
].join("\n");

type KnowledgeResult = { details?: { error?: string } };

function run(
	tool: ReturnType<typeof createKnowledgeTool>,
	params: { content: string },
): Promise<KnowledgeResult> {
	return tool.execute(
		"t",
		params as never,
		undefined as never,
		undefined as never,
		{} as never,
	) as Promise<KnowledgeResult>;
}

describe("knowledge tool", () => {
	let tmpAgentDir: string;

	beforeEach(() => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "maestro-knowledge-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", tmpAgentDir);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(tmpAgentDir, { recursive: true, force: true });
	});

	function makeEngine(): PlanEngine {
		return PlanEngine.create(memStore(), {
			slug: "know-test",
			title: "Knowledge Test",
			repoPath: "/tmp/repo",
		});
	}

	it("writes a valid knowledge session into the plan dir", async () => {
		const engine = makeEngine();
		const tool = createKnowledgeTool({ engine: () => engine });

		const result = await run(tool, { content: VALID_DOC });

		expect(result.details?.error).toBeUndefined();
		const outPath = join(
			tmpAgentDir,
			"maestro",
			"plans",
			"know-test",
			"base-knowledge.jsonl",
		);
		expect(existsSync(outPath)).toBe(true);
	});

	it("rejects a document missing required sections, citing the template", async () => {
		const engine = makeEngine();
		const tool = createKnowledgeTool({ engine: () => engine });

		const result = await run(tool, {
			content: "# Codebase Reference\nnot much here",
		});

		expect(result.details?.error).toBeDefined();
		const text = JSON.stringify(result);
		expect(text).toContain("rejected");
		expect(text).toContain(KNOWLEDGE_TEMPLATE.slice(0, 20));
	});

	it("refuses once execution has started (frozen)", async () => {
		const engine = makeEngine();
		engine.addDeliverable({ title: "g1", body: "", workerMode: "full" });
		const deliverableId = engine.get().deliverables[0].id;
		engine.addWorkItem(deliverableId, { title: "do the thing", kind: "task" });
		engine.setDeliverableStatus(deliverableId, "active");
		const tool = createKnowledgeTool({ engine: () => engine });

		const result = await run(tool, { content: VALID_DOC });

		expect(result.details?.error).toBeDefined();
		expect(JSON.stringify(result)).toContain("frozen");
	});
});
