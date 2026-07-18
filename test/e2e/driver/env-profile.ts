// Environment profiles: everything the SUT needs to run, minus the driver.
//
// Two profiles decouple the brittle external dependencies (models, GitHub) while
// keeping pi/RPC/workers/ship real:
//   • Live — real models + a disposable GitHub repo. The acceptance run.
//   • CI   — a mock model provider + a local bare remote + a `gh` shim, so the
//            whole stack runs deterministically offline. (The cassette server
//            and `gh` shim binaries are provided by the Phase 4 CI harness and
//            passed in here; this module wires them.)
//
// Both use an isolated pi HOME so plan state never touches the developer's
// `~/.pi`, and both default the worker transport to `headless` — headless spawns
// workers as child processes that inherit this env directly, so the mock
// provider / PATH shim reach every worker without any tmux env-propagation.

import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface EnvProfile {
	/** Working directory for the maestro (the repo under test). */
	readonly repoDir: string;
	/** Isolated pi HOME (holds .pi/agent/{settings,auth}.json, sessions, plans). */
	readonly piHome: string;
	/** Extra env for `launchSut` (transport, PATH shim, mock provider URL). */
	readonly env: Record<string, string>;
	/** Extra `-e` extension paths the maestro should load (e.g. mock provider). */
	readonly extraExtensions: string[];
	/** Optional model pattern to pass as --model. */
	readonly model?: string;
	/** Tears everything down (deletes dirs; deletes the disposable repo if live). */
	readonly teardown: () => void;
}

const GIT_IDENT = [
	"-c",
	"user.email=e2e@pi-maestro.test",
	"-c",
	"user.name=pi-maestro e2e",
];

function git(cwd: string, args: string[]): string {
	return execFileSync("git", [...GIT_IDENT, ...args], {
		cwd,
		encoding: "utf8",
	});
}

/** A minimal npm repo the workers can actually build/test against. */
function seedRepo(repoDir: string): void {
	writeFileSync(
		join(repoDir, "README.md"),
		"# pi-maestro e2e sandbox\n\nDisposable repo driven end to end by the maestro.\n",
	);
	writeFileSync(
		join(repoDir, "package.json"),
		`${JSON.stringify(
			{
				name: "pi-maestro-e2e-sandbox",
				version: "0.0.0",
				private: true,
				type: "module",
				scripts: { test: "node --test" },
			},
			null,
			2,
		)}\n`,
	);
	mkdirSync(join(repoDir, "src"), { recursive: true });
	mkdirSync(join(repoDir, "tests"), { recursive: true });
	git(repoDir, ["init", "-q", "-b", "main"]);
	git(repoDir, ["add", "."]);
	git(repoDir, ["commit", "-qm", "chore: bootstrap e2e sandbox"]);
}

function isolatedHome(): string {
	const piHome = mkdtempSync(join(tmpdir(), "pi-e2e-home-"));
	mkdirSync(join(piHome, ".pi", "agent"), { recursive: true });
	mkdirSync(join(piHome, "sessions"), { recursive: true });
	return piHome;
}

function agentDir(piHome: string): string {
	return join(piHome, ".pi", "agent");
}

/** Write `<piHome>/.pi/agent/settings.json` merging in the given slices. */
function writeSettings(piHome: string, extensionConfig: object): void {
	writeFileSync(
		join(agentDir(piHome), "settings.json"),
		`${JSON.stringify({ extensionConfig }, null, 2)}\n`,
	);
}

// --- Live profile ----------------------------------------------------------

