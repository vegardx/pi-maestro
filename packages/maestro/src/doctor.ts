import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	DefaultPackageManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	type MaestroSetupPins,
	maestroDependencyRequirements,
	maestroPackageIdentity,
	maestroRequiredPackageSources,
	planMaestroSetup,
} from "./setup.js";

export type DoctorStatus = "pass" | "warn" | "fail";

export const MAESTRO_REVIEW_SKILLS = [
	"security-review",
	"correctness-review",
	"simplification-review",
	"adversarial-review",
] as const;

export interface DoctorCheck {
	readonly id: string;
	readonly status: DoctorStatus;
	readonly detail: string;
}

export interface DoctorCommandResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export type DoctorCommandRunner = (
	command: string,
	args: readonly string[],
	cwd: string,
) => DoctorCommandResult;

export interface MaestroDoctorOptions {
	readonly cwd: string;
	readonly settings: Record<string, unknown>;
	readonly pins: MaestroSetupPins;
	readonly agentToolkitRoot?: string;
	readonly dependencyRoots?: Readonly<Record<string, string>>;
	readonly configuredPackages?: readonly {
		readonly source: string;
		readonly scope: "user" | "project";
		readonly filtered: boolean;
		readonly installedPath?: string;
	}[];
	readonly run?: DoctorCommandRunner;
}

const realRun: DoctorCommandRunner = (command, args, cwd) => {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? result.error?.message ?? "",
	};
};

function check(id: string, status: DoctorStatus, detail: string): DoctorCheck {
	return { id, status, detail };
}

function readPackage(root: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(
			readFileSync(join(root, "package.json"), "utf8"),
		);
		return typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function skillFiles(root: string): string[] {
	const skills = join(root, "skills");
	if (!existsSync(skills) || !statSync(skills).isDirectory()) return [];
	const found: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && entry.name === "SKILL.md") found.push(path);
		}
	};
	visit(skills);
	return found.sort();
}

