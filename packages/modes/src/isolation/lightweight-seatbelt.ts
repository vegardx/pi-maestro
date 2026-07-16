import { type ChildProcess, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	SandboxManager,
	type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
	type IsolationBackend,
	type IsolationBackendStatus,
	IsolationUnavailableError,
} from "./backend.js";
import {
	type ResearchWorkspace,
	ResearchWorkspaceManager,
} from "./workspace.js";

const CONTROL_ENV =
	/^(?:PI_MAESTRO_|TMUX(?:_|$)|SSH_AUTH_SOCK$|GPG_AGENT_INFO$)/u;
const SECRET_ENV =
	/(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|COOKIE|AUTH$)/iu;
const SAFE_ENV =
	/^(?:PATH|LANG|LC_[A-Z_]+|TERM|COLORTERM|CI|NO_COLOR|FORCE_COLOR|SHELL|EDITOR|VISUAL|TZ|NODE_OPTIONS)$/u;

export interface SandboxRuntimeAdapter {
	isSupportedPlatform(platform: NodeJS.Platform): boolean;
	initialize(
		config: SandboxRuntimeConfig,
		allowNetwork: (request: {
			host: string;
			port?: number;
		}) => Promise<boolean>,
	): Promise<void>;
	wrap(
		command: string,
		signal?: AbortSignal,
		privateTmp?: string,
	): Promise<string>;
	reset(): Promise<void>;
}

let productionWrapQueue: Promise<void> = Promise.resolve();

const productionRuntime: SandboxRuntimeAdapter = {
	isSupportedPlatform: (platform) =>
		SandboxManager.isSupportedPlatform(
			platform === "darwin"
				? "macos"
				: platform === "linux"
					? "linux"
					: "windows",
		),
	initialize: (config, allowNetwork) =>
		SandboxManager.initialize(config, allowNetwork, false),
	wrap: (command, signal, privateTmp) => {
		const run = productionWrapQueue.then(async () => {
			// sandbox-runtime derives policy and an injected TMPDIR from controller
			// globals. Point both at the private epoch while compiling the profile;
			// otherwise its compatibility default broadens writes under host /tmp.
			const previousTmp = process.env.TMPDIR;
			const previousClaudeTmp = process.env.CLAUDE_TMPDIR;
			if (privateTmp) {
				process.env.TMPDIR = privateTmp;
				process.env.CLAUDE_TMPDIR = privateTmp;
			}
			try {
				return await SandboxManager.wrapWithSandbox(
					command,
					"bash",
					undefined,
					signal,
				);
			} finally {
				if (previousTmp === undefined) delete process.env.TMPDIR;
				else process.env.TMPDIR = previousTmp;
				if (previousClaudeTmp === undefined) delete process.env.CLAUDE_TMPDIR;
				else process.env.CLAUDE_TMPDIR = previousClaudeTmp;
			}
		});
		productionWrapQueue = run.then(
			() => {},
			() => {},
		);
		return run;
	},
	reset: () => SandboxManager.reset(),
};

export interface LightweightSeatbeltOptions {
	readonly runtime?: SandboxRuntimeAdapter;
	readonly workspaces?: ResearchWorkspaceManager;
	readonly platform?: NodeJS.Platform;
	readonly sourceRoot?: (cwd: string) => Promise<string>;
	readonly spawnProcess?: typeof spawn;
	readonly baseEnv?: NodeJS.ProcessEnv;
}

/**
 * Lightweight is a Seatbelt/bubblewrap accident-prevention boundary, not a VM
 * and not adversarial-code isolation. Host reads remain broadly compatible;
 * writes are confined to a controller-owned private workspace. Network is
 * proxy-mediated and generally allowed, while localhost/private endpoints and
 * Unix control sockets remain unavailable.
 */
export class LightweightSeatbeltBackend implements IsolationBackend {
	readonly tier = "lightweight" as const;
	private readonly runtime: SandboxRuntimeAdapter;
	private readonly workspaces: ResearchWorkspaceManager;
	private readonly platform: NodeJS.Platform;
	private readonly spawnProcess: typeof spawn;
	private state: IsolationBackendStatus["state"] = "idle";
	private error: string | undefined;
	private initializedWorkspace: string | undefined;
	private sourceRoot: string | undefined;
	private generation = 0;
	private readonly children = new Set<ChildProcess>();

	constructor(private readonly opts: LightweightSeatbeltOptions = {}) {
		this.runtime = opts.runtime ?? productionRuntime;
		this.workspaces = opts.workspaces ?? new ResearchWorkspaceManager();
		this.platform = opts.platform ?? process.platform;
		this.spawnProcess = opts.spawnProcess ?? spawn;
	}

