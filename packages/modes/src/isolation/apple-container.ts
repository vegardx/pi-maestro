import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { release } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
	type IsolationBackend,
	type IsolationBackendStatus,
	IsolationUnavailableError,
} from "./backend.js";
import { createResearchEnvironment } from "./research-environment.js";
import {
	type ResearchWorkspace,
	ResearchWorkspaceManager,
} from "./workspace.js";

/**
 * The Strong image is deliberately immutable and arm64-specific. Updating it
 * is a reviewed controller change, never an action available to model Bash.
 */
export const APPLE_CONTAINER_RESEARCH_IMAGE =
	"docker.io/library/node@sha256:63c7334e154f369954e1d59c0299a4eb24f4f8e197d197fba8c7de259e69302b";
export const APPLE_CONTAINER_OWNER_LABEL = "io.pi-maestro.research";
const CONTAINER_PREFIX = "pi-maestro-research-";
const MIN_CONTAINER_VERSION = [0, 6, 0] as const;
const GUEST_WORKSPACE = "/workspace";

export interface AppleContainerCommandOptions {
	readonly onData?: (data: Buffer) => void;
	readonly signal?: AbortSignal;
	readonly timeout?: number;
	readonly env?: NodeJS.ProcessEnv;
}

export interface AppleContainerCommandResult {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** Injectable CLI boundary. Tests never need to launch a VM. */
export interface AppleContainerCommandRunner {
	run(
		args: readonly string[],
		options?: AppleContainerCommandOptions,
	): Promise<AppleContainerCommandResult>;
}

export interface AppleContainerProbe {
	readonly supported: boolean;
	readonly detail: string;
	readonly version?: string;
}

export interface AppleContainerStrongOptions {
	readonly runner?: AppleContainerCommandRunner;
	readonly workspaces?: ResearchWorkspaceManager;
	readonly platform?: NodeJS.Platform;
	readonly arch?: string;
	readonly macosVersion?: string;
	readonly image?: string;
	readonly sourceRoot?: (cwd: string) => Promise<string>;
	readonly baseEnv?: NodeJS.ProcessEnv;
	readonly now?: () => string;
}

/**
 * Apple container Strong isolation. A Recon→Plan epoch owns one Linux VM,
 * populated only through private snapshot copy-in. The host checkout, home,
 * credentials and control sockets are never mounted into the guest.
 */
export class AppleContainerStrongBackend implements IsolationBackend {
	readonly tier = "strong" as const;
	private readonly runner: AppleContainerCommandRunner;
	private readonly workspaces: ResearchWorkspaceManager;
	private readonly platform: NodeJS.Platform;
	private readonly arch: string;
	private readonly macosVersion: string;
	private readonly image: string;
	private state: IsolationBackendStatus["state"] = "idle";
	private error: string | undefined;
	private detail: string;
	private sourceRoot: string | undefined;
	private containerName: string | undefined;
	private generation = 0;
	private enabled = true;
	private preparing: Promise<PreparedContainer> | undefined;

	constructor(private readonly opts: AppleContainerStrongOptions = {}) {
		this.runner = opts.runner ?? new SpawnAppleContainerRunner();
		this.workspaces = opts.workspaces ?? new ResearchWorkspaceManager();
		this.platform = opts.platform ?? process.platform;
		this.arch = opts.arch ?? process.arch;
		this.macosVersion =
			opts.macosVersion ?? detectedMacosVersion(this.platform, release());
		this.image = opts.image ?? APPLE_CONTAINER_RESEARCH_IMAGE;
		this.detail = platformReason(this.platform, this.arch, this.macosVersion);
	}

