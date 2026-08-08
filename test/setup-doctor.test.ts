import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	formatMaestroDoctor,
	MAESTRO_REVIEW_SKILLS,
	runInstalledMaestroDoctor,
	runMaestroDoctor,
} from "../packages/maestro/src/doctor.js";
import { handleMaestroPackageCommand } from "../packages/maestro/src/package-command.js";
import {
	applyMaestroSetup,
	DEFAULT_MAESTRO_SETUP_PINS,
	formatMaestroSetupPlan,
	MAESTRO_PACKAGE_PINS,
	planMaestroSetup,
} from "../packages/maestro/src/setup.js";

const REVISION = "a".repeat(40);
const PINS = {
	agentToolkit: `git:github.com/vegardx/agent-toolkit@${REVISION}` as const,
};

function writeReviewSkills(toolkit: string): void {
	for (const name of MAESTRO_REVIEW_SKILLS) {
		const directory = join(toolkit, "skills", name);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "SKILL.md"), `# ${name}\n`);
	}
}

describe("Maestro setup", () => {
	it("applies package pins only after the shared command receives one human approval", async () => {
		const root = mkdtempSync(join(tmpdir(), "maestro-setup-command-"));
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const ask = vi.fn(async () => [
			{
				questionId: "maestro-setup",
				value: "yes",
				source: "human" as const,
			},
		]);
		const notify = vi.fn();

		await handleMaestroPackageCommand("setup", {
			cwd: root,
			agentDir,
			asker: { ask },
			notify,
		});

		const settings = JSON.parse(
			readFileSync(join(agentDir, "settings.json"), "utf8"),
		) as { packages: string[] };
		expect(settings.packages).toContain(MAESTRO_PACKAGE_PINS.workflow);
		expect(settings.packages).toContain(MAESTRO_PACKAGE_PINS.agentToolkit);
		expect(ask).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenLastCalledWith(
			expect.stringMatching(/Reload Pi/),
			"info",
		);
	});

	it("reconciles immutable pins, preserves unrelated packages, and removes disabling filters", () => {
		const unrelatedFiltered = {
			source: "npm:unrelated-filtered@2.0.0",
			extensions: ["chosen.ts"],
		};
		const plan = planMaestroSetup(
			[
				"npm:unrelated@9.0.0",
				unrelatedFiltered,
				{
					source: "npm:@agwab/pi-workflow@0.10.0",
					extensions: [],
					skills: ["chosen/**"],
				},
				`git:https://github.com/vegardx/agent-toolkit.git@${"b".repeat(40)}`,
			],
			PINS,
		);

		expect(plan.changes).toHaveLength(4);
		expect(plan.packages).toContain("npm:unrelated@9.0.0");
		expect(plan.packages).toContain(unrelatedFiltered);
		expect(plan.packages).toContain(MAESTRO_PACKAGE_PINS.subagent);
		expect(plan.packages).toContain(MAESTRO_PACKAGE_PINS.webAccess);
		expect(plan.packages).toContain(PINS.agentToolkit);
		expect(plan.packages).toContain(MAESTRO_PACKAGE_PINS.workflow);
		expect(
			plan.packages.some(
				(entry) =>
					typeof entry === "object" &&
					entry.source === MAESTRO_PACKAGE_PINS.workflow,
			),
		).toBe(false);
		expect(DEFAULT_MAESTRO_SETUP_PINS.agentToolkit).toBe(
			"git:github.com/vegardx/agent-toolkit@d8dcea414dc4086fda540394515b14ce3959c34b",
		);
		expect(formatMaestroSetupPlan(plan)).toContain(
			"Review the pinned sources before approving.",
		);
	});

	it("rejects unpinned toolkit sources and duplicate identities", () => {
		expect(() =>
			planMaestroSetup([], {
				agentToolkit:
					"git:github.com/vegardx/agent-toolkit@main" as typeof PINS.agentToolkit,
			}),
		).toThrow(/pinned/);
		expect(() =>
			planMaestroSetup(
				["npm:pi-web-access@0.17.0", "npm:pi-web-access@0.16.0"],
				PINS,
			),
		).toThrow(/duplicate package identity/);
	});

	it("requires confirmation, writes atomically, and is idempotent", () => {
		const root = mkdtempSync(join(tmpdir(), "maestro-setup-"));
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			`${JSON.stringify({ theme: "dark", packages: ["npm:unrelated@1"] })}\n`,
		);
		expect(() =>
			applyMaestroSetup({
				cwd: root,
				agentDir,
				pins: PINS,
				confirmed: false,
			}),
		).toThrow(/confirmation/);

		const applied = applyMaestroSetup({
			cwd: root,
			agentDir,
			pins: PINS,
			confirmed: true,
		});
		expect(applied.changes).toHaveLength(4);
		const first = readFileSync(join(agentDir, "settings.json"), "utf8");
		expect(JSON.parse(first).theme).toBe("dark");
		const second = applyMaestroSetup({
			cwd: root,
			agentDir,
			pins: PINS,
			confirmed: false,
		});
		expect(second.changes).toEqual([]);
		expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(first);
	});
});

