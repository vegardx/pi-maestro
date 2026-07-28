// Real-tree per-actor sandbox (design: "the OS enforces, we explain").
//
// Builds a per-actor WRITE profile (capability-grants) for the REAL cwd — no
// copy — and either:
//  - SHADOW: logs the profile it WOULD apply, runs the command unchanged; or
//  - ENFORCE: confines writes to the profile via @anthropic-ai/sandbox-runtime
//    (verified live on macOS: a write to a real HOME path is kernel-denied, a
//    write inside the scope succeeds, temp stays writable).
//
// The router selects the mode by env (see bash-router.ts): both are opt-in
// until real workflows (worker git, builds) have baked, then the default flips.
// SandboxManager is a process-global; its config comes from initialize(), so we
// re-initialize when the effective profile changes (rare — a worker is always
// its worktree, the maestro its repo) and serialize wraps through wrapQueue.

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
	SandboxManager,
	type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import {
	type BashOperations,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { ModeName } from "@vegardx/pi-contracts";
import type { BashActor } from "../bash-policy.js";
import {
	compileWriteProfile,
	type ProfilePaths,
	type WriteProfile,
	type WriteScope,
	writeScopeFor,
} from "./capability-grants.js";

/** Git-path resolvers (injected for testing; defaults shell out to `git`). */
export interface GitDeps {
	/** `git rev-parse --show-toplevel` — the repo checkout root. */
	readonly toplevel: (cwd: string) => string | undefined;
	/** `git rev-parse --git-common-dir` — the SHARED repo `.git` (worktrees share it). */
	readonly commonDir: (cwd: string) => string | undefined;
	/** `git rev-parse --git-dir` — THIS worktree's own git dir (`.git/worktrees/<name>`). */
	readonly gitDir: (cwd: string) => string | undefined;
}

function gitPath(cwd: string, arg: string): string | undefined {
	try {
		const out = execFileSync("git", ["-C", cwd, "rev-parse", arg], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (!out) return undefined;
		return isAbsolute(out) ? out : resolve(cwd, out);
	} catch {
		return undefined;
	}
}

/** Production git resolvers (shell out to `git rev-parse`). */
export const defaultGitDeps: GitDeps = {
	toplevel: (cwd) => gitPath(cwd, "--show-toplevel"),
	commonDir: (cwd) => gitPath(cwd, "--git-common-dir"),
	gitDir: (cwd) => gitPath(cwd, "--git-dir"),
};

/**
 * Resolve the concrete paths a profile needs for an actor at a cwd. A worker's
 * cwd IS its worktree; the maestro/reviewer see the repo root. The shared git
 * dir feeds the config/refs deny; the worktree's own git dir stays writable.
 */
export function resolveProfilePaths(
	actor: BashActor,
	cwd: string,
	scratch: readonly string[],
	git: GitDeps = defaultGitDeps,
): ProfilePaths {
	const repoRoot = git.toplevel(cwd) ?? cwd;
	const sharedGitDir = git.commonDir(cwd);
	if (actor === "worker") {
		return {
			worktree: cwd,
			repoRoot,
			...(git.gitDir(cwd) ? { worktreeGitDir: git.gitDir(cwd) } : {}),
			...(sharedGitDir ? { sharedGitDir } : {}),
			scratch,
		};
	}
	return {
		repoRoot,
		...(sharedGitDir ? { sharedGitDir } : {}),
		scratch,
	};
}

/** The profile that WOULD apply to an actor's command at a cwd. */
export function selectProfile(
	actor: BashActor,
	mode: ModeName,
	cwd: string,
	scratch: readonly string[],
	git: GitDeps = defaultGitDeps,
): { scope: WriteScope; profile: WriteProfile; paths: ProfilePaths } {
	const scope = writeScopeFor(actor, mode);
	const paths = resolveProfilePaths(actor, cwd, scratch, git);
	return { scope, profile: compileWriteProfile(scope, paths), paths };
}

/** A per-process private scratch (writes always allowed here, never the repo). */
export function defaultScratch(): readonly string[] {
	// The child's HOME/TMPDIR already point at private dirs under the agent dir;
	// this is the coarse default when nothing more specific is provided.
	return [process.env.TMPDIR ?? "/tmp", process.env.HOME ?? homedir()];
}

export interface ShadowOptions {
	readonly actor: BashActor;
	readonly mode: ModeName;
	readonly scratch?: readonly string[];
	readonly git?: GitDeps;
	/** Where a would-apply profile line is written (a file appender / logger). */
	readonly log: (line: string) => void;
}

/**
 * Wrap a base BashOperations so that, per command, it LOGS the per-actor write
 * profile it would enforce and then runs the command unchanged (unsandboxed).
 * Report-only: nothing is blocked. This is plan step 0 (shadow).
 */
export function createShadowBashOperations(
	base: BashOperations,
	opts: ShadowOptions,
): BashOperations {
	const scratch = opts.scratch ?? defaultScratch();
	const git = opts.git ?? defaultGitDeps;
	return {
		exec: (command, cwd, options) => {
			try {
				const { scope, profile } = selectProfile(
					opts.actor,
					opts.mode,
					cwd,
					scratch,
					git,
				);
				opts.log(
					`[sandbox-shadow] actor=${opts.actor} mode=${opts.mode} scope=${scope} ` +
						`cwd=${cwd} allowWrite=[${profile.allowWrite.join(" ")}] ` +
						`denyWrite=[${profile.denyWrite.join(" ")}] ` +
						`unrestricted=${profile.unrestricted} cmd=${command.slice(0, 300)}`,
				);
			} catch {
				// Shadow logging must never affect execution.
			}
			return base.exec(command, cwd, options);
		},
	};
}

// ─── Enforce ─────────────────────────────────────────────────────────────────

/** Wrap a command under a write profile; returns the sandboxed command string. */
export type SandboxWrap = (
	command: string,
	profile: WriteProfile,
	signal?: AbortSignal,
) => Promise<string>;

export interface EnforceOptions {
	readonly actor: BashActor;
	readonly mode: ModeName;
	readonly scratch?: readonly string[];
	readonly git?: GitDeps;
	/** Wrap a command under the profile (default: {@link defaultSandboxWrap}). */
	readonly wrap: SandboxWrap;
}

/**
 * Wrap a base BashOperations so each command runs under the actor's write
 * profile, enforced by the OS. An `unrestricted` (host / hack) profile runs the
 * command unwrapped; every other scope confines writes to the profile's
 * `allowWrite` — a bash-classifier miss then stops being an escape.
 */
export function createEnforcingBashOperations(
	base: BashOperations,
	opts: EnforceOptions,
): BashOperations {
	const scratch = opts.scratch ?? defaultScratch();
	const git = opts.git ?? defaultGitDeps;
	return {
		exec: async (command, cwd, options) => {
			const { profile } = selectProfile(
				opts.actor,
				opts.mode,
				cwd,
				scratch,
				git,
			);
			if (profile.unrestricted) return base.exec(command, cwd, options);
			const wrapped = await opts.wrap(command, profile, options.signal);
			return base.exec(wrapped, cwd, options);
		},
	};
}

/** Named secrets withheld from reads (mutation is the concern, not reading). */
function secretDenyRead(): string[] {
	const home = homedir();
	return [
		resolve(home, ".ssh"),
		resolve(home, ".aws"),
		resolve(home, ".config", "gcloud"),
		resolve(home, ".kube"),
		resolve(home, ".docker"),
		resolve(getAgentDir()),
	];
}

function configFor(profile: WriteProfile): SandboxRuntimeConfig {
	return {
		network: {
			allowedDomains: [],
			deniedDomains: ["*"],
			allowUnixSockets: [],
			allowAllUnixSockets: false,
			allowLocalBinding: false,
		},
		filesystem: {
			denyRead: secretDenyRead(),
			allowWrite: [...profile.allowWrite],
			denyWrite: [...profile.denyWrite],
			allowGitConfig: false,
		},
		enableWeakerNestedSandbox: false,
		allowPty: false,
	};
}

function platformName(): "macos" | "linux" | "windows" {
	return process.platform === "darwin"
		? "macos"
		: process.platform === "linux"
			? "linux"
			: "windows";
}

// The SandboxManager is a process-global: the config comes from initialize(),
// NOT from per-command customConfig (a customConfig override does NOT actually
// confine writes — verified live). So we (re)initialize whenever the effective
// profile changes and wrap without a customConfig, mirroring the lightweight
// backend. Serialized through wrapQueue. Per process the profile is stable
// (a worker is always its worktree; the maestro its repo), so this re-inits
// rarely.
let currentConfigKey: string | undefined;
let wrapQueue: Promise<void> = Promise.resolve();

/**
 * The production wrap: confine writes to the profile via @anthropic-ai/
 * sandbox-runtime on the real tree. On a platform that can't sandbox, returns
 * the command unwrapped (no worse than today's unsandboxed `direct`).
 */
export const defaultSandboxWrap: SandboxWrap = async (
	command,
	profile,
	signal,
) => {
	if (!SandboxManager.isSupportedPlatform(platformName())) return command;
	const key = JSON.stringify({
		allow: [...profile.allowWrite].sort(),
		deny: [...profile.denyWrite].sort(),
	});
	const run = wrapQueue.then(async () => {
		if (currentConfigKey !== key) {
			await SandboxManager.reset();
			await SandboxManager.initialize(
				configFor(profile),
				async () => false,
				false,
			);
			currentConfigKey = key;
		}
		return SandboxManager.wrapWithSandbox(command, "bash", undefined, signal);
	});
	wrapQueue = run.then(
		() => {},
		() => {},
	);
	return run;
};

/** Reset the sandbox (session lifecycle); safe to call when uninitialized. */
export async function resetRealTreeSandbox(): Promise<void> {
	currentConfigKey = undefined;
	wrapQueue = Promise.resolve();
	try {
		await SandboxManager.reset();
	} catch {
		// reset on an uninitialized/failed manager is a no-op
	}
}
