import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideBashPolicy } from "../packages/maestro/src/bash-policy.js";
import {
	DEFAULT_EXECUTION_POLICY,
	describePolicyDeviations,
} from "../packages/maestro/src/execution-policy.js";

describe("recoverable deletion guidance", () => {
	it("redirects rm and rm -rf only when delete is available", () => {
		for (const command of ["rm notes.txt", "rm -rf dist"])
			expect(
				decideBashPolicy({
					command,
					mode: "auto",
					policy: DEFAULT_EXECUTION_POLICY,
					availableTools: new Set(["delete"]),
				}),
			).toMatchObject({ action: "refuse", suggestedTool: "delete" });
	});

	it("does not name an unavailable tool", () => {
		expect(
			decideBashPolicy({
				command: "rm notes.txt",
				mode: "auto",
				policy: DEFAULT_EXECUTION_POLICY,
				availableTools: new Set(),
			}).suggestedTool,
		).toBeUndefined();
	});

	it("does not redirect secure erase to recoverable trash", () => {
		expect(
			decideBashPolicy({
				command: "shred secret.key",
				mode: "auto",
				policy: DEFAULT_EXECUTION_POLICY,
				availableTools: new Set(["delete"]),
			}).suggestedTool,
		).toBeUndefined();
	});
});

describe("explicit policy deviations", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "maestro-policy-"));
		mkdirSync(join(cwd, ".pi"), { recursive: true });
	});
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	it("reports nothing for defaults", () => {
		expect(describePolicyDeviations(cwd)).toEqual([]);
	});

	it("reports an overridden mode/effect action", () => {
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({
				extensionConfig: {
					maestro: {
						bash: { policy: { plan: { "workspace-write": "allow" } } },
					},
				},
			}),
		);
		expect(describePolicyDeviations(cwd)).toContain(
			"plan.workspace-write: allow (default refuse)",
		);
	});
});
