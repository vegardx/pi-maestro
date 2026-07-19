// Interactive /maestro entry: a select-driven EDITOR over the maestro
// configuration domains. Every page is a select loop (works in the TUI and
// over RPC via extension_ui_request); edits go through the validated domain
// writer (writeDomainValue → global scope), so the menu can never write a
// shape the scripted /maestro set path would reject. Esc backs out of any
// page; the plain notify summary remains the no-select fallback.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getSessionSettingOverride,
	MODEL_ROLES,
	setSessionSettingOverride,
} from "@vegardx/pi-contracts";
import {
	activeResidency,
	isResidencyOff,
	RESIDENCY_OFF,
	readModelsConfig,
	residencyError,
	residencyNames,
} from "@vegardx/pi-models";
import {
	type DomainRegistryInput,
	readDomainSnapshot,
	writeDomainValue,
} from "./domain.js";
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

type Snapshot = ReturnType<typeof readDomainSnapshot>;
type SelectFn = (
	title: string,
	options: string[],
) => Promise<string | undefined>;
type InputFn = (
	title: string,
	placeholder?: string,
) => Promise<string | undefined>;
type ConfirmFn = (title: string, message: string) => Promise<boolean>;

interface Dialogs {
	readonly select: SelectFn;
	readonly input?: InputFn;
	readonly confirm?: ConfirmFn;
}

function dialogs(ctx: ExtensionContext): Dialogs | undefined {
	if (!ctx.hasUI || !ctx.ui.select) return undefined;
	return {
		select: ctx.ui.select.bind(ctx.ui) as SelectFn,
		input: ctx.ui.input?.bind(ctx.ui) as InputFn | undefined,
		confirm: ctx.ui.confirm?.bind(ctx.ui) as ConfirmFn | undefined,
	};
}

const AUTO_EFFORT = "auto — the planner chooses";
const EFFORTS = [
	AUTO_EFFORT,
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

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
	// the snapshot swallows read errors, so probe explicitly first.
	try {
		readModelsConfig(ctx.cwd);
	} catch (cause) {
		ctx.ui.notify(
			`Maestro model settings could not be read: ${cause instanceof Error ? cause.message : String(cause)}\nFix the models block in settings.json; the menu shows only what parses.`,
			"warning",
		);
	}
	if (!ui) {
		notifySummary(ctx, readDomainSnapshot(ctx, registry));
		return;
	}
	// Esc/cancel anywhere exits the menu (select resolves undefined). The
	// snapshot is re-read every iteration so edits show immediately.
	while (true) {
		const snapshot = readDomainSnapshot(ctx, registry);
		const config = safeModelsConfig(ctx);
		const choice = await ui.select(
			`Maestro configuration — preset: ${snapshot.activePreset ?? "session fallback"}`,
			[
				`Model sets (${snapshot.modelSets.length})`,
				`Presets (${snapshot.presets.length})`,
				`Residency (${config?.residency ? activeResidency(config) : "not configured"})`,
				`Agent kinds (${snapshot.kinds.length})`,
				`Runtime policies (${snapshot.runtimePolicies.length})`,
				`Transition gates (${snapshot.gates.length})`,
				"Summary",
			],
		);
		if (!choice) return;
		if (choice.startsWith("Model sets")) await browseModelSets(ctx, ui);
		else if (choice.startsWith("Presets")) await browsePresets(ctx, ui);
		else if (choice.startsWith("Residency")) await browseResidency(ctx);
		else if (choice.startsWith("Agent kinds"))
			await browseKinds(ctx, ui, registry);
		else if (choice.startsWith("Runtime policies"))
			await browsePolicies(ctx, ui, registry);
		else if (choice.startsWith("Transition gates"))
			await browseGates(ctx, ui, registry);
		else notifySummary(ctx, readDomainSnapshot(ctx, registry));
	}
}

function safeModelsConfig(ctx: ExtensionContext) {
	try {
		return readModelsConfig(ctx.cwd);
	} catch {
		return undefined;
	}
}

// ─── Model sets ──────────────────────────────────────────────────────────────

const ADD_OPTION = "+ Add option…";
const USAGE_DETAIL = "Where is this set used?";

