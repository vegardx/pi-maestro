// Data-residency filtering over `provider/model` refs.
//
// One named whitelist ("EEA", …) is active at a time; the reserved name
// "global" (case-insensitive) matches everything. The user curates the
// lists — maestro applies them mechanically and never reasons about them.

import type { ModelsConfig } from "@vegardx/pi-contracts";

/** Reserved residency name: matches all models — the filter is off. */
export const GLOBAL_RESIDENCY = "global";

export function isGlobalResidency(name: string): boolean {
	return name.toLowerCase() === GLOBAL_RESIDENCY;
}

/** The active residency name; "global" when unset. */
export function activeResidency(config: ModelsConfig | undefined): string {
	return config?.residency?.active ?? GLOBAL_RESIDENCY;
}

/** All selectable residency names: "global" plus every configured list. */
export function residencyNames(config: ModelsConfig | undefined): string[] {
	return [GLOBAL_RESIDENCY, ...Object.keys(config?.residency?.lists ?? {})];
}

/** `*`-wildcard glob over a full `provider/model` ref. */
function globMatch(pattern: string, modelId: string): boolean {
	const regex = new RegExp(
		`^${pattern
			.split("*")
			.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*")}$`,
	);
	return regex.test(modelId);
}

/**
 * Whether `modelId` is allowed under the active residency. Global allows
 * everything; otherwise the model must match a pattern in the active list.
 * FAIL-CLOSED: an active name with no configured list (a typo) allows
 * nothing — for a data-boundary filter, stranding the fleet on the session
 * model beats silently letting everything through. `residencyError`
 * surfaces the misconfiguration.
 */
export function modelAllowedByResidency(
	config: ModelsConfig | undefined,
	modelId: string,
): boolean {
	const active = activeResidency(config);
	if (isGlobalResidency(active)) return true;
	const list = config?.residency?.lists?.[active] ?? [];
	return list.some((pattern) => globMatch(pattern, modelId));
}

/** A configuration problem worth surfacing, or undefined when coherent. */
export function residencyError(
	config: ModelsConfig | undefined,
): string | undefined {
	const active = config?.residency?.active;
	if (!active || isGlobalResidency(active)) return undefined;
	if (!config?.residency?.lists?.[active])
		return `active residency "${active}" has no configured list — all concrete models are excluded until it exists`;
	return undefined;
}
