import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	APPLE_CONTAINER_OWNER_LABEL,
	APPLE_CONTAINER_RESEARCH_IMAGE,
	type AppleContainerCommandOptions,
	type AppleContainerCommandResult,
	type AppleContainerCommandRunner,
	AppleContainerStrongBackend,
	createArgs,
	createControllerEnvironment,
	createStrongGuestEnvironment,
	ownedContainerNames,
} from "../packages/modes/src/isolation/apple-container.js";
import { IsolationUnavailableError } from "../packages/modes/src/isolation/backend.js";
import { ResearchWorkspaceManager } from "../packages/modes/src/isolation/workspace.js";

class FakeContainerRunner implements AppleContainerCommandRunner {
	readonly calls: Array<{
		args: readonly string[];
		options?: AppleContainerCommandOptions;
	}> = [];
	readonly containers = new Set<string>();
	fail?: (args: readonly string[]) => Error | undefined;
	exec?: (
		args: readonly string[],
		options?: AppleContainerCommandOptions,
	) => Promise<AppleContainerCommandResult>;

	async run(
		args: readonly string[],
		options?: AppleContainerCommandOptions,
	): Promise<AppleContainerCommandResult> {
		this.calls.push({ args: [...args], options });
		const failure = this.fail?.(args);
		if (failure) throw failure;
		if (this.exec && args[0] === "exec" && args.includes("/bin/bash"))
			return this.exec(args, options);
		if (args[0] === "--version") return ok("container 0.6.0\n");
		if (args[1] === "--help") return ok(requiredHelp(args[0]));
		if (args[0] === "list")
			return ok(
				JSON.stringify(
					[...this.containers].map((name) => ({
						name,
						labels: { [APPLE_CONTAINER_OWNER_LABEL]: "true" },
					})),
				),
			);
		if (args[0] === "create") {
			const name = args[args.indexOf("--name") + 1];
			if (name) this.containers.add(name);
		}
		if (args[0] === "delete") {
			const name = args.at(-1);
			if (name) this.containers.delete(name);
		}
		return ok();
	}
}

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "apple-container-test-"));
	roots.push(root);
	const source = join(root, "source");
	const privateBase = join(root, "epochs");
	await mkdir(join(source, "sub"), { recursive: true });
	await writeFile(join(source, "input.txt"), "host");
	await writeFile(join(source, "sub", "nested.txt"), "nested");
	return {
		root,
		source,
		workspaces: new ResearchWorkspaceManager({
			baseDir: privateBase,
			listFiles: async () => ["input.txt", "sub/nested.txt"],
		}),
	};
}

function backend(
	runner: FakeContainerRunner,
	workspaces: ResearchWorkspaceManager,
	source: string,
) {
	return new AppleContainerStrongBackend({
		runner,
		workspaces,
		platform: "darwin",
		arch: "arm64",
		macosVersion: "26.0",
		sourceRoot: async () => source,
		baseEnv: {
			PATH: "/usr/bin:/bin",
			LANG: "C.UTF-8",
			GH_TOKEN: "controller-secret",
			SSH_AUTH_SOCK: "/private/agent",
		},
		now: () => "2026-01-01T00:00:00.000Z",
	});
}

function ok(stdout = "", stderr = ""): AppleContainerCommandResult {
	return { exitCode: 0, stdout, stderr };
}

function requiredHelp(command: string | undefined): string {
	if (command === "create")
		return "--network --no-dns --cap-drop --cpus --memory --read-only --tmpfs";
	return `${command ?? "command"} help`;
}

describe("Apple container Strong capability probe", () => {
	it("reports unsupported hosts without invoking the CLI", async () => {
		for (const options of [
			{ platform: "linux" as const, arch: "arm64", macosVersion: "26" },
			{ platform: "darwin" as const, arch: "x64", macosVersion: "26" },
			{ platform: "darwin" as const, arch: "arm64", macosVersion: "15.7" },
		]) {
			const runner = new FakeContainerRunner();
			const strong = new AppleContainerStrongBackend({ runner, ...options });
			await expect(strong.probe()).resolves.toMatchObject({ supported: false });
			expect(runner.calls).toHaveLength(0);
			expect(strong.status().supported).toBe(false);
		}
	});

	it("probes CLI, service, required features, lifecycle and pinned image", async () => {
		const runner = new FakeContainerRunner();
		const strong = new AppleContainerStrongBackend({
			runner,
			platform: "darwin",
			arch: "arm64",
			macosVersion: "26.1",
		});
		await expect(strong.probe()).resolves.toMatchObject({
			supported: true,
			version: "0.6.0",
		});
		const calls = runner.calls.map(({ args }) => args.join(" "));
		expect(calls).toEqual(
			expect.arrayContaining([
				"--version",
				"system status",
				"create --help",
				"cp --help",
				"exec --help",
				"delete --help",
				`image inspect ${APPLE_CONTAINER_RESEARCH_IMAGE}`,
			]),
		);
		expect(
			runner.calls.every(({ options }) => options?.env?.GH_TOKEN === undefined),
		).toBe(true);
	});

	it("gives an actionable, fail-closed image diagnostic", async () => {
		const runner = new FakeContainerRunner();
		runner.fail = (args) =>
			args[0] === "image" ? new Error("image manifest missing") : undefined;
		const strong = new AppleContainerStrongBackend({
			runner,
			platform: "darwin",
			arch: "arm64",
			macosVersion: "26",
		});
		await expect(strong.probe()).resolves.toMatchObject({
			supported: false,
			detail: expect.stringContaining("operator must pre-pull"),
		});
	});
});