describe("Maestro doctor", () => {
	it("discovers the actual pinned Git checkout through Pi's package manager", () => {
		const root = mkdtempSync(join(tmpdir(), "maestro-doctor-installed-"));
		const agentDir = join(root, "agent");
		const toolkit = join(
			agentDir,
			"git",
			"github.com",
			"vegardx",
			"agent-toolkit",
		);
		writeReviewSkills(toolkit);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				packages: [DEFAULT_MAESTRO_SETUP_PINS.agentToolkit],
			}),
		);
		writeFileSync(
			join(toolkit, "package.json"),
			JSON.stringify({
				name: "@vegardx/agent-toolkit",
				version: "0.1.0",
				pi: { skills: ["./skills"] },
			}),
		);
		const checks = runInstalledMaestroDoctor({
			cwd: root,
			agentDir,
			pins: DEFAULT_MAESTRO_SETUP_PINS,
			run: (command, args) => {
				const invocation = [command, ...args].join(" ");
				if (invocation === "git rev-parse HEAD") {
					return {
						status: 0,
						stdout: "d8dcea414dc4086fda540394515b14ce3959c34b",
						stderr: "",
					};
				}
				if (invocation === "git remote get-url origin") {
					return {
						status: 0,
						stdout: "https://github.com/vegardx/agent-toolkit.git",
						stderr: "",
					};
				}
				return { status: 1, stdout: "", stderr: "" };
			},
		});
		expect(
			checks.find(
				(item) =>
					item.id === "package-discovery:git:github.com/vegardx/agent-toolkit",
			),
		).toEqual({
			id: "package-discovery:git:github.com/vegardx/agent-toolkit",
			status: "pass",
			detail: `user ${toolkit}`,
		});
	});

	it("checks package identity, skills, pins, Git, and gh without mutation", () => {
		const root = mkdtempSync(join(tmpdir(), "maestro-doctor-"));
		const toolkit = join(root, "toolkit");
		writeReviewSkills(toolkit);
		writeFileSync(
			join(toolkit, "package.json"),
			JSON.stringify({
				name: "@vegardx/agent-toolkit",
				version: "1.0.0",
				pi: { skills: ["./skills"] },
			}),
		);
		const dependencyRoots: Record<string, string> = {};
		for (const [name, version, directory] of [
			["@agwab/pi-workflow", "0.11.0", "workflow"],
			["@agwab/pi-subagent", "0.4.8", "subagent"],
			["pi-web-access", "0.18.0", "web"],
		] as const) {
			const path = join(root, directory);
			mkdirSync(path);
			writeFileSync(
				join(path, "package.json"),
				JSON.stringify({ name, version }),
			);
			dependencyRoots[name] = path;
		}
		const settings = {
			packages: [
				PINS.agentToolkit,
				MAESTRO_PACKAGE_PINS.workflow,
				MAESTRO_PACKAGE_PINS.subagent,
				MAESTRO_PACKAGE_PINS.webAccess,
			],
		};
		const calls: string[] = [];
		const values = new Map([
			["git rev-parse HEAD", REVISION],
			["git remote get-url origin", "git@github.com:vegardx/agent-toolkit.git"],
			["git rev-parse --show-toplevel", root],
			["git config --get user.name", "Vegard"],
			["git config --get user.email", "vegard@example.com"],
			["git config --bool --get commit.gpgSign", "true"],
			["git config --get user.signingkey", "ssh-ed25519 AAAA"],
			["gh auth status", "authenticated"],
		]);
		const checks = runMaestroDoctor({
			cwd: root,
			settings,
			pins: PINS,
			agentToolkitRoot: toolkit,
			dependencyRoots,
			configuredPackages: settings.packages.map((source) => ({
				source,
				scope: "user" as const,
				filtered: false,
				installedPath:
					source === PINS.agentToolkit
						? toolkit
						: dependencyRoots[
								source.includes("pi-workflow")
									? "@agwab/pi-workflow"
									: source.includes("pi-subagent")
										? "@agwab/pi-subagent"
										: "pi-web-access"
							],
			})),
			run: (command, args) => {
				const invocation = [command, ...args].join(" ");
				calls.push(invocation);
				const stdout = values.get(invocation);
				return { status: stdout ? 0 : 1, stdout: stdout ?? "", stderr: "" };
			},
		});

		expect(checks.every((item) => item.status === "pass")).toBe(true);
		expect(calls).toContain("gh auth status");
		expect(formatMaestroDoctor(checks)).toContain("PASS agent-toolkit-skills");
	});

	it("rejects a toolkit manifest or effective package filter that hides skills", () => {
		const root = mkdtempSync(join(tmpdir(), "maestro-doctor-filter-"));
		mkdirSync(join(root, "skills", "security"), { recursive: true });
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				name: "@vegardx/agent-toolkit",
				version: "1.0.0",
				pi: { skills: [] },
			}),
		);
		writeFileSync(join(root, "skills", "security", "SKILL.md"), "# Security\n");
		const checks = runMaestroDoctor({
			cwd: root,
			settings: {
				packages: [{ source: PINS.agentToolkit, skills: [] }],
			},
			pins: PINS,
			agentToolkitRoot: root,
			configuredPackages: [
				{
					source: PINS.agentToolkit,
					scope: "user",
					filtered: true,
					installedPath: root,
				},
			],
			run: (command, args) => {
				const invocation = [command, ...args].join(" ");
				if (invocation === "git rev-parse HEAD") {
					return { status: 0, stdout: REVISION, stderr: "" };
				}
				if (invocation === "git remote get-url origin") {
					return {
						status: 0,
						stdout: "https://github.com/vegardx/agent-toolkit.git",
						stderr: "",
					};
				}
				return { status: 1, stdout: "", stderr: "" };
			},
		});
		expect(checks.find((item) => item.id === "package-pins")?.status).toBe(
			"fail",
		);
		expect(
			checks.find((item) => item.id === "agent-toolkit-manifest")?.status,
		).toBe("fail");
		expect(
			checks.find(
				(item) =>
					item.id === "package-discovery:git:github.com/vegardx/agent-toolkit",
			)?.status,
		).toBe("fail");
	});

	it("reports umbrella cwd and missing auth as warnings", () => {
		const checks = runMaestroDoctor({
			cwd: "/workspace",
			settings: { packages: [] },
			pins: PINS,
			run: () => ({ status: 1, stdout: "", stderr: "not found" }),
		});
		expect(checks).toContainEqual({
			id: "git-repository",
			status: "warn",
			detail: "current directory is not a Git repository",
		});
		expect(checks.find((item) => item.id === "github-auth")?.status).toBe(
			"warn",
		);
	});

	it("derives installed dependency versions from overridden setup pins", () => {
		const checks = runMaestroDoctor({
			cwd: "/workspace",
			settings: { packages: [] },
			pins: { ...PINS, workflow: "npm:@agwab/pi-workflow@9.9.9" },
			dependencyRoots: {},
			run: () => ({ status: 1, stdout: "", stderr: "not found" }),
		});
		expect(
			checks.find((item) => item.id === "dependency:@agwab/pi-workflow")
				?.detail,
		).toBe("expected installed @agwab/pi-workflow 9.9.9");
	});
});
