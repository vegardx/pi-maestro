// Repo commit-message policy: detection + the pre-push audit. Repos managed
// by semantic-release (or commitlint / an AGENTS.md mandate) require
// Conventional Commits; a worker committing "Add provider configs" there
// makes semantic-release run green and release NOTHING. The audit catches
// that before push and can explain exactly what the pushed commits would do
// to the release.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "@vegardx/pi-git";

export interface CommitPolicy {
	/** Commit subjects must follow Conventional Commits. */
	readonly conventional: boolean;
	/** What established the policy (".releaserc", "AGENTS.md", …). */
	readonly source?: string;
	/** A release tool derives versions from commit types (semantic-release …). */
	readonly releaseManaged: boolean;
}

const RELEASE_CONFIGS = [
	".releaserc",
	".releaserc.json",
	".releaserc.yaml",
	".releaserc.yml",
	".releaserc.js",
	".releaserc.cjs",
	"release.config.js",
	"release.config.cjs",
	"release.config.mjs",
	"release-please-config.json",
];

const COMMITLINT_CONFIGS = [
	"commitlint.config.js",
	"commitlint.config.cjs",
	"commitlint.config.mjs",
	"commitlint.config.ts",
	".commitlintrc",
	".commitlintrc.json",
	".commitlintrc.yaml",
	".commitlintrc.yml",
	".commitlintrc.js",
];

/** Detect the repo's commit policy from release/lint config and agent docs. */
export function detectCommitPolicy(repoPath: string): CommitPolicy {
	for (const f of RELEASE_CONFIGS) {
		if (existsSync(join(repoPath, f)))
			return { conventional: true, source: f, releaseManaged: true };
	}
	try {
		const pkg = JSON.parse(
			readFileSync(join(repoPath, "package.json"), "utf8"),
		) as {
			release?: unknown;
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		if (pkg.release)
			return {
				conventional: true,
				source: 'package.json "release"',
				releaseManaged: true,
			};
		const deps = { ...pkg.dependencies, ...pkg.devDependencies };
		if (deps["semantic-release"])
			return {
				conventional: true,
				source: "semantic-release dependency",
				releaseManaged: true,
			};
	} catch {
		// no/unparseable package.json — fall through
	}
	for (const f of COMMITLINT_CONFIGS) {
		if (existsSync(join(repoPath, f)))
			return { conventional: true, source: f, releaseManaged: false };
	}
	for (const f of ["AGENTS.md", "CONTRIBUTING.md"]) {
		try {
			if (
				/conventional commits?/i.test(readFileSync(join(repoPath, f), "utf8"))
			)
				return { conventional: true, source: f, releaseManaged: false };
		} catch {
			// absent — fall through
		}
	}
	return { conventional: false, releaseManaged: false };
}

const CONVENTIONAL_RE =
	/^(feat|fix|docs|test|chore|refactor|perf|build|ci|style|revert)(\([^)]*\))?!?: \S/;
