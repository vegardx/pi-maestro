// Capability-policy Phase C: `rm`/`rmdir` redirect to the delete tool (step 2),
// and the startup deviation warning (step 8).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideBashPolicy } from "../packages/maestro/src/bash-policy.js";
import {
	describePolicyDeviations,
	type ExecutionPolicySettings,
} from "../packages/maestro/src/execution-policy.js";

const guided: ExecutionPolicySettings = {
	preset: "guided",
	toolGuidance: "mode-aware",
	modeRoutes: "protected-research",
	delivery: "dedicated-tools",
	consequential: "confirm",
	privilegedRemote: "hack-only",
	githubReads: "allow-apparent-reads",
	unknowns: "allow",
	fallback: "fail-closed",
};

describe("rm redirects to the delete tool, which exists", () => {
	// This block once asserted `suggestedTool === "delete"` while no such tool
	// was declared anywhere — pinning a phantom as correct. `delete` had gone
	// with `packages/modes` and the redirect outlived it, so a worker running
	// `rm -rf dist` was denied and pointed at nothing.
	//
	// The redirect is right; the missing half was the tool. It is recovered in
	// `delete-tool.ts`, and `refusals-name-real-tools.test.ts` now asserts the
	// whole `SUGGESTABLE_TOOLS` set against what agents really hold — the set,
	// not the prose, because this refusal names its tool by interpolation and no
	// source scan can see it.
	it("denies a bare rm and points at the delete tool", () => {
		const decision = decideBashPolicy({
			command: "rm notes.txt",
			mode: "auto",
			actor: "worker",
			policy: guided,
		});
		expect(decision.suggestedTool).toBe("delete");
		expect(decision.route).toBe("deny");
		expect(decision.reason).toContain("delete");
	});

	it("catches rm -rf too (flags don't dodge the redirect)", () => {
		const decision = decideBashPolicy({
			command: "rm -rf dist",
			mode: "auto",
			actor: "worker",
			policy: guided,
		});
		expect(decision.suggestedTool).toBe("delete");
		expect(decision.route).toBe("deny");
	});

	it("leaves shred alone (a recoverable trash would defeat secure-erase)", () => {
		const decision = decideBashPolicy({
			command: "shred secret.key",
			mode: "auto",
			actor: "worker",
			policy: guided,
		});
		expect(decision.suggestedTool).toBeUndefined();
	});
});

describe("describePolicyDeviations", () => {
	let cwd: string;
	let prevSandbox: string | undefined;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "dev-"));
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		prevSandbox = process.env.MAESTRO_SANDBOX;
		delete process.env.MAESTRO_SANDBOX;
	});
	afterEach(() => {
		if (prevSandbox === undefined) delete process.env.MAESTRO_SANDBOX;
		else process.env.MAESTRO_SANDBOX = prevSandbox;
		rmSync(cwd, { recursive: true, force: true });
	});

	it("reports nothing when the default (guided) is in force", () => {
		expect(describePolicyDeviations(cwd)).toEqual([]);
	});

	it("names a loosened preset key by key", () => {
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({
				extensionConfig: { modes: { execution: { preset: "permissive" } } },
			}),
		);
		const deviations = describePolicyDeviations(cwd);
		expect(deviations.some((d) => d.startsWith("consequential: allow"))).toBe(
			true,
		);
	});

	it("flags disabled bash enforcement (MAESTRO_SANDBOX=off)", () => {
		process.env.MAESTRO_SANDBOX = "off";
		expect(describePolicyDeviations(cwd)[0]).toContain("sandbox: OFF");
	});
});
