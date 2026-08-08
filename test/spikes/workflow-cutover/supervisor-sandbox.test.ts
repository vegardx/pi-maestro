import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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
	const root = join(homedir(), `.m-sb-${label}-${process.pid}-${Date.now()}`);
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
				worktreeAccess: "write",
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
const unsupportedMachine = !platformClaimsSupport ? describe : describe.skip;

afterAll(async () => {
	await SandboxManager.reset().catch(() => undefined);
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("workflow supervisor sandbox profile", () => {
	it("allows only declared worktrees, workflow state, and scratch", async () => {
		const paths = makeRoots("profile");
		const scratch = join(paths.root, "scratch", "agent-home");
		mkdirSync(scratch, { recursive: true });
		const seen: Array<{
			command: string;
			allowWrite: readonly string[];
		}> = [];

		const wrapped = await wrapWorkflowSupervisorCommand(
			"pi-workflow supervise run-1",
			{
				coordinatedRunRoot: paths.root,
				workflowStateRoot: paths.workflowState,
				coordinatedWorktreeRoots: [paths.worktreeA, paths.worktreeB],
				worktreeAccess: "write",
				scratchRoots: [scratch],
			},
			undefined,
			{
				supported: () => true,
				wrap: async (command, profile) => {
					seen.push({
						command,
						allowWrite: profile.allowWrite,
					});
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

	it("keeps review worktrees readable but out of the writable set", () => {
		const paths = makeRoots("read-profile");
		const profile = workflowSupervisorWriteProfile({
			coordinatedRunRoot: paths.root,
			workflowStateRoot: paths.workflowState,
			coordinatedWorktreeRoots: [paths.worktreeA, paths.worktreeB],
			worktreeAccess: "read",
		});

		expect(profile.allowWrite).toEqual([paths.workflowState]);
		expect(profile.allowWrite).not.toContain(paths.worktreeA);
		expect(profile.allowWrite).not.toContain(paths.worktreeB);
	});

	it("binds an exact canonical set of hidden prior workflow trees", () => {
		const paths = makeRoots("deny-read-profile");
		const workflows = join(paths.workflowState, "workflows");
		const reviewA = join(workflows, "review-a");
		const reviewB = join(workflows, "review-b");
		mkdirSync(reviewA, { recursive: true });
		mkdirSync(reviewB, { recursive: true });

		const profile = workflowSupervisorWriteProfile({
			coordinatedRunRoot: paths.root,
			workflowStateRoot: paths.workflowState,
			coordinatedWorktreeRoots: [paths.worktreeA],
			worktreeAccess: "write",
			deniedReadRoots: [reviewB, reviewA],
		});

		expect(profile.denyRead).toEqual([reviewA, reviewB]);
	});

	it("rejects broad, relative, and overlapping declarations", () => {
		const paths = makeRoots("invalid");
		expect(() =>
			workflowSupervisorWriteProfile({
				coordinatedRunRoot: paths.root,
				workflowStateRoot: paths.workflowState,
				coordinatedWorktreeRoots: [],
				worktreeAccess: "write",
			}),
		).toThrow(/requires a coordinated worktree/);
		expect(() =>
			workflowSupervisorWriteProfile({
				coordinatedRunRoot: paths.root,
				workflowStateRoot: "relative/.pi",
				coordinatedWorktreeRoots: [paths.worktreeA],
				worktreeAccess: "write",
			}),
		).toThrow(/must be absolute/);
		expect(() =>
			workflowSupervisorWriteProfile({
				coordinatedRunRoot: paths.root,
				workflowStateRoot: join(paths.worktreeA, ".pi"),
				coordinatedWorktreeRoots: [paths.worktreeA],
				worktreeAccess: "write",
			}),
		).toThrow(/workflow state roots must stay below/);

		// Scratch is not an escape hatch for HOME or another broad absolute path.
		expect(() =>
			workflowSupervisorWriteProfile({
				coordinatedRunRoot: paths.root,
				workflowStateRoot: paths.workflowState,
				coordinatedWorktreeRoots: [paths.worktreeA],
				worktreeAccess: "write",
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
				worktreeAccess: "write",
				scratchRoots: [linkedScratch],
			}),
		).toThrow(/scratch roots must stay below/);

		const workflows = join(paths.workflowState, "workflows");
		const priorReview = join(workflows, "review-a");
		mkdirSync(priorReview, { recursive: true });
		expect(() =>
			workflowSupervisorWriteProfile({
				coordinatedRunRoot: paths.root,
				workflowStateRoot: paths.workflowState,
				coordinatedWorktreeRoots: [paths.worktreeA],
				worktreeAccess: "write",
				deniedReadRoots: [paths.workflowState],
			}),
		).toThrow(/denied workflow read roots must stay below/);
		expect(() =>
			workflowSupervisorWriteProfile({
				coordinatedRunRoot: paths.root,
				workflowStateRoot: paths.workflowState,
				coordinatedWorktreeRoots: [paths.worktreeA],
				worktreeAccess: "write",
				deniedReadRoots: [priorReview, priorReview],
			}),
		).toThrow(/denied read roots must be unique/);
		const linkedReview = join(workflows, "linked-review");
		symlinkSync(externalTarget, linkedReview, "dir");
		expect(() =>
			workflowSupervisorWriteProfile({
				coordinatedRunRoot: paths.root,
				workflowStateRoot: paths.workflowState,
				coordinatedWorktreeRoots: [paths.worktreeA],
				worktreeAccess: "write",
				deniedReadRoots: [linkedReview],
			}),
		).toThrow(/denied workflow read roots must stay below/);
	});
});

describe("workflow supervisor sandbox availability", () => {
	it("reports the enforcement precondition on every platform", () => {
		// Enforcement can only succeed where the package claims platform support.
		// The two unavailable cases are asserted explicitly in the suites below.
		expect(canSandbox && !platformClaimsSupport).toBe(false);
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
					worktreeAccess: "write",
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

unsupportedMachine(
	"workflow supervisor unsupported-platform precondition",
	() => {
		it("reports that no kernel-denial proof can run on this platform", () => {
			expect({ platformClaimsSupport, canSandbox }).toEqual({
				platformClaimsSupport: false,
				canSandbox: false,
			});
		});
	},
);

live("outer workflow supervisor sandbox enforcement", () => {
	it("lets a read phase inspect a worktree and write state but not alter the worktree", async () => {
		const paths = makeRoots("read-live");
		const source = join(paths.worktreeA, "source.ts");
		const observed = join(paths.workflowState, "observed.txt");
		writeFileSync(source, "approved source\n");
		const inner = [
			`cat ${shellLiteral(source)} > ${shellLiteral(observed)}`,
			`printf corrupted > ${shellLiteral(source)}`,
		].join(" && ");
		const command = await wrapWorkflowSupervisorCommand(
			`bash -c ${shellLiteral(inner)}`,
			{
				coordinatedRunRoot: paths.root,
				workflowStateRoot: paths.workflowState,
				coordinatedWorktreeRoots: [paths.worktreeA, paths.worktreeB],
				worktreeAccess: "read",
			},
		);

		expect(() =>
			execFileSync("bash", ["-c", command], { stdio: "ignore" }),
		).toThrow();
		expect(readFileSync(observed, "utf8")).toBe("approved source\n");
		expect(readFileSync(source, "utf8")).toBe("approved source\n");
	}, 20_000);

	it("hides prior review control data from a decision descendant without hiding its own state or worktree", async () => {
		const paths = makeRoots("deny-read-live");
		const priorReview = join(paths.workflowState, "workflows", "review-run");
		const priorControl = join(priorReview, "raw", "control.json");
		const decisionState = join(
			paths.workflowState,
			"workflows",
			"decision-run",
			"run.json",
		);
		const worktreeFile = join(paths.worktreeA, "source.ts");
		mkdirSync(join(priorReview, "raw"), { recursive: true });
		mkdirSync(join(paths.workflowState, "workflows", "decision-run"), {
			recursive: true,
		});
		writeFileSync(priorControl, "reviewer identity\n");
		writeFileSync(decisionState, "decision state\n");
		writeFileSync(worktreeFile, "worktree source\n");
		const sandboxRoots = {
			coordinatedRunRoot: paths.root,
			workflowStateRoot: paths.workflowState,
			coordinatedWorktreeRoots: [paths.worktreeA, paths.worktreeB],
			worktreeAccess: "write" as const,
			deniedReadRoots: [priorReview],
		};

		const allowed = await wrapWorkflowSupervisorCommand(
			`bash -c ${shellLiteral(`cat ${shellLiteral(decisionState)} && cat ${shellLiteral(worktreeFile)}`)}`,
			sandboxRoots,
		);
		const result = execFileSync("bash", ["-c", allowed], { encoding: "utf8" });
		expect(result).toBe("decision state\nworktree source\n");

		const denied = await wrapWorkflowSupervisorCommand(
			`bash -c ${shellLiteral(`bash -c ${shellLiteral(`cat ${shellLiteral(priorControl)}`)}`)}`,
			sandboxRoots,
		);
		expect(() =>
			execFileSync("bash", ["-c", denied], { stdio: "ignore" }),
		).toThrow();
	}, 20_000);

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
				worktreeAccess: "write",
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
				worktreeAccess: "write",
			},
		);
		expect(() =>
			execFileSync("bash", ["-c", escaping], { stdio: "ignore" }),
		).toThrow();
		expect(existsSync(paths.outside)).toBe(false);
	}, 20_000);
});
