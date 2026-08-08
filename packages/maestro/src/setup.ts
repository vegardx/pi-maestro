import { readFileSync } from "node:fs";
import { updateSettingsFile } from "../../settings/src/writer.js";

export const MAESTRO_PACKAGE_PINS = {
	agentToolkit:
		"git:github.com/vegardx/agent-toolkit@d8dcea414dc4086fda540394515b14ce3959c34b",
	workflow: "npm:@agwab/pi-workflow@0.11.0",
	subagent: "npm:@agwab/pi-subagent@0.4.8",
	webAccess: "npm:pi-web-access@0.18.0",
} as const;

export const DEFAULT_MAESTRO_SETUP_PINS: MaestroSetupPins = {
	agentToolkit: MAESTRO_PACKAGE_PINS.agentToolkit,
};

export interface MaestroSetupPins {
	readonly agentToolkit: `git:github.com/vegardx/agent-toolkit@${string}`;
	readonly workflow?: string;
	readonly subagent?: string;
	readonly webAccess?: string;
}

export interface MaestroPackageChange {
	readonly identity: string;
	readonly action: "add" | "update";
	readonly from?: string;
	readonly to: string;
}

export interface MaestroPackageRequirement {
	readonly name: string;
	readonly version: string;
	readonly source: string;
}

export interface MaestroSetupPlan {
	readonly packages: readonly PackageSetting[];
	readonly changes: readonly MaestroPackageChange[];
	readonly requiresConfirmation: boolean;
	readonly reloadRequired: boolean;
}

export type PackageSetting =
	| string
	| ({ readonly source: string } & Record<string, unknown>);

const TOOLKIT_PREFIX = "git:github.com/vegardx/agent-toolkit@";
const PINNED_REVISION = /^[a-f0-9]{40,64}$/;

function sourceOf(value: PackageSetting): string {
	return typeof value === "string" ? value : value.source;
}

export function maestroPackageIdentity(source: string): string | undefined {
	const npm = source.match(/^npm:(@[^/]+\/[^@]+|[^@]+)(?:@.+)?$/);
	if (npm) return `npm:${npm[1]}`;

	let git = source.trim();
	if (git.startsWith("git:")) git = git.slice(4);
	git = git.replace(/^https?:\/\//, "").replace(/^ssh:\/\//, "");
	git = git.replace(/^git@/, "").replace(/^github\.com:/, "github.com/");
	git = git.replace(/\.git(?=@|$)/, "");
	git = git.replace(/@[a-f0-9]{40,64}$/, "");
	if (git === "github.com/vegardx/agent-toolkit") {
		return "git:github.com/vegardx/agent-toolkit";
	}
	return undefined;
}

function validatedPins(input: MaestroSetupPins): readonly string[] {
	if (!input.agentToolkit.startsWith(TOOLKIT_PREFIX)) {
		throw new Error(
			"agent-toolkit must use git:github.com/vegardx/agent-toolkit@<commit>",
		);
	}
	const revision = input.agentToolkit.slice(TOOLKIT_PREFIX.length);
	if (!PINNED_REVISION.test(revision)) {
		throw new Error("agent-toolkit must be pinned to a 40-64 character commit");
	}
	const pins = [
		input.agentToolkit,
		input.workflow ?? MAESTRO_PACKAGE_PINS.workflow,
		input.subagent ?? MAESTRO_PACKAGE_PINS.subagent,
		input.webAccess ?? MAESTRO_PACKAGE_PINS.webAccess,
	];
	for (const source of pins.slice(1)) {
		if (!/^npm:(@[^/]+\/[^@]+|[^@]+)@[^@]+$/.test(source)) {
			throw new Error(`dependency package must be version-pinned: ${source}`);
		}
	}
	return pins;
}

export function maestroRequiredPackageSources(
	pins: MaestroSetupPins,
): readonly string[] {
	return validatedPins(pins);
}

/** The npm identities and versions doctor must verify, derived from setup. */
export function maestroDependencyRequirements(
	pins: MaestroSetupPins,
): readonly MaestroPackageRequirement[] {
	return validatedPins(pins)
		.slice(1)
		.map((source) => {
			const match = source.match(/^npm:(@[^/]+\/[^@]+|[^@]+)@([^@]+)$/);
			if (!match)
				throw new Error(`dependency package must be version-pinned: ${source}`);
			return { name: match[1], version: match[2], source };
		});
}

function packageArray(raw: unknown): PackageSetting[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw))
		throw new Error("settings packages must be an array");
	return raw.map((entry) => {
		if (typeof entry === "string" && entry.trim()) return entry;
		if (
			typeof entry === "object" &&
			entry !== null &&
			!Array.isArray(entry) &&
			typeof (entry as { source?: unknown }).source === "string" &&
			(entry as { source: string }).source.trim()
		) {
			return entry as PackageSetting;
		}
		throw new Error("settings packages contains an invalid entry");
	});
}

