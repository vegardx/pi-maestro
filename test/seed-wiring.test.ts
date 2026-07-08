// Seed + knowledge wiring in the execution adapter's spawn path: a spawned
// agent's session file must fork the plan's frozen knowledge session (when
// present) and carry the deterministic framed seed (Prior Work from dep-deliverable
// summaries, Your Tasks) — not the legacy unframed seed.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
import {
	ExecutionAdapter,
	type TmuxApi,
} from "../packages/modes/src/exec/execution-adapter.js";
import {
	buildKnowledgeSession,
	KNOWLEDGE_CUSTOM_TYPE,
	KNOWLEDGE_FRAME,
} from "../packages/modes/src/exec/knowledge.js";
import {
	PRIOR_WORK_FRAME,
	PRIOR_WORK_HEADER,
	TASKS_FRAME,
	TASKS_HEADER,
} from "../packages/modes/src/exec/seeds.js";
import type { Plan } from "../packages/modes/src/schema.js";
import { EXECUTION_SEED_ENTRY } from "../packages/modes/src/session.js";
import type { PlanStore } from "../packages/modes/src/storage.js";

const TOKEN = "seed-wiring-token";

const KNOWLEDGE_DOC = `${KNOWLEDGE_FRAME}

## Project Structure
packages/ holds the seams.

## Key Patterns
Injectable deps everywhere.

## Conventions
Tabs, biome.

## Key Interfaces
ExecutorDeps, ExecutionHandle.
`;

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

/** Stub tmux: records spawns; sessions are never "alive". */
function stubTmux(): TmuxApi & { spawned: string[] } {
	const spawned: string[] = [];
	return {
		spawned,
		async spawn(name: string) {
			spawned.push(name);
		},
		async hasSession() {
			return false;
		},
		async kill() {},
	};
}

type SessionLine = Record<string, unknown>;

function readSessionLines(path: string): SessionLine[] {
	return readFileSync(path, "utf-8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as SessionLine);
}

describe("execution adapter seed wiring", () => {
	let tmpDir: string;
	let planDir: string;
	let engine: PlanEngine;
	let tmux: ReturnType<typeof stubTmux>;
	let adapter: ExecutionAdapter | undefined;
	let prevSessionDir: string | undefined;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "seed-wiring-"));
		planDir = join(tmpDir, "plan");
		prevSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
		process.env.PI_CODING_AGENT_SESSION_DIR = join(tmpDir, "sessions");

		engine = PlanEngine.create(memStore(), {
			slug: "seed-wiring",
			title: "Seed Wiring Plan",
			repoPath: tmpDir,
		});
		// Shipped dependency with a stored deliverable summary → # Prior Work.
		engine.addDeliverable({ title: "Setup DB", workerMode: "full" });
		engine.addWorkItem("setup-db", { title: "Create tables", kind: "task" });
		engine.toggleWorkItem("setup-db", "create-tables");
		engine.updateDeliverable("setup-db", {
			summary: "Database tables created: users, sessions.",
		});
		engine.setDeliverableStatus("setup-db", "active");
		engine.setDeliverableStatus("setup-db", "complete");
		engine.setDeliverableStatus("setup-db", "shipped");
		// Active deliverable whose worker we spawn (pre-provisioned worktree).
		engine.addDeliverable({
			title: "Implement Auth",
			workerMode: "full",
			dependsOn: ["setup-db"],
		});
		engine.addWorkItem("implement-auth", {
			title: "Create login endpoint",
			kind: "task",
		});
		engine.setDeliverableStatus("implement-auth", "active");
		engine.updateDeliverable("implement-auth", { worktreePath: tmpDir });

		tmux = stubTmux();
	});

	afterEach(async () => {
		await adapter?.destroy();
		adapter = undefined;
		if (prevSessionDir === undefined) {
			delete process.env.PI_CODING_AGENT_SESSION_DIR;
		} else {
			process.env.PI_CODING_AGENT_SESSION_DIR = prevSessionDir;
		}
		rmSync(tmpDir, { recursive: true, force: true });
	});

	async function spawnWorker(): Promise<SessionLine[]> {
		adapter = new ExecutionAdapter({
			engine,
			ctx: { cwd: tmpDir } as ExtensionContext,
			extensionPath: "/nonexistent/ext",
			defaultBranch: "main",
			planDir,
			tmux,
			token: TOKEN,
			socketPath: join(tmpDir, "maestro.sock"),
			onPlanChanged: () => {},
		});
		await adapter.start();
		adapter.getExecutor().unblockDeliverable("implement-auth");
		await adapter.tick();

		const sessionName = tmux.spawned[0];
		expect(sessionName).toBeTruthy();
		return readSessionLines(
			join(
				tmpDir,
				"sessions",
				"agents",
				sessionName,
				"implement-auth-worker.jsonl",
			),
		);
	}

	function seedContent(lines: SessionLine[]): string {
		const seedEntry = lines.find(
			(l) => l.customType === EXECUTION_SEED_ENTRY,
		) as { content?: string } | undefined;
		expect(seedEntry).toBeDefined();
		return seedEntry?.content ?? "";
	}

	it("forks the knowledge session and seeds framed sections", async () => {
		const knowledge = buildKnowledgeSession({
			content: KNOWLEDGE_DOC,
			repoPath: tmpDir,
			outPath: join(planDir, "base-knowledge.jsonl"),
		});

		const lines = await spawnWorker();

		// Header: fresh id, agent cwd, lineage back to the knowledge session.
		const header = lines[0];
		expect(header.parentSession).toBe(knowledge.id);
		expect(header.id).not.toBe(knowledge.id);
		expect(header.cwd).toBe(tmpDir);

		// Knowledge entry precedes the seed entry (shared cache prefix first).
		const knowledgeIdx = lines.findIndex(
			(l) => l.customType === KNOWLEDGE_CUSTOM_TYPE,
		);
		const seedIdx = lines.findIndex(
			(l) => l.customType === EXECUTION_SEED_ENTRY,
		);
		expect(knowledgeIdx).toBeGreaterThan(0);
		expect(seedIdx).toBeGreaterThan(knowledgeIdx);

		// Framed seed: Prior Work (dep-deliverable summary) then Your Tasks.
		const seed = seedContent(lines);
		expect(seed).toContain(PRIOR_WORK_HEADER);
		expect(seed).toContain(PRIOR_WORK_FRAME);
		expect(seed).toContain("Database tables created: users, sessions.");
		expect(seed).toContain(TASKS_HEADER);
		expect(seed).toContain(TASKS_FRAME);
		expect(seed).toContain("Create login endpoint");
		expect(seed.indexOf(PRIOR_WORK_HEADER)).toBeLessThan(
			seed.indexOf(TASKS_HEADER),
		);
	});

	it("seeds framed sections without a knowledge fork when no base file exists", async () => {
		const lines = await spawnWorker();

		const header = lines[0];
		expect(header.parentSession).toBeUndefined();
		expect(lines.some((l) => l.customType === KNOWLEDGE_CUSTOM_TYPE)).toBe(
			false,
		);

		const seed = seedContent(lines);
		expect(seed).toContain(PRIOR_WORK_HEADER);
		expect(seed).toContain(TASKS_HEADER);
	});
});
