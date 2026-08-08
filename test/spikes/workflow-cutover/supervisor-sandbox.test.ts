import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { afterAll, describe, expect, it } from "vitest";
import {
	workflowSupervisorWriteProfile,
	wrapWorkflowSupervisorCommand,
} from "../../../packages/maestro/src/workflow/supervisor-sandbox.js";

const platform =
	process.platform === "darwin"
		? "macos"
		: process.platform === "linux"
			? "linux"
			: "windows";
const platformClaimsSupport = SandboxManager.isSupportedPlatform(platform);
const roots: string[] = [];

function makeRoots(label: string) {
	// Do not use the system temp directory: sandbox-runtime deliberately permits
	// temp writes on some platforms. A sibling below HOME is a meaningful escape.
	const root = join(
		homedir(),
		`.maestro-supervisor-sandbox-${label}-${process.pid}-${Date.now()}`,
	);
	roots.push(root);
	const worktreeA = join(root, "repos", "contracts");
	const worktreeB = join(root, "repos", "api");
	const workflowState = join(root, "runtime", ".pi");
	const outside = join(root, "outside", "escape.txt");
	for (const path of [
		worktreeA,
		worktreeB,
		workflowState,
		join(root, "outside"),
	])
		mkdirSync(path, { recursive: true });
	return { root, worktreeA, worktreeB, workflowState, outside };
}