	status(): IsolationBackendStatus {
		const platformSupported = platformCompatible(
			this.platform,
			this.arch,
			this.macosVersion,
		);
		return {
			tier: this.tier,
			state: this.state,
			supported: platformSupported && this.state !== "failed",
			workspace: this.workspaces.current()?.root,
			detail: this.detail,
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
		this.enabled = false;
		const preparing = this.preparing;
		await preparing?.catch(() => undefined);
		await Promise.allSettled([
			this.cleanupContainer(),
			this.workspaces.reset(),
		]);
		this.enabled = true;
		this.state = "idle";
		this.error = undefined;
		this.detail = platformReason(this.platform, this.arch, this.macosVersion);
		this.sourceRoot = sourceRoot;
	}

	async destroy(): Promise<void> {
		// Invalidate first: setMode() intentionally does not await teardown.
		this.generation += 1;
		this.enabled = false;
		this.state = "destroyed";
		const preparing = this.preparing;
		await preparing?.catch(() => undefined);
		await Promise.allSettled([
			this.cleanupContainer(),
			this.workspaces.reset(),
		]);
	}

	async probe(): Promise<AppleContainerProbe> {
		try {
			if (!platformCompatible(this.platform, this.arch, this.macosVersion))
				throw new Error(
					platformReason(this.platform, this.arch, this.macosVersion),
				);
			const versionResult = await this.required(
				["--version"],
				"container CLI version",
			);
			const version = parseContainerVersion(
				versionResult.stdout || versionResult.stderr,
			);
			if (!version || compareVersions(version, MIN_CONTAINER_VERSION) < 0)
				throw new Error(
					`Apple container ${formatVersion(MIN_CONTAINER_VERSION)} or newer is required for --network none; found ${version ? formatVersion(version) : "an unparseable version"}.`,
				);
			await this.required(["system", "status"], "container service readiness");
			const createHelp = await this.required(
				["create", "--help"],
				"create support",
			);
			for (const flag of [
				"--network",
				"--no-dns",
				"--cap-drop",
				"--cpus",
				"--memory",
				"--read-only",
				"--tmpfs",
			]) {
				if (
					!createHelp.stdout.includes(flag) &&
					!createHelp.stderr.includes(flag)
				)
					throw new Error(
						`Installed container CLI lacks required create flag ${flag}.`,
					);
			}
			for (const command of ["cp", "exec", "stop", "delete", "list"])
				await this.required(
					[command, "--help"],
					`${command} lifecycle support`,
				);
			await this.required(
				["image", "inspect", this.image],
				"pinned image availability",
			);
			this.detail = `Apple container ${formatVersion(version)} ready; pinned arm64 image is local, networking disabled, private copy-in workspace.`;
			this.error = undefined;
			return {
				supported: true,
				detail: this.detail,
				version: formatVersion(version),
			};
		} catch (cause) {
			const reason = errorMessage(cause);
			this.detail = actionableProbeReason(reason, this.image);
			this.error = reason;
			return { supported: false, detail: this.detail };
		}
	}

	private async exec(
		command: string,
		sourceCwd: string,
		options: Parameters<BashOperations["exec"]>[2],
	): Promise<{ exitCode: number | null }> {
		const epoch = this.generation;
		let prepared: PreparedContainer;
		try {
			prepared = await this.prepare(sourceCwd, epoch);
		} catch (cause) {
			if (cause instanceof IsolationUnavailableError) throw cause;
			if (epoch !== this.generation || !this.enabled)
				throw new IsolationUnavailableError(
					this.tier,
					"Research epoch ended during Strong preparation",
					cause,
				);
			this.fail(cause);
			throw new IsolationUnavailableError(
				this.tier,
				`Strong isolation was unavailable before command execution: ${errorMessage(cause)}`,
				cause,
			);
		}
		if (epoch !== this.generation || !this.enabled)
			throw new IsolationUnavailableError(
				this.tier,
				"Research epoch ended before Strong command execution",
			);

		const guestCwd = mapGuestCwd(prepared.workspace, await realpath(sourceCwd));
		const guestEnv = createStrongGuestEnvironment(
			this.opts.baseEnv ?? process.env,
			options.env,
		);
		const args = ["exec", "--workdir", guestCwd];
		for (const [key, value] of Object.entries(guestEnv))
			if (value !== undefined) args.push("--env", `${key}=${value}`);
		args.push(prepared.name, "/bin/bash", "-lc", command);

		// From this point the requested command may have started. Never translate
		// failures into IsolationUnavailableError, which would permit host retry.
		let tainted = false;
		const abort = () => {
			tainted = true;
			void this.cleanupContainer(prepared.name);
		};
		if (options.signal?.aborted) abort();
		else options.signal?.addEventListener("abort", abort, { once: true });
		try {
			const result = await this.runner.run(args, {
				onData: options.onData,
				signal: options.signal,
				timeout: options.timeout,
				env: createControllerEnvironment(this.opts.baseEnv ?? process.env),
			});
			if (result.stderr && !options.onData) void result.stderr;
			return { exitCode: result.exitCode };
		} catch (cause) {
			tainted = true;
			throw new Error(
				`Strong container command failed after execution may have started: ${errorMessage(cause)}`,
				{ cause },
			);
		} finally {
			options.signal?.removeEventListener("abort", abort);
			if (tainted) await this.cleanupContainer(prepared.name);
		}
	}

	private async prepare(
		sourceCwd: string,
		epoch: number,
	): Promise<PreparedContainer> {
		if (!this.enabled)
			throw new Error("Strong isolation is not active for this research epoch");
		if (this.containerName && this.state === "ready") {
			const workspace = this.workspaces.current();
			if (workspace) return { name: this.containerName, workspace };
		}
		if (this.preparing) return this.preparing;
		this.preparing = this.prepareFresh(sourceCwd, epoch).finally(() => {
			this.preparing = undefined;
		});
		return this.preparing;
	}

	private async prepareFresh(
		sourceCwd: string,
		epoch: number,
	): Promise<PreparedContainer> {
		this.state = "preparing";
		const probe = await this.probe();
		if (!probe.supported) throw new Error(probe.detail);
		await this.reconcileStaleContainers();
		const sourceRoot =
			this.sourceRoot ??
			(await (this.opts.sourceRoot ?? resolveGitRoot)(sourceCwd));
		const workspace = await this.workspaces.ensure(sourceRoot);
		if (epoch !== this.generation || !this.enabled)
			throw new Error("Research epoch ended during Strong workspace creation");

		const name = `${CONTAINER_PREFIX}${workspace.id}-${randomUUID().slice(0, 6)}`;
		this.containerName = name;
		const createdAt = (this.opts.now ?? (() => new Date().toISOString()))();
		try {
			await this.required(
				createArgs(name, this.image, workspace.id, createdAt),
				"container creation",
			);
			this.assertEpoch(epoch);
			await this.required(["start", name], "container start");
			this.assertEpoch(epoch);
			await this.required(
				["cp", `${workspace.root}/.`, `${name}:${GUEST_WORKSPACE}`],
				"private workspace copy-in",
			);
			this.assertEpoch(epoch);
			await this.required(
				[
					"exec",
					name,
					"/bin/sh",
					"-c",
					"test -d /workspace && test ! -S /run/host-services/ssh-auth.sock",
				],
				"container workspace verification",
			);
			this.assertEpoch(epoch);
		} catch (cause) {
			await this.cleanupContainer(name);
			throw cause;
		}
		this.state = "ready";
		this.error = undefined;
		this.detail =
			"Strong Apple-container VM ready: offline, capability-dropped, resource-bounded, private snapshot only.";
		return { name, workspace };
	}

	private assertEpoch(epoch: number): void {
		if (epoch !== this.generation || !this.enabled)
			throw new Error("Research epoch ended during Strong container setup");
	}

	private async reconcileStaleContainers(): Promise<void> {
		const result = await this.required(
			["list", "--all", "--format", "json"],
			"stale-container reconciliation",
		);
		for (const name of ownedContainerNames(result.stdout))
			await this.cleanupContainer(name);
	}

	private async cleanupContainer(name = this.containerName): Promise<void> {
		if (!name) return;
		if (this.containerName === name) this.containerName = undefined;
		await this.runner
			.run(["stop", "--time", "2", name], {
				timeout: 5,
				env: createControllerEnvironment(this.opts.baseEnv ?? process.env),
			})
			.catch(() => undefined);
		await this.runner
			.run(["delete", "--force", name], {
				timeout: 10,
				env: createControllerEnvironment(this.opts.baseEnv ?? process.env),
			})
			.catch((cause) => {
				this.error = `Could not force-delete ${name}: ${errorMessage(cause)}`;
			});
		try {
			const listed = await this.runner.run(
				["list", "--all", "--format", "json"],
				{
					timeout: 5,
					env: createControllerEnvironment(this.opts.baseEnv ?? process.env),
				},
			);
			if (ownedContainerNames(listed.stdout).includes(name))
				this.error = `Strong cleanup could not verify deletion of ${name}. Run: container delete --force ${name}`;
		} catch (cause) {
			this.error = `Strong cleanup verification failed: ${errorMessage(cause)}`;
		}
	}

	private async required(
		args: readonly string[],
		purpose: string,
	): Promise<AppleContainerCommandResult> {
		const result = await this.runner.run(args, {
			timeout: 15,
			env: createControllerEnvironment(this.opts.baseEnv ?? process.env),
		});
		if (result.exitCode !== 0)
			throw new Error(
				`${purpose} failed (${result.exitCode ?? "signal"}): ${(result.stderr || result.stdout).trim() || "no diagnostic"}`,
			);
		return result;
	}

	private fail(cause: unknown): void {
		this.state = "failed";
		this.error = errorMessage(cause);
		this.detail = actionableProbeReason(this.error, this.image);
	}
}

interface PreparedContainer {
	readonly name: string;
	readonly workspace: ResearchWorkspace;
}

export class SpawnAppleContainerRunner implements AppleContainerCommandRunner {
	constructor(
		private readonly executable = "container",
		private readonly spawnProcess: typeof spawn = spawn,
	) {}

