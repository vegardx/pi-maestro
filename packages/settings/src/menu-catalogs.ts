// The /maestro "Profiles and catalogs" pages: full CRUD over the v2 model
// vocabulary (design §"Profile, catalog, residency"). Profiles are thin
// targets→catalog bindings; catalogs hold the three fixed-meaning tiers with
// per-entry model/effort/family/notes and a LIVE availability word computed
// per entry (available / not authenticated / not in registry / outside
// residency).
//
// Every write goes through updateSettingsFile AND must pass the v2 validator
// first: the candidate global settings object is parsed with the exact
// reader (parseV2Settings — entry shapes + cross-object rules) before any
// byte lands. An invalid state is unwriteable, with the validator's message
// shown; never write-then-warn. Canonical keys: models.catalogs.<name>,
// models.profiles.<name> (legacy models.catalog.<name> is migrated to the
// canonical key whenever the named catalog is rewritten).

import { readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	type CatalogEntry,
	TIER_IDS,
	type TierId,
	type V2ModelsConfig,
} from "@vegardx/pi-contracts";
import {
	activeV2Profile,
	explainCatalogEntry,
	modelAllowedByResidency,
	parseModelSpec,
	parseV2Settings,
	readModelsConfig,
	readV2Config,
	supportedEfforts,
	type V2CandidateFact,
} from "@vegardx/pi-models";
import {
	DELETE_MARK,
	type Dialogs,
	modelsByProvider,
	pickModelRef,
	THINKING_LEVELS,
} from "./menu-shared.js";
import { sessionModelId } from "./model.js";
import { multiSelect, supportsMultiSelect } from "./multi-select.js";
import { isPlainObject } from "./reader.js";
import { settingsPath, updateSettingsFile } from "./writer.js";

const NEW_PROFILE = "+ New profile…";
const NEW_CATALOG = "+ New catalog…";
const ADD_MODELS = "+ Add models…";
const ADD_TARGET = "+ Add model…";
const REMOVE_TARGET = "− Remove model…";
const RENAME = "Rename…";
const DEFAULT_PROFILE_TARGETS = "No targets — the default profile";
const PICK_TARGET = "Pick a target model…";
const MODEL_DEFAULT_EFFORT = "model default — no override";
const NOT_SET = "not set";

// ─── Validated write path ────────────────────────────────────────────────────