/**
 * Compute the explicit global setup mutation. This never downloads or executes
 * package code. Required package entries are normalized to unfiltered string
 * form; unrelated package entries are preserved byte-for-byte as JSON values.
 */
export function planMaestroSetup(
	currentPackages: unknown,
	pins: MaestroSetupPins,
): MaestroSetupPlan {
	const desired = validatedPins(pins);
	const packages = packageArray(currentPackages);
	const changes: MaestroPackageChange[] = [];

	for (const source of desired) {
		const identity = maestroPackageIdentity(source);
		if (!identity)
			throw new Error(`unsupported maestro package pin: ${source}`);
		const matches = packages
			.map((entry, index) => ({ entry, index, source: sourceOf(entry) }))
			.filter(
				(candidate) => maestroPackageIdentity(candidate.source) === identity,
			);
		if (matches.length > 1) {
			throw new Error(`duplicate package identity in settings: ${identity}`);
		}
		const match = matches[0];
		if (!match) {
			packages.push(source);
			changes.push({ identity, action: "add", to: source });
			continue;
		}
		if (match.source === source && typeof match.entry === "string") continue;
		// Required packages use the string form deliberately. Object-form filters
		// can disable workflow extensions or hide toolkit skills, so retaining
		// those filters would make setup report success over an inert package.
		packages[match.index] = source;
		changes.push({
			identity,
			action: "update",
			from: match.source,
			to: source,
		});
	}

	return {
		packages,
		changes,
		requiresConfirmation: changes.length > 0,
		reloadRequired: changes.length > 0,
	};
}

/** Human-facing text for the single confirmation owned by the command route. */
export function formatMaestroSetupPlan(plan: MaestroSetupPlan): string {
	if (plan.changes.length === 0) {
		return "Maestro packages already match the approved pins.";
	}
	return [
		"Update global Pi package settings?",
		...plan.changes.map((change) =>
			change.action === "add"
				? `- Add ${change.to}`
				: `- Replace ${change.from} with ${change.to}`,
		),
		"This changes settings only. Pi will install missing package code after reload.",
		"Review the pinned sources before approving.",
	].join("\n");
}

export interface ApplyMaestroSetupOptions {
	readonly cwd: string;
	readonly agentDir: string;
	readonly pins: MaestroSetupPins;
	/** Must be true only after the user approved the displayed setup plan. */
	readonly confirmed: boolean;
}

/** Read global settings and compute the exact mutation without writing them. */
export function planInstalledMaestroSetup(options: {
	readonly agentDir: string;
	readonly pins: MaestroSetupPins;
}): MaestroSetupPlan {
	const settingsPath = `${options.agentDir}/settings.json`;
	let raw: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
			throw new Error("global settings must contain a JSON object");
		raw = parsed as Record<string, unknown>;
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
	}
	return planMaestroSetup(raw.packages, options.pins);
}

/** Apply an already-authorized global settings reconciliation atomically. */
export function applyMaestroSetup(
	options: ApplyMaestroSetupOptions,
): MaestroSetupPlan {
	const plan = planInstalledMaestroSetup(options);
	if (plan.requiresConfirmation && !options.confirmed) {
		throw new Error("global package changes require explicit confirmation");
	}
	if (!plan.requiresConfirmation) return plan;
	updateSettingsFile("global", options.cwd, options.agentDir, (settings) => {
		const current = planMaestroSetup(settings.packages, options.pins);
		if (current.changes.length === 0) return false;
		settings.packages = current.packages;
	});
	return plan;
}