const RELEASE_TRIGGER_RE = /^(feat|fix)(\([^)]*\))?!?[:(]/;
/** Subjects git itself generates — never the worker's fault. */
const EXEMPT_RE = /^(Merge |Revert ")/;

export interface CommitAudit {
	readonly ok: boolean;
	/** Non-conforming subjects (empty when ok or policy not conventional). */
	readonly violations: readonly string[];
	/** At least one feat/fix commit — semantic-release would publish. */
	readonly releaseTriggering: boolean;
	/** Human-readable: what these commits mean for the release, and why. */
	readonly explanation: string;
}

/**
 * Audit branch commit subjects against the policy. Blocks on format
 * violations always; on a missing release trigger only when the release is
 * commit-driven AND the diff includes runtime code (`hasRuntimeChanges`) —
 * a docs-only branch legitimately releases nothing.
 */
export function auditCommitSubjects(
	subjects: readonly string[],
	policy: CommitPolicy,
	opts: { hasRuntimeChanges?: boolean } = {},
): CommitAudit {
	const releaseTriggering = subjects.some((s) => RELEASE_TRIGGER_RE.test(s));
	if (!policy.conventional || subjects.length === 0) {
		return {
			ok: true,
			violations: [],
			releaseTriggering,
			explanation: policy.conventional
				? "no commits to audit"
				: "repo has no conventional-commit policy",
		};
	}
	const violations = subjects.filter(
		(s) => !CONVENTIONAL_RE.test(s) && !EXEMPT_RE.test(s),
	);
	if (violations.length > 0) {
		return {
			ok: false,
			violations,
			releaseTriggering,
			explanation:
				`${violations.length} of ${subjects.length} commit subject(s) violate ` +
				`Conventional Commits (policy: ${policy.source}). ` +
				(policy.releaseManaged
					? "semantic-release derives versions from commit types — these commits would release nothing. "
					: "") +
				`Rewrite them (e.g. \`feat(scope): subject\`, \`fix(scope): subject\`, ` +
				`test/docs/chore for non-runtime work) before shipping.`,
		};
	}
	if (
		policy.releaseManaged &&
		!releaseTriggering &&
		opts.hasRuntimeChanges === true
	) {
		return {
			ok: false,
			violations: [],
			releaseTriggering: false,
			explanation:
				`all ${subjects.length} commit(s) are conventional but NONE is feat/fix — ` +
				`semantic-release would run green and publish nothing, despite runtime ` +
				`changes on the branch. Add a release-triggering commit ` +
				`(\`feat(scope): …\` or \`fix(scope): …\`).`,
		};
	}
	return {
		ok: true,
		violations: [],
		releaseTriggering,
		explanation: policy.releaseManaged
			? releaseTriggering
				? "conventional + at least one feat/fix — semantic-release will publish"
				: "conventional; no feat/fix — no release (docs/test/chore-only change)"
			: "commit subjects conform to the policy",
	};
}

/** Files whose changes don't constitute user-visible runtime behaviour. */
const NON_RUNTIME_RE =
	/(^|\/)(docs?|__tests__|tests?)\/|\.(md|txt)$|\.test\.|\.spec\.|^\.github\//;

/**
 * Branch audit against live git state: enumerate `base..HEAD` subjects (the
 * base may exist only as origin/<base>) and classify the diff for the
 * release-trigger requirement.
 */
export function auditBranchCommits(
	worktreePath: string,
	baseBranch: string,
	policy: CommitPolicy,
): CommitAudit {
	const ref = resolveRef(worktreePath, baseBranch);
	if (!ref) {
		return {
			ok: true,
			violations: [],
			releaseTriggering: false,
			explanation: `cannot resolve base ${baseBranch} — commit audit skipped`,
		};
	}
	const log = runCommand("git", ["log", "--format=%s", `${ref}..HEAD`], {
		cwd: worktreePath,
	});
	if (!log.ok) {
		return {
			ok: true,
			violations: [],
			releaseTriggering: false,
			explanation: "git log failed — commit audit skipped",
		};
	}
	const subjects = log.stdout.split("\n").filter((s) => s.trim().length > 0);
	const diff = runCommand("git", ["diff", "--name-only", `${ref}...HEAD`], {
		cwd: worktreePath,
	});
	const files = diff.ok
		? diff.stdout.split("\n").filter((f) => f.trim().length > 0)
		: [];
	const hasRuntimeChanges = files.some((f) => !NON_RUNTIME_RE.test(f));
	return auditCommitSubjects(subjects, policy, { hasRuntimeChanges });
}

function resolveRef(cwd: string, base: string): string | null {
	for (const candidate of [base, `origin/${base}`]) {
		const ok = runCommand(
			"git",
			["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`],
			{ cwd },
		).ok;
		if (ok) return candidate;
	}
	return null;
}

/** One seed/preamble paragraph teaching the worker the repo's commit policy. */
export function commitPolicyInstruction(policy: CommitPolicy): string | null {
	if (!policy.conventional) return null;
	return (
		`## Commit policy\n\nThis repo mandates Conventional Commits (${policy.source}). ` +
		"EVERY commit subject must match `type(scope): subject` — feat/fix for " +
		"runtime behaviour, test/docs/chore/refactor for the rest." +
		(policy.releaseManaged
			? " Releases are derived from commit types: feature or fix work MUST " +
				"include at least one `feat(...)` or `fix(...)` commit, or " +
				"semantic-release will publish nothing. The maestro audits commits " +
				"before shipping and will block non-conforming branches."
			: "")
	);
}
