// Readiness: whether this machine can run the plan that was just stored.
//
// Validation asks whether the DOCUMENT is coherent. Readiness asks whether the
// WORLD it names is there: the repositories exist, they are working-tree roots
// rather than some directory inside one, they are clean, the base branch the
// publication policy asked for resolves, and `gh` is on PATH when the policy
// asked for a pull request. Those are facts about a host at a moment, which is
// why they are not plan errors — the same plan is ready on one machine and not
// on another, and a document that stored the answer would be storing a fact
// that expires.
//
// **Named readiness, never "preflight".** `preflight` belongs to
// `@vegardx/pi-subagent`, where it names the launch-plan compile for a
// delegated attempt. Two names for two steps in two processes.
//
// This module reports; it never asks. There are no dialogs here: a dirty tree
// is a problem the CALLER resolves (continue, or go back to the conversation),
// and creating a missing repository happens only when the caller passes the
// confirmation it already obtained. Keeping the questions outside is what lets
// the whole surface be tested without a UI.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import {
	gitRepoProbe,
	type PlanPolicy,
	type PlanRepo,
	type PublishMode,
	type RepoProbe,
	resolvePolicy,
} from "./plan.js";

/** The kinds of thing readiness can find. One kind per outcome, on purpose. */
export const PROBLEM_KINDS = [
	"missing-path",
	"not-a-root",
	"dirty",
	"missing-base",
	"missing-gh",
] as const;

export type ProblemKind = (typeof PROBLEM_KINDS)[number];

/**
 * One thing standing between a stored plan and a run.
 *
 * Every repository problem carries the repo it is about, because the caller
 * resolves them per repository: `missing-path` offers creation, `dirty` offers
 * continue-or-go-back. `missing-gh` is about the host, so it carries no repo.
 */
export type Problem =
	| {
			readonly kind: "missing-path";
			readonly repo: PlanRepo;
			readonly message: string;
	  }
	| {
			readonly kind: "not-a-root";
			readonly repo: PlanRepo;
			/** The working-tree root that does contain the path, when there is one. */
			readonly root: string | null;
			readonly message: string;
	  }
	| {
			readonly kind: "dirty";
			readonly repo: PlanRepo;
			readonly message: string;
	  }
	| {
			readonly kind: "missing-base";
			readonly repo: PlanRepo;
			readonly base: string;
			readonly message: string;
	  }
	| { readonly kind: "missing-gh"; readonly message: string };

/** What a probe found. `ok` is exactly "nothing to resolve". */
export interface Readiness {
	readonly ok: boolean;
	readonly problems: readonly Problem[];
}

/**
 * The world, injected.
 *
 * `probe` is the same `RepoProbe` plan validation uses, so "is this a
 * working-tree root" is answered once, in one place, by one implementation.
 * The two extra questions are their own functions rather than raw command
 * strings because a test that faked a shell would be asserting that the fake
 * shell was written correctly.
 */
export interface ReadinessDeps {
	/** Is there anything at this path at all? Default: `existsSync`. */
	readonly exists?: (path: string) => boolean;
	/** Git working-tree probe. Default: `gitRepoProbe`. */
	readonly probe?: RepoProbe;
	/** `git rev-parse --verify <ref>` in `cwd`. Default: the real thing. */
	readonly refExists?: (cwd: string, ref: string) => boolean;
	/** `gh --version`. Default: the real thing. */
	readonly ghPresent?: () => boolean;
}

/** `git rev-parse --verify <ref>` run in `cwd`: does the ref resolve there? */
export const gitRefExists = (cwd: string, ref: string): boolean => {
	try {
		execFileSync("git", ["rev-parse", "--verify", ref], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "ignore", "ignore"],
		});
		return true;
	} catch {
		// No such ref, no such repository, or no git: the caller cannot act
		// differently on any of those here, so they are one answer.
		return false;
	}
};

/** `gh --version`: is the GitHub CLI on PATH? */
export const ghOnPath = (): boolean => {
	try {
		execFileSync("gh", ["--version"], {
			encoding: "utf8",
			stdio: ["ignore", "ignore", "ignore"],
		});
		return true;
	} catch {
		return false;
	}
};

/**
 * Everything standing between this plan and a run, all of it at once.
 *
 * Reported whole for the same reason plan validation is: a caller that fixes
 * one repository per round trip is a caller who stops reading the list. A
 * repository whose path is missing or is not a root is reported once and then
 * left alone — its later questions ("is it clean", "does the base exist") have
 * no meaning yet, and answering them would bury the one problem that matters.
 */
