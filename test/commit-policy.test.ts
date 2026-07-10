// Commit-policy detection + the pre-ship audit. Regression for the live
// incident: a worker in a semantic-release repo pushed "Add RadicalAI
// production and SIT provider configs" (etc.) — semantic-release ran green
// and published nothing; a corrective empty `feat(...)` commit was needed.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	auditCommitSubjects,
	commitPolicyInstruction,
	detectCommitPolicy,
} from "../packages/modes/src/exec/commit-policy.js";

let repo: string;

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "commit-policy-"));
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("detectCommitPolicy", () => {
	it("detects semantic-release via .releaserc as release-managed", () => {
		writeFileSync(join(repo, ".releaserc"), "{}");
		expect(detectCommitPolicy(repo)).toEqual({
			conventional: true,
			source: ".releaserc",
			releaseManaged: true,
		});
	});

	it("detects semantic-release via package.json dependency", () => {
		writeFileSync(
			join(repo, "package.json"),
			JSON.stringify({ devDependencies: { "semantic-release": "^24" } }),
		);
		const policy = detectCommitPolicy(repo);
		expect(policy.conventional).toBe(true);
		expect(policy.releaseManaged).toBe(true);
	});

	it("detects an AGENTS.md conventional-commits mandate (not release-managed)", () => {
		writeFileSync(
			join(repo, "AGENTS.md"),
			"# Rules\nUse Conventional Commits for every commit.",
		);
		expect(detectCommitPolicy(repo)).toEqual({
			conventional: true,
			source: "AGENTS.md",
			releaseManaged: false,
		});
	});

	it("no config → no policy", () => {
		expect(detectCommitPolicy(repo).conventional).toBe(false);
	});
});

describe("auditCommitSubjects", () => {
	const semrel = {
		conventional: true,
		source: ".releaserc",
		releaseManaged: true,
	} as const;

	it("rejects the exact subjects from the incident, and explains the release impact", () => {
		const audit = auditCommitSubjects(
			[
				"Add RadicalAI production and SIT provider configs",
				"Expand dual RadicalAI provider tests",
				"Document dual RadicalAI environments",
				"Tighten RadicalAI gateway URL validation",
			],
			semrel,
		);
		expect(audit.ok).toBe(false);
		expect(audit.violations).toHaveLength(4);
		expect(audit.explanation).toContain("release nothing");
		expect(audit.explanation).toContain("feat(scope)");
	});

	it("accepts conventional subjects and reports release-triggering", () => {
		const audit = auditCommitSubjects(
			[
				"feat(radicalai): support production and SIT providers",
				"test(radicalai): expand dual provider tests",
				"docs(radicalai): document dual environments",
			],
			semrel,
		);
		expect(audit.ok).toBe(true);
		expect(audit.releaseTriggering).toBe(true);
		expect(audit.explanation).toContain("will publish");
	});

	it("blocks conventional-but-releaseless branches with runtime changes", () => {
		const audit = auditCommitSubjects(
			["chore(radicalai): add provider configs", "test(radicalai): cover it"],
			semrel,
			{ hasRuntimeChanges: true },
		);
		expect(audit.ok).toBe(false);
		expect(audit.releaseTriggering).toBe(false);
		expect(audit.explanation).toContain("publish nothing");
	});

	it("allows docs/test-only branches without a feat/fix commit", () => {
		const audit = auditCommitSubjects(["docs(readme): clarify setup"], semrel, {
			hasRuntimeChanges: false,
		});
		expect(audit.ok).toBe(true);
	});

	it("exempts git-generated subjects (merges, reverts)", () => {
		const audit = auditCommitSubjects(
			["Merge branch dev into feat/x", 'Revert "bad idea"'],
			semrel,
		);
		expect(audit.ok).toBe(true);
	});

	it("passes everything when the repo has no policy", () => {
		const audit = auditCommitSubjects(["Add stuff"], {
			conventional: false,
			releaseManaged: false,
		});
		expect(audit.ok).toBe(true);
	});
});

describe("commitPolicyInstruction", () => {
	it("teaches the release-trigger requirement for release-managed repos", () => {
		const note = commitPolicyInstruction({
			conventional: true,
			source: ".releaserc",
			releaseManaged: true,
		});
		expect(note).toContain("Conventional Commits");
		expect(note).toContain("feat(...)");
		expect(note).toContain("publish nothing");
	});

	it("is absent without a policy", () => {
		expect(
			commitPolicyInstruction({ conventional: false, releaseManaged: false }),
		).toBeNull();
	});
});