	run(
		args: readonly string[],
		options: AppleContainerCommandOptions = {},
	): Promise<AppleContainerCommandResult> {
		return new Promise((resolveRun, reject) => {
			let child: ChildProcess;
			try {
				child = this.spawnProcess(this.executable, [...args], {
					stdio: ["ignore", "pipe", "pipe"],
					env: options.env,
				});
			} catch (cause) {
				reject(cause);
				return;
			}
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let settled = false;
			let timedOut = false;
			let timer: NodeJS.Timeout | undefined;
			let forceTimer: NodeJS.Timeout | undefined;
			const terminate = () => {
				child.kill("SIGTERM");
				forceTimer = setTimeout(() => child.kill("SIGKILL"), 500);
				forceTimer.unref?.();
			};
			const abort = () => terminate();
			const finish = (error?: Error, exitCode: number | null = null) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				if (forceTimer) clearTimeout(forceTimer);
				options.signal?.removeEventListener("abort", abort);
				if (error) reject(error);
				else
					resolveRun({
						exitCode,
						stdout: Buffer.concat(stdout).toString("utf8"),
						stderr: Buffer.concat(stderr).toString("utf8"),
					});
			};
			if (options.signal?.aborted) abort();
			else options.signal?.addEventListener("abort", abort, { once: true });
			if (options.timeout && options.timeout > 0) {
				timer = setTimeout(() => {
					timedOut = true;
					terminate();
				}, options.timeout * 1_000);
				timer.unref?.();
			}
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout.push(chunk);
				options.onData?.(chunk);
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr.push(chunk);
				options.onData?.(chunk);
			});
			child.once("error", (error) => finish(error));
			child.once("close", (code) => {
				if (options.signal?.aborted) finish(new Error("aborted"));
				else if (timedOut) finish(new Error(`timeout:${options.timeout}`));
				else finish(undefined, code);
			});
		});
	}
}

