// Data-residency filtering over `provider/model` refs.
//
// One named whitelist ("EEA", "Global", …) is active at a time; the
// reserved state "off" (alias "none", case-insensitive) matches everything
// — residency has no opinion until a named filter is added on top. The
// user curates the lists — maestro applies them mechanically and never
// reasons about them. "Global" is deliberately NOT special: catalogs use
// Global as a real residency category, so it must be explicit.

import type { ModelsConfig } from "@vegardx/pi-contracts";

/** Reserved residency state: matches all models — the filter is off. */
export const RESIDENCY_OFF = "off";

export function isResidencyOff(name: string): boolean {
	const lower = name.toLowerCase();
	return lower === RESIDENCY_OFF || lower === "none";
}

/** The active residency name; "off" when unset. */
export function activeResidency(config: ModelsConfig | undefined): string {
	return config?.residency?.active ?? RESIDENCY_OFF;
}

/** All selectable residency names: "off" plus every configured list. */
export function residencyNames(config: ModelsConfig | undefined): string[] {
	return [RESIDENCY_OFF, ...Object.keys(config?.residency?.lists ?? {})];
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
	if (isResidencyOff(active)) return true;
	const list = config?.residency?.lists?.[active] ?? [];
	return list.some((pattern) => globMatch(pattern, modelId));
}

/** A configuration problem worth surfacing, or undefined when coherent. */
export function residencyError(
	config: ModelsConfig | undefined,
): string | undefined {
	const active = config?.residency?.active;
	if (!active || isResidencyOff(active)) return undefined;
	if (!config?.residency?.lists?.[active])
		return `active residency "${active}" has no configured list — all concrete models are excluded until it exists`;
	return undefined;
}
