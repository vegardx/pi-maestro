import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalTokenSnapshot } from "@vegardx/pi-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { UsageCheckpointStore } from "../packages/modes/src/usage-checkpoints.js";
import { UsageLedger } from "../packages/modes/src/usage-ledger.js";

const dirs: string[] = [];
const checkpoint = (revision: number, input: number) => ({
	source: { kind: "agent" as const, id: "d/worker", generation: 2 },
	revision,
	snapshot: canonicalTokenSnapshot({ input, cacheRead: input }),
	updatedAt: revision,
});

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("usage checkpoint store", () => {
	it("atomically persists only increasing revisions", () => {
		const dir = mkdtempSync(join(tmpdir(), "usage-checkpoints-"));
		dirs.push(dir);
		const path = join(dir, "execution", "usage.json");
		const store = new UsageCheckpointStore(path);
		expect(store.accept(checkpoint(2, 20))).toBe(true);
		expect(store.accept(checkpoint(2, 99))).toBe(false);
		expect(store.accept(checkpoint(1, 99))).toBe(false);
		expect(JSON.parse(readFileSync(path, "utf8")).checkpoints).toHaveLength(1);
	});

	it("restores exact canonical totals before new updates", () => {
		const dir = mkdtempSync(join(tmpdir(), "usage-checkpoints-"));
		dirs.push(dir);
		const path = join(dir, "usage.json");
		new UsageCheckpointStore(path).accept(checkpoint(3, 40));

		const restoredStore = new UsageCheckpointStore(path);
		const ledger = new UsageLedger();
		expect(ledger.restore(restoredStore.load())).toBe(1);
		expect(ledger.snapshot().totals).toMatchObject({
			input: 40,
			cacheRead: 40,
			promptTokens: 80,
			totalTokens: 80,
		});
	});
});