describe("Apple container Strong workspace and execution", () => {
	it("creates an offline resource-bounded VM and copies only the private snapshot", async () => {
		const { source, workspaces } = await fixture();
		const runner = new FakeContainerRunner();
		const strong = backend(runner, workspaces, source);
		const chunks: string[] = [];
		runner.exec = async (_args, options) => {
			options?.onData?.(Buffer.from("streamed"));
			return ok("streamed");
		};

		await expect(
			strong.operations(join(source, "sub")).exec("npm test", source, {
				onData: (chunk) => chunks.push(chunk.toString()),
				env: {
					PATH: "/usr/bin:/bin",
					CI: "1",
					NPM_TOKEN: "secret",
					PI_MAESTRO_SOCK: "/secret/socket",
				},
			}),
		).resolves.toEqual({ exitCode: 0 });
		expect(chunks).toEqual(["streamed"]);

		const create = runner.calls.find(
			({ args }) => args[0] === "create" && args[1] !== "--help",
		)?.args;
		expect(create).toEqual(
			expect.arrayContaining([
				"--network",
				"none",
				"--no-dns",
				"--cap-drop",
				"ALL",
				"--read-only",
				"--cpus",
				"2",
				"--memory",
				"2g",
				APPLE_CONTAINER_RESEARCH_IMAGE,
			]),
		);
		expect(create?.some((arg) => arg.includes(source))).toBe(false);
		expect(create).not.toContain("--mount");

		const copy = runner.calls.find(
			({ args }) => args[0] === "cp" && args[1] !== "--help",
		)?.args;
		expect(copy?.[1]).toContain("epochs/epoch-");
		expect(copy?.[1]).not.toContain(`${source}/`);
		expect(copy?.[2]).toMatch(/^pi-maestro-research-.+:/u);

		const execution = runner.calls.find(
			({ args }) => args[0] === "exec" && args.includes("/bin/bash"),
		)?.args;
		expect(execution).toEqual(
			expect.arrayContaining(["--workdir", "/workspace/sub"]),
		);
		const joined = execution?.join(" ") ?? "";
		expect(joined).toContain("CI=1");
		expect(joined).toContain("MAESTRO_RESEARCH_ISOLATION=strong");
		expect(joined).not.toContain("NPM_TOKEN");
		expect(joined).not.toContain("PI_MAESTRO_SOCK");
		expect(joined).not.toContain("SSH_AUTH_SOCK");
	});

	it("reuses one VM across the Recon to Plan epoch and destroys it idempotently", async () => {
		const { source, workspaces } = await fixture();
		const runner = new FakeContainerRunner();
		const strong = backend(runner, workspaces, source);
		const operations = strong.operations(source);
		for (const command of ["touch generated", "cat generated"])
			await operations.exec(command, source, { onData: vi.fn() });
		expect(
			runner.calls.filter(
				({ args }) => args[0] === "create" && args[1] !== "--help",
			),
		).toHaveLength(1);
		expect(
			runner.calls.filter(
				({ args }) => args[0] === "cp" && args[1] !== "--help",
			),
		).toHaveLength(1);
		expect(strong.status()).toMatchObject({ state: "ready", supported: true });

		await strong.destroy();
		await strong.destroy();
		expect(runner.containers.size).toBe(0);
		expect(strong.status().state).toBe("destroyed");
	});

	it("reconciles stale labeled containers before creation", async () => {
		const { source, workspaces } = await fixture();
		const runner = new FakeContainerRunner();
		runner.containers.add("pi-maestro-research-stale");
		const strong = backend(runner, workspaces, source);
		await strong.operations(source).exec("true", source, { onData: vi.fn() });
		const staleDelete = runner.calls.find(
			({ args }) =>
				args[0] === "delete" && args.at(-1) === "pi-maestro-research-stale",
		);
		expect(staleDelete?.args).toEqual([
			"delete",
			"--force",
			"pi-maestro-research-stale",
		]);
	});

	it("destroy during setup cannot orphan a container", async () => {
		const { source, workspaces } = await fixture();
		const runner = new FakeContainerRunner();
		let releaseCreate: (() => void) | undefined;
		let enteredCreate = false;
		const gate = new Promise<void>((resolve) => {
			releaseCreate = resolve;
		});
		const originalRun = runner.run.bind(runner);
		runner.run = async (args, options) => {
			if (args[0] === "create" && args[1] !== "--help") {
				enteredCreate = true;
				await gate;
			}
			return originalRun(args, options);
		};
		const strong = backend(runner, workspaces, source);
		const execution = strong
			.operations(source)
			.exec("true", source, { onData: vi.fn() })
			.catch((error) => error);
		await vi.waitFor(() => expect(enteredCreate).toBe(true));
		const destroyed = strong.destroy();
		releaseCreate?.();
		await destroyed;
		await execution;
		expect(runner.containers.size).toBe(0);
		expect(strong.status().state).toBe("destroyed");
	});

	it("cleans a tainted VM on abort and does not expose a fallback-eligible error", async () => {
		const { source, workspaces } = await fixture();
		const runner = new FakeContainerRunner();
		const strong = backend(runner, workspaces, source);
		runner.exec = async (_args, options) => {
			await new Promise<void>((resolve) => {
				options?.signal?.addEventListener("abort", () => resolve(), {
					once: true,
				});
			});
			throw new Error("aborted");
		};
		const controller = new AbortController();
		const execution = strong.operations(source).exec("sleep 60", source, {
			onData: vi.fn(),
			signal: controller.signal,
		});
		await vi.waitFor(() => {
			expect(runner.calls.some(({ args }) => args.includes("/bin/bash"))).toBe(
				true,
			);
		});
		controller.abort();
		const error = await execution.catch((caught) => caught);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(IsolationUnavailableError);
		expect(runner.containers.size).toBe(0);
		expect(
			runner.calls.some(
				({ args }) => args[0] === "delete" && args[1] === "--force",
			),
		).toBe(true);
	});

	it("uses IsolationUnavailableError only before requested execution", async () => {
		const { source, workspaces } = await fixture();
		const runner = new FakeContainerRunner();
		runner.fail = (args) =>
			args[0] === "system" ? new Error("service unavailable") : undefined;
		const strong = backend(runner, workspaces, source);
		const error = await strong
			.operations(source)
			.exec("touch should-not-run", source, { onData: vi.fn() })
			.catch((caught) => caught);
		expect(error).toBeInstanceOf(IsolationUnavailableError);
		expect(runner.calls.some(({ args }) => args.includes("/bin/bash"))).toBe(
			false,
		);
	});
});

