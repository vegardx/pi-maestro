// The research WORKSPACE copy (still used by the strong/VM backend) and the
// research child ENVIRONMENT allowlist. The lightweight copy-seatbelt backend
// and its config/network helpers were retired (recon/plan now run in-place,
// write-confined by the OS at the bash router — see realtree-sandbox).

import {
	lstat,
	mkdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createResearchEnvironment } from "../packages/modes/src/isolation/research-environment.js";
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

describe("private research workspace (strong/VM copy)", () => {
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
		await expect(lstat(dirname(first.root))).rejects.toThrow();
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

describe("createResearchEnvironment", () => {
	const workspace: ResearchWorkspace = {
		id: "epoch",
		sourceRoot: "/repo",
		root: "/private/phase/workspace",
		home: "/private/phase/home",
		tmp: "/private/phase/tmp",
		cache: "/private/phase/home/.cache",
		createdAt: "now",
	};

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
			{
				PATH: "/requested/bin",
				LANG: "nb_NO.UTF-8",
				NODE_OPTIONS: "--no-warnings",
				API_KEY: "secret",
			},
			workspace,
		);
		expect(env).toMatchObject({
			PATH: "/requested/bin",
			LANG: "nb_NO.UTF-8",
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