export function probeReadiness(
	repos: readonly PlanRepo[],
	policy: PlanPolicy | undefined,
	deps: ReadinessDeps = {},
): Readiness {
	const exists = deps.exists ?? existsSync;
	const probe = deps.probe ?? gitRepoProbe;
	const refExists = deps.refExists ?? gitRefExists;
	const ghPresent = deps.ghPresent ?? ghOnPath;
	const publish = resolvePolicy(policy).publish;
	const problems: Problem[] = [];

	for (const repo of repos) {
		if (!exists(repo.path)) {
			problems.push({
				kind: "missing-path",
				repo,
				message: `repo \`${repo.key}\`: nothing exists at \`${repo.path}\``,
			});
			continue;
		}
		const state = probe(repo.path);
		if (state.root === null) {
			problems.push({
				kind: "not-a-root",
				repo,
				root: null,
				message: `repo \`${repo.key}\`: \`${repo.path}\` is not a Git working tree`,
			});
			continue;
		}
		if (state.root !== state.resolved) {
			problems.push({
				kind: "not-a-root",
				repo,
				root: state.root,
				message: `repo \`${repo.key}\`: \`${repo.path}\` is not a working-tree root — that is \`${state.root}\``,
			});
			continue;
		}
		// Dirty and a missing base are INDEPENDENT: a tree can have both, the
		// caller resolves them differently, and reporting only the first would
		// send it back here for the second.
		if (state.dirty)
			problems.push({
				kind: "dirty",
				repo,
				message: `repo \`${repo.key}\`: \`${repo.path}\` has uncommitted changes — every worktree branches from its HEAD, so those changes are not in the run`,
			});
		// The base is only a question when something is going to be published
		// onto it. A base recorded under `mode: "none"` describes a publication
		// that will not happen, and refusing a run over it would be refusing
		// over an unused field.
		if (
			publish.mode !== "none" &&
			publish.base &&
			!refExists(repo.path, publish.base)
		)
			problems.push({
				kind: "missing-base",
				repo,
				base: publish.base,
				message: `repo \`${repo.key}\`: \`${publish.base}\` does not resolve in \`${repo.path}\` — publication branches from it`,
			});
	}

	// Asked once, about the host, and only for the one mode that needs it:
	// `branch` and `none` publish without ever calling `gh`.
	if (publish.mode === "pr" && !ghPresent())
		problems.push({
			kind: "missing-gh",
			message:
				'`gh` is not on PATH — `publish.mode: "pr"` opens the pull request with it',
		});

	return { ok: problems.length === 0, problems };
}

/** What a command through the audited Bash tool returned. */
export interface BashOutcome {
	readonly ok: boolean;
	/** Whatever the command (or the refusal) said, for the failure message. */
	readonly output: string;
}

/**
 * The seat's audited Bash tool, narrowed to what creation needs.
 *
 * Injected rather than built here so that the classifier, the session mode's
 * policy and its confirmation all apply exactly as they do to any other
 * command the seat runs: creating a repository is host-write work, and it is
 * not a category the flow gets to exempt itself from.
 */
export type AuditedBash = (
	command: string,
	intent: string,
) => Promise<BashOutcome>;

export interface CreationDeps {
	readonly bash: AuditedBash;
	/**
	 * The caller's own confirmation, already obtained.
	 *
	 * This module never asks — the dialog belongs to the controller — but it
	 * also never assumes. Creating a repository without an answer is exactly
	 * the failure this flag exists to make impossible, so the default of an
	 * absent flag is refusal.
	 */
	readonly confirmed: boolean;
	/** What the plan's policy publishes, which decides whether `gh` is used. */
	readonly publish: { readonly mode: PublishMode };
}

/** What creation did, including when it did nothing. */
export type Creation =
	| { readonly ok: true; readonly commands: readonly string[] }
	| {
			readonly ok: false;
			readonly reason: string;
			/** The commands that did run before it stopped. */
			readonly commands: readonly string[];
	  };

/** Shell-safe single argument. Paths come from a document; they can be odd. */
function quote(value: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
		? value
		: `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The commands creating `path` would issue, in order.
 *
 * Exported because the caller shows them before it asks: a confirmation whose
 * text is written separately from the commands it authorizes is a confirmation
 * that can describe something else.
 *
 * `gh repo create --source` wires the remote itself, so `--remote origin` IS
 * the `git remote add origin` step — issued as part of the same command
 * because a separate `git remote add origin` would need a URL nothing has
 * printed yet, and would fail against the remote `gh` just added.
 */
export function creationCommands(
	path: string,
	mode: PublishMode,
): readonly string[] {
	const at = quote(path);
	const commands = [
		`git init ${at}`,
		// An empty initial commit, so the tree has a HEAD: every worktree a run
		// creates branches from one, and a repository with no commits has none.
		`git -C ${at} commit --allow-empty -m ${quote("Initial commit")}`,
	];
	if (mode !== "none")
		commands.push(
			`gh repo create ${quote(basename(path))} --private --source ${at} --remote origin`,
		);
	return commands;
}

/**
 * Create the repository a `missing-path` problem named.
 *
 * Every command goes through the injected audited Bash runner, in order, and
 * the first failure stops the rest: a repository half-created is easier to
 * look at than one whose remote was added over a tree that has no commit.
 */
export async function createRepository(
	problem: Problem,
	deps: CreationDeps,
): Promise<Creation> {
	if (problem.kind !== "missing-path")
		return {
			ok: false,
			reason: `readiness: \`${problem.kind}\` is not a problem creating a repository would solve`,
			commands: [],
		};
	if (!deps.confirmed)
		return {
			ok: false,
			reason: `readiness: creating \`${problem.repo.path}\` was not confirmed`,
			commands: [],
		};
	const issued: string[] = [];
	for (const command of creationCommands(
		problem.repo.path,
		deps.publish.mode,
	)) {
		const outcome = await deps.bash(
			command,
			`create the repository plan repo \`${problem.repo.key}\` names`,
		);
		issued.push(command);
		if (!outcome.ok)
			return {
				ok: false,
				reason: `readiness: \`${command}\` failed — ${outcome.output}`,
				commands: issued,
			};
	}
	return { ok: true, commands: issued };
}
