// Typed process-local role-pool overrides. The store deliberately lives in the
// dependency-neutral contracts package: settings can mutate it and model
// resolution can consume it without either extension importing the other.

import type { ModelRole, SessionProfileRoleOverride } from "./models.js";

const roleOverrides = new Map<string, SessionProfileRoleOverride>();

function key(profile: string, role: ModelRole): string {
	// JSON encoding avoids delimiter collisions in user-chosen profile names.
	return JSON.stringify([profile, role]);
}

function copy(patch: SessionProfileRoleOverride): SessionProfileRoleOverride {
	return {
		...(patch.models ? { models: [...patch.models] } : {}),
		...(patch.efforts ? { efforts: [...patch.efforts] } : {}),
	};
}

export function getSessionRoleOverride(
	profile: string,
	role: ModelRole,
): SessionProfileRoleOverride | undefined {
	const value = roleOverrides.get(key(profile, role));
	return value ? copy(value) : undefined;
}

export function setSessionRoleOverride(
	profile: string,
	role: ModelRole,
	patch: SessionProfileRoleOverride | undefined,
): void {
	const storeKey = key(profile, role);
	if (
		!patch ||
		(patch.models === undefined && patch.efforts === undefined) ||
		patch.models?.length === 0 ||
		patch.efforts?.length === 0
	) {
		roleOverrides.delete(storeKey);
		return;
	}
	roleOverrides.set(storeKey, copy(patch));
}

/** Clear every process-local override at a host session boundary. */
export function resetSessionRoleOverrides(): void {
	roleOverrides.clear();
}