function commandValue(
	run: DoctorCommandRunner,
	cwd: string,
	args: readonly string[],
): string | undefined {
	const result = run(args[0], args.slice(1), cwd);
	return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Read-only diagnostics. It never invokes Pi's package installation APIs. */
export function runMaestroDoctor(
	options: MaestroDoctorOptions,
): readonly DoctorCheck[] {
	const checks: DoctorCheck[] = [];
	const run = options.run ?? realRun;
	let setupPlan: ReturnType<typeof planMaestroSetup> | undefined;
	try {
		setupPlan = planMaestroSetup(options.settings.packages, options.pins);
		checks.push(
			setupPlan.changes.length === 0
				? check(
						"package-pins",
						"pass",
						"all Maestro package sources are pinned",
					)
				: check(
						"package-pins",
						"fail",
						`${setupPlan.changes.length} package source(s) require setup`,
					),
		);
	} catch (cause) {
		checks.push(
			check(
				"package-pins",
				"fail",
				cause instanceof Error ? cause.message : String(cause),
			),
		);
	}

	const toolkitRoot = options.agentToolkitRoot;
	const toolkitPackage = toolkitRoot ? readPackage(toolkitRoot) : undefined;
	if (
		toolkitRoot &&
		toolkitPackage?.name === "@vegardx/agent-toolkit" &&
		typeof toolkitPackage.version === "string" &&
		toolkitPackage.version.length > 0
	) {
		checks.push(
			check(
				"agent-toolkit-identity",
				"pass",
				`@vegardx/agent-toolkit ${toolkitPackage.version}`,
			),
		);
		const manifest = toolkitPackage.pi;
		const declaredSkills =
			typeof manifest === "object" &&
			manifest !== null &&
			!Array.isArray(manifest) &&
			Array.isArray((manifest as { skills?: unknown }).skills)
				? (manifest as { skills: unknown[] }).skills
				: [];
		checks.push(
			declaredSkills.includes("./skills")
				? check(
						"agent-toolkit-manifest",
						"pass",
						"package.json declares pi.skills ./skills",
					)
				: check(
						"agent-toolkit-manifest",
						"fail",
						"package.json must declare pi.skills including ./skills",
					),
		);
		const skills = skillFiles(toolkitRoot);
		const skillNames = new Set(skills.map((path) => basename(dirname(path))));
		const missingReviewSkills = MAESTRO_REVIEW_SKILLS.filter(
			(name) => !skillNames.has(name),
		);
		checks.push(
			missingReviewSkills.length === 0
				? check(
						"agent-toolkit-skills",
						"pass",
						`${skills.length} skill(s) discovered; required review skills present`,
					)
				: check(
						"agent-toolkit-skills",
						"fail",
						`missing required review skills: ${missingReviewSkills.join(", ")}`,
					),
		);
		const revision = commandValue(run, toolkitRoot, [
			"git",
			"rev-parse",
			"HEAD",
		]);
		const expectedRevision = options.pins.agentToolkit.slice(
			options.pins.agentToolkit.lastIndexOf("@") + 1,
		);
		checks.push(
			revision === expectedRevision
				? check("agent-toolkit-revision", "pass", revision)
				: check(
						"agent-toolkit-revision",
						"fail",
						`expected ${expectedRevision}, found ${revision ?? "unreadable"}`,
					),
		);
		const toolkitOrigin = commandValue(run, toolkitRoot, [
			"git",
			"remote",
			"get-url",
			"origin",
		]);
		const recognizedOrigin = toolkitOrigin
			?.replace(/^git@github\.com:/, "github.com/")
			.replace(/^https?:\/\//, "")
			.replace(/\.git$/, "");
		checks.push(
			recognizedOrigin === "github.com/vegardx/agent-toolkit"
				? check(
						"agent-toolkit-origin",
						"pass",
						toolkitOrigin ?? recognizedOrigin,
					)
				: check(
						"agent-toolkit-origin",
						"fail",
						`expected github.com/vegardx/agent-toolkit, found ${toolkitOrigin ?? "unreadable"}`,
					),
		);
	} else {
		checks.push(
			check(
				"agent-toolkit-identity",
				"fail",
				"installed @vegardx/agent-toolkit package was not found or is invalid",
			),
		);
	}

	if (options.configuredPackages) {
		for (const requiredSource of maestroRequiredPackageSources(options.pins)) {
			const identity = maestroPackageIdentity(requiredSource);
			const discovered = options.configuredPackages.filter(
				(entry) => maestroPackageIdentity(entry.source) === identity,
			);
			const active = discovered[0];
			const valid =
				discovered.length === 1 &&
				active.source === requiredSource &&
				!active.filtered &&
				typeof active.installedPath === "string";
			checks.push(
				valid
					? check(
							`package-discovery:${identity}`,
							"pass",
							`${active.scope} ${active.installedPath}`,
						)
					: check(
							`package-discovery:${identity}`,
							"fail",
							"required package must be exactly pinned, unfiltered, installed, and configured in one scope",
						),
			);
		}
	}

	for (const { name, version } of maestroDependencyRequirements(options.pins)) {
		const root = options.dependencyRoots?.[name];
		const actual = root ? readPackage(root) : undefined;
		checks.push(
			actual?.name === name && actual.version === version
				? check(`dependency:${name}`, "pass", `${name} ${version}`)
				: check(
						`dependency:${name}`,
						"fail",
						`expected installed ${name} ${version}`,
					),
		);
	}

	const repoRoot = commandValue(run, options.cwd, [
		"git",
		"rev-parse",
		"--show-toplevel",
	]);
	checks.push(
		repoRoot
			? check("git-repository", "pass", repoRoot)
			: check(
					"git-repository",
					"warn",
					"current directory is not a Git repository",
				),
	);
	if (repoRoot) {
		const origin = commandValue(run, repoRoot, [
			"git",
			"remote",
			"get-url",
			"origin",
		]);
		checks.push(
			origin
				? check("git-origin", "pass", origin)
				: check("git-origin", "warn", "origin remote is not configured"),
		);
		for (const key of ["user.name", "user.email"] as const) {
			const value = commandValue(run, repoRoot, [
				"git",
				"config",
				"--get",
				key,
			]);
			checks.push(
				value
					? check(`git-${key}`, "pass", value)
					: check(`git-${key}`, "fail", `${key} is not configured`),
			);
		}
		const signing = commandValue(run, repoRoot, [
			"git",
			"config",
			"--bool",
			"--get",
			"commit.gpgSign",
		]);
		checks.push(
			signing === "true"
				? check("git-commit-signing", "pass", "commit.gpgSign is enabled")
				: check("git-commit-signing", "warn", "commit.gpgSign is not enabled"),
		);
		if (signing === "true") {
			const signingKey = commandValue(run, repoRoot, [
				"git",
				"config",
				"--get",
				"user.signingkey",
			]);
			checks.push(
				signingKey
					? check("git-signing-key", "pass", signingKey)
					: check(
							"git-signing-key",
							"warn",
							"user.signingkey is not configured",
						),
			);
		}
	}

	const gh = run("gh", ["auth", "status"], options.cwd);
	checks.push(
		gh.status === 0
			? check("github-auth", "pass", "gh reports an authenticated account")
			: check("github-auth", "warn", "gh is unavailable or not authenticated"),
	);
	return checks;
}

export function formatMaestroDoctor(checks: readonly DoctorCheck[]): string {
	const icon = { pass: "PASS", warn: "WARN", fail: "FAIL" } as const;
	return checks
		.map((item) => `${icon[item.status]} ${item.id}: ${item.detail}`)
		.join("\n");
}

/**
 * Resolve configured global package paths using Pi's package manager and run
 * doctor. `getInstalledPath` only inspects disk; this path deliberately never
 * calls resolve/install/update, so opening Maestro cannot execute missing code.
 */
export function runInstalledMaestroDoctor(options: {
	readonly cwd: string;
	readonly agentDir: string;
	readonly pins: MaestroSetupPins;
	readonly run?: DoctorCommandRunner;
}): readonly DoctorCheck[] {
	const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
	const packages = new DefaultPackageManager({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
	});
	const configuredPackages = packages.listConfiguredPackages();
	const dependencyRoots = Object.fromEntries(
		maestroDependencyRequirements(options.pins).flatMap((requirement) => {
			const path = configuredPackages.find(
				(entry) => entry.source === requirement.source && !entry.filtered,
			)?.installedPath;
			return path ? [[requirement.name, path]] : [];
		}),
	);
	const agentToolkitRoot = configuredPackages.find(
		(entry) => entry.source === options.pins.agentToolkit && !entry.filtered,
	)?.installedPath;
	return runMaestroDoctor({
		cwd: options.cwd,
		settings: settingsManager.getGlobalSettings() as Record<string, unknown>,
		pins: options.pins,
		agentToolkitRoot,
		dependencyRoots,
		configuredPackages,
		run: options.run,
	});
}
