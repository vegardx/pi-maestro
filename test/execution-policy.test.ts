import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TIER_IDS } from "@vegardx/pi-models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_EXECUTION_POLICY,
	readExecutionPolicySettings,
} from "../packages/maestro/src/execution-policy.js";

let cwd: string;
let agentDir: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "maestro-policy-cwd-"));
	agentDir = mkdtempSync(join(tmpdir(), "maestro-policy-agent-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

function auditorTier(tier: unknown): string {
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			extensionConfig: { maestro: { bash: { auditor: { tier } } } },
		}),
	);
	return readExecutionPolicySettings(cwd, agentDir, { projectTrusted: false })
		.auditor.tier;
}

describe("Bash auditor tier", () => {
	it("defaults to fast", () => {
		expect(DEFAULT_EXECUTION_POLICY.auditor.tier).toBe("fast");
		expect(
			readExecutionPolicySettings(cwd, agentDir, { projectTrusted: false })
				.auditor.tier,
		).toBe("fast");
	});

	it.each(TIER_IDS)("accepts %s", (tier) => {
		expect(auditorTier(tier)).toBe(tier);
	});

	it.each(["standard", "heavy", "", 7])(
		"refuses %j and falls back to fast",
		(tier) => {
			expect(auditorTier(tier)).toBe("fast");
		},
	);
});