function readRawGlobal(cwd: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(
			readFileSync(settingsPath("global", cwd), "utf8"),
		);
		return isPlainObject(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * Apply `mutate` to the GLOBAL settings only if the resulting merged v2
 * config parses and validates. Returns false (with the validator's message
 * notified) when it does not — nothing is written in that case.
 */
export function writeV2Settings(
	ctx: ExtensionContext,
	mutate: (raw: Record<string, unknown>) => void,
): boolean {
	const candidate = structuredClone(readRawGlobal(ctx.cwd));
	mutate(candidate);
	try {
		parseV2Settings(
			candidate,
			SettingsManager.create(ctx.cwd).getProjectSettings() as unknown,
		);
	} catch (cause) {
		ctx.ui.notify(
			`Not written: ${cause instanceof Error ? cause.message : String(cause)}`,
			"warning",
		);
		return false;
	}
	updateSettingsFile("global", ctx.cwd, undefined, mutate);
	return true;
}

function modelsObject(raw: Record<string, unknown>): Record<string, unknown> {
	if (!isPlainObject(raw.models)) raw.models = {};
	return raw.models as Record<string, unknown>;
}

function deleteFrom(
	container: Record<string, unknown>,
	key: string,
	name: string,
): void {
	const bucket = container[key];
	if (!isPlainObject(bucket)) return;
	delete bucket[name];
	if (Object.keys(bucket).length === 0) delete container[key];
}

/** JSON shape for one catalog: entries per tier, empty tiers omitted. */
function catalogJson(
	tiers: Readonly<Record<TierId, readonly CatalogEntry[]>>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const tier of TIER_IDS) {
		if (tiers[tier].length > 0) out[tier] = tiers[tier].map((e) => ({ ...e }));
	}
	return out;
}

/** Set (or with null: delete) a catalog at the canonical key, migrating any
 *  legacy `models.catalog.<name>` spelling out of the way. */
function setCatalog(
	raw: Record<string, unknown>,
	name: string,
	value: Record<string, unknown> | null,
): void {
	const models = modelsObject(raw);
	deleteFrom(models, "catalog", name);
	if (value === null) {
		deleteFrom(models, "catalogs", name);
		return;
	}
	if (!isPlainObject(models.catalogs)) models.catalogs = {};
	(models.catalogs as Record<string, unknown>)[name] = value;
}

function setProfile(
	raw: Record<string, unknown>,
	name: string,
	value: Record<string, unknown> | null,
): void {
	const models = modelsObject(raw);
	if (value === null) {
		deleteFrom(models, "profiles", name);
		return;
	}
	if (!isPlainObject(models.profiles)) models.profiles = {};
	(models.profiles as Record<string, unknown>)[name] = value;
}

function profileJson(profile: {
	catalog: string;
	targets?: readonly string[];
}): Record<string, unknown> {
	return {
		...(profile.targets?.length ? { targets: [...profile.targets] } : {}),
		catalog: profile.catalog,
	};
}

// ─── Read helpers ────────────────────────────────────────────────────────────

export function safeV2(ctx: ExtensionContext): V2ModelsConfig | undefined {
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

function catalogEntryCount(
	tiers: Readonly<Record<TierId, readonly CatalogEntry[]>>,
): number {
	return TIER_IDS.reduce((sum, tier) => sum + tiers[tier].length, 0);
}

/** The availability word for one entry fact — plain words, never glyphs. */
export function availabilityWord(fact: V2CandidateFact): string {
	return fact.available ? "available" : (fact.reason ?? "unavailable");
}

export async function tierFacts(
	ctx: ExtensionContext,
	entries: readonly CatalogEntry[],
): Promise<V2CandidateFact[]> {
	return Promise.all(entries.map((entry) => explainCatalogEntry(ctx, entry)));
}

/** "2 available, 1 not authenticated" — grouped availability summary. */
function availabilitySummary(facts: readonly V2CandidateFact[]): string {
	const counts = new Map<string, number>();
	for (const fact of facts) {
		const word = availabilityWord(fact);
		counts.set(word, (counts.get(word) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([word, count]) => `${count} ${word}`)
		.join(", ");
}

// ─── Pages ───────────────────────────────────────────────────────────────────

/** Top page: every profile (with the ACTIVE marker) and every catalog. */
export async function browseProfilesCatalogs(
	ctx: ExtensionContext,
	ui: Dialogs,
): Promise<void> {
	while (true) {
		const v2 = safeV2(ctx);
		const active = activeV2Profile(v2, sessionModelId(ctx));
		const profiles = Object.entries(v2?.profiles ?? {});
		const catalogs = Object.entries(v2?.catalogs ?? {});
		const picked = await ui.select(
			`Profiles and catalogs — active profile: ${active?.id ?? "none"}`,
			[
				...profiles.map(
					([name, profile]) =>
						`profile ${name}${name === active?.id ? " (active)" : ""} → ${profile.catalog}${
							profile.targets?.length
								? ` · targets: ${profile.targets.join(", ")}`
								: " · default (no targets)"
						}`,
				),
				...catalogs.map(
					([name, tiers]) =>
						`catalog ${name} — ${catalogEntryCount(tiers)} entr${catalogEntryCount(tiers) === 1 ? "y" : "ies"}`,
				),
				NEW_PROFILE,
				NEW_CATALOG,
			],
		);
		if (!picked) return;
		if (picked === NEW_PROFILE) await createProfile(ctx, ui);
		else if (picked === NEW_CATALOG) await createCatalog(ctx, ui);
		else if (picked.startsWith("profile ")) {
			const name = profiles.find(([id]) =>
				picked.startsWith(`profile ${id} `),
			)?.[0];
			if (name) await editProfile(ctx, ui, name);
		} else {
			const name = catalogs.find(([id]) =>
				picked.startsWith(`catalog ${id} `),
			)?.[0];
			if (name) await editCatalog(ctx, ui, name);
		}
	}
}

async function createProfile(
	ctx: ExtensionContext,
	ui: Dialogs,
): Promise<void> {
	if (!ui.input) {
		ctx.ui.notify(
			"This surface has no input dialog — use /maestro set models.profiles.<name> <json>.",
			"warning",
		);
		return;
	}
	const v2 = safeV2(ctx);
	const catalogNames = Object.keys(v2?.catalogs ?? {});
	if (catalogNames.length === 0) {
		ctx.ui.notify(
			"Create a catalog first — a profile is a binding to a catalog.",
			"warning",
		);
		return;
	}
	const name = (await ui.input("New profile name"))?.trim();
	if (!name) return;
	if (v2?.profiles[name]) {
		ctx.ui.notify(`Profile ${name} already exists.`, "warning");
		return;
	}
	const catalog = await ui.select(`${name} → which catalog?`, catalogNames);
	if (!catalog) return;
	const targetChoice = await ui.select(`${name} — targets`, [
		DEFAULT_PROFILE_TARGETS,
		PICK_TARGET,
	]);
	if (!targetChoice) return;
	let targets: string[] | undefined;
	if (targetChoice === PICK_TARGET) {
		const target = await pickModelRef(ctx, ui, { allowSession: false });
		if (!target) return;
		targets = [target];
	}
	writeV2Settings(ctx, (raw) =>
		setProfile(
			raw,
			name,
			profileJson({ catalog, ...(targets ? { targets } : {}) }),
		),
	);
}

async function editProfile(
	ctx: ExtensionContext,
	ui: Dialogs,
	name: string,
): Promise<void> {
	while (true) {
		const v2 = safeV2(ctx);
		const profile = v2?.profiles[name];
		if (!profile) return;
		const picked = await ui.select(
			`Profile ${name} — targets pick it, the catalog supplies its pools`,
			[
				`Catalog: ${profile.catalog} — change…`,
				`Targets (${profile.targets?.length ?? 0}) — session models that activate this profile`,
				`Open catalog ${profile.catalog}…`,
				RENAME,
				`${DELETE_MARK} profile ${name}…`,
			],
		);
		if (!picked) return;
		if (picked.startsWith("Catalog:")) {
			const catalog = await ui.select(
				`${name} → which catalog?`,
				Object.keys(v2?.catalogs ?? {}),
			);
			if (!catalog) continue;
			writeV2Settings(ctx, (raw) =>
				setProfile(raw, name, profileJson({ ...profile, catalog })),
			);
		} else if (picked.startsWith("Targets")) {
			await editProfileTargets(ctx, ui, name);
		} else if (picked.startsWith("Open catalog")) {
			await editCatalog(ctx, ui, profile.catalog);
		} else if (picked === RENAME) {
			if (!ui.input) continue;
			const next = (await ui.input("New profile name", name))?.trim();
			if (!next || next === name) continue;
			if (v2?.profiles[next]) {
				ctx.ui.notify(`Profile ${next} already exists.`, "warning");
				continue;
			}
			if (
				writeV2Settings(ctx, (raw) => {
					setProfile(raw, name, null);
					setProfile(raw, next, profileJson(profile));
				})
			)
				return;
		} else if (picked.startsWith(DELETE_MARK)) {
			const sure =
				(await ui.confirm?.("Delete profile", `Delete ${name}?`)) ?? true;
			if (sure && writeV2Settings(ctx, (raw) => setProfile(raw, name, null)))
				return;
		}
	}
}

async function editProfileTargets(
	ctx: ExtensionContext,
	ui: Dialogs,
	name: string,
): Promise<void> {
	while (true) {
		const profile = safeV2(ctx)?.profiles[name];
		if (!profile) return;
		const targets = profile.targets ?? [];
		const picked = await ui.select(
			`Profile ${name} — targets (empty = the default profile)`,
			[...targets, ADD_TARGET, ...(targets.length ? [REMOVE_TARGET] : [])],
		);
		if (!picked) return;
		if (picked === ADD_TARGET) {
			const target = await pickModelRef(ctx, ui, { allowSession: false });
			if (!target) continue;
			writeV2Settings(ctx, (raw) =>
				setProfile(
					raw,
					name,
					profileJson({ ...profile, targets: [...targets, target] }),
				),
			);
		} else if (picked === REMOVE_TARGET) {
			const victim = await ui.select("Remove which model?", [...targets]);
			if (!victim) continue;
			writeV2Settings(ctx, (raw) =>
				setProfile(
					raw,
					name,
					profileJson({
						...profile,
						targets: targets.filter((t) => t !== victim),
					}),
				),
			);
		}
	}
}

async function createCatalog(
	ctx: ExtensionContext,
	ui: Dialogs,
): Promise<void> {
	if (!ui.input) {
		ctx.ui.notify(
			"This surface has no input dialog — use /maestro set models.catalogs.<name> <json>.",
			"warning",
		);
		return;
	}
	const name = (await ui.input("New catalog name"))?.trim();
	if (!name) return;
	if (safeV2(ctx)?.catalogs[name]) {
		ctx.ui.notify(`Catalog ${name} already exists.`, "warning");
		return;
	}
	const tier = await ui.select(
		`${name} — add the first models to which tier?`,
		[...TIER_IDS],
	);
	if (!tier) return;
	// The catalog is created on the first applied entry write — an empty
	// catalog is invalid and therefore unwriteable.
	await addTierEntries(ctx, ui, name, tier as TierId);
}

async function editCatalog(
	ctx: ExtensionContext,
	ui: Dialogs,
	name: string,
): Promise<void> {
	while (true) {
		const v2 = safeV2(ctx);
		const tiers = v2?.catalogs[name];
		if (!tiers) return;
		const rows: string[] = [];
		for (const tier of TIER_IDS) {
			const entries = tiers[tier];
			if (entries.length === 0) {
				rows.push(`${tier} — empty`);
				continue;
			}
			const facts = await tierFacts(ctx, entries);
			rows.push(
				`${tier} — ${entries.length} entr${entries.length === 1 ? "y" : "ies"}: ${availabilitySummary(facts)}`,
			);
		}
		const usedBy = Object.entries(v2?.profiles ?? {})
			.filter(([, profile]) => profile.catalog === name)
			.map(([id]) => id);
		const picked = await ui.select(
			`Catalog ${name}${usedBy.length ? ` — bound by ${usedBy.join(", ")}` : " — bound by no profile"}`,
			[...rows, RENAME, `${DELETE_MARK} catalog ${name}…`],
		);
		if (!picked) return;
		if (picked === RENAME) {
			if (!ui.input) continue;
			const next = (await ui.input("New catalog name", name))?.trim();
			if (!next || next === name) continue;
			if (v2?.catalogs[next]) {
				ctx.ui.notify(`Catalog ${next} already exists.`, "warning");
				continue;
			}
			if (
				writeV2Settings(ctx, (raw) => {
					setCatalog(raw, name, null);
					setCatalog(raw, next, catalogJson(tiers));
					// Re-point every profile bound to the old name in one write.
					for (const [id, profile] of Object.entries(v2?.profiles ?? {}))
						if (profile.catalog === name)
							setProfile(raw, id, profileJson({ ...profile, catalog: next }));
				})
			)
				return;
		} else if (picked.startsWith(DELETE_MARK)) {
			const sure =
				(await ui.confirm?.("Delete catalog", `Delete ${name}?`)) ?? true;
			if (!sure) continue;
			// A catalog still bound by a profile is rejected by the validator
			// (unknown catalog reference) — the state stays consistent.
			if (writeV2Settings(ctx, (raw) => setCatalog(raw, name, null))) return;
		} else {
			const tier = TIER_IDS.find((t) => picked.startsWith(`${t} `));
			if (tier) await editCatalogTier(ctx, ui, name, tier);
		}
	}
}

/** One tier: per-entry rows (model, effort, family, notes, availability). */
async function editCatalogTier(
	ctx: ExtensionContext,
	ui: Dialogs,
	name: string,
	tier: TierId,
): Promise<void> {
	while (true) {
		const tiers = safeV2(ctx)?.catalogs[name];
		if (!tiers) return;
		const entries = tiers[tier];
		const facts = await tierFacts(ctx, entries);
		const picked = await ui.select(
			`Catalog ${name} · ${tier} — first available wins, authored order`,
			[
				...entries.map((entry, index) => {
					const detail = [
						availabilityWord(facts[index]),
						entry.effort ? `@${entry.effort}` : undefined,
						entry.family ? `family ${entry.family}` : undefined,
						entry.notes,
					]
						.filter(Boolean)
						.join(" · ");
					return `${entry.model} — ${detail}`;
				}),
				ADD_MODELS,
			],
		);
		if (!picked) return;
		if (picked === ADD_MODELS) {
			await addTierEntries(ctx, ui, name, tier);
			continue;
		}
		const entry = entries.find((e) => picked.startsWith(`${e.model} `));
		if (entry) await editCatalogEntry(ctx, ui, name, tier, entry.model);
	}
}

/** One entry: effort (from the model's supported levels), family, notes. */
async function editCatalogEntry(
	ctx: ExtensionContext,
	ui: Dialogs,
	name: string,
	tier: TierId,
	model: string,
): Promise<void> {
	while (true) {
		const tiers = safeV2(ctx)?.catalogs[name];
		const entry = tiers?.[tier].find((e) => e.model === model);
		if (!tiers || !entry) return;
		const picked = await ui.select(`${name} · ${tier} · ${model}`, [
			`Effort: ${entry.effort ?? "model default"} — change…`,
			`Family: ${entry.family ?? NOT_SET} — change…`,
			`Notes: ${entry.notes ?? NOT_SET} — change…`,
			`− Remove ${model} from ${tier}…`,
		]);
		if (!picked) return;
		if (picked.startsWith("Effort")) {
			const spec = parseModelSpec(model);
			const registryModel = spec
				? ctx.modelRegistry.find(spec.provider, spec.modelId)
				: undefined;
			const levels = registryModel
				? supportedEfforts(registryModel as never)
				: [...THINKING_LEVELS];
			const effort = await ui.select(`${model} → effort`, [
				MODEL_DEFAULT_EFFORT,
				...levels,
			]);
			if (!effort) continue;
			writeEntryUpdate(ctx, name, tier, model, (current) => ({
				...current,
				effort: effort === MODEL_DEFAULT_EFFORT ? undefined : effort,
			}));
		} else if (picked.startsWith("Family")) {
			if (!ui.input) continue;
			const family = (
				await ui.input(
					"Family — authored, never inferred (diversity compares these)",
					entry.family ?? "",
				)
			)?.trim();
			if (family === undefined) continue;
			writeEntryUpdate(ctx, name, tier, model, (current) => ({
				...current,
				family: family || undefined,
			}));
		} else if (picked.startsWith("Notes")) {
			if (!ui.input) continue;
			const notes = (
				await ui.input(
					"Notes — written for agents to reason with",
					entry.notes ?? "",
				)
			)?.trim();
			if (notes === undefined) continue;
			writeEntryUpdate(ctx, name, tier, model, (current) => ({
				...current,
				notes: notes || undefined,
			}));
		} else if (picked.startsWith("− Remove")) {
			const next = catalogJson({
				...tiers,
				[tier]: tiers[tier].filter((e) => e.model !== model),
			});
			// Removing the last entry everywhere is rejected by the validator
			// ("every tier is empty") — delete the catalog instead.
			if (writeV2Settings(ctx, (raw) => setCatalog(raw, name, next))) return;
		}
	}
}

function writeEntryUpdate(
	ctx: ExtensionContext,
	name: string,
	tier: TierId,
	model: string,
	update: (
		current: Record<string, unknown>,
	) => Record<string, unknown | undefined>,
): void {
	const tiers = safeV2(ctx)?.catalogs[name];
	if (!tiers) return;
	const nextEntries = tiers[tier].map((entry) => {
		if (entry.model !== model) return { ...entry };
		const updated = update({ ...entry });
		// undefined-valued fields are removed from the JSON entirely.
		return Object.fromEntries(
			Object.entries(updated).filter(([, value]) => value !== undefined),
		);
	});
	const next: Record<string, unknown> = {};
	for (const t of TIER_IDS) {
		const list =
			t === tier ? nextEntries : tiers[t].map((entry) => ({ ...entry }));
		if (list.length > 0) next[t] = list;
	}
	writeV2Settings(ctx, (raw) => setCatalog(raw, name, next));
}

/**
 * Add entries via the configured-provider model browser: auth-filtered
 * (#237) and residency-filtered — a model residency would strike is not
 * offered. Checkbox overlay when the surface supports it; select-loop
 * toggles otherwise. Existing entries keep their authored order and
 * metadata; newly picked models append as bare `{ model }` entries.
 */
async function addTierEntries(
	ctx: ExtensionContext,
	ui: Dialogs,
	name: string,
	tier: TierId,
): Promise<void> {
	const v1Config = safeV1(ctx);
	const providers = new Map<string, string[]>();
	for (const [provider, ids] of await modelsByProvider(ctx)) {
		const allowed = ids.filter((id) =>
			modelAllowedByResidency(v1Config, `${provider}/${id}`),
		);
		if (allowed.length > 0) providers.set(provider, allowed);
	}
	if (providers.size === 0) {
		ctx.ui.notify(
			"No models to pick from — every registry model is outside the active residency or its provider is not configured.",
			"warning",
		);
		return;
	}
	while (true) {
		const entries = safeV2(ctx)?.catalogs[name]?.[tier] ?? [];
		const members = new Set(entries.map((entry) => entry.model));
		const providerPick = await ui.select(
			`${name} · ${tier} — which provider?`,
			[...providers.entries()].map(([provider, ids]) => {
				const inTier = ids.filter((id) =>
					members.has(`${provider}/${id}`),
				).length;
				return `${provider} — ${inTier} of ${ids.length} in ${tier}`;
			}),
		);
		if (!providerPick) return;
		const provider = providerPick.split(" ")[0];
		const ids = providers.get(provider) ?? [];
		if (supportsMultiSelect(ctx)) {
			const chosen = await multiSelect(
				ctx,
				`${name} · ${tier} · ${provider}`,
				ids.map((id) => ({
					id: `${provider}/${id}`,
					label: id,
					checked: members.has(`${provider}/${id}`),
				})),
			);
			if (chosen === undefined) continue; // cancelled — back to providers
			applyProviderSelection(ctx, name, tier, provider, new Set(chosen));
			continue;
		}
		while (true) {
			const current = safeV2(ctx)?.catalogs[name]?.[tier] ?? [];
			const inTier = new Set(current.map((entry) => entry.model));
			const picked = await ui.select(
				`${name} · ${tier} · ${provider} — pick to toggle, Esc when done`,
				ids.map((id) => `${inTier.has(`${provider}/${id}`) ? "✓" : "✗"} ${id}`),
			);
			if (!picked) break;
			const ref = `${provider}/${picked.slice(2)}`;
			const next = new Set(
				current
					.filter((entry) => entry.model.startsWith(`${provider}/`))
					.map((entry) => entry.model),
			);
			if (next.has(ref)) next.delete(ref);
			else next.add(ref);
			applyProviderSelection(ctx, name, tier, provider, next);
		}
	}
}

/** Replace one provider's membership in a tier as ONE validated write. */
function applyProviderSelection(
	ctx: ExtensionContext,
	name: string,
	tier: TierId,
	provider: string,
	selected: ReadonlySet<string>,
): void {
	const v2 = safeV2(ctx);
	const tiers = v2?.catalogs[name];
	const current = tiers?.[tier] ?? [];
	const kept = current.filter(
		(entry) =>
			!entry.model.startsWith(`${provider}/`) || selected.has(entry.model),
	);
	const existing = new Set(kept.map((entry) => entry.model));
	const added = [...selected]
		.filter((ref) => !existing.has(ref))
		.sort()
		.map((model) => ({ model }));
	const nextEntries = [...kept.map((entry) => ({ ...entry })), ...added];
	const base = tiers ?? {
		fast: [] as readonly CatalogEntry[],
		normal: [] as readonly CatalogEntry[],
		heavy: [] as readonly CatalogEntry[],
	};
	const next: Record<string, unknown> = {};
	for (const t of TIER_IDS) {
		const list =
			t === tier ? nextEntries : base[t].map((entry) => ({ ...entry }));
		if (list.length > 0) next[t] = list;
	}
	writeV2Settings(ctx, (raw) => setCatalog(raw, name, next));
}

function safeV1(ctx: ExtensionContext) {
	try {
		return readModelsConfig(ctx.cwd);
	} catch {
		return undefined;
	}
}