/** "preset X · role" entries → "X (3 roles), Y (1 role)". */
function formatUsedBy(usedBy: readonly string[]): string {
	const byPreset = new Map<string, number>();
	for (const entry of usedBy) {
		const match = /^preset (.+) · /.exec(entry);
		const preset = match?.[1] ?? entry;
		byPreset.set(preset, (byPreset.get(preset) ?? 0) + 1);
	}
	return [...byPreset.entries()]
		.map(
			([preset, count]) => `${preset} (${count} role${count === 1 ? "" : "s"})`,
		)
		.join(", ");
}

/** Grouped multi-line usage breakdown for the detail notify. */
function usedByDetail(usedBy: readonly string[]): string[] {
	const byPreset = new Map<string, string[]>();
	for (const entry of usedBy) {
		const match = /^preset (.+) · (.+)$/.exec(entry);
		const preset = match?.[1] ?? entry;
		const role = match?.[2] ?? "";
		const bucket = byPreset.get(preset) ?? [];
		if (role) bucket.push(role);
		byPreset.set(preset, bucket);
	}
	return [...byPreset.entries()].map(
		([preset, roles]) => `  ${preset}: ${roles.join(", ")}`,
	);
}
const REMOVE_OPTION = "− Remove option…";
const NEW_SET = "+ New model set…";
const DELETE_MARK = "✕ Delete";

/** Toggle-select a subset of thinking levels; undefined = no limit. */
async function pickEffortLimits(
	ctx: ExtensionContext,
	ui: Dialogs,
): Promise<string[] | undefined> {
	const scope = await ui.select("Limit the allowed levels for this option?", [
		"All the model supports",
		"Pick levels…",
	]);
	if (!scope || scope.startsWith("All")) return undefined;
	const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	if (supportsMultiSelect(ctx)) {
		const chosen = await multiSelect(
			ctx,
			"Allowed levels for this option",
			levels.map((level) => ({ id: level, label: level, checked: false })),
		);
		return chosen?.length ? chosen : undefined;
	}
	const chosen = new Set<string>();
	while (true) {
		const picked = await ui.select(
			"Allowed levels — pick to toggle, Esc when done",
			levels.map((level) => `${chosen.has(level) ? "✓" : "✗"} ${level}`),
		);
		if (!picked) break;
		const level = picked.slice(2);
		if (chosen.has(level)) chosen.delete(level);
		else chosen.add(level);
	}
	return chosen.size ? levels.filter((level) => chosen.has(level)) : undefined;
}

/**
 * Pick a model ref via the registry: session → provider → model, with a
 * manual-entry escape hatch for models pi has not cached yet.
 */
async function pickModelRef(
	ctx: ExtensionContext,
	ui: Dialogs,
): Promise<string | undefined> {
	const SESSION_ENTRY = "session — the live session model";
	const MANUAL_ENTRY = "Type a ref manually… (provider/model)";
	const providers = await modelsByProvider(ctx);
	while (true) {
		const picked = await ui.select("Model for this option", [
			SESSION_ENTRY,
			...[...providers.entries()].map(
				([provider, ids]) => `${provider} — ${ids.length} model(s)`,
			),
			MANUAL_ENTRY,
		]);
		if (!picked) return undefined;
		if (picked === SESSION_ENTRY) return "session";
		if (picked === MANUAL_ENTRY) {
			if (!ui.input) return undefined;
			const typed = (
				await ui.input("Model ref (provider/model)", "provider/model")
			)?.trim();
			if (typed) return typed;
			continue;
		}
		const provider = picked.split(" ")[0];
		const ids = providers.get(provider) ?? [];
		const id = await ui.select(`${provider} — which model?`, ids);
		if (id) return `${provider}/${id}`;
		// Esc from the model list returns to the provider picker.
	}
}

/**
 * Prompt the fields of one model-set option. The option id is auto-derived
 * from the model name — the stable handle /models rows, assignments, and
 * agent-kind pins refer to — and only prompted on a collision within the
 * set. Undefined = cancelled.
 */
async function buildOption(
	ctx: ExtensionContext,
	ui: Dialogs,
	takenIds: readonly string[],
): Promise<
	| {
			id: string;
			model: string;
			effort: string;
			summary: string;
			efforts?: string[];
	  }
	| undefined