	status(): IsolationBackendStatus {
		const workspace = this.workspaces.current();
		const supported = this.runtime.isSupportedPlatform(this.platform);
		return {
			tier: this.tier,
			state: this.state,
			supported,
			workspace: workspace?.root,
			detail: supported
				? "Lightweight process-policy isolation; broad host reads and network compatibility, private-workspace writes only."
				: `Lightweight isolation is unavailable on ${this.platform}.`,
			...(this.error ? { error: this.error } : {}),
		};
	}

	operations(sourceCwd: string): BashOperations {
		return {
			exec: (command, _cwd, options) => this.exec(command, sourceCwd, options),
		};
	}

	async reset(sourceRoot?: string): Promise<void> {
		this.generation += 1;
		this.state = "idle";
		this.error = undefined;
		this.initializedWorkspace = undefined;
		this.sourceRoot = sourceRoot;
		this.killAll("SIGKILL");
		await Promise.allSettled([this.runtime.reset(), this.workspaces.reset()]);
	}

	async destroy(): Promise<void> {
		this.generation += 1;
		this.state = "destroyed";
		this.killAll("SIGKILL");
		await Promise.allSettled([this.runtime.reset(), this.workspaces.reset()]);
		this.initializedWorkspace = undefined;
	}

	private async exec(
		command: string,
		sourceCwd: string,
		options: Parameters<BashOperations["exec"]>[2],
	): Promise<{ exitCode: number | null }> {
		const epoch = this.generation;
		let workspace: ResearchWorkspace;
		try {
			workspace = await this.prepare(sourceCwd);
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			this.state = "failed";
			this.error = message;
			throw new IsolationUnavailableError(
				this.tier,
				`Lightweight isolation could not prepare a private research workspace: ${message}`,
				cause,
			);
		}
		if (epoch !== this.generation)
			throw new IsolationUnavailableError(
				this.tier,
				"Research epoch ended during sandbox preparation",
			);

		const targetCwd = mapWorkspaceCwd(workspace, await realpath(sourceCwd));
		let wrapped: string;
		try {
			wrapped = await this.runtime.wrap(command, options.signal, workspace.tmp);
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			this.state = "failed";
			this.error = message;
			throw new IsolationUnavailableError(
				this.tier,
				`Lightweight isolation failed before command execution: ${message}`,
				cause,
			);
		}
		return this.spawnWrapped(wrapped, targetCwd, workspace, options);
	}

	private async prepare(sourceCwd: string): Promise<ResearchWorkspace> {
		if (!this.runtime.isSupportedPlatform(this.platform))
			throw new Error(`sandbox-runtime does not support ${this.platform}`);
		this.state = "preparing";
		const sourceRoot =
			this.sourceRoot ??
			(await (this.opts.sourceRoot ?? resolveGitRoot)(sourceCwd));
		const workspace = await this.workspaces.ensure(sourceRoot);
		if (this.initializedWorkspace !== workspace.root) {
			await this.runtime.reset();
			await this.runtime.initialize(
				seatbeltConfig(workspace, sourceRoot),
				async ({ host }) => networkDestinationAllowed(host),
			);
			this.initializedWorkspace = workspace.root;
		}
		this.state = "ready";
		this.error = undefined;
		return workspace;
	}

	private spawnWrapped(
		wrapped: string,
		cwd: string,
		workspace: ResearchWorkspace,
		options: Parameters<BashOperations["exec"]>[2],
	): Promise<{ exitCode: number | null }> {
		return new Promise((resolveExec, reject) => {
			const child = this.spawnProcess("bash", ["-c", wrapped], {
				cwd,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: createResearchEnvironment(
					this.opts.baseEnv ?? process.env,
					options.env,
					workspace,
				),
			});
			this.children.add(child);
			let settled = false;
			let timedOut = false;
			let timer: NodeJS.Timeout | undefined;
			let forceTimer: NodeJS.Timeout | undefined;
			const finish = (error?: Error, code: number | null = null) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				if (forceTimer) clearTimeout(forceTimer);
				options.signal?.removeEventListener("abort", abort);
				this.children.delete(child);
				if (error) reject(error);
				else resolveExec({ exitCode: code });
			};
			const terminate = () => {
				killProcessGroup(child, "SIGTERM");
				forceTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), 500);
				forceTimer.unref?.();
			};
			const abort = () => terminate();
			if (options.signal?.aborted) abort();
			else options.signal?.addEventListener("abort", abort, { once: true });
			if (options.timeout !== undefined && options.timeout > 0) {
				timer = setTimeout(() => {
					timedOut = true;
					terminate();
				}, options.timeout * 1_000);
				timer.unref?.();
			}
			child.stdout?.on("data", options.onData);
			child.stderr?.on("data", options.onData);
			child.once("error", (error) => finish(error));
			child.once("close", (code) => {
				if (options.signal?.aborted) finish(new Error("aborted"));
				else if (timedOut) finish(new Error(`timeout:${options.timeout}`));
				else finish(undefined, code);
			});
		});
	}

	private killAll(signal: NodeJS.Signals): void {
		for (const child of this.children) killProcessGroup(child, signal);
		this.children.clear();
	}
}