export interface LiveEnvOptions {
	/** Worker transport; defaults to "headless" (works without a tmux server). */
	readonly transport?: "tmux" | "headless";
	/** Model pattern (--model); omit to use the copied profile's default. */
	readonly model?: string;
	/** Skip creating a GitHub repo; use a local bare remote instead (offline live). */
	readonly localRemote?: boolean;
	/**
	 * Provider extensions the maestro must load so its default provider resolves
	 * (e.g. a custom-provider extension). Workers pick these up from the written
	 * settings' `modes.childExtensions`.
	 */
	readonly providerExtensions?: string[];
	/**
	 * A models.json to install into the isolated agent dir (defines providers for
	 * the maestro AND every worker, since they share the pinned agent dir). Use
	 * for a self-contained provider like a local ollama endpoint.
	 */
	readonly agentModelsJson?: string;
	/** Default provider written to the isolated settings.json. */
	readonly defaultProvider?: string;
	/** Default model written to the isolated settings.json (and every worker). */
	readonly defaultModel?: string;
	/** Keep the disposable repo + dirs after teardown (for debugging). */
	readonly keep?: boolean;
}

/**
 * Real models + real ship. Copies the developer's real pi credentials into the
 * isolated home so provider auth works, then either creates a disposable private
 * GitHub repo (default) or a local bare remote (`localRemote`).
 */
export function setupLiveEnv(opts: LiveEnvOptions = {}): EnvProfile {
	const piHome = isolatedHome();
	copyRealCredentials(piHome);
	if (opts.agentModelsJson) {
		copyFileSync(opts.agentModelsJson, join(agentDir(piHome), "models.json"));
	}
	if (opts.defaultProvider || opts.defaultModel) {
		writeAgentSettings(piHome, opts.defaultProvider, opts.defaultModel);
	}
	const transport = opts.transport ?? "headless";

	let repoDir: string;
	let deleteRepo: (() => void) | undefined;
	let bareRemote: string | undefined;
	if (opts.localRemote) {
		repoDir = mkdtempSync(join(tmpdir(), "pi-e2e-repo-"));
		seedRepo(repoDir);
		bareRemote = attachLocalBareRemote(repoDir);
	} else {
		const created = createDisposableGithubRepo();
		repoDir = created.repoDir;
		deleteRepo = created.deleteRepo;
	}

	return {
		repoDir,
		piHome,
		extraExtensions: opts.providerExtensions ?? [],
		env: { PI_MAESTRO_TRANSPORT: transport },
		model: opts.model,
		teardown: () => {
			if (opts.keep) return;
			deleteRepo?.();
			for (const dir of [piHome, repoDir, bareRemote]) {
				if (dir) rmSync(dir, { recursive: true, force: true });
			}
		},
	};
}

