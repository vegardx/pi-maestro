// Legacy (pre-cutover) run records must never crash pi: list() skips them
// (the HUD renders through list), legacy() reports them for the cleanup
// offer, and archiveLegacy() moves them aside into _legacy/ where every
// sweep ignores them. Regression: UnsupportedRunStateError thrown from the
// TUI render loop took down the whole session (2026-07-19).

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunStore } from "../packages/subagents/src/store.js";

let root: string;

function writeRawRecord(id: string, record: Record<string, unknown>): void {
	mkdirSync(join(root, id), { recursive: true });
	writeFileSync(join(root, id, "status.json"), JSON.stringify(record));
}

const V2: Record<string, unknown> = {
	schemaVersion: 2,
	id: "run-new",
	profile: { profile: "research", cwd: "/tmp" },
	status: "succeeded",
	createdAt: 1,
	updatedAt: 2,
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "legacy-runs-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("legacy run state", () => {
	it("list() skips legacy records instead of throwing", () => {
		writeRawRecord("run-old", {
			id: "run-old",
			profile: { cwd: "/somewhere/worktrees/old" },
			status: "completed",
		});
		writeRawRecord("run-new", V2);
		const store = createRunStore(root);
		const listed = store.list();
		expect(listed.map((record) => record.id)).toEqual(["run-new"]);
	});

	it("legacy() reports id, schema, and the old cwd", () => {
		writeRawRecord("run-old", {
			id: "run-old",
			schemaVersion: 1,
			profile: { cwd: "/somewhere/worktrees/old" },
		});
		const store = createRunStore(root);
		const legacy = store.legacy();
		expect(legacy).toHaveLength(1);
		expect(legacy[0]).toMatchObject({
			id: "run-old",
			schemaVersion: 1,
			cwd: "/somewhere/worktrees/old",
		});
	});

	it("archiveLegacy() moves records into _legacy/ and out of every sweep", () => {
		writeRawRecord("run-old", { id: "run-old", status: "completed" });
		writeRawRecord("run-new", V2);
		const store = createRunStore(root);
		expect(store.archiveLegacy()).toBe(1);
		expect(existsSync(join(root, "_legacy", "run-old", "status.json"))).toBe(
			true,
		);
		expect(existsSync(join(root, "run-old"))).toBe(false);
		// The archive dir itself is invisible to both sweeps.
		expect(store.legacy()).toEqual([]);
		expect(store.list().map((record) => record.id)).toEqual(["run-new"]);
	});

	it("direct read of a specific legacy run still fails loudly", () => {
		writeRawRecord("run-old", { id: "run-old", status: "completed" });
		const store = createRunStore(root);
		expect(() => store.readRecord("run-old" as never)).toThrow(
			/Unsupported Maestro run state/,
		);
	});
});
