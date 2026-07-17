import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunId } from "@vegardx/pi-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createChildRunProjectionSource,
	createRunBus,
	createRunStore,
	persistRunBus,
	SubagentService,
} from "../packages/subagents/src/index.js";

const id = (value: string) => value as RunId;

describe("worker child projection source", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	it("notifies only from durable records and rebuilds cumulative usage", () => {
		const root = mkdtempSync(join(tmpdir(), "child-source-"));
		dirs.push(root);
		const bus = createRunBus();
		const store = createRunStore(root);
		persistRunBus(bus, store);
		const service = new SubagentService({
			bus,
			store,
			repoRoot: root,
			runner: {
				launch: () => ({
					steer: vi.fn(),
					stop: vi.fn(),
					result: async () => ({ status: "succeeded" }),
				}),
			},
			mintId: () => id("child-1"),
		});
		const source = createChildRunProjectionSource({ bus, store, service });
		const seen: number[] = [];
		source.subscribe((item) => {
			expect(store.readRecord(item.runId)).toBeDefined();
			seen.push(item.revision);
		});
		service.spawn("review", {
			profile: "research",
			model: "provider/reviewer",
			thinking: "high",
			meta: { kind: "security-review" },
		});
		bus.publish({
			type: "progress",
			runId: id("child-1"),
			delta: {
				tokensIn: 10,
				tokensOut: 2,
				cacheRead: 5,
				cost: 0.25,
			},
		});

		const projected = source.list()[0];
		expect(projected).toMatchObject({
			revision: 3,
			kind: "security-review",
			model: "provider/reviewer",
			effort: "high",
			usage: {
				input: 10,
				output: 2,
				cacheRead: 5,
				totalTokens: 17,
				cost: 0.25,
				turns: 1,
			},
		});
		expect(seen).toEqual([1, 2, 3]);
	});
});
