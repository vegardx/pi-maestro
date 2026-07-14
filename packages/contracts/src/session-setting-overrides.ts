// Typed process-local overrides for capability-declared extension settings.
// Kept in contracts so settings writers and runtime readers share state without
// extension-to-extension value imports.

export type SessionSettingValue = boolean | string | number | readonly string[];

const overrides = new Map<string, SessionSettingValue>();

function key(extension: string, path: string): string {
	return JSON.stringify([extension, path]);
}

function copy(value: SessionSettingValue): SessionSettingValue {
	return Array.isArray(value) ? [...value] : value;
}

export function getSessionSettingOverride(
	extension: string,
	path: string,
): SessionSettingValue | undefined {
	const value = overrides.get(key(extension, path));
	return value === undefined ? undefined : copy(value);
}

export function setSessionSettingOverride(
	extension: string,
	path: string,
	value: SessionSettingValue | undefined,
): void {
	const storeKey = key(extension, path);
	if (value === undefined) overrides.delete(storeKey);
	else overrides.set(storeKey, copy(value));
}

export function listSessionSettingOverrides(): ReadonlyArray<{
	extension: string;
	path: string;
	value: SessionSettingValue;
}> {
	return [...overrides.entries()].map(([encoded, value]) => {
		const [extension, path] = JSON.parse(encoded) as [string, string];
		return { extension, path, value: copy(value) };
	});
}

export function resetSessionSettingOverrides(): void {
	overrides.clear();
}
