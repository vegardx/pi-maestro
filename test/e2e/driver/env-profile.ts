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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the developer really keeps checkouts for a GitHub owner. Override with
 * PI_E2E_CHECKOUT_ROOT; defaults to the layout this repo itself lives in.
 */
export function checkoutRoot(owner: string): string {
	return (
		process.env.PI_E2E_CHECKOUT_ROOT ??
		join(homedir(), "src", "github.com", owner)
	);
}

/** The bundled `gh` shim (CI Phase 4 artifact) — generic over any bare origin. */
function ghShimDir(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "ci", "gh-shim");
}

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

/**
 * The scaffolding every drive starts from: a runner the agents can actually
 * invoke, and the directories the scenario expects. Node 24 strips TypeScript
 * natively, so `node --test` runs the scenario's `.ts` test files directly.
 *
 * Without this the planner finds a bare repo, correctly concludes there is no
 * toolchain, and adds a bootstrap deliverable — so the scenario's three
 * expected deliverables no longer describe what gets built.
 */
function writeSeedFiles(repoDir: string): void {
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
}

/** Seed a repo that does not exist yet (local-remote and CI paths). */
function seedRepo(repoDir: string): void {
	writeSeedFiles(repoDir);
	git(repoDir, ["init", "-q", "-b", "main"]);
	git(repoDir, ["add", "."]);
	git(repoDir, ["commit", "-qm", "chore: bootstrap e2e sandbox"]);
}

/**
 * Seed a repo that already exists as a clone (the real-GitHub path).
 *
 * Deliberately NOT {@link seedRepo}: that one runs `git init`, which would
 * re-init an existing clone, and it never pushes — so agents would see the
 * scaffolding locally while `origin` still held only the README, and the first
 * PR's diff would contain the seed.
 */