> {
	if (!ui.input) {
		ctx.ui.notify(
			"This surface has no input dialog — use /maestro set models.modelSets.<id> <json>.",
			"warning",
		);
		return undefined;
	}
	const model = await pickModelRef(ctx, ui);
	if (!model) return undefined;
	const effortPick = await ui.select("Effort", EFFORTS);
	if (!effortPick) return undefined;
	const effort = effortPick === AUTO_EFFORT ? "auto" : effortPick;
	const efforts =
		effort === "auto" ? await pickEffortLimits(ctx, ui) : undefined;
	const summary = (
		await ui.input("Summary — what should the planner know about this option?")
	)?.trim();
	if (!summary) return undefined;
	const derived =
		model === "session"
			? "own"
			: (model.split("/").pop() ?? "option").replace(/[^A-Za-z0-9._-]+/g, "-");
	let id = derived;
	if (takenIds.includes(id)) {
		id =
			(await ui.input(`Option id (${derived} is taken)`, derived))?.trim() ??
			"";
		if (!id || takenIds.includes(id)) return undefined;
	}
	return { id, model, effort, summary, ...(efforts ? { efforts } : {}) };
}

async function browseModelSets(
	ctx: ExtensionContext,
	ui: Dialogs,
): Promise<void> {
	while (true) {
		const snapshot = readDomainSnapshot(ctx);
		const picked = await ui.select("Model sets (Esc to go back)", [
			...snapshot.modelSets.map(
				(s) =>
					`${s.id} — ${s.options.length} option(s)${s.usedBy.length ? ` · used by ${formatUsedBy(s.usedBy)}` : " · unused"}`,
			),
			NEW_SET,
		]);
		if (!picked) return;
		if (picked === NEW_SET) {
			if (!ui.input) continue;
			const name = (await ui.input("New model set name"))?.trim();
			if (!name) continue;
			const option = await buildOption(ctx, ui, []);
			if (!option) continue;
			write(ctx, `models.modelSets.${name}`, { options: [option] });
			continue;
		}
		const setId = snapshot.modelSets.find((s) =>
			picked.startsWith(`${s.id} `),
		)?.id;
		if (setId) await editModelSet(ctx, ui, setId);
	}
}

async function editModelSet(
	ctx: ExtensionContext,
	ui: Dialogs,
	setId: string,
): Promise<void> {
	while (true) {
		const set = readDomainSnapshot(ctx).modelSets.find((s) => s.id === setId);
		if (!set) return;
		const picked = await ui.select(
			`Model set ${setId} — first available wins; \`session\` sorts to the back`,
			[
				...set.options.map(
					(o) => `${o.id}: ${o.model} @${o.effort} — ${o.summary}`,
				),
				...(set.usedBy.length ? [USAGE_DETAIL] : []),
				ADD_OPTION,
				REMOVE_OPTION,
				`${DELETE_MARK} set ${setId}…`,
			],
		);
		if (!picked) return;
		if (picked === USAGE_DETAIL) {
			ctx.ui.notify(
				[`Model set ${setId} is used by:`, ...usedByDetail(set.usedBy)].join(
					"\n",
				),
				"info",
			);
			continue;
		}
		if (picked === ADD_OPTION) {
			const option = await buildOption(
				ctx,
				ui,
				set.options.map((o) => o.id),
			);
			if (option)
				write(ctx, `models.modelSets.${setId}`, {
					options: [...set.options, option],
				});
		} else if (picked === REMOVE_OPTION) {
			const victim = await ui.select(
				"Remove which option?",
				set.options.map((o) => o.id),
			);
			if (!victim) continue;
			if (set.options.length === 1) {
				ctx.ui.notify(
					"A model set cannot be empty — delete the whole set instead.",
					"warning",
				);
				continue;
			}
			write(ctx, `models.modelSets.${setId}`, {
				options: set.options.filter((o) => o.id !== victim),
			});
		} else if (picked.startsWith(DELETE_MARK)) {
			if (set.usedBy.length) {
				ctx.ui.notify(
					`Still referenced by ${formatUsedBy(set.usedBy)}. Unmap those roles first.`,
					"warning",
				);
				continue;
			}
			if ((await ui.confirm?.("Delete model set", `Delete ${setId}?`)) ?? true)
				if (write(ctx, `models.modelSets.${setId}`, null)) return;
		}
	}
}

// ─── Presets ─────────────────────────────────────────────────────────────────

