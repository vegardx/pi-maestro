// Interactive /maestro entry: a select-driven EDITOR over the maestro
// configuration domains. Every page is a select loop (works in the TUI and
// over RPC via extension_ui_request); edits go through validated write
// paths, so the menu can never write a shape the scripted /maestro set path
// would reject. Esc backs out of any page; the plain notify summary remains
// the no-select fallback.
//
// v2 sections only (design §v1→v2 mapping): profiles/catalogs, agent tiers,
// the policy table, and residency. The v1 preset/model-set screens are
// RETIRED — the v1→v2 migration derives catalogs/profiles automatically,
// and the v1 CONFIG read paths in pi-models stay for fallback resolution;
// only the editing skin is gone. A one-line pointer says so when legacy
// keys are still present. Scripted access to v1 keys remains via
// /maestro set (command.ts).

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getSessionSettingOverride,
	setSessionSettingOverride,
	type V2ModelsConfig,
} from "@vegardx/pi-contracts";
import {
	activeResidency,
	activeV2Profile,
	isResidencyOff,
	RESIDENCY_OFF,
	readModelsConfig,
	readV2Config,
	residencyError,
	residencyNames,
} from "@vegardx/pi-models";
import { type DomainRegistryInput, writeDomainValue } from "./domain.js";
import { browseAgentTiers } from "./menu-agents.js";
import { browseProfilesCatalogs } from "./menu-catalogs.js";
import { browsePolicyTable, readSettingsPolicyTable } from "./menu-policies.js";
import {
	DELETE_MARK,
	type Dialogs,
	dialogs,
	modelsByProvider,
} from "./menu-shared.js";
import { sessionModelId } from "./model.js";
import { multiSelect, supportsMultiSelect } from "./multi-select.js";

export function getSessionSetting(extension: string, key: string) {
	return getSessionSettingOverride(extension, key);
}

export function setSessionSetting(
	extension: string,
	key: string,
	value: boolean | string | number | readonly string[] | undefined,
): void {
	setSessionSettingOverride(extension, key, value);
}

/** Write through the validated domain path (global scope); notify errors. */
function write(ctx: ExtensionContext, key: string, value: unknown): boolean {
	const errors = writeDomainValue(
		ctx,
		key,
		"global",
		value === null ? "null" : JSON.stringify(value),
	);
	if (errors.length) {
		ctx.ui.notify(errors.map((error) => `- ${error}`).join("\n"), "warning");
		return false;
	}
	return true;
}

export async function showConfigMenu(
	ctx: ExtensionContext,
	registry: DomainRegistryInput = {},
): Promise<void> {
	const ui = dialogs(ctx);
	// A malformed models block must read as guidance, not as an empty menu:
	// readers below swallow read errors, so probe explicitly first.
	let legacyConfig: ReturnType<typeof readModelsConfig>;
	try {
		legacyConfig = readModelsConfig(ctx.cwd);
	} catch (cause) {
		legacyConfig = undefined;
		ctx.ui.notify(
			`Maestro model settings could not be read: ${cause instanceof Error ? cause.message : String(cause)}\nFix the models block in settings.json; the menu shows only what parses.`,
			"warning",
		);
	}
	// The single pointer for surviving v1 keys: the migration already derived
	// the v2 shape; the old editing screens no longer exist.
	if (
		Object.keys(legacyConfig?.presets ?? {}).length > 0 ||
		Object.keys(legacyConfig?.modelSets ?? {}).length > 0
	) {
		ctx.ui.notify(
			"legacy presets detected — migrated automatically; v1 screens removed",
			"info",
		);
	}
	if (!ui) {
		notifySummary(ctx);
		return;
	}
	// Esc/cancel anywhere exits the menu (select resolves undefined). The
	// config is re-read every iteration so edits show immediately.
	while (true) {
		const config = safeModelsConfig(ctx);
		const v2 = safeV2Config(ctx);
		const active = activeV2Profile(v2, sessionModelId(ctx));
		const choice = await ui.select(
			`Maestro configuration — profile: ${active?.id ?? "none (everything inherits the seat)"}`,
			[
				`Profiles and catalogs (${Object.keys(v2?.profiles ?? {}).length} profile(s), ${Object.keys(v2?.catalogs ?? {}).length} catalog(s))`,
				"Agent tiers (worker, explorer, reviewer, advisor)",
				`Policies (${readSettingsPolicyTable(ctx.cwd).rows.length} rows)`,
				`Residency (${config?.residency ? activeResidency(config) : "not configured"})`,
				"Summary",
			],
		);
		if (!choice) return;
		if (choice.startsWith("Profiles and catalogs"))
			await browseProfilesCatalogs(ctx, ui);
		else if (choice.startsWith("Agent tiers")) await browseAgentTiers(ctx, ui);
		else if (choice.startsWith("Policies"))
			await browsePolicyTable(ctx, ui, registry);
		else if (choice.startsWith("Residency")) await browseResidency(ctx);
		else notifySummary(ctx);
	}
}