export function seatbeltConfig(
	workspace: ResearchWorkspace,
	sourceRoot: string,
): SandboxRuntimeConfig {
	const hostHome = homedir();
	return {
		network: {
			// A sentinel starts proxy mediation; the callback authorizes ordinary
			// external destinations and rejects local/control endpoints.
			allowedDomains: ["network-probe.invalid"],
			deniedDomains: [],
			allowUnixSockets: [],
			allowAllUnixSockets: false,
			allowLocalBinding: false,
		},
		filesystem: {
			// Lightweight intentionally keeps broad reads for developer-tool
			// compatibility. Known credentials and control state are unreadable.
			denyRead: [
				resolve(hostHome, ".ssh"),
				resolve(hostHome, ".aws"),
				resolve(hostHome, ".gnupg"),
				resolve(hostHome, ".config", "gcloud"),
				resolve(hostHome, ".kube"),
				resolve(hostHome, ".docker"),
				resolve(hostHome, ".pi", "agent", "auth.json"),
			],
			allowWrite: [
				workspace.root,
				workspace.home,
				workspace.tmp,
				workspace.cache,
			],
			denyWrite: [
				sourceRoot,
				"/tmp/claude",
				"/private/tmp/claude",
				resolve(hostHome, ".npm", "_logs"),
				resolve(hostHome, ".claude", "debug"),
			],
			allowGitConfig: false,
		},
		enableWeakerNestedSandbox: false,
		allowPty: false,
	};
}

export function createResearchEnvironment(
	base: NodeJS.ProcessEnv,
	requested: NodeJS.ProcessEnv | undefined,
	workspace: ResearchWorkspace,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	// The Pi tool supplies a resolved shell environment. It is authoritative;
	// falling back to the controller environment is only for direct adapter use.
	const sources = requested ? [requested] : [base];
	for (const source of sources) {
		for (const [key, value] of Object.entries(source)) {
			if (
				value !== undefined &&
				SAFE_ENV.test(key) &&
				!CONTROL_ENV.test(key) &&
				!SECRET_ENV.test(key)
			)
				env[key] = value;
		}
	}
	return {
		...env,
		HOME: workspace.home,
		TMPDIR: workspace.tmp,
		TMP: workspace.tmp,
		TEMP: workspace.tmp,
		XDG_CACHE_HOME: workspace.cache,
		XDG_CONFIG_HOME: resolve(workspace.home, ".config"),
		XDG_DATA_HOME: resolve(workspace.home, ".local", "share"),
		NPM_CONFIG_CACHE: resolve(workspace.cache, "npm"),
		YARN_CACHE_FOLDER: resolve(workspace.cache, "yarn"),
		PNPM_HOME: resolve(workspace.home, ".local", "share", "pnpm"),
		GIT_TERMINAL_PROMPT: "0",
		GH_PROMPT_DISABLED: "1",
		PAGER: "cat",
		GIT_PAGER: "cat",
		MAESTRO_RESEARCH_ISOLATION: "lightweight",
	};
}

export function networkDestinationAllowed(host: string): boolean {
	const normalized = host.toLowerCase().replace(/^\[|\]$/gu, "");
	if (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		normalized === "0.0.0.0" ||
		normalized === "::" ||
		normalized === "::1" ||
		normalized.startsWith("127.") ||
		normalized.startsWith("169.254.") ||
		normalized.startsWith("10.") ||
		normalized.startsWith("192.168.")
	)
		return false;
	const octets = normalized.split(".").map(Number);
	if (octets.length === 4 && octets.every(Number.isFinite)) {
		if (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31)
			return false;
	}
	return true;
}

function mapWorkspaceCwd(
	workspace: ResearchWorkspace,
	sourceCwd: string,
): string {
	const rel = relative(workspace.sourceRoot, resolve(sourceCwd));
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		throw new Error(
			`Command cwd is outside the research source root: ${sourceCwd}`,
		);
	return resolve(workspace.root, rel);
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (!child.pid) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// Process already exited.
		}
	}
}

async function resolveGitRoot(cwd: string): Promise<string> {
	return new Promise((resolveRoot, reject) => {
		const child = spawn("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0)
				resolveRoot(Buffer.concat(stdout).toString("utf8").trim());
			else
				reject(
					new Error(
						Buffer.concat(stderr).toString("utf8").trim() ||
							"Not inside a Git repository",
					),
				);
		});
	});
}