export function createArgs(
	name: string,
	image: string,
	epoch: string,
	createdAt: string,
): string[] {
	return [
		"create",
		"--name",
		name,
		"--label",
		`${APPLE_CONTAINER_OWNER_LABEL}=true`,
		"--label",
		`io.pi-maestro.epoch=${epoch}`,
		"--label",
		`io.pi-maestro.created=${createdAt}`,
		"--network",
		"none",
		"--no-dns",
		"--cap-drop",
		"ALL",
		"--cpus",
		"2",
		"--memory",
		"2g",
		"--ulimit",
		"nofile=1024:1024",
		"--ulimit",
		"nproc=256:256",
		"--read-only",
		"--tmpfs",
		GUEST_WORKSPACE,
		"--tmpfs",
		"/tmp",
		"--tmpfs",
		"/home/research",
		"--workdir",
		GUEST_WORKSPACE,
		"--init",
		image,
		"sleep",
		"infinity",
	];
}

export function createStrongGuestEnvironment(
	base: NodeJS.ProcessEnv,
	requested?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const virtualWorkspace: ResearchWorkspace = {
		id: "guest",
		sourceRoot: GUEST_WORKSPACE,
		root: GUEST_WORKSPACE,
		home: "/home/research",
		tmp: "/tmp",
		cache: "/home/research/.cache",
		createdAt: "",
	};
	return {
		...createResearchEnvironment(base, requested, virtualWorkspace),
		MAESTRO_RESEARCH_ISOLATION: "strong",
		GIT_CONFIG_NOSYSTEM: "1",
	};
}

