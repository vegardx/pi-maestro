// Immutable Git targets for code-inspection workflow stages. Reviewers never
// inspect a moving branch or an uncommitted working tree: the orchestrator
// freezes HEAD and passes the explicit delivery and incremental ranges.

import { headSha, workingTreeClean } from "@vegardx/pi-git";

export interface CommitTarget {
	/** Delivery base captured before its branch/worktree was created. */
	readonly base: string;
	/** Clean, committed revision shared by every assignment in the stage. */
	readonly head: string;
	/** Prior inspected/fixed revision, when this is not the first stage. */
	readonly previousHead?: string;
}

export interface CommitCheckpointInput {
	readonly cwd: string;
	readonly base: string;
	readonly previousHead?: string;
}

export interface CommitCheckpointDeps {
	readonly clean: (cwd: string) => boolean;
	readonly head: (cwd: string) => string | null;
}

const defaults: CommitCheckpointDeps = {
	clean: workingTreeClean,
	head: headSha,
};

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function isImmutableCommit(value: string): boolean {
	return SHA_PATTERN.test(value);
}

/**
 * Freeze the current committed workspace revision. This is intentionally a
 * hard barrier: auto-staging or reviewing dirty files would make evidence
 * impossible to reproduce and could mix revisions within a parallel stage.
 */
export function captureCommitCheckpoint(
	input: CommitCheckpointInput,
	overrides: Partial<CommitCheckpointDeps> = {},
): CommitTarget {
	const deps = { ...defaults, ...overrides };
	if (!isImmutableCommit(input.base)) {
		throw new Error(
			`delivery base is not an immutable commit SHA: ${input.base}`,
		);
	}
	if (input.previousHead && !isImmutableCommit(input.previousHead)) {
		throw new Error(
			`previous review head is not an immutable commit SHA: ${input.previousHead}`,
		);
	}
	if (!deps.clean(input.cwd)) {
		throw new Error(
			"code-inspection stage requires a clean working tree; commit or discard all changes first",
		);
	}
	const head = deps.head(input.cwd);
	if (!head || !isImmutableCommit(head)) {
		throw new Error("code-inspection stage could not resolve committed HEAD");
	}
	return {
		base: input.base,
		head,
		...(input.previousHead ? { previousHead: input.previousHead } : {}),
	};
}

/** Stable prompt fragment used by reviewers and scoped verifiers. */
export function renderCommitTarget(target: CommitTarget): string {
	return [
		`Delivery base: ${target.base}`,
		`Frozen head: ${target.head}`,
		`Delivery range: ${target.base}..${target.head}`,
		...(target.previousHead
			? [
					`Previous head: ${target.previousHead}`,
					`Incremental range: ${target.previousHead}..${target.head}`,
				]
			: []),
	].join("\n");
}
