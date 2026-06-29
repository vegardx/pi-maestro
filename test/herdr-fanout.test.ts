import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

// Mock @vegardx/pi-herdr before importing the module under test.
vi.mock("@vegardx/pi-herdr", () => ({
	worktreeCreate: vi.fn(),
	worktreeRemove: vi.fn(),
	paneRun: vi.fn(),
	paneClose: vi.fn(),
	agentSend: vi.fn(),
	agentRename: vi.fn(),
	HerdrEventClient: vi.fn().mockImplementation(() => ({
		on: vi.fn(),
		subscribe: vi.fn(),
		close: vi.fn(),
	})),
}));

import {
	agentRename,
	agentSend,
	paneClose,
	paneRun,
	worktreeCreate,
	worktreeRemove,
} from "@vegardx/pi-herdr";
import { PlanEngine } from "@vegardx/pi-modes";
import { HerdrFanout } from "../packages/modes/src/execution-herdr.js";
import { createPlanStore } from "../packages/modes/src/storage.js";

let counter = 0;
function now(): string {
	counter++;
	return `2025-01-01T00:00:${String(counter).padStart(2, "0")}.000Z`;
}

describe("HerdrFanout", () => {
	let root: string;
	let engine: PlanEngine;

	beforeEach(() => {
		counter = 0;
		root = mkdtempSync(join(tmpdir(), "herdr-fanout-"));
		const store = createPlanStore(root);
		engine = PlanEngine.create(
			store,
			{ slug: "test-plan", title: "Test Plan", repoPath: root },
			now,
		);

		// worktreeCreate returns a mock result pointing into tmpdir.
		const mockedCreate = vi.mocked(worktreeCreate);
		mockedCreate.mockImplementation(async (opts) => {
			const wtPath = join(root, "worktrees", opts.branch ?? "default");
			return {
				workspace: { workspace_id: `ws_${opts.branch}` },
				tab: { tab_id: "tab_1" },
				root_pane: { pane_id: `pane_${opts.branch}` },
				worktree: { path: wtPath, branch: opts.branch },
			};
		});

		vi.mocked(worktreeRemove).mockResolvedValue(undefined);
		vi.mocked(paneRun).mockResolvedValue(undefined);
		vi.mocked(paneClose).mockResolvedValue(undefined);
		vi.mocked(agentSend).mockResolvedValue(undefined);
		vi.mocked(agentRename).mockResolvedValue(undefined);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	it("spawns agents for ready deliverables", async () => {
		engine.addDeliverable({ title: "First", dependsOn: [] });
		engine.addDeliverable({ title: "Second", dependsOn: [] });

		const fanout = new HerdrFanout({ engine });
		const spawned = await fanout.tick();

		expect(spawned).toBe(2);
		expect(worktreeCreate).toHaveBeenCalledTimes(2);
		expect(paneRun).toHaveBeenCalledTimes(2);

		const snap = fanout.snapshot();
		expect(snap.agents.size).toBe(2);
		expect(snap.spawnedDeliverables.size).toBe(2);

		await fanout.destroy();
	});

	it("does not re-spawn already-spawned deliverables", async () => {
		engine.addDeliverable({ title: "Solo", dependsOn: [] });

		const fanout = new HerdrFanout({ engine });
		await fanout.tick();
		const spawned2 = await fanout.tick();

		expect(spawned2).toBe(0);
		expect(worktreeCreate).toHaveBeenCalledTimes(1);

		await fanout.destroy();
	});

	it("respects dependency ordering", async () => {
		const a = engine.addDeliverable({ title: "First", dependsOn: [] });
		engine.addDeliverable({ title: "Second", dependsOn: [a.id] });

		const fanout = new HerdrFanout({ engine });
		const spawned = await fanout.tick();

		// Only 'First' should be ready (Second depends on it).
		expect(spawned).toBe(1);
		const snap = fanout.snapshot();
		expect(snap.agents.has(a.id)).toBe(true);

		await fanout.destroy();
	});

	it("creates session file with execution seed", async () => {
		engine.addDeliverable({ title: "Task A", dependsOn: [] });

		const fanout = new HerdrFanout({ engine });
		await fanout.tick();

		const snap = fanout.snapshot();
		const agent = [...snap.agents.values()][0]!;
		expect(agent.sessionFile).toBeDefined();
		expect(existsSync(agent.sessionFile)).toBe(true);

		const content = readFileSync(agent.sessionFile, "utf8");
		const lines = content.trim().split("\n");
		// First line is session header, second is seed.
		expect(lines.length).toBe(2);
		const header = JSON.parse(lines[0]!);
		expect(header.type).toBe("session");
		expect(header.version).toBe(3);
		const seed = JSON.parse(lines[1]!);
		expect(seed.type).toBe("custom_message");
		expect(seed.customType).toBe("maestro-execution-seed");
		expect(seed.content).toContain("Task A");

		await fanout.destroy();
	});

	it("assigns unique agent names", async () => {
		engine.addDeliverable({ title: "Alpha", dependsOn: [] });
		engine.addDeliverable({ title: "Beta", dependsOn: [] });

		const fanout = new HerdrFanout({ engine });
		await fanout.tick();

		const snap = fanout.snapshot();
		const names = [...snap.agents.values()].map((a) => a.agentName);
		expect(names[0]).not.toBe(names[1]);
		// Names should be adjective-noun format.
		for (const name of names) {
			expect(name).toMatch(/^[a-z]+-[a-z]+$/);
		}

		await fanout.destroy();
	});

	it("steer sends message to agent", async () => {
		const d = engine.addDeliverable({ title: "Steerable", dependsOn: [] });

		const fanout = new HerdrFanout({ engine });
		await fanout.tick();

		const result = await fanout.steer(d.id, "focus on tests");
		expect(result).toBe(true);
		expect(agentSend).toHaveBeenCalledWith(
			expect.any(String),
			"focus on tests",
		);

		await fanout.destroy();
	});

	it("steer returns false for unknown deliverable", async () => {
		const fanout = new HerdrFanout({ engine });
		const result = await fanout.steer("nonexistent", "hi");
		expect(result).toBe(false);

		await fanout.destroy();
	});

	it("cleanup removes workspace", async () => {
		const d = engine.addDeliverable({ title: "Cleanable", dependsOn: [] });

		const fanout = new HerdrFanout({ engine });
		await fanout.tick();

		await fanout.cleanup(d.id);
		expect(worktreeRemove).toHaveBeenCalledWith({
			workspaceId: expect.stringContaining("ws_"),
			force: true,
		});
		expect(fanout.agentForDeliverable(d.id)).toBeUndefined();

		await fanout.destroy();
	});

	it("sets deliverable status to active on spawn", async () => {
		const d = engine.addDeliverable({ title: "Status Check", dependsOn: [] });
		expect(d.status).toBe("planned");

		const fanout = new HerdrFanout({ engine });
		await fanout.tick();

		const plan = engine.get();
		const updated = plan.nodes.find((n) => n.id === d.id);
		expect(updated && "status" in updated ? updated.status : undefined).toBe(
			"active",
		);

		await fanout.destroy();
	});

	it("calls onPlanChanged after spawning", async () => {
		engine.addDeliverable({ title: "Notifier", dependsOn: [] });
		const onPlanChanged = vi.fn();

		const fanout = new HerdrFanout({ engine, onPlanChanged });
		await fanout.tick();

		expect(onPlanChanged).toHaveBeenCalledTimes(1);

		await fanout.destroy();
	});

	it("agentByName finds agent", async () => {
		engine.addDeliverable({ title: "Named", dependsOn: [] });

		const fanout = new HerdrFanout({ engine });
		await fanout.tick();

		const snap = fanout.snapshot();
		const agent = [...snap.agents.values()][0]!;
		expect(fanout.agentByName(agent.agentName)).toBe(agent);
		expect(fanout.agentByName("nonexistent")).toBeUndefined();

		await fanout.destroy();
	});
});