function shellLiteral(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function canEnforce(): Promise<boolean> {
	if (!platformClaimsSupport) return false;
	const paths = makeRoots("probe");
	try {
		const command = await wrapWorkflowSupervisorCommand(
			`printf probe > ${shellLiteral(join(paths.worktreeA, "probe.txt"))}`,
			{
				coordinatedRunRoot: paths.root,
				workflowStateRoot: paths.workflowState,
				coordinatedWorktreeRoots: [paths.worktreeA, paths.worktreeB],
			},
		);
		execFileSync("bash", ["-c", command], { stdio: "ignore" });
		return existsSync(join(paths.worktreeA, "probe.txt"));
	} catch {
		return false;
	}
}

const canSandbox = await canEnforce();
const live = canSandbox ? describe : describe.skip;
const unavailableMachine =
	platformClaimsSupport && !canSandbox ? describe : describe.skip;

afterAll(async () => {
	await SandboxManager.reset().catch(() => undefined);
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("workflow supervisor sandbox profile", () => {
	it("allows only declared worktrees, workflow state, and scratch", async () => {
		const paths = makeRoots("profile");
		const scratch = join(paths.root, "scratch", "agent-home");
		mkdirSync(scratch, { recursive: true });
		const seen: Array<{ command: string; allowWrite: readonly string[] }> = [];

		const wrapped = await wrapWorkflowSupervisorCommand(
			"pi-workflow supervise run-1",
			{
				coordinatedRunRoot: paths.root,
				workflowStateRoot: paths.workflowState,
				coordinatedWorktreeRoots: [paths.worktreeA, paths.worktreeB],
				scratchRoots: [scratch],
			},
			undefined,
			{
				supported: () => true,
				wrap: async (command, profile) => {
					seen.push({ command, allowWrite: profile.allowWrite });
					return `sandboxed:${command}`;
				},
			},
		);

		expect(wrapped).toBe("sandboxed:pi-workflow supervise run-1");
		expect(seen[0]?.allowWrite).toEqual(
			[paths.worktreeA, paths.worktreeB, paths.workflowState, scratch].sort(),
		);
		expect(seen[0]?.allowWrite).not.toContain(paths.root);
	});

	it("rejects broad, relative, and overlapping declarations", () => {
		const paths = makeRoots("invalid");
		expect(() =>
			workflowSupervisorWriteProfile({
				coordinatedRunRoot: paths.root,
				workflowStateRoot: paths.workflowState,
				coordinatedWorktreeRoots: [],
			}),
		).toThrow(/requires a coordinated worktree/);
		expect(() =>
			workflowSupervisorWriteProfile({
				coordinatedRunRoot: paths.root,
				workflowStateRoot: "relative/.pi",
				coordinatedWorktreeRoots: [paths.worktreeA],
			}),
		).toThrow(/must be absolute/);
		expect(() =>
			workflowSupervisorWriteProfile({
				coordinatedRunRoot: paths.root,
				workflowStateRoot: join(paths.worktreeA, ".pi"),
				coordinatedWorktreeRoots: [paths.worktreeA],
			}),
		).toThrow(/workflow state roots must stay below/);

		// Scratch is not an escape hatch for HOME or another broad absolute path.
		expect(() =>
			workflowSupervisorWriteProfile({
				coordinatedRunRoot: paths.root,
				workflowStateRoot: paths.workflowState,
				coordinatedWorktreeRoots: [paths.worktreeA],
				scratchRoots: [homedir()],
			}),
		).toThrow(/scratch roots must stay below/);

		// A path spelled below the run root but symlinked elsewhere is canonicalized
		// before containment is evaluated.
		const externalTarget = `${paths.root}-external-target`;
		roots.push(externalTarget);
		mkdirSync(externalTarget, { recursive: true });
		const linkedScratch = join(paths.root, "scratch", "linked-scratch");
		mkdirSync(join(paths.root, "scratch"), { recursive: true });
		symlinkSync(externalTarget, linkedScratch, "dir");
		expect(() =>
			workflowSupervisorWriteProfile({
				coordinatedRunRoot: paths.root,
				workflowStateRoot: paths.workflowState,
				coordinatedWorktreeRoots: [paths.worktreeA],
				scratchRoots: [linkedScratch],
			}),
		).toThrow(/scratch roots must stay below/);
	});
});

describe("workflow supervisor sandbox availability", () => {
	it("reports the enforcement precondition on every platform", () => {
		// A supported platform without working runtime dependencies is a failed
		// security boundary, not a reason to silently skip the live assertion.
		expect(canSandbox).toBe(platformClaimsSupport);
	});

	it("refuses instead of launching unconfined when unavailable", () => {
		const paths = makeRoots("unsupported");
		expect(() =>
			wrapWorkflowSupervisorCommand(
				"pi-workflow supervise run-1",
				{
					coordinatedRunRoot: paths.root,
					workflowStateRoot: paths.workflowState,
					coordinatedWorktreeRoots: [paths.worktreeA, paths.worktreeB],
				},
				undefined,
				{
					supported: () => false,
					wrap: async () => "must-not-run",
				},
			),
		).toThrow(/refusing an unconfined launch/);
	});
});

unavailableMachine("workflow supervisor sandbox machine precondition", () => {
	it("reports claimed platform support without executable dependencies", () => {
		process.stdout.write(
			`\n  NOTE: ${process.platform} claims sandbox support but this machine cannot enforce it.\n` +
				"  The supervisor refuses launch here; the kernel-denial proof is skipped.\n",
		);
		expect({ platformClaimsSupport, canSandbox }).toEqual({
			platformClaimsSupport: true,
			canSandbox: false,
		});
	});
});

live("outer workflow supervisor sandbox enforcement", () => {
	it("lets descendants edit every coordinated worktree and denies a sibling write", async () => {
		const paths = makeRoots("live");
		const contractsFile = join(paths.worktreeA, "contract.json");
		const apiFile = join(paths.worktreeB, "consumer.ts");
		const runFile = join(paths.workflowState, "run.json");
		const inner = [
			`printf contract > ${shellLiteral(contractsFile)}`,
			`printf api > ${shellLiteral(apiFile)}`,
			`printf state > ${shellLiteral(runFile)}`,
		].join(" && ");
		const allowed = await wrapWorkflowSupervisorCommand(
			`bash -c ${shellLiteral(inner)}`,
			{
				coordinatedRunRoot: paths.root,
				workflowStateRoot: paths.workflowState,
				coordinatedWorktreeRoots: [paths.worktreeA, paths.worktreeB],
			},
		);
		execFileSync("bash", ["-c", allowed], { stdio: "ignore" });

		expect(existsSync(contractsFile)).toBe(true);
		expect(existsSync(apiFile)).toBe(true);
		expect(existsSync(runFile)).toBe(true);

		const escaping = await wrapWorkflowSupervisorCommand(
			`bash -c ${shellLiteral(`printf escaped > ${shellLiteral(paths.outside)}`)}`,
			{
				coordinatedRunRoot: paths.root,
				workflowStateRoot: paths.workflowState,
				coordinatedWorktreeRoots: [paths.worktreeA, paths.worktreeB],
			},
		);
		expect(() =>
			execFileSync("bash", ["-c", escaping], { stdio: "ignore" }),
		).toThrow();
		expect(existsSync(paths.outside)).toBe(false);
	}, 20_000);
});
