import type { SettingDeclaration } from "@vegardx/pi-contracts";

/** Process-local declarations populated through settings.v1. */
export const settingsRegistry: Map<string, SettingDeclaration[]> = new Map();

export function declaredSetting(
	qualifiedKey: string,
): { extension: string; declaration: SettingDeclaration } | undefined {
	const dot = qualifiedKey.indexOf(".");
	if (dot < 1) return undefined;
	const extension = qualifiedKey.slice(0, dot);
	const key = qualifiedKey.slice(dot + 1);
	const declaration = settingsRegistry
		.get(extension)
		?.find((candidate) => candidate.key === key);
	return declaration ? { extension, declaration } : undefined;
}

export function declaredSettingKeys(): string[] {
	return [...settingsRegistry].flatMap(([extension, declarations]) =>
		declarations.map((declaration) => `${extension}.${declaration.key}`),
	);
}
