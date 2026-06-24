// Pull-request operations over the gh CLI. Network ops use pi-git's async,
// abortable runner so a stalled gh call can't freeze the TUI; JSON parsing is
// pure (exported for tests).

import { runCommandAsync } from "@vegardx/pi-git";
import { type RepoSlug, targetArgs } from "./host.js";

export interface PrMetadata {
	number: number;
	title: string;
	body: string;
	state: string;
	baseRefName: string;
	headRefName: string;
	isCrossRepository: boolean;
	maintainerCanModify: boolean;
	headRepositoryNameWithOwner: string;
	headRepositoryOwnerLogin: string;
}

const PR_FIELDS = [
	"number",
	"title",
	"body",
	"state",
	"baseRefName",
	"headRefName",
	"isCrossRepository",
	"maintainerCanModify",
	"headRepository",
	"headRepositoryOwner",
].join(",");

export function parsePrMetadata(raw: string): PrMetadata | null {
	try {
		const obj = JSON.parse(raw) as Record<string, unknown>;
		const head = (obj.headRepository ?? {}) as { nameWithOwner?: string };
		const owner = (obj.headRepositoryOwner ?? {}) as { login?: string };
		if (obj.number === undefined) return null;
		return {
			number: Number(obj.number),
			title: String(obj.title ?? ""),
			body: String(obj.body ?? ""),
			state: String(obj.state ?? ""),
			baseRefName: String(obj.baseRefName ?? ""),
			headRefName: String(obj.headRefName ?? ""),
			isCrossRepository: Boolean(obj.isCrossRepository),
			maintainerCanModify: Boolean(obj.maintainerCanModify),
			headRepositoryNameWithOwner: String(head.nameWithOwner ?? ""),
			headRepositoryOwnerLogin: String(owner.login ?? ""),
		};
	} catch {
		return null;
	}
}

export interface PrResult {
	pr: PrMetadata | null;
	error?: string;
}

/** Find an open PR whose head is `branch`. Distinguishes "no PR" from failure. */
export async function findOpenPr(
	cwd: string,
	branch: string,
	opts: { target?: RepoSlug; signal?: AbortSignal } = {},
): Promise<PrResult> {
	const r = await runCommandAsync(
		"gh",
		[
			"pr",
			"list",
			"--head",
			branch,
			"--state",
			"open",
			"--json",
			PR_FIELDS,
			"--limit",
			"1",
			...targetArgs(opts.target),
		],
		{ cwd, signal: opts.signal },
	);
	if (!r.ok)
		return { pr: null, error: r.stderr.trim() || `gh exit ${r.exitCode}` };
	const trimmed = r.stdout.trim();
	if (!trimmed) return { pr: null };
	let arr: unknown;
	try {
		arr = JSON.parse(trimmed);
	} catch {
		return { pr: null, error: "gh pr list: unparseable JSON" };
	}
	if (!Array.isArray(arr) || arr.length === 0) return { pr: null };
	const parsed = parsePrMetadata(JSON.stringify(arr[0]));
	return parsed ? { pr: parsed } : { pr: null, error: "unexpected shape" };
}

export async function viewPr(
	cwd: string,
	number: number,
	opts: { target?: RepoSlug; signal?: AbortSignal } = {},
): Promise<PrResult> {
	const r = await runCommandAsync(
		"gh",
		[
			"pr",
			"view",
			String(number),
			"--json",
			PR_FIELDS,
			...targetArgs(opts.target),
		],
		{ cwd, signal: opts.signal },
	);
	if (!r.ok)
		return { pr: null, error: r.stderr.trim() || `gh exit ${r.exitCode}` };
	const pr = parsePrMetadata(r.stdout);
	return pr ? { pr } : { pr: null, error: "parse failure" };
}

/**
 * Create a PR. `--body-file -` on stdin so multi-line / backtick bodies survive
 * without shell escaping. Returns the created PR URL on success.
 */
