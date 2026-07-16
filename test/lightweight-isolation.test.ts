import {
	lstat,
	mkdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createResearchEnvironment,
	LightweightSeatbeltBackend,
	networkDestinationAllowed,
	type SandboxRuntimeAdapter,
	seatbeltConfig,
} from "../packages/modes/src/isolation/lightweight-seatbelt.js";
import type { ResearchWorkspace } from "../packages/modes/src/isolation/workspace.js";
import { ResearchWorkspaceManager } from "../packages/modes/src/isolation/workspace.js";

const roots: string[] = [];

async function fixtureRoot(name: string): Promise<string> {
	const root = join(
		tmpdir(),
		`maestro-isolation-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	roots.push(root);
	await mkdir(root, { recursive: true });
	return root;
}

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("private research workspace", () => {
	it("copies current relevant files and persists mutations for one epoch", async () => {
		const source = await fixtureRoot("snapshot-source");
		const base = await fixtureRoot("snapshot-base");
		await mkdir(join(source, "src"), { recursive: true });
		await writeFile(join(source, "src", "tracked.ts"), "current contents");
		await writeFile(join(source, "scratch.txt"), "untracked relevant");
		const manager = new ResearchWorkspaceManager({
			baseDir: base,
			listFiles: async () => ["src/tracked.ts", "scratch.txt"],
		});

		const first = await manager.ensure(source);
		expect(await readFile(join(first.root, "src", "tracked.ts"), "utf8")).toBe(
			"current contents",
		);
		await writeFile(join(first.root, "generated.txt"), "private mutation");
		const second = await manager.ensure(source);
		expect(second.root).toBe(first.root);
		expect(await readFile(join(second.root, "generated.txt"), "utf8")).toBe(
			"private mutation",
		);
		await expect(
			readFile(join(source, "generated.txt"), "utf8"),
		).rejects.toThrow();

		await manager.reset();
		await expect(lstat(first.root)).rejects.toThrow();
	});

	it("preserves safe relative symlinks and rejects path escapes", async () => {
		const source = await fixtureRoot("symlink-source");
		const base = await fixtureRoot("symlink-base");
		await writeFile(join(source, "target.txt"), "ok");
		await symlink("target.txt", join(source, "safe-link"));
		const safe = new ResearchWorkspaceManager({
			baseDir: base,
			listFiles: async () => ["target.txt", "safe-link"],
		});
		const workspace = await safe.ensure(source);
		expect(await readFile(join(workspace.root, "safe-link"), "utf8")).toBe(
			"ok",
		);
		await safe.reset();

		await symlink("../../outside", join(source, "escape-link"));
		const escaping = new ResearchWorkspaceManager({
			baseDir: base,
			listFiles: async () => ["escape-link"],
		});
		await expect(escaping.ensure(source)).rejects.toThrow(
			/escapes research workspace/u,
		);
	});
});

describe("Lightweight policy", () => {
	const workspace: ResearchWorkspace = {
		id: "epoch",
		sourceRoot: "/repo",
		root: "/private/phase/workspace",
		home: "/private/phase/home",
		tmp: "/private/phase/tmp",
		cache: "/private/phase/home/.cache",
		createdAt: "now",
	};

	it("confines writes, blocks control sockets, and keeps broad reads/network", () => {
		const config = seatbeltConfig(workspace, "/repo");
		expect(config.filesystem.allowWrite).toEqual(
			expect.arrayContaining([workspace.root, workspace.home, workspace.tmp]),
		);
		expect(config.filesystem.denyWrite).toContain("/repo");
		expect(config.filesystem.denyRead).toEqual(
			expect.arrayContaining([expect.stringContaining("auth.json")]),
		);
		expect(config.network.allowUnixSockets).toEqual([]);
		expect(config.network.allowAllUnixSockets).toBe(false);
		expect(config.network.allowLocalBinding).toBe(false);
	});

	it("allows external destinations but rejects local and host-control ranges", () => {
		for (const host of [
			"localhost",
			"127.0.0.1",
			"::1",
			"10.0.0.5",
			"172.20.1.2",
			"192.168.1.2",
			"169.254.169.254",
		]) {
			expect(networkDestinationAllowed(host), host).toBe(false);
		}
		expect(networkDestinationAllowed("registry.npmjs.org")).toBe(true);
		expect(networkDestinationAllowed("1.1.1.1")).toBe(true);
	});

	it("constructs a private environment and removes credentials/control endpoints", () => {
		const env = createResearchEnvironment(
			{
				PATH: "/bin:/usr/bin",
				LANG: "en_US.UTF-8",
				PI_MAESTRO_SOCK: "/tmp/maestro.sock",
				PI_MAESTRO_TOKEN: "secret",
				SSH_AUTH_SOCK: "/tmp/ssh.sock",
				GITHUB_TOKEN: "secret",
				AWS_ACCESS_KEY_ID: "secret",
				UNRELATED: "not allowlisted",
			},
			{ NODE_OPTIONS: "--no-warnings", API_KEY: "secret" },
			workspace,
		);
		expect(env).toMatchObject({
			PATH: "/bin:/usr/bin",
			LANG: "en_US.UTF-8",
			HOME: workspace.home,
			TMPDIR: workspace.tmp,
			XDG_CACHE_HOME: workspace.cache,
			MAESTRO_RESEARCH_ISOLATION: "lightweight",
		});
		for (const key of [
			"PI_MAESTRO_SOCK",
			"PI_MAESTRO_TOKEN",
			"SSH_AUTH_SOCK",
			"GITHUB_TOKEN",
			"AWS_ACCESS_KEY_ID",
			"API_KEY",
			"UNRELATED",
		]) {
			expect(env[key], key).toBeUndefined();
		}
	});
});

describe("Lightweight backend lifecycle and failure", () => {
	it("is lazy, preserves an epoch, streams command output, and cleans up", async () => {
		const source = await fixtureRoot("backend-source");
		const base = await fixtureRoot("backend-base");
		await writeFile(join(source, "input.txt"), "fixture");
		const runtime: SandboxRuntimeAdapter = {
			isSupportedPlatform: () => true,
			initialize: vi.fn(async () => {}),
			wrap: vi.fn(async (command) => command),
			reset: vi.fn(async () => {}),
		};
		const manager = new ResearchWorkspaceManager({
			baseDir: base,
			listFiles: async () => ["input.txt"],
		});
		const backend = new LightweightSeatbeltBackend({
			runtime,
			workspaces: manager,
			platform: "darwin",
			sourceRoot: async () => source,
		});
		expect(backend.status().state).toBe("idle");

		const chunks: Buffer[] = [];
		const operations = backend.operations(source);
		const result = await operations.exec(
			"printf streamed; touch generated.txt",
			source,
			{
				onData: (chunk) => chunks.push(chunk),
			},
		);
		expect(result.exitCode).toBe(0);
		expect(Buffer.concat(chunks).toString()).toBe("streamed");
		expect(backend.status()).toMatchObject({ state: "ready", supported: true });
		expect(runtime.initialize).toHaveBeenCalledTimes(1);
		const privateRoot = backend.status().workspace;
		expect(privateRoot).toBeTruthy();
		expect(await readFile(join(privateRoot!, "generated.txt"), "utf8")).toBe(
			"",
		);
		await expect(
			readFile(join(source, "generated.txt"), "utf8"),
		).rejects.toThrow();

		await operations.exec("test -f generated.txt", source, {
			onData: () => {},
		});
		expect(runtime.initialize).toHaveBeenCalledTimes(1);
		await backend.destroy();
		expect(backend.status().state).toBe("destroyed");
		await expect(lstat(privateRoot!)).rejects.toThrow();
	});

	it("fails visibly and closed when setup fails", async () => {
		const source = await fixtureRoot("failed-source");
		const runtime: SandboxRuntimeAdapter = {
			isSupportedPlatform: () => true,
			initialize: vi.fn(async () => {
				throw new Error("seatbelt unavailable");
			}),
			wrap: vi.fn(async (command) => command),
			reset: vi.fn(async () => {}),
		};
		const backend = new LightweightSeatbeltBackend({
			runtime,
			platform: "darwin",
			sourceRoot: async () => source,
			workspaces: new ResearchWorkspaceManager({ listFiles: async () => [] }),
		});
		await expect(
			backend
				.operations(source)
				.exec("touch host", source, { onData: () => {} }),
		).rejects.toThrow(/could not prepare.*seatbelt unavailable/iu);
		expect(backend.status()).toMatchObject({
			state: "failed",
			error: "seatbelt unavailable",
		});
		await expect(readFile(resolve(source, "host"), "utf8")).rejects.toThrow();
		await backend.destroy();
	});

	it("terminates the process group on timeout", async () => {
		const source = await fixtureRoot("timeout-source");
		const base = await fixtureRoot("timeout-base");
		const runtime: SandboxRuntimeAdapter = {
			isSupportedPlatform: () => true,
			initialize: vi.fn(async () => {}),
			wrap: vi.fn(async (command) => command),
			reset: vi.fn(async () => {}),
		};
		const backend = new LightweightSeatbeltBackend({
			runtime,
			platform: "darwin",
			sourceRoot: async () => source,
			workspaces: new ResearchWorkspaceManager({
				baseDir: base,
				listFiles: async () => [],
			}),
		});
		await expect(
			backend.operations(source).exec("sleep 5 & wait", source, {
				onData: () => {},
				timeout: 0.05,
			}),
		).rejects.toThrow("timeout:0.05");
		await backend.destroy();
	});
});
