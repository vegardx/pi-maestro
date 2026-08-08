import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	WorkflowPhaseCheckpointer,
	type WorkflowPhaseCheckpointInput,
} from "../../../packages/maestro/src/workflow/phase-checkpoint.js";

const fixtures: string[] = [];

afterEach(() => {
	for (const fixture of fixtures.splice(0))
		rmSync(fixture, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(root: string, key: string) {
	const path = join(root, "repos", key);
	mkdirSync(path, { recursive: true });
	git(path, "init", "-b", "workflow/change");
	git(path, "config", "user.name", `${key} Developer`);
	git(path, "config", "user.email", `${key}@example.test`);
	git(path, "config", "commit.gpgSign", "false");
	writeFileSync(join(path, "base.txt"), "base\n");
	git(path, "add", "base.txt");
	git(path, "commit", "-m", "Initial state");
	return {
		key,
		path,
		head: () => git(path, "rev-parse", "HEAD"),
	};
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "maestro-phase-checkpoint-"));
	fixtures.push(root);
	const api = repository(root, "api");
	const contracts = repository(root, "contracts");
	const state = join(root, "maestro-state");
	const workflowState = join(root, "runtime", ".pi");
	mkdirSync(state, { recursive: true });
	mkdirSync(workflowState, { recursive: true });
	const checkpoint = () =>
		new WorkflowPhaseCheckpointer({
			maestroStateRoot: state,
			descendantWritableRoots: [api.path, contracts.path, workflowState],
			depth: () => 0,
		});
	const repositories = [
		{ key: "api", worktree: api.path, expectedBranch: "workflow/change" },
		{
			key: "contracts",
			worktree: contracts.path,
			expectedBranch: "workflow/change",
		},
	] as const;
	return {
		root,
		state,
		workflowState,
		api,
		contracts,
		checkpoint,
		repositories,
	};
}

function implementationInput(
	value: ReturnType<typeof fixture>,
): WorkflowPhaseCheckpointInput {
	return {
		runId: "run-1",
		phase: "implementation",
		repositories: value.repositories,
		messages: {
			api: "Implement the API behavior",
			contracts: "Define the shared contract",
		},
	};
}

describe("seat-only workflow phase checkpoint", () => {
	it("creates ordinary per-repository commits and treats a clean repository as a no-op", () => {
		const value = fixture();
		const apiPreHead = value.api.head();
		const contractsPreHead = value.contracts.head();
		writeFileSync(join(value.api.path, "api.ts"), "export const value = 1;\n");

		const result = value.checkpoint().checkpoint(implementationInput(value));
		const api = result.repositories.find(
			({ repository }) => repository === "api",
		)!;
		const contracts = result.repositories.find(
			({ repository }) => repository === "contracts",
		)!;
		expect(api).toMatchObject({ preHead: apiPreHead, commit: api.finalHead });
		expect(api.changedPaths).toEqual(["api.ts"]);
		expect(api.finalHead).not.toBe(apiPreHead);
		expect(contracts).toMatchObject({
			preHead: contractsPreHead,
			finalHead: contractsPreHead,
			commit: null,
		});
		expect(git(value.api.path, "log", "-1", "--format=%s")).toBe(
			"Implement the API behavior",
		);
		expect(git(value.api.path, "log", "-1", "--format=%an <%ae>")).toBe(
			"api Developer <api@example.test>",
		);
		expect(git(value.api.path, "status", "--porcelain")).toBe("");
		expect(result.commitRefs).toEqual([
			{ repository: "api", commit: api.finalHead },
		]);
	});

	it("requires a decision phase dirty set to exactly match approved paths", () => {
		const value = fixture();
		const apiPreHead = value.api.head();
		writeFileSync(join(value.api.path, "expected.ts"), "expected\n");
		writeFileSync(join(value.api.path, "surprise.ts"), "surprise\n");
		const input: WorkflowPhaseCheckpointInput = {
			runId: "run-decision",
			phase: "decision",
			repositories: value.repositories,
			messages: {
				api: "Apply accepted fixes",
				contracts: "Apply contract fixes",
			},
			expectedChangedPaths: { api: ["expected.ts"], contracts: [] },
		};

		expect(() => value.checkpoint().checkpoint(input)).toThrow(
			/api decision dirty paths do not exactly match/,
		);
		expect(value.api.head()).toBe(apiPreHead);
		expect(
			existsSync(
				join(value.state, "phase-checkpoints", "run-decision", "decision.json"),
			),
		).toBe(false);
	});

	it("returns decision commit references and exact changed paths for ledger enrichment", () => {
		const value = fixture();
		writeFileSync(join(value.api.path, "fix.ts"), "accepted fix\n");
		const result = value.checkpoint().checkpoint({
			runId: "run-decision-ok",
			phase: "decision",
			repositories: value.repositories,
			messages: {
				api: "Apply accepted API fixes",
				contracts: "Apply contract fixes",
			},
			expectedChangedPaths: { api: ["fix.ts"], contracts: [] },
		});
		const api = result.repositories.find(
			({ repository }) => repository === "api",
		)!;
		expect(api.changedPaths).toEqual(["fix.ts"]);
		expect(result.commitRefs).toEqual([
			{ repository: "api", commit: api.finalHead },
		]);
	});

	it("rejects a pre-staged index before journaling or committing", () => {
		const value = fixture();
		writeFileSync(join(value.api.path, "staged.ts"), "staged\n");
		git(value.api.path, "add", "staged.ts");

		expect(() =>
			value.checkpoint().checkpoint(implementationInput(value)),
		).toThrow(/api index must be clean/);
		expect(
			existsSync(
				join(value.state, "phase-checkpoints", "run-1", "implementation.json"),
			),
		).toBe(false);
	});

	it("rejects a checkout on any branch other than the registered branch", () => {
		const value = fixture();
		git(value.api.path, "checkout", "-b", "unexpected");
		writeFileSync(join(value.api.path, "api.ts"), "api\n");

		expect(() =>
			value.checkpoint().checkpoint(implementationInput(value)),
		).toThrow(/api expected branch workflow\/change is not checked out/);
	});

	it("resumes a partial multi-repository checkpoint without recommitting completed work", () => {
		const value = fixture();
		writeFileSync(join(value.api.path, "api.ts"), "api\n");
		writeFileSync(join(value.contracts.path, "contract.ts"), "contract\n");
		git(value.contracts.path, "config", "commit.gpgSign", "true");
		git(value.contracts.path, "config", "gpg.program", "/usr/bin/false");

		expect(() =>
			value.checkpoint().checkpoint(implementationInput(value)),
		).toThrow(/contracts checkpoint commit failed/);
		const apiCommittedHead = value.api.head();
		expect(git(value.api.path, "log", "-1", "--format=%s")).toBe(
			"Implement the API behavior",
		);
		expect(git(value.contracts.path, "diff", "--cached", "--name-only")).toBe(
			"contract.ts",
		);

		git(value.contracts.path, "config", "commit.gpgSign", "false");
		const resumed = value.checkpoint().checkpoint(implementationInput(value));
		expect(value.api.head()).toBe(apiCommittedHead);
		expect(
			resumed.repositories.find(({ repository }) => repository === "api")
				?.commit,
		).toBe(apiCommittedHead);
		expect(
			resumed.repositories.find(({ repository }) => repository === "contracts")
				?.commit,
		).toBe(value.contracts.head());
		expect(git(value.contracts.path, "status", "--porcelain")).toBe("");
	});

	it("honors repository signing and path-scoped identity configuration", () => {
		const value = fixture();
		const privateKey = join(value.root, "signing-key");
		execFileSync("ssh-keygen", [
			"-q",
			"-t",
			"ed25519",
			"-N",
			"",
			"-f",
			privateKey,
		]);
		const publicKey = readFileSync(`${privateKey}.pub`, "utf8").trim();
		const allowedSigners = join(value.root, "allowed-signers");
		writeFileSync(allowedSigners, `api@example.test ${publicKey}\n`);
		git(value.api.path, "config", "gpg.format", "ssh");
		git(value.api.path, "config", "user.signingkey", privateKey);
		git(value.api.path, "config", "commit.gpgSign", "true");
		git(value.api.path, "config", "gpg.ssh.allowedSignersFile", allowedSigners);
		writeFileSync(join(value.api.path, "signed.ts"), "signed\n");

		value.checkpoint().checkpoint(implementationInput(value));

		git(value.api.path, "verify-commit", "HEAD");
		expect(git(value.api.path, "log", "-1", "--format=%G?")).toBe("G");
		expect(git(value.api.path, "log", "-1", "--format=%an <%ae>")).toBe(
			"api Developer <api@example.test>",
		);
	});

	it("fails closed on conflicting replay input and journal tampering", () => {
		const value = fixture();
		writeFileSync(join(value.api.path, "api.ts"), "api\n");
		value.checkpoint().checkpoint(implementationInput(value));
		const changed = implementationInput(value);
		expect(() =>
			value.checkpoint().checkpoint({
				...changed,
				messages: { ...changed.messages, api: "A different API change" },
			}),
		).toThrow(/already started with different input/);

		const journal = join(
			value.state,
			"phase-checkpoints",
			"run-1",
			"implementation.json",
		);
		writeFileSync(
			journal,
			readFileSync(journal, "utf8").replace("api.ts", "evil.ts"),
		);
		expect(() =>
			value.checkpoint().checkpoint(implementationInput(value)),
		).toThrow(/journal integrity check failed/);
	});

	it("verifies completed Git lineage instead of accepting a moved branch", () => {
		const value = fixture();
		writeFileSync(join(value.api.path, "api.ts"), "api\n");
		value.checkpoint().checkpoint(implementationInput(value));
		git(value.api.path, "commit", "--allow-empty", "-m", "Unrelated movement");

		expect(() =>
			value.checkpoint().checkpoint(implementationInput(value)),
		).toThrow(/api checkpoint branch moved after completion/);
	});

	it("rejects non-seat authority and private-state overlap", () => {
		const value = fixture();
		expect(
			() =>
				new WorkflowPhaseCheckpointer({
					maestroStateRoot: value.state,
					descendantWritableRoots: [value.api.path],
					depth: () => 1,
				}),
		).toThrow(/belongs to depth 0/);
		expect(
			() =>
				new WorkflowPhaseCheckpointer({
					maestroStateRoot: value.workflowState,
					descendantWritableRoots: [value.workflowState],
					depth: () => 0,
				}),
		).toThrow(/must be disjoint/);
	});
});
