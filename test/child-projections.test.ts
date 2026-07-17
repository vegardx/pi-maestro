import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildRunProjection, RunId } from "@vegardx/pi-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ChildProjectionStore } from "../packages/modes/src/exec/child-projections.js";

const runId = (value: string) => value as RunId;

function projection(
	revision: number,
	status: ChildRunProjection["status"] = "running",
): ChildRunProjection {
	return {
		runId: runId("child-1"),
		revision,
		kind: "security-review",
		model: "provider/reviewer",
		effort: "high",
		status,
		createdAt: 10,
		updatedAt: 10 + revision,
		profile: { profile: "research" },
		usage: {
			input: revision * 10,
			output: revision,
			cacheRead: 0,
			cacheWrite: 0,
			promptTokens: revision * 10,
			totalTokens: revision * 11,
			cost: revision / 100,
			turns: revision,
		},
	};
}

describe("ChildProjectionStore", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	function store() {
		const dir = mkdtempSync(join(tmpdir(), "child-projections-"));
		dirs.push(dir);
		const path = join(dir, "projections.json");
		return { path, store: new ChildProjectionStore(path) };
	}

	it("persists before acknowledging and ignores stale revisions/generations", () => {
		const created = store();
		expect(
			created.store.apply({
				ownerId: "delivery/worker",
				expectedGeneration: 2,
				ownerGeneration: 2,
				reconcile: true,
				runs: [projection(2)],
			}),
		).toEqual([{ runId: "child-1", revision: 2 }]);
		expect(JSON.parse(readFileSync(created.path, "utf8")).records).toHaveLength(
			1,
		);

		created.store.apply({
			ownerId: "delivery/worker",
			expectedGeneration: 2,
			ownerGeneration: 2,
			reconcile: false,
			runs: [projection(1)],
		});
		expect(created.store.get("child-1")?.projection.revision).toBe(2);
		expect(
			created.store.apply({
				ownerId: "delivery/worker",
				expectedGeneration: 3,
				ownerGeneration: 2,
				reconcile: false,
				runs: [projection(3)],
			}),
		).toEqual([]);
	});

	it("restores live records unconfirmed until an owner reconciliation", () => {
		const created = store();
		created.store.apply({
			ownerId: "delivery/worker",
			expectedGeneration: 1,
			ownerGeneration: 1,
			reconcile: false,
			runs: [projection(1)],
		});
		const restored = new ChildProjectionStore(created.path);
		expect(restored.get("child-1")?.confirmed).toBe(false);
		restored.apply({
			ownerId: "delivery/worker",
			expectedGeneration: 1,
			ownerGeneration: 1,
			reconcile: true,
			runs: [projection(1)],
		});
		expect(restored.get("child-1")?.confirmed).toBe(true);
	});

	it("markLiveUnconfirmed(ownerId) unconfirms only that owner's live records", () => {
		const { store: s } = store();
		const projFor = (id: string): ChildRunProjection => ({
			...projection(1),
			runId: runId(id),
		});
		s.apply({
			ownerId: "ga/worker",
			expectedGeneration: 1,
			ownerGeneration: 1,
			reconcile: false,
			runs: [projFor("child-a")],
		});
		s.apply({
			ownerId: "gb/worker",
			expectedGeneration: 1,
			ownerGeneration: 1,
			reconcile: false,
			runs: [projFor("child-b")],
		});
		expect(s.get("child-a")?.confirmed).toBe(true);
		expect(s.get("child-b")?.confirmed).toBe(true);

		// One owner disconnects: only its records degrade to unconfirmed.
		s.markLiveUnconfirmed("ga/worker");

		expect(s.get("child-a")?.confirmed).toBe(false);
		expect(s.get("child-b")?.confirmed).toBe(true);
	});
});