function seedClonedRepo(repoDir: string): void {
	writeSeedFiles(repoDir);
	git(repoDir, ["add", "."]);
	git(repoDir, ["commit", "-qm", "chore: bootstrap e2e sandbox"]);
	git(repoDir, ["push", "-q", "origin", "HEAD"]);
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
	 * Provider credentials to write into the isolated auth.json INSTEAD of
	 * copying the developer's. With this set the drive runs on a credential the
	 * driver owns and nothing of the developer's reaches the sandbox — the
	 * point of the Copilot path.
	 */
	readonly isolatedAuth?: Record<string, unknown>;
	/**
	 * A models.json to install into the isolated agent dir (defines providers for
	 * the maestro AND every worker, since they share the pinned agent dir). Use
	 * for a self-contained provider like a local ollama endpoint.
	 */
	readonly agentModelsJson?: string;
	/**
	 * models.json *content* to install into the isolated agent dir (same effect as
	 * `agentModelsJson` but inline; takes precedence). Used by the built-in
	 * multi-model profile, which generates its catalog rather than shipping a file.
	 */
	readonly modelsJsonContent?: string;
	/** Default provider written to the isolated settings.json. */
	readonly defaultProvider?: string;
	/** Default model written to the isolated settings.json (and every worker). */
	readonly defaultModel?: string;
	/**
	 * Seat thinking level (`defaultThinkingLevel`). The seat effort every
	 * inherited node runs at — set it when the drive wants the maestro reasoning
	 * harder (or cheaper) than pi's built-in default.
	 */
	readonly defaultThinkingLevel?: string;
	/**
	 * A `models` settings block (presets + modelSets) written top-level into the
	 * isolated settings.json — the maestro and every worker read it, so real
	 * role→model routing is exercised. See `MULTI_MODEL_OLLAMA`.
	 */
	readonly models?: Record<string, unknown>;
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
	if (opts.isolatedAuth) {
		writeFileSync(
			join(agentDir(piHome), "auth.json"),
			`${JSON.stringify(opts.isolatedAuth, null, 2)}\n`,
			{ mode: 0o600 },
		);
	} else {
		copyRealCredentials(piHome);
	}
	if (opts.modelsJsonContent) {
		writeFileSync(
			join(agentDir(piHome), "models.json"),
			opts.modelsJsonContent,
		);
	} else if (opts.agentModelsJson) {
		copyFileSync(opts.agentModelsJson, join(agentDir(piHome), "models.json"));
	}
	if (
		opts.defaultProvider ||
		opts.defaultModel ||
		opts.models ||
		opts.defaultThinkingLevel
	) {
		writeAgentSettings(piHome, {
			defaultProvider: opts.defaultProvider,
			defaultModel: opts.defaultModel,
			defaultThinkingLevel: opts.defaultThinkingLevel,
			models: opts.models,
		});
	}
	const transport = opts.transport ?? "headless";

	let repoDir: string;
	let deleteRepo: (() => void) | undefined;
	let bareRemote: string | undefined;
	let ghState: string | undefined;
	const env: Record<string, string> = { PI_MAESTRO_TRANSPORT: transport };
	if (opts.localRemote) {
		repoDir = mkdtempSync(join(tmpdir(), "pi-e2e-repo-"));
		seedRepo(repoDir);
		bareRemote = attachLocalBareRemote(repoDir);
		// The ship path shells out to `gh` (pr create/view/…). Offline, that
		// must hit the bundled shim, backed by the bare remote — without it
		// every live --local-remote drive ends `pr-failed` (drive 4's finding).
		ghState = mkdtempSync(join(tmpdir(), "pi-e2e-gh-"));
		env.PI_E2E_GH_STATE = ghState;
		env.PATH = `${ghShimDir()}:${process.env.PATH ?? ""}`;
	} else {
		const created = createDisposableGithubRepo();
		repoDir = created.repoDir;
		deleteRepo = created.deleteRepo;
		// Same starting point as the local-remote path, pushed so `origin`
		// matches the working tree — otherwise the first PR diff carries it.
		seedClonedRepo(repoDir);
	}

	return {
		repoDir,
		piHome,
		extraExtensions: opts.providerExtensions ?? [],
		env,
		model: opts.model,
		teardown: () => {
			if (opts.keep) return;
			deleteRepo?.();
			for (const dir of [piHome, repoDir, bareRemote, ghState]) {
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
	opts: {
		defaultProvider?: string;
		defaultModel?: string;
		defaultThinkingLevel?: string;
		/** Top-level `models` block (presets + modelSets) for real role routing. */
		models?: Record<string, unknown>;
	},
): void {
	const settings: Record<string, unknown> = {
		extensionConfig: { modes: { enabled: true } },
	};
	if (opts.defaultProvider) settings.defaultProvider = opts.defaultProvider;
	if (opts.defaultModel) settings.defaultModel = opts.defaultModel;
	if (opts.defaultThinkingLevel)
		settings.defaultThinkingLevel = opts.defaultThinkingLevel;
	if (opts.models) settings.models = opts.models;
	writeFileSync(
		join(agentDir(piHome), "settings.json"),
		`${JSON.stringify(settings, null, 2)}\n`,
	);
}

/**
 * Create a private disposable repo under the logged-in gh user and clone it
 * into the developer's NORMAL checkout location (`~/src/github.com/<owner>/`),
 * not a temp dir.
 *
 * This is the point, not a convenience: git config is path-scoped. A developer
 * whose identity comes from `includeIf "gitdir:~/src/github.com/"` resolves NO
 * identity for a clone in /var/folders, so every worker spawn fails the
 * identity preflight — which is exactly how a drive stalled with three
 * deliverables stuck `active` and no processes running. Cloning where the repo
 * would really live makes the sandbox a faithful replica: the same includeIf,
 * the same credential helpers, the same everything. Only the pi agent dir and
 * plan store are temporary.
 */
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
	const parent = checkoutRoot(owner);
	mkdirSync(parent, { recursive: true });
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
			// The clone now lives in the developer's real checkout root, so remove
			// exactly what we created — the clone and its sibling worktrees dir —
			// and NEVER the parent, which holds their actual work.
			rmSync(repoDir, { recursive: true, force: true });
			rmSync(join(parent, "worktrees", slug), {
				recursive: true,
				force: true,
			});
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

/**
 * Internals exposed for tests. The two seeds differ in ways that fail
 * differently and silently — see seed-repo.test.ts.
 */
export const __testing = { seedRepo, seedClonedRepo, writeSeedFiles };
