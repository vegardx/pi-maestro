import { createHash, randomUUID } from "node:crypto";
import {
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readlink,
	realpath,
	rm,
	symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
	dirname,
	isAbsolute,
	join,
	normalize,
	relative,
	resolve,
	sep,
} from "node:path";

export interface ResearchWorkspace {
	readonly id: string;
	readonly sourceRoot: string;
	readonly root: string;
	readonly home: string;
	readonly tmp: string;
	readonly cache: string;
	readonly createdAt: string;
}

export interface ResearchWorkspaceManagerOptions {
	readonly baseDir?: string;
	readonly now?: () => string;
	readonly listFiles?: (sourceRoot: string) => Promise<readonly string[]>;
}

/**
 * Lazily materializes one private copy for a Recon→Plan epoch. It includes
 * tracked files plus current untracked, non-ignored files (`git ls-files
 * --cached --others --exclude-standard`). Nothing is copied back.
 */
export class ResearchWorkspaceManager {
	private workspace: ResearchWorkspace | undefined;
	private preparing: Promise<ResearchWorkspace> | undefined;

	constructor(private readonly opts: ResearchWorkspaceManagerOptions = {}) {}

	current(): ResearchWorkspace | undefined {
		return this.workspace;
	}

	async ensure(sourceRoot: string): Promise<ResearchWorkspace> {
		const canonical = await realpath(sourceRoot);
		if (this.workspace?.sourceRoot === canonical) return this.workspace;
		if (this.preparing) return this.preparing;
		this.preparing = this.create(canonical).finally(() => {
			this.preparing = undefined;
		});
		return this.preparing;
	}

	async reset(): Promise<void> {
		const current = this.workspace;
		this.workspace = undefined;
		if (current) await rm(current.root, { recursive: true, force: true });
	}

	private async create(sourceRoot: string): Promise<ResearchWorkspace> {
		await this.reset();
		const base = this.opts.baseDir ?? join(tmpdir(), "pi-maestro-research");
		await mkdir(base, { recursive: true, mode: 0o700 });
		const phaseRoot = await mkdtemp(join(base, "epoch-"));
		const root = join(phaseRoot, "workspace");
		const home = join(phaseRoot, "home");
		const privateTmp = join(phaseRoot, "tmp");
		const cache = join(home, ".cache");
		await Promise.all([
			mkdir(root, { recursive: true, mode: 0o700 }),
			mkdir(privateTmp, { recursive: true, mode: 0o700 }),
			mkdir(cache, { recursive: true, mode: 0o700 }),
		]);

		try {
			const files = await (this.opts.listFiles ?? listRelevantFiles)(
				sourceRoot,
			);
			for (const item of files) await copySafeEntry(sourceRoot, root, item);
		} catch (error) {
			await rm(phaseRoot, { recursive: true, force: true });
			throw error;
		}

		this.workspace = {
			id: `${createHash("sha256").update(sourceRoot).digest("hex").slice(0, 10)}-${randomUUID().slice(0, 8)}`,
			sourceRoot,
			root,
			home,
			tmp: privateTmp,
			cache,
			createdAt: (this.opts.now ?? (() => new Date().toISOString()))(),
		};
		return this.workspace;
	}
}

async function listRelevantFiles(
	sourceRoot: string,
): Promise<readonly string[]> {
	const { spawn } = await import("node:child_process");
	return new Promise((resolveFiles, reject) => {
		const child = spawn(
			"git",
			[
				"-C",
				sourceRoot,
				"ls-files",
				"-z",
				"--cached",
				"--others",
				"--exclude-standard",
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		child.once("error", reject);
		child.once("close", (code) => {
			if (code !== 0) {
				reject(
					new Error(
						`Could not enumerate research snapshot files: ${Buffer.concat(stderr).toString("utf8").trim()}`,
					),
				);
				return;
			}
			resolveFiles(
				Buffer.concat(stdout).toString("utf8").split("\0").filter(Boolean),
			);
		});
	});
}

async function copySafeEntry(
	sourceRoot: string,
	destinationRoot: string,
	entry: string,
): Promise<void> {
	if (!safeRelative(entry)) throw new Error(`Unsafe snapshot path: ${entry}`);
	const source = resolve(sourceRoot, entry);
	const destination = resolve(destinationRoot, entry);
	assertWithin(sourceRoot, source);
	assertWithin(destinationRoot, destination);
	const stat = await lstat(source);
	await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
	if (stat.isSymbolicLink()) {
		const target = await readlink(source);
		if (isAbsolute(target))
			throw new Error(
				`Snapshot excludes absolute symlink: ${entry} -> ${target}`,
			);
		const resolvedTarget = resolve(dirname(source), target);
		assertWithin(sourceRoot, resolvedTarget);
		await symlink(target, destination);
		return;
	}
	if (!stat.isFile())
		throw new Error(`Snapshot excludes non-regular entry: ${entry}`);
	await copyFile(source, destination);
}

function safeRelative(path: string): boolean {
	const normalized = normalize(path);
	return (
		path.length > 0 &&
		!isAbsolute(path) &&
		normalized !== ".." &&
		!normalized.startsWith(`..${sep}`) &&
		!normalized.includes("\0")
	);
}

function assertWithin(root: string, candidate: string): void {
	const rel = relative(resolve(root), resolve(candidate));
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		throw new Error(`Path escapes research workspace: ${candidate}`);
}

/** Test/helper probe that avoids following directory symlinks. */
export async function enumerateWorkspace(root: string): Promise<string[]> {
	const result: string[] = [];
	async function visit(dir: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			result.push(relative(root, path));
			if (entry.isDirectory()) await visit(path);
		}
	}
	await visit(root);
	return result.sort();
}

/** Bounded manifest used by diagnostics without exposing file contents. */
export async function workspaceManifest(root: string): Promise<string> {
	const names = await enumerateWorkspace(root);
	return JSON.stringify({
		files: names.slice(0, 1_000),
		truncated: names.length > 1_000,
	});
}