const NEW_PRESET = "+ New preset…";
const ADD_TARGET = "+ Add model…";
const REMOVE_TARGET = "− Remove model…";
const UNSET = "none — use the session model";

async function browsePresets(
	ctx: ExtensionContext,
	ui: Dialogs,
): Promise<void> {
	while (true) {
		const snapshot = readDomainSnapshot(ctx);
		const picked = await ui.select("Presets (Esc to go back)", [
			...snapshot.presets.map(
				(preset) =>
					`${preset.id}${preset.id === snapshot.activePreset ? " (active)" : ""} — ${preset.targets.length} model(s), ${Object.keys(preset.modelSets).length} role mapping(s)`,
			),
			NEW_PRESET,
		]);
		if (!picked) return;
		if (picked === NEW_PRESET) {
			if (!ui.input) continue;
			const id = (await ui.input("New preset name"))?.trim();
			if (!id) continue;
			const target = (
				await ui.input("First model target (provider/model)")
			)?.trim();
			if (!target) continue;
			write(ctx, `models.presets.${id}`, { targets: [target], modelSets: {} });
			continue;
		}
		const preset = snapshot.presets.find((p) => picked.startsWith(p.id));
		if (preset) await editPreset(ctx, ui, preset.id);
	}
}

async function editPreset(
	ctx: ExtensionContext,
	ui: Dialogs,
	presetId: string,
): Promise<void> {
	while (true) {
		const preset = readDomainSnapshot(ctx).presets.find(
			(p) => p.id === presetId,
		);
		if (!preset) return;
		const picked = await ui.select(`Preset ${presetId}`, [
			`Models (${preset.targets.length}) — session models that activate this preset`,
			`Role mappings (${Object.keys(preset.modelSets).length}) — role → model set`,
			`${DELETE_MARK} preset ${presetId}…`,
		]);
		if (!picked) return;
		if (picked.startsWith("Models")) await editTargets(ctx, ui, presetId);
		else if (picked.startsWith("Role mappings"))
			await editRoleMappings(ctx, ui, presetId);
		else if (picked.startsWith(DELETE_MARK)) {
			if ((await ui.confirm?.("Delete preset", `Delete ${presetId}?`)) ?? true)
				if (write(ctx, `models.presets.${presetId}`, null)) return;
		}
	}
}

async function editTargets(
	ctx: ExtensionContext,
	ui: Dialogs,
	presetId: string,
): Promise<void> {
	while (true) {
		const preset = readDomainSnapshot(ctx).presets.find(
			(p) => p.id === presetId,
		);
		if (!preset) return;
		const picked = await ui.select(`Preset ${presetId} — models`, [
			...preset.targets,
			ADD_TARGET,
			REMOVE_TARGET,
		]);
		if (!picked) return;
		if (picked === ADD_TARGET) {
			if (!ui.input) continue;
			const target = (await ui.input("Model (provider/model)"))?.trim();
			if (target)
				write(ctx, `models.presets.${presetId}.targets`, [
					...preset.targets,
					target,
				]);
		} else if (picked === REMOVE_TARGET) {
			const victim = await ui.select("Remove which model?", [
				...preset.targets,
			]);
			if (!victim) continue;
			const remaining = preset.targets.filter((t) => t !== victim);
			if (remaining.length === 0) {
				ctx.ui.notify(
					"A preset needs at least one model — delete the preset instead.",
					"warning",
				);
				continue;
			}
			write(ctx, `models.presets.${presetId}.targets`, remaining);
		}
	}
}

async function editRoleMappings(
	ctx: ExtensionContext,
	ui: Dialogs,
	presetId: string,
): Promise<void> {
	while (true) {
		const snapshot = readDomainSnapshot(ctx);
		const preset = snapshot.presets.find((p) => p.id === presetId);
		if (!preset) return;
		const picked = await ui.select(
			`Preset ${presetId} — role → model set (pick a role to change)`,
			MODEL_ROLES.map(
				(role) =>
					`${role} → ${preset.modelSets[role] ?? "none (session model)"}`,
			),
		);
		if (!picked) return;
		const role = picked.split(" ")[0];
		const setId = await ui.select(`${role} → which model set?`, [
			UNSET,
			...snapshot.modelSets.map((s) => s.id),
		]);
		if (!setId) continue;
		const next: Record<string, string> = { ...preset.modelSets };
		if (setId === UNSET) delete next[role];
		else next[role] = setId;
		write(ctx, `models.presets.${presetId}.modelSets`, next);
	}
}

