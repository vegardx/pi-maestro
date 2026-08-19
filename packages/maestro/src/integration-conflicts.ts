import { SettingsManager } from "@earendil-works/pi-coding-agent";

const STANDALONE_INTEGRATIONS = [
	"@agwab/pi-subagent",
	"@agwab/pi-workflow",
	"pi-web-access",
] as const;

type StandaloneIntegration = (typeof STANDALONE_INTEGRATIONS)[number];

function packageSource(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	if (typeof entry !== "object" || entry === null) return undefined;
	if (
		"extensions" in entry &&
		Array.isArray(entry.extensions) &&
		entry.extensions.length === 0
	)
		return undefined;
	if ("source" in entry && typeof entry.source === "string")
		return entry.source;
	return undefined;
}

function npmPackageName(source: string): string | undefined {
	const value = source.startsWith("npm:") ? source.slice(4) : source;
	if (value.startsWith("@")) {
		const separator = value.indexOf("/", 1);
		if (separator < 0) return undefined;
		const version = value.indexOf("@", separator);
		return version < 0 ? value : value.slice(0, version);
	}
	if (/^(?:git:|https?:|ssh:|\.\.?\/|\/|~\/)/.test(value)) return undefined;
	const version = value.indexOf("@");
	return version < 0 ? value : value.slice(0, version);
}

function configuredPackages(settings: unknown): readonly unknown[] {
	if (typeof settings !== "object" || settings === null) return [];
	if (!("packages" in settings) || !Array.isArray(settings.packages)) return [];
	return settings.packages;
}

export function configuredStandaloneIntegrations(
	cwd: string,
	agentDir?: string,
): StandaloneIntegration[] {
	const manager = SettingsManager.create(cwd, agentDir);
	const configured = [
		...configuredPackages(manager.getGlobalSettings()),
		...configuredPackages(manager.getProjectSettings()),
	];
	const names = new Set(
		configured
			.map(packageSource)
			.filter((source): source is string => source !== undefined)
			.map(npmPackageName)
			.filter((name): name is string => name !== undefined),
	);
	return STANDALONE_INTEGRATIONS.filter((name) => names.has(name));
}

export function assertNoStandaloneIntegrations(
	cwd: string,
	agentDir?: string,
): void {
	const conflicts = configuredStandaloneIntegrations(cwd, agentDir);
	if (conflicts.length === 0) return;
	throw new Error(
		`pi-maestro already bundles ${conflicts.join(", ")}. Remove the standalone ${
			conflicts.length === 1 ? "entry" : "entries"
		} from global or project settings.json packages, keep pi-maestro, and restart Pi.`,
	);
}