/** The host's real pi agent dir: PI_CODING_AGENT_DIR, else ~/.pi/agent. */
function realAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * Copy the host's provider stack into the isolated home so real model calls
 * work: credentials, model catalog, and settings (which carry the default
 * provider/model and the workers' `modes.childExtensions`).
 */
function copyRealCredentials(piHome: string): void {
	const realAgent = realAgentDir();
	// NB: settings.json is deliberately NOT copied — it carries the host's
	// `modes.childExtensions`, whose provider extensions may be built for a
	// different pi version and would crash every worker on load. The isolated
	// default provider/model is written explicitly via writeAgentSettings.
	for (const file of ["auth.json", "models.json", "models-store.json"]) {
		const src = join(realAgent, file);
		if (existsSync(src)) copyFileSync(src, join(agentDir(piHome), file));
	}
}

/** Write a minimal isolated settings.json pinning the default provider/model. */
function writeAgentSettings(
	piHome: string,
	defaultProvider?: string,
	defaultModel?: string,
): void {
	const settings: Record<string, unknown> = {
		extensionConfig: { modes: { enabled: true } },
	};
	if (defaultProvider) settings.defaultProvider = defaultProvider;
	if (defaultModel) settings.defaultModel = defaultModel;
	writeFileSync(
		join(agentDir(piHome), "settings.json"),
		`${JSON.stringify(settings, null, 2)}\n`,
	);
}

/** Create a private disposable repo under the logged-in gh user and clone it. */
function createDisposableGithubRepo(): {
	repoDir: string;
	deleteRepo: () => void;
} {
	const owner = execFileSync("gh", ["api", "user", "-q", ".login"], {
		encoding: "utf8",
	}).trim();
	// Uniqueness without Date.now()/random (unavailable in some contexts): use
	// the short git sha of the current HEAD plus the pid.
	const suffix = `${process.pid.toString(36)}${execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim()}`;
	const slug = `pi-maestro-e2e-${suffix}`;
	const parent = mkdtempSync(join(tmpdir(), "pi-e2e-clone-"));
	const repoDir = join(parent, slug);
	// `--clone` takes no path arg; it clones into <cwd>/<repo>. Run from parent.
	execFileSync(
		"gh",
		[
			"repo",
			"create",
			`${owner}/${slug}`,
			"--private",
			"--add-readme",
			"--clone",
		],
		{ stdio: "inherit", cwd: parent },
	);
	return {
		repoDir,
		deleteRepo: () => {
			try {
				execFileSync("gh", ["repo", "delete", `${owner}/${slug}`, "--yes"], {
					stdio: "inherit",
				});
			} catch {
				// Best-effort; a leaked private repo is preferable to a crashed teardown.
			}
			rmSync(parent, { recursive: true, force: true });
		},
	};
}

/** Point `origin` at a fresh local bare repo so `git push` works offline. */
function attachLocalBareRemote(repoDir: string): string {
	const bare = mkdtempSync(join(tmpdir(), "pi-e2e-remote-"));
	execFileSync("git", ["init", "-q", "--bare", bare]);
	git(repoDir, ["remote", "add", "origin", bare]);
	git(repoDir, ["push", "-q", "origin", "main"]);
	return bare;
}

// --- CI profile ------------------------------------------------------------

export interface CiEnvOptions {
	/** Absolute path to the mock-provider extension (Phase 4 artifact). */
	readonly mockProviderExtension: string;
	/** Base URL of the running cassette server (Phase 4 artifact). */
	readonly mockBaseUrl: string;
	/** Directory containing the `gh` shim executable (Phase 4 artifact). */
	readonly ghShimDir: string;
	/** Keep dirs after teardown (for debugging). */
	readonly keep?: boolean;
}

/**
 * Deterministic offline profile: a mock model provider (registered in both the
 * maestro and, via childExtensions, every worker), a local bare remote, and a
 * `gh` shim on PATH. Uses headless transport so all of this env reaches workers.
 */
export function setupCiEnv(opts: CiEnvOptions): EnvProfile {
	const piHome = isolatedHome();
	// The mock provider needs a (dummy) key so the provider resolves at all.
	writeFileSync(
		join(agentDir(piHome), "auth.json"),
		`${JSON.stringify({ anthropic: { key: "e2e-mock-key" } }, null, 2)}\n`,
	);
	// Workers run `-ne`; childExtensions is the one seam that re-injects the mock
	// provider into every spawned worker.
	writeSettings(piHome, {
		modes: { childExtensions: [opts.mockProviderExtension] },
	});

	const repoDir = mkdtempSync(join(tmpdir(), "pi-e2e-repo-"));
	seedRepo(repoDir);
	const bareRemote = attachLocalBareRemote(repoDir);
	const ghState = mkdtempSync(join(tmpdir(), "pi-e2e-gh-"));

	return {
		repoDir,
		piHome,
		extraExtensions: [opts.mockProviderExtension],
		env: {
			PI_MAESTRO_TRANSPORT: "headless",
			PI_E2E_MOCK_URL: opts.mockBaseUrl,
			PI_E2E_GH_STATE: ghState,
			PATH: `${opts.ghShimDir}:${process.env.PATH ?? ""}`,
		},
		teardown: () => {
			if (opts.keep) return;
			for (const dir of [piHome, repoDir, bareRemote, ghState]) {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	};
}
