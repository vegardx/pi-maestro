import { describe, expect, it } from "vitest";
import {
	captureCommitCheckpoint,
	renderCommitTarget,
} from "../packages/modes/src/exec/commit-target.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const PREVIOUS = "c".repeat(40);

describe("commit-bound review targets", () => {
	it("freezes a clean committed head and renders explicit ranges", () => {
		const target = captureCommitCheckpoint(
			{ cwd: "/repo", base: BASE, previousHead: PREVIOUS },
			{ clean: () => true, head: () => HEAD },
		);
		expect(target).toEqual({ base: BASE, head: HEAD, previousHead: PREVIOUS });
		expect(renderCommitTarget(target)).toContain(`${BASE}..${HEAD}`);
		expect(renderCommitTarget(target)).toContain(`${PREVIOUS}..${HEAD}`);
	});

	it("rejects dirty workspaces and symbolic revisions", () => {
		expect(() =>
			captureCommitCheckpoint(
				{ cwd: "/repo", base: BASE },
				{ clean: () => false, head: () => HEAD },
			),
		).toThrow("clean working tree");
		expect(() =>
			captureCommitCheckpoint(
				{ cwd: "/repo", base: "main" },
				{ clean: () => true, head: () => HEAD },
			),
		).toThrow("immutable commit SHA");
	});
});