export function createControllerEnvironment(
	base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR"])
		if (base[key] !== undefined) env[key] = base[key];
	return {
		...env,
		HOME: "/var/empty",
		GIT_TERMINAL_PROMPT: "0",
	};
}

export function ownedContainerNames(stdout: string): string[] {
	try {
		const parsed = JSON.parse(stdout) as unknown;
		const records = Array.isArray(parsed) ? parsed : [parsed];
		return records.flatMap((record) => {
			if (!record || typeof record !== "object") return [];
			const value = record as Record<string, unknown>;
			const name = value.name ?? value.Name;
			const labels = value.labels ?? value.Labels;
			const labelOwned =
				(typeof labels === "object" &&
					labels !== null &&
					(labels as Record<string, unknown>)[APPLE_CONTAINER_OWNER_LABEL] ===
						"true") ||
				(typeof labels === "string" &&
					labels.includes(`${APPLE_CONTAINER_OWNER_LABEL}=true`));
			return typeof name === "string" && labelOwned ? [name] : [];
		});
	} catch {
		// Ownership must come from structured labels. Never authorize deletion
		// from a predictable name prefix or unparseable CLI output.
		return [];
	}
}

function mapGuestCwd(workspace: ResearchWorkspace, sourceCwd: string): string {
	const rel = relative(workspace.sourceRoot, resolve(sourceCwd));
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		throw new Error(
			`Command cwd is outside the research source root: ${sourceCwd}`,
		);
	return rel
		? `${GUEST_WORKSPACE}/${rel.split(sep).join("/")}`
		: GUEST_WORKSPACE;
}

function platformCompatible(
	platform: NodeJS.Platform,
	arch: string,
	version: string,
): boolean {
	return platform === "darwin" && arch === "arm64" && macosMajor(version) >= 26;
}

function platformReason(
	platform: NodeJS.Platform,
	arch: string,
	version: string,
): string {
	if (platform !== "darwin")
		return `Strong Apple-container isolation requires macOS 26 or later; this host is ${platform}.`;
	if (arch !== "arm64")
		return `Strong Apple-container isolation requires Apple silicon; this host is ${arch}.`;
	if (macosMajor(version) < 26)
		return `Strong Apple-container isolation requires macOS 26 or later; this host reports ${version}.`;
	return "Strong isolation is available after lazy Apple container CLI, service, feature, and pinned-image probes.";
}

function macosMajor(version: string): number {
	return Number.parseInt(version.split(".")[0] ?? "0", 10) || 0;
}

function detectedMacosVersion(
	platform: NodeJS.Platform,
	kernelRelease: string,
): string {
	if (platform !== "darwin") return kernelRelease;
	// Darwin 25 is macOS 26; Apple has used the +1 mapping since macOS 11.
	const darwinMajor = Number.parseInt(kernelRelease.split(".")[0] ?? "0", 10);
	return darwinMajor >= 20 ? String(darwinMajor + 1) : "unknown";
}

function parseContainerVersion(input: string): readonly number[] | undefined {
	const match = /(?:container\s+)?v?(\d+)\.(\d+)\.(\d+)/iu.exec(input);
	return match
		? [Number(match[1]), Number(match[2]), Number(match[3])]
		: undefined;
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference) return difference;
	}
	return 0;
}

function formatVersion(version: readonly number[]): string {
	return version.join(".");
}

function actionableProbeReason(reason: string, image: string): string {
	if (/ENOENT|not found|version/iu.test(reason))
		return `Apple container CLI is unavailable or incompatible. Install Apple container 0.6.0+ on Apple-silicon macOS 26, then start its service. ${reason}`;
	if (/service|system status/iu.test(reason))
		return `Apple container service is not ready. Start it explicitly with \`container system start\`, then retry. ${reason}`;
	if (/image|manifest|reference/iu.test(reason))
		return `The trusted research image is not local. An operator must pre-pull it (never model Bash): \`container image pull ${image}\`. ${reason}`;
	return `Strong Apple-container requirements were not met. No command ran and no weaker backend was selected. ${reason}`;
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

async function resolveGitRoot(cwd: string): Promise<string> {
	const result = await new SpawnAppleContainerRunner("git").run([
		"-C",
		cwd,
		"rev-parse",
		"--show-toplevel",
	]);
	if (result.exitCode !== 0)
		throw new Error(result.stderr.trim() || "Not inside a Git repository");
	return realpath(result.stdout.trim());
}
