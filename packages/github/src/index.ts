// @vegardx/pi-github — typed gh seam: multi-host routing, PR ops (create/view/
// edit/merge/checks), and default-branch + branch-protection discovery. Network
// ops use pi-git's async, abortable runner; JSON parsing is pure.

export { isAuthed } from "./auth.js";
export {
	detectHost,
	parseRemoteUrl,
	type RepoSlug,
	repoSlug,
	targetArgs,
} from "./host.js";
export {
	type CheckState,
	type CheckSummary,
	createPr,
	editPr,
	findOpenPr,
	mergePr,
	type PrMetadata,
	type PrResult,
	parseChecks,
	parsePrMetadata,
	prChecks,
	viewPr,
} from "./pr.js";
export {
	type BranchProtection,
	defaultBranch,
	getBranchProtection,
	parseBranchProtection,
	parseDefaultBranch,
} from "./protection.js";
