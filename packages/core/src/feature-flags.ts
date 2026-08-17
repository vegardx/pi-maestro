// Environment-controlled extension and feature gates. Everything defaults on.

function envVarName(name: string): string {
	return `PI_EXT_${name.replace(/-/g, "_").toUpperCase()}`;
}

function parseBool(raw: string | undefined): boolean | undefined {
	if (raw === undefined) return undefined;
	const value = raw.trim().toLowerCase();
	if (["1", "on", "true", "yes"].includes(value)) return true;
	if (["0", "off", "false", "no"].includes(value)) return false;
	return undefined;
}

function envPathSet(name: string): Set<string> {
	const raw = process.env[name];
	if (!raw) return new Set();
	return new Set(
		raw
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean),
	);
}

export function isExtensionEnabled(name: string): boolean {
	return parseBool(process.env[envVarName(name)]) ?? true;
}

export function isFlagEnabled(name: string, flag: string): boolean {
	if (!isExtensionEnabled(name)) return false;
	const path = `${name}.${flag}`;
	if (envPathSet("PI_DISABLE").has(path)) return false;
	if (envPathSet("PI_ENABLE").has(path)) return true;
	return true;
}

export interface FlagChecker {
	enabled(flag: string): boolean;
}

export function createFlagChecker(name: string): FlagChecker {
	return { enabled: (flag) => isFlagEnabled(name, flag) };
}