// ─── Residency ───────────────────────────────────────────────────────────────

const NEW_LIST = "+ New list…";
const EDIT_MODELS = "Edit models by provider…";
const RENAME_LIST = "Rename…";

/** All registry models grouped by provider (the same catalog /model shows). */
async function modelsByProvider(
	ctx: ExtensionContext,
): Promise<Map<string, string[]>> {
	const registry = ctx.modelRegistry as unknown as {
		getAll?: () => { provider: string; id: string }[];
		getApiKeyAndHeaders?: (model: {
			provider: string;
			id: string;
		}) => Promise<{ ok: boolean }>;
	};
	const grouped = new Map<string, string[]>();
	const firstModel = new Map<string, { provider: string; id: string }>();
	for (const model of registry.getAll?.() ?? []) {
		const bucket = grouped.get(model.provider) ?? [];
		bucket.push(model.id);
		grouped.set(model.provider, bucket);
		if (!firstModel.has(model.provider)) firstModel.set(model.provider, model);
	}
	// Only CONFIGURED providers — pi's built-in catalog knows about far
	// more providers than this install uses. getProviderAuthStatus is the
	// authoritative signal (getApiKeyAndHeaders answers ok:true for KNOWN
	// providers even with no credential, which is why an ok-probe filtered
	// nothing). Async credential probe is the fallback for older surfaces;
	// if everything filters out, show all rather than none.
	const authStatus = (
		ctx.modelRegistry as unknown as {
			getProviderAuthStatus?: (provider: string) => { configured: boolean };
		}
	).getProviderAuthStatus;
	const configured = new Set<string>();
	if (authStatus) {
		for (const provider of grouped.keys()) {
			try {
				if (authStatus.call(ctx.modelRegistry, provider).configured)
					configured.add(provider);
			} catch {
				// unknown to the status surface — treated as unconfigured
			}
		}
	} else if (registry.getApiKeyAndHeaders) {
		const probes = await Promise.all(
			[...firstModel.entries()].map(async ([provider, model]) => {
				try {
					const auth = (await registry.getApiKeyAndHeaders?.(model)) as
						| { ok: boolean; apiKey?: string; headers?: Record<string, string> }
						| undefined;
					const hasCredential = Boolean(
						auth?.ok && (auth.apiKey || Object.keys(auth.headers ?? {}).length),
					);
					return { provider, ok: hasCredential };
				} catch {
					return { provider, ok: false };
				}
			}),
		);
		for (const probe of probes) if (probe.ok) configured.add(probe.provider);
	}
	if (configured.size > 0) {
		for (const provider of [...grouped.keys()])
			if (!configured.has(provider)) grouped.delete(provider);
	}
	for (const bucket of grouped.values()) bucket.sort();
	return new Map([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

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

// ─── Agent kinds ─────────────────────────────────────────────────────────────

/**
 * Agent kinds are the classes of agent the maestro spawns (worker, the
 * review kinds, research, …). Each kind binds a runtime policy (what it may
 * do) and optionally a model set / pinned option (what it runs on). This
 * page edits those bindings; the definitions themselves ship with the
 * harness.
 */
async function browseKinds(
	ctx: ExtensionContext,
	ui: Dialogs,
	registry: DomainRegistryInput,
): Promise<void> {
	while (true) {
		const snapshot = readDomainSnapshot(ctx, registry);
		const picked = await ui.select(
			"Agent kinds — what maestro spawns; each binds a policy + model set",
			snapshot.kinds.map(
				(k) =>
					`${k.kind} — policy ${k.runtimePolicy}${k.modelSet ? ` · set ${k.modelSet}` : ""}${k.option ? ` · option ${k.option}` : ""} (${k.source})`,
			),
		);
		if (!picked) return;
		const kind = picked.split(" ")[0];
		await editKind(ctx, ui, registry, kind);
	}
}

async function editKind(
	ctx: ExtensionContext,
	ui: Dialogs,
	registry: DomainRegistryInput,
	kind: string,
): Promise<void> {
	while (true) {
		const snapshot = readDomainSnapshot(ctx, registry);
		const binding = snapshot.kinds.find((k) => k.kind === kind);
		if (!binding) return;
		const picked = await ui.select(`Agent kind ${kind}`, [
			`Runtime policy: ${binding.runtimePolicy} — change…`,
			`Model set: ${binding.modelSet ?? "—"} — change…`,
			`Pinned option: ${binding.option ?? "—"} — change…`,
			"Explain (full definition)",
		]);
		if (!picked) return;
		if (picked.startsWith("Runtime policy")) {
			const policy = await ui.select(
				`${kind} → runtime policy`,
				snapshot.runtimePolicies.map((p) => p.id),
			);
			if (policy) write(ctx, `agents.kinds.${kind}.runtimePolicy`, policy);
		} else if (picked.startsWith("Model set")) {
			const setId = await ui.select(`${kind} → model set`, [
				UNSET,
				...snapshot.modelSets.map((s) => s.id),
			]);
			if (!setId) continue;
			write(
				ctx,
				`agents.kinds.${kind}.modelSet`,
				setId === UNSET ? null : setId,
			);
		} else if (picked.startsWith("Pinned option")) {
			const set = snapshot.modelSets.find((s) => s.id === binding.modelSet);
			if (!set) {
				ctx.ui.notify("Bind a model set first.", "warning");
				continue;
			}
			const option = await ui.select(`${kind} → pinned option`, [
				UNSET,
				...set.options.map((o) => o.id),
			]);
			if (!option) continue;
			write(
				ctx,
				`agents.kinds.${kind}.option`,
				option === UNSET ? null : option,
			);
		} else {
			ctx.ui.notify(`Full definition: /maestro explain ${kind}`, "info");
		}
	}
}

// ─── Runtime policies ────────────────────────────────────────────────────────

const NEW_POLICY = "+ New policy…";

async function browsePolicies(
	ctx: ExtensionContext,
	ui: Dialogs,
	registry: DomainRegistryInput,
): Promise<void> {
	while (true) {
		const snapshot = readDomainSnapshot(ctx, registry);
		const picked = await ui.select(
			"Runtime policies — what a spawned agent may do (pick to edit)",
			[
				...snapshot.runtimePolicies.map(
					(p) =>
						`${p.id} — permissions=${p.permissions} session=${p.session} transport=${p.transport}`,
				),
				NEW_POLICY,
			],
		);
		if (!picked) return;
		if (picked === NEW_POLICY) {
			if (!ui.input) continue;
			const id = (await ui.input("New policy id"))?.trim();
			if (!id) continue;
			const built = await buildPolicy(ui, snapshot);
			if (built) write(ctx, `agents.runtimePolicies.${id}`, built);
			continue;
		}
		const id = picked.split(" ")[0];
		await editPolicy(ctx, ui, registry, id);
	}
}

async function buildPolicy(
	ui: Dialogs,
	snapshot: Snapshot,
): Promise<
	{ permissions: string; session: string; transport: string } | undefined
> {
	const permissions = await ui.select(
		"Permissions",
		snapshot.permissions.map((p) => p.id),
	);
	if (!permissions) return undefined;
	const session = await ui.select(
		"Session policy",
		snapshot.sessions.map((s) => s.id),
	);
	if (!session) return undefined;
	const transport = await ui.select(
		"Transport",
		snapshot.transports.map((t) => t.id),
	);
	if (!transport) return undefined;
	return { permissions, session, transport };
}

async function editPolicy(
	ctx: ExtensionContext,
	ui: Dialogs,
	registry: DomainRegistryInput,
	id: string,
): Promise<void> {
	while (true) {
		const snapshot = readDomainSnapshot(ctx, registry);
		const policy = snapshot.runtimePolicies.find((p) => p.id === id);
		if (!policy) return;
		const picked = await ui.select(`Runtime policy ${id}`, [
			`Permissions: ${policy.permissions} — change…`,
			`Session: ${policy.session} — change…`,
			`Transport: ${policy.transport} — change…`,
			`${DELETE_MARK} settings override for ${id}…`,
		]);
		if (!picked) return;
		if (picked.startsWith(DELETE_MARK)) {
			const sure =
				(await ui.confirm?.(
					"Remove policy override",
					`Remove the settings override for ${id}? A built-in policy reverts to its shipped definition.`,
				)) ?? true;
			if (sure && write(ctx, `agents.runtimePolicies.${id}`, null)) return;
			continue;
		}
		const field = picked.startsWith("Permissions")
			? "permissions"
			: picked.startsWith("Session")
				? "session"
				: "transport";
		const choices =
			field === "permissions"
				? snapshot.permissions.map((p) => p.id)
				: field === "session"
					? snapshot.sessions.map((s) => s.id)
					: snapshot.transports.map((t) => t.id);
		const value = await ui.select(`${id} → ${field}`, choices);
		if (!value) continue;
		// The whole object is written so cross-field safety rules re-validate.
		write(ctx, `agents.runtimePolicies.${id}`, { ...policy, [field]: value });
	}
}

// ─── Transition gates ────────────────────────────────────────────────────────

async function browseGates(
	ctx: ExtensionContext,
	ui: Dialogs,
	registry: DomainRegistryInput,
): Promise<void> {
	while (true) {
		const snapshot = readDomainSnapshot(ctx, registry);
		if (snapshot.gates.length === 0) {
			ctx.ui.notify("No transition gates configured.", "info");
			return;
		}
		const picked = await ui.select(
			"Transition gates — reviews that run on mode edges (pick to edit)",
			snapshot.gates.map(
				(g) =>
					`${g.id} — ${g.edges.join("/")} via ${g.agentKind} (${g.contract}) ${g.enabled ? "on" : "off"}`,
			),
		);
		if (!picked) return;
		const gate = snapshot.gates.find((g) => picked.startsWith(`${g.id} `));
		if (gate) await editGate(ctx, ui, registry, gate.id);
	}
}

async function editGate(
	ctx: ExtensionContext,
	ui: Dialogs,
	registry: DomainRegistryInput,
	id: string,
): Promise<void> {
	while (true) {
		const snapshot = readDomainSnapshot(ctx, registry);
		const gate = snapshot.gates.find((g) => g.id === id);
		if (!gate) return;
		const picked = await ui.select(`Gate ${id} — ${gate.edges.join(", ")}`, [
			`Enabled: ${gate.enabled ? "on" : "off"} — toggle`,
			`Agent kind: ${gate.agentKind} — change…`,
			`Contract: ${gate.contract} — change…`,
		]);
		if (!picked) return;
		if (picked.startsWith("Enabled")) {
			write(ctx, `transitionGates.${id}`, {
				...gate,
				enabled: !gate.enabled,
			});
		} else if (picked.startsWith("Agent kind")) {
			const kind = await ui.select(
				`${id} → agent kind`,
				snapshot.kindDefinitions.map((k) => k.id),
			);
			if (!kind) continue;
			const definition = snapshot.kindDefinitions.find((k) => k.id === kind);
			const contract = definition?.contracts.some((c) => c.id === gate.contract)
				? gate.contract
				: (definition?.contracts[0]?.id ?? gate.contract);
			write(ctx, `transitionGates.${id}`, {
				...gate,
				agentKind: kind,
				contract,
			});
		} else if (picked.startsWith("Contract")) {
			const definition = snapshot.kindDefinitions.find(
				(k) => k.id === gate.agentKind,
			);
			if (!definition?.contracts.length) {
				ctx.ui.notify(
					`Agent kind ${gate.agentKind} declares no contracts.`,
					"warning",
				);
				continue;
			}
			const contract = await ui.select(
				`${id} → contract`,
				definition.contracts.map((c) => c.id),
			);
			if (contract) write(ctx, `transitionGates.${id}`, { ...gate, contract });
		}
	}
}

// ─── Fallback summary ────────────────────────────────────────────────────────

function notifySummary(ctx: ExtensionContext, snapshot: Snapshot): void {
	ctx.ui.notify(
		[
			"Maestro configuration",
			`Active preset: ${snapshot.activePreset ?? "session fallback"}`,
			`Exact model sets: ${snapshot.modelSets.length}`,
			`Agent kinds: ${snapshot.kinds.length}`,
			`Runtime policies: ${snapshot.runtimePolicies.length}`,
			`Transition gates: ${snapshot.gates.length}`,
			"",
			"Use /maestro explain <kind>, /maestro validate, or /maestro set <domain-key> <json>.",
		].join("\n"),
		"info",
	);
}
