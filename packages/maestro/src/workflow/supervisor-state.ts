import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readlinkSync,
	realpathSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

export interface WorkflowSupervisorStateLayout {
	readonly coordinatedRunRoot: string;
	readonly workflowStateRoot: string;
	readonly workflowStateLink: string;
}

/**
 * pi-workflow fixes its state location at `<cwd>/.pi/workflows`. Coordinated
 * runs use a non-Git umbrella cwd, so this creates one deliberate link into the
 * separately writable runtime root. Existing layouts are verified, never
 * repaired: a changed link on resume is a failed integrity boundary.
 */
export function materializeWorkflowSupervisorState(
	coordinatedRunRoot: string,
): WorkflowSupervisorStateLayout {
	const runRoot = canonicalExistingDirectory(
		coordinatedRunRoot,
		"coordinated run root",
	);
	const runtimeContainer = join(runRoot, "runtime");
	const stateRoot = join(runtimeContainer, ".pi");
	const stateLink = join(runRoot, ".pi");

	ensurePrivateDirectory(runtimeContainer, "workflow runtime container");
	ensurePrivateDirectory(stateRoot, "workflow state root");
	const canonicalStateRoot = realpathSync(stateRoot);
	assertStrictChild(canonicalStateRoot, runRoot, "workflow state root");

	const existingLink = lstatIfPresent(stateLink);
	if (!existingLink) {
		symlinkSync(relative(runRoot, canonicalStateRoot), stateLink, "dir");
	} else {
		if (!existingLink.isSymbolicLink())
			throw new Error("workflow state path must be the managed symbolic link");
		const target = resolve(dirname(stateLink), readlinkSync(stateLink));
		if (realpathSync(target) !== canonicalStateRoot)
			throw new Error("workflow state link target changed");
	}

	return {
		coordinatedRunRoot: runRoot,
		workflowStateRoot: canonicalStateRoot,
		workflowStateLink: stateLink,
	};
}

function ensurePrivateDirectory(path: string, label: string): void {
	const existing = lstatIfPresent(path);
	if (!existing) {
		mkdirSync(path, { mode: 0o700 });
		if (process.platform !== "win32") chmodSync(path, 0o700);
		return;
	}
	if (!existing.isDirectory() || existing.isSymbolicLink())
		throw new Error(`${label} must be a real directory`);
	if (process.platform !== "win32" && (statSync(path).mode & 0o777) !== 0o700)
		throw new Error(`${label} must have mode 0700`);
}

function lstatIfPresent(
	path: string,
): ReturnType<typeof lstatSync> | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function canonicalExistingDirectory(input: string, label: string): string {
	if (!isAbsolute(input)) throw new Error(`${label} must be absolute`);
	const canonical = realpathSync(input);
	if (canonical === parse(canonical).root)
		throw new Error(`${label} must not be the filesystem root`);
	if (!lstatSync(canonical).isDirectory())
		throw new Error(`${label} must be a directory`);
	return canonical;
}

function assertStrictChild(
	candidate: string,
	parent: string,
	label: string,
): void {
	const child = relative(parent, candidate);
	if (!child || child.startsWith("..") || isAbsolute(child))
		throw new Error(`${label} must stay below the coordinated run root`);
}
