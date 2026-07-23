// v2-native region filtering over `provider/model` refs (was "residency").
//
// One named allowlist ("EEA", "Global", …) is active at a time; the reserved
// state "off" (alias "none", case-insensitive) matches everything — region has
// no opinion until a named filter is added on top. The user curates the lists;
// maestro applies them mechanically and never reasons about them. Sourced from
// the v2 `models.region` slice, not the v1 residency block.

import type { RegionConfig } from "@vegardx/pi-contracts";

/** Reserved region state: matches all models — the filter is off. */
export const REGION_OFF = "off";

export function isRegionOff(name: string): boolean {
	const lower = name.toLowerCase();
	return lower === REGION_OFF || lower === "none";
}

/** The active region name; "off" when unset. */
export function activeRegion(region: RegionConfig | undefined): string {
	return region?.active ?? REGION_OFF;
}

/** All selectable region names: "off" plus every configured list. */
export function regionNames(region: RegionConfig | undefined): string[] {
	return [REGION_OFF, ...Object.keys(region?.lists ?? {})];
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
 * Whether `modelId` is allowed under the active region. Off allows everything;
 * otherwise the model must match a pattern in the active list. FAIL-CLOSED: an
 * active name with no configured list (a typo) allows nothing — for a
 * data-boundary filter, stranding the fleet on the session model beats
 * silently letting everything through. `regionError` surfaces the typo.
 */
export function modelAllowedByRegion(
	region: RegionConfig | undefined,
	modelId: string,
): boolean {
	const active = activeRegion(region);
	if (isRegionOff(active)) return true;
	const list = region?.lists?.[active] ?? [];
	return list.some((pattern) => globMatch(pattern, modelId));
}

/** A configuration problem worth surfacing, or undefined when coherent. */
export function regionError(
	region: RegionConfig | undefined,
): string | undefined {
	const active = region?.active;
	if (!active || isRegionOff(active)) return undefined;
	if (!region?.lists?.[active])
		return `active region "${active}" has no configured list — all concrete models are excluded until it exists`;
	return undefined;
}
