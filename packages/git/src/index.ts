// @vegardx/pi-git — typed git seam: a non-interactive shell runner, repo
// queries, branch ops, explicit-paths-only staging, and worktree mechanics +
// the reserved path scheme. Mechanics live here; lifecycle lives in modes.

export {
	branchExists,
	checkoutBranch,
	checkoutOrCreateBranch,
	createBranch,
	pullFastForward,
	pushBranch,
	rebaseOnto,
} from "./branch.js";
export {
	currentBranch,
	detectDefaultBranch,
	gitToplevel,
	hasChanges,
	headSha,
	isAncestor,
	isGitRepo,
	mergeBase,
	originUrl,
	refExists,
	repoNameFromPath,
	revParse,
	statusPorcelain,
	workingTreeClean,
} from "./repo.js";
export {
	DEFAULT_COMMAND_TIMEOUT_MS,
	nonInteractiveEnv,
	type RunCommandAsyncOpts,
	type RunCommandOpts,
	runCommand,
	runCommandAsync,
	type ShellResult,
} from "./shell.js";
export {
	commit,
	stageAndCommit,
	stageFiles,
	UnsafeStageError,
} from "./stage.js";
export {
	addWorktree,
	agentWorktreePath,
	findCheckoutOf,
	listWorktrees,
	parseWorktreeList,
	removeWorktree,
	type WorktreeAddResult,
	type WorktreeEntry,
	type WorktreeRemoveResult,
	worktreeBaseSha,
	worktreePathFor,
	worktreesRoot,
} from "./worktree.js";