export async function createPr(
	cwd: string,
	args: { title: string; body: string; base?: string; target?: RepoSlug },
	opts: { signal?: AbortSignal } = {},
): Promise<{ url: string | null; error?: string }> {
	const ghArgs = ["pr", "create", "--title", args.title, "--body-file", "-"];
	if (args.base) ghArgs.push("--base", args.base);
	ghArgs.push(...targetArgs(args.target));
	const r = await runCommandAsync("gh", ghArgs, {
		cwd,
		stdin: args.body,
		signal: opts.signal,
	});
	if (!r.ok)
		return { url: null, error: r.stderr.trim() || `gh exit ${r.exitCode}` };
	return { url: r.stdout.trim().match(/https?:\/\/\S+/)?.[0] ?? null };
}

export async function editPr(
	cwd: string,
	number: number,
	args: { title?: string; body?: string; target?: RepoSlug },
	opts: { signal?: AbortSignal } = {},
): Promise<{ ok: boolean; error?: string }> {
	const ghArgs = ["pr", "edit", String(number)];
	if (args.title !== undefined) ghArgs.push("--title", args.title);
	const body = args.body;
	if (body !== undefined) ghArgs.push("--body-file", "-");
	ghArgs.push(...targetArgs(args.target));
	const r = await runCommandAsync("gh", ghArgs, {
		cwd,
		stdin: body,
		signal: opts.signal,
	});
	return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() };
}

/**
 * Merge a PR. Rebase by default — the repo convention for linear, stacked-PR
 * history. Deletes the head branch unless told otherwise.
 */
export async function mergePr(
	cwd: string,
	number: number,
	opts: {
		method?: "rebase" | "merge" | "squash";
		deleteBranch?: boolean;
		target?: RepoSlug;
		signal?: AbortSignal;
	} = {},
): Promise<{ ok: boolean; error?: string }> {
	const method = opts.method ?? "rebase";
	const ghArgs = ["pr", "merge", String(number), `--${method}`];
	if (opts.deleteBranch ?? true) ghArgs.push("--delete-branch");
	ghArgs.push(...targetArgs(opts.target));
	const r = await runCommandAsync("gh", ghArgs, { cwd, signal: opts.signal });
	return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() };
}

export type CheckState = "pass" | "fail" | "pending";

export interface CheckSummary {
	total: number;
	passed: number;
	failed: number;
	pending: number;
	state: CheckState;
}

/** Summarise `gh pr checks --json`. Pure — exported for tests. */
export function parseChecks(raw: string): CheckSummary | null {
	let arr: unknown;
	try {
		arr = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!Array.isArray(arr)) return null;
	let passed = 0;
	let failed = 0;
	let pending = 0;
	for (const item of arr) {
		const c = item as { state?: string; bucket?: string };
		const bucket = (c.bucket ?? c.state ?? "").toLowerCase();
		if (["pass", "success", "completed"].includes(bucket)) passed++;
		else if (
			["fail", "failure", "error", "cancel", "cancelled"].includes(bucket)
		)
			failed++;
		else pending++;
	}
	const state: CheckState =
		failed > 0 ? "fail" : pending > 0 ? "pending" : "pass";
	return { total: arr.length, passed, failed, pending, state };
}

export async function prChecks(
	cwd: string,
	number: number,
	opts: { target?: RepoSlug; signal?: AbortSignal } = {},
): Promise<{ checks: CheckSummary | null; error?: string }> {
	const r = await runCommandAsync(
		"gh",
		[
			"pr",
			"checks",
			String(number),
			"--json",
			"name,state,bucket",
			...targetArgs(opts.target),
		],
		{ cwd, signal: opts.signal },
	);
	// gh exits non-zero when checks are failing/pending; parse stdout regardless.
	const checks = parseChecks(r.stdout);
	if (checks) return { checks };
	return { checks: null, error: r.stderr.trim() || `gh exit ${r.exitCode}` };
}