function safeV2Config(ctx: ExtensionContext): V2ModelsConfig | undefined {
	try {
		return readV2Config(ctx.cwd);
	} catch (cause) {
		ctx.ui.notify(
			`v2 model config could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
			"warning",
		);
		return undefined;
	}
}

function safeModelsConfig(ctx: ExtensionContext) {
	try {
		return readModelsConfig(ctx.cwd);
	} catch {
		return undefined;
	}
}

// ─── Residency ───────────────────────────────────────────────────────────────

const NEW_LIST = "+ New list…";
const EDIT_MODELS = "Edit models by provider…";
const RENAME_LIST = "Rename…";

/**
 * Residency editor: pick the active list, and curate the lists themselves —
 * per model, grouped by provider (no patterns in the UI; hand-authored
 * globs in settings stay honored by the matcher). "off" (alias "none") is
 * the reserved no-filter state; every named list, including one called
 * "Global", is explicit. Everything persists to global settings.
 */
export async function browseResidency(ctx: ExtensionContext): Promise<void> {
	const ui = dialogs(ctx);
	if (!ui) {
		ctx.ui.notify(
			'Residency needs an interactive surface. Scripted: /maestro residency <name>, or set models.residency.lists.<name> ["provider/model", …].',
			"info",
		);
		return;
	}
	while (true) {
		const config = safeModelsConfig(ctx);
		const names = residencyNames(config);
		const active = activeResidency(config);
		const problem = residencyError(config);
		const listNames = names.filter((name) => !isResidencyOff(name));
		const picked = await ui.select(
			`Residency — active: ${active}${problem ? ` (⚠ ${problem})` : ""}`,
			[
				`Active: ${active} — change…`,
				...listNames.map(
					(name) =>
						`${name} — ${config?.residency?.lists?.[name]?.length ?? 0} model(s)`,
				),
				NEW_LIST,
			],
		);
		if (!picked) return;
		if (picked.startsWith("Active:")) {
			const chosen = await ui.select("Set active residency", [
				`${RESIDENCY_OFF} — no filter`,
				...listNames,
			]);
			if (!chosen) continue;
			const name = chosen.startsWith(RESIDENCY_OFF) ? RESIDENCY_OFF : chosen;
			if (name !== active) setResidency(ctx, name);
		} else if (picked === NEW_LIST) {
			if (!ui.input) continue;
			const name = (await ui.input("New residency list name", "EEA"))?.trim();
			if (!name) continue;
			if (isResidencyOff(name)) {
				ctx.ui.notify(
					'"off"/"none" are reserved (the no-filter state).',
					"warning",
				);
				continue;
			}
			// Straight into the provider browser; the list is created on the
			// first toggle (an empty list is never written).
			await editResidencyMembers(ctx, ui, name);
		} else {
			const name = listNames.find((n) => picked.startsWith(`${n} `));
			if (name) await editResidencyList(ctx, ui, name);
		}
	}
}

async function editResidencyList(
	ctx: ExtensionContext,
	ui: Dialogs,
	name: string,
): Promise<void> {
	while (true) {
		const config = safeModelsConfig(ctx);
		const members = config?.residency?.lists?.[name];
		if (!members) return;
		const active = activeResidency(config);
		const picked = await ui.select(
			`Residency list ${name}${active === name ? " (active)" : ""} — ${members.length} model(s)`,
			[EDIT_MODELS, RENAME_LIST, `${DELETE_MARK} list ${name}…`],
		);
		if (!picked) return;
		if (picked === EDIT_MODELS) {
			await editResidencyMembers(ctx, ui, name);
		} else if (picked === RENAME_LIST) {
			if (!ui.input) continue;
			const next = (await ui.input("New name", name))?.trim();
			if (!next || next === name) continue;
			if (isResidencyOff(next)) {
				ctx.ui.notify('"off"/"none" are reserved.', "warning");
				continue;
			}
			if (!write(ctx, `models.residency.lists.${next}`, [...members])) continue;
			write(ctx, `models.residency.lists.${name}`, null);
			if (active === name) write(ctx, "models.residency.active", next);
			return;
		} else if (picked.startsWith(DELETE_MARK)) {
			const sure =
				(await ui.confirm?.("Delete residency list", `Delete ${name}?`)) ??
				true;
			if (!sure) continue;
			if (!write(ctx, `models.residency.lists.${name}`, null)) continue;
			if (active === name) {
				write(ctx, "models.residency.active", RESIDENCY_OFF);
				ctx.ui.notify(
					`Deleted the active list — residency is now ${RESIDENCY_OFF} (no filter).`,
					"info",
				);
			}
			return;
		}
	}
}

/** Provider picker → per-model ✓/✗ toggles. Each toggle writes the list. */
async function editResidencyMembers(
	ctx: ExtensionContext,
	ui: Dialogs,
	name: string,
): Promise<void> {
	const providers = await modelsByProvider(ctx);
	if (providers.size === 0) {
		ctx.ui.notify(
			'No models in the registry to pick from — add them via /maestro set models.residency.lists.<name> ["provider/model", …].',
			"warning",
		);
		return;
	}
	while (true) {
		const config = safeModelsConfig(ctx);
		const members = new Set(config?.residency?.lists?.[name] ?? []);
		const providerPick = await ui.select(
			`${name} — which provider?`,
			[...providers.entries()].map(([provider, ids]) => {
				const inList = ids.filter((id) =>
					members.has(`${provider}/${id}`),
				).length;
				return `${provider} — ${inList} of ${ids.length} in list`;
			}),
		);
		if (!providerPick) return;
		const provider = providerPick.split(" ")[0];
		const ids = providers.get(provider) ?? [];
		// Preferred surface: the checkbox overlay — space toggles, enter
		// applies the whole provider selection as ONE write, cursor stays put.
		if (supportsMultiSelect(ctx)) {
			const chosen = await multiSelect(
				ctx,
				`${name} · ${provider}`,
				ids.map((id) => ({
					id: `${provider}/${id}`,
					label: id,
					checked: members.has(`${provider}/${id}`),
				})),
			);
			if (chosen === undefined) continue; // cancelled — back to providers
			const next = new Set(
				[...members].filter((ref) => !ref.startsWith(`${provider}/`)),
			);
			for (const ref of chosen) next.add(ref);
			if (next.size === 0) {
				ctx.ui.notify(
					"A residency list cannot be empty — delete the list instead.",
					"warning",
				);
				continue;
			}
			write(ctx, `models.residency.lists.${name}`, [...next].sort());
			continue;
		}
		while (true) {
			const current = new Set(
				safeModelsConfig(ctx)?.residency?.lists?.[name] ?? [],
			);
			const inList = ids.filter((id) =>
				current.has(`${provider}/${id}`),
			).length;
			const ADD_ALL = `+ Add all ${ids.length} ${provider} model(s)`;
			const REMOVE_ALL = `− Remove all ${provider} model(s) from ${name}`;
			const picked = await ui.select(
				`${name} · ${provider} — pick to toggle, Esc when done`,
				[
					...(inList < ids.length ? [ADD_ALL] : []),
					...(inList > 0 ? [REMOVE_ALL] : []),
					...ids.map(
						(id) => `${current.has(`${provider}/${id}`) ? "✓" : "✗"} ${id}`,
					),
				],
			);
			if (!picked) break;
			const next = new Set(current);
			if (picked === ADD_ALL) {
				for (const id of ids) next.add(`${provider}/${id}`);
			} else if (picked === REMOVE_ALL) {
				for (const id of ids) next.delete(`${provider}/${id}`);
			} else {
				const ref = `${provider}/${picked.slice(2)}`;
				if (next.has(ref)) next.delete(ref);
				else next.add(ref);
			}
			if (next.size === 0) {
				ctx.ui.notify(
					"A residency list cannot be empty — delete the list instead.",
					"warning",
				);
				continue;
			}
			write(ctx, `models.residency.lists.${name}`, [...next].sort());
		}
	}
}

/** Persist the active residency to global settings and confirm. */
export function setResidency(ctx: ExtensionContext, name: string): void {
	const config = safeModelsConfig(ctx);
	// "none" is a forgiving alias for the canonical "off".
	const normalized = isResidencyOff(name) ? RESIDENCY_OFF : name;
	const names = residencyNames(config);
	if (!names.some((candidate) => candidate === normalized)) {
		ctx.ui.notify(
			`Unknown residency "${name}". Configured: ${names.join(", ")}`,
			"warning",
		);
		return;
	}
	if (!write(ctx, "models.residency.active", normalized)) return;
	ctx.ui.notify(
		`Residency → ${normalized}${isResidencyOff(normalized) ? " (all models, no filter)" : ""}. Fleet roles now resolve within it; /models shows the effect.`,
		"info",
	);
}

// ─── Fallback summary ────────────────────────────────────────────────────────

function notifySummary(ctx: ExtensionContext): void {
	const v2 = safeV2Config(ctx);
	const config = safeModelsConfig(ctx);
	const active = activeV2Profile(v2, sessionModelId(ctx));
	const table = readSettingsPolicyTable(ctx.cwd);
	ctx.ui.notify(
		[
			"Maestro configuration",
			`Active profile: ${active?.id ?? "none (everything inherits the seat)"}`,
			`Profiles: ${Object.keys(v2?.profiles ?? {}).length} · catalogs: ${Object.keys(v2?.catalogs ?? {}).length}`,
			`Policy rows: ${table.rows.length}`,
			`Residency: ${config?.residency ? activeResidency(config) : "not configured"}`,
			"",
			"Use /maestro explain <agent>, /maestro validate, or /maestro set <domain-key> <json>.",
		].join("\n"),
		"info",
	);
}
