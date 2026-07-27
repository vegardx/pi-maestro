// The parent→child family edge: soft but loud.
//
// Fanning work out buys a second perspective. Two agents from the same model
// family are one perspective wearing two names — so the edge is recorded and
// a collision is announced. It never blocks: the planner may have meant it,
// and an authored waiver says so.
//
// The contract was written long ago and had ZERO live callers until now.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diversityRecordFor } from "../packages/contracts/src/plan-schema.js";

const adapter = readFileSync(
	join(process.cwd(), "packages/modes/src/plan/node-adapter.ts"),
	"utf8",
);

describe("the edge record", () => {
	it("flags a same-family child", () => {
		const r = diversityRecordFor("Anthropic", "Anthropic", undefined, "T");
		expect(r.sameFamily).toBe(true);
		expect(r.waiver).toBeUndefined();
	});

	it("does not flag genuinely different families", () => {
		expect(
			diversityRecordFor("Anthropic", "OpenAI", undefined, "T").sameFamily,
		).toBe(false);
	});

	it("carries the waiver when the planner knowingly waived", () => {
		const r = diversityRecordFor(
			"Anthropic",
			"Anthropic",
			"one family on purpose",
			"T",
		);
		expect(r.sameFamily).toBe(true);
		expect(r.waiver).toBe("one family on purpose");
	});

	it("never flags on an unknown family — half an edge is not an edge", () => {
		// inherit and session-fallback resolutions carry an empty family. Calling
		// those a collision would flag every plan that never configured a roster.
		expect(diversityRecordFor("", "Anthropic", undefined, "T").sameFamily).toBe(
			false,
		);
		expect(diversityRecordFor("Anthropic", "", undefined, "T").sameFamily).toBe(
			false,
		);
		expect(diversityRecordFor("", "", undefined, "T").sameFamily).toBe(false);
	});
});

describe("the edge is wired to the live spawn path", () => {
	it("records as each node resolves its model", () => {
		expect(adapter).toContain("recordDiversityEdge(node, outcome.resolution)");
		expect(adapter).toContain("this.engine.recordDiversity(node.id, record)");
	});

	it("takes the parent family from the parent's own last resolution", () => {
		expect(adapter).toContain("parent?.resolutions?.at(-1)?.family");
	});

	it("skips the root rather than guessing", () => {
		// With no parent resolution there is nothing to compare against; inventing
		// a comparison would manufacture collisions that are not real.
		expect(adapter).toContain("if (!parentFamily) return;");
	});

	it("announces an unwaived collision", () => {
		expect(adapter).toContain('this.logEvent("diversity-collision"');
		expect(adapter).toContain("record.sameFamily && !record.waiver");
	});

	it("never lets observability fail a spawn", () => {
		// A recording failure must not take a worker down with it.
		const helper = adapter.slice(
			adapter.indexOf("private recordDiversityEdge("),
			adapter.indexOf("private notifyFallbackOnce("),
		);
		expect(helper).toContain("catch");
	});
});
