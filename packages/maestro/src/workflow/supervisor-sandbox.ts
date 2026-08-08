import { existsSync, realpathSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	parse,
	relative,
	resolve,
} from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { WriteProfile } from "../isolation/capability-grants.js";
import {
	defaultSandboxWrap,
	type SandboxWrap,
} from "../isolation/realtree-sandbox.js";

export interface WorkflowSupervisorSandboxRoots {
	/** Parent boundary for every path this run may mutate; never writable itself. */
	readonly coordinatedRunRoot: string;
	/** Durable pi-workflow and pi-subagent state for this coordinated run. */
	readonly workflowStateRoot: string;
	/** Maestro-created worktrees that workflow descendants may edit. */
	readonly coordinatedWorktreeRoots: readonly string[];
	/**
	 * Optional private HOME/TMP/cache roots below `<run>/scratch`. This should
	 * include a minimal PI_CODING_AGENT_DIR materialized for the supervisor;
	 * the existing worker sandbox deliberately denies the developer's real agent
	 * directory, so ambient global skills are not proven through this adapter.
	 */
	readonly scratchRoots?: readonly string[];
}

export interface WorkflowSupervisorSandboxRuntime {
	readonly supported: () => boolean;
	readonly wrap: SandboxWrap;
}

const DEFAULT_RUNTIME: WorkflowSupervisorSandboxRuntime = {
	supported: () => SandboxManager.isSupportedPlatform(platformName()),
	wrap: defaultSandboxWrap,
};

/**
 * Build the coarse write boundary inherited by a workflow supervisor and every
 * process it starts. Stage-specific authority remains a separate, narrower
 * layer; this boundary only prevents an accidental write from escaping the
 * coordinated run's declared roots.
 */
export function workflowSupervisorWriteProfile(
	roots: WorkflowSupervisorSandboxRoots,
): WriteProfile {
	if (roots.coordinatedWorktreeRoots.length === 0)
		throw new Error(
			"workflow supervisor sandbox requires a coordinated worktree",
		);

	const runRoot = validatedRoot(roots.coordinatedRunRoot, "coordinated run");
	const worktrees = roots.coordinatedWorktreeRoots.map((root) =>
		validatedRoot(root, "coordinated worktree"),
	);
	const workflowState = validatedRoot(
		roots.workflowStateRoot,
		"workflow state",
	);
	const scratch = (roots.scratchRoots ?? []).map((root) =>
		validatedRoot(root, "scratch"),
	);
	const declaredRoots = [...worktrees, workflowState, ...scratch];
	const worktreeContainer = canonicalPath(resolve(runRoot, "repos"));
	const runtimeContainer = canonicalPath(resolve(runRoot, "runtime"));
	const scratchContainer = canonicalPath(resolve(runRoot, "scratch"));

	for (const worktree of worktrees)
		assertStrictChild(worktree, worktreeContainer, "coordinated worktree");
	assertStrictChild(workflowState, runtimeContainer, "workflow state");
	for (const root of scratch)
		assertStrictChild(root, scratchContainer, "scratch");

	for (const root of declaredRoots) {
		if (root === runRoot || !isWithin(root, runRoot))
			throw new Error(
				"workflow supervisor writable roots must be strict children of the coordinated run root",
			);
	}
	for (let left = 0; left < declaredRoots.length; left += 1) {
		for (let right = left + 1; right < declaredRoots.length; right += 1) {
			if (overlaps(declaredRoots[left]!, declaredRoots[right]!))
				throw new Error(
					"workflow supervisor writable roots must be mutually disjoint",
				);
		}
	}

	return {
		allowWrite: [...new Set(declaredRoots)].sort(),
		denyWrite: [],
		unrestricted: false,
	};
}

function assertStrictChild(
	candidate: string,
	container: string,
	label: string,
): void {
	if (candidate === container || !isWithin(candidate, container))
		throw new Error(`${label} roots must stay below ${container}`);
}

/** Wrap the whole workflow command once so detached descendants inherit it. */
export function wrapWorkflowSupervisorCommand(
	command: string,
	roots: WorkflowSupervisorSandboxRoots,
	signal?: AbortSignal,
	runtime: WorkflowSupervisorSandboxRuntime = DEFAULT_RUNTIME,
): Promise<string> {
	if (!runtime.supported())
		throw new Error(
			`workflow supervisor sandbox is unavailable on ${process.platform}; refusing an unconfined launch`,
		);
	return runtime.wrap(command, workflowSupervisorWriteProfile(roots), signal);
}

function platformName(): "macos" | "linux" | "windows" {
	return process.platform === "darwin"
		? "macos"
		: process.platform === "linux"
			? "linux"
			: "windows";
}

function validatedRoot(input: string, label: string): string {
	if (!isAbsolute(input)) throw new Error(`${label} root must be absolute`);
	const normalized = canonicalPath(input);
	if (normalized === parse(normalized).root)
		throw new Error(`${label} root must not be the filesystem root`);
	return normalized;
}

/** Resolve symlinks through the nearest existing ancestor, including new paths. */
function canonicalPath(input: string): string {
	let cursor = resolve(input);
	const missing: string[] = [];
	while (!existsSync(cursor)) {
		const parent = dirname(cursor);
		if (parent === cursor) break;
		missing.unshift(basename(cursor));
		cursor = parent;
	}
	return resolve(realpathSync(cursor), ...missing);
}

function overlaps(left: string, right: string): boolean {
	return isWithin(left, right) || isWithin(right, left);
}

function isWithin(candidate: string, parent: string): boolean {
	const rel = relative(parent, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