describe("Apple container policy helpers", () => {
	it("pins all creation controls and no mount", () => {
		const args = createArgs(
			"name",
			APPLE_CONTAINER_RESEARCH_IMAGE,
			"epoch",
			"now",
		);
		expect(args).not.toContain("--mount");
		expect(args).not.toContain("--ssh");
		expect(args).not.toContain("--publish");
		expect(args).toEqual(
			expect.arrayContaining(["--network", "none", "--cap-drop", "ALL"]),
		);
	});

	it("scrubs controller and guest credentials and control endpoints", () => {
		const source = {
			PATH: "/bin",
			LANG: "en_US.UTF-8",
			CI: "1",
			HOME: "/Users/person",
			HTTP_PROXY: "http://credential@proxy",
			GH_TOKEN: "secret",
			SSH_AUTH_SOCK: "/secret/socket",
			DOCKER_HOST: "unix:///var/run/docker.sock",
			PI_MAESTRO_SOCK: "/secret/maestro.sock",
		};
		expect(createControllerEnvironment(source)).toEqual({
			PATH: "/bin",
			LANG: "en_US.UTF-8",
			HOME: "/var/empty",
			GIT_TERMINAL_PROMPT: "0",
		});
		const guest = createStrongGuestEnvironment({}, source);
		expect(guest).toMatchObject({
			PATH: "/bin",
			LANG: "en_US.UTF-8",
			CI: "1",
			HOME: "/home/research",
			MAESTRO_RESEARCH_ISOLATION: "strong",
		});
		for (const key of [
			"HTTP_PROXY",
			"GH_TOKEN",
			"SSH_AUTH_SOCK",
			"DOCKER_HOST",
			"PI_MAESTRO_SOCK",
		])
			expect(guest[key]).toBeUndefined();
	});

	it("requires an exact ownership label for stale containers", () => {
		expect(
			ownedContainerNames(
				JSON.stringify([
					{ name: "other", labels: {} },
					{ name: "owned", labels: { [APPLE_CONTAINER_OWNER_LABEL]: "true" } },
					{ name: "pi-maestro-research-crashed", labels: {} },
				]),
			),
		).toEqual(["owned"]);
	});
});
