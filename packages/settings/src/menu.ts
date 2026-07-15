// Hierarchical /maestro settings UI composed from pi's pinned core list
// primitives. Domain-specific multi-select/input components stay deliberately
// small; navigation, search, scrolling, value rows, and submenus belong to
// SettingsList/SelectList rather than a parallel renderer.

import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DynamicBorder,
	type ExtensionContext,
	getAgentDir,
	getSelectListTheme,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Input,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	getSessionSettingOverride,
	MODEL_ROLES,
	type ModelRole,
	type SessionSettingValue,
	setSessionSettingOverride,
	type ThinkingLevel,
} from "@vegardx/pi-contracts";
import {
	activeProfile,
	readModelsConfig,
	SESSION_MODEL_SENTINEL,
} from "@vegardx/pi-models";
import { settingsRegistry } from "./extension.js";
import {
	createProfile,
	deleteProfile,
	formatSettingValue,
	type MaestroScope,
	type ModelOption,
	modelOptions,
	modelProfileKeys,
	parseSettingValue,
	readAdvancedValue,
	readProfileTargets,
	readRoleLeaf,
	renameProfile,
	resolveModelName,
	sessionFallbackLabel,
	sessionModelId,
	shortModelName,
	supportedEfforts,
	THINKING_LEVELS,
	writeAdvancedValue,
	writeProfileTargets,
	writeRoleLeaf,
} from "./model.js";
import { readLayeredExtensionConfig } from "./reader.js";
import { updateSettingsFile } from "./writer.js";

export { modelOptions } from "./model.js";

const MAX_VISIBLE = 14;
const SCOPES = [
	"session",
	"project",
	"global",
] as const satisfies readonly MaestroScope[];
const PERSISTENT_SCOPES = ["project", "global"] as const;

function title(
	theme: ExtensionContext["ui"]["theme"],
	text: string,
): Component {
	return new Text(theme.fg("accent", theme.bold(text)), 1, 0);
}

function framed(
	ctx: ExtensionContext,
	body: Component,
	heading?: string,
): Component {
	const container = new Container();
	container.addChild(
		new DynamicBorder((value) => ctx.ui.theme.fg("border", value)),
	);
	if (heading) container.addChild(title(ctx.ui.theme, heading));
	container.addChild(body);
	container.addChild(
		new DynamicBorder((value) => ctx.ui.theme.fg("border", value)),
	);
	return container;
}

function selectComponent(
	items: SelectItem[],
	done: (value?: string) => void,
	selected?: string,
): SelectList {
	const list = new SelectList(
		items,
		Math.min(MAX_VISIBLE, Math.max(items.length, 1)),
		getSelectListTheme(),
	);
	const selectedIndex = items.findIndex((item) => item.value === selected);
	if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
	list.onSelect = (item) => done(item.value);
	list.onCancel = () => done();
	return list;
}

function settingsComponent(
	items: SettingItem[],
	onChange: (id: string, value: string) => void,
	onCancel: () => void,
): SettingsList {
	return new SettingsList(
		items,
		Math.min(MAX_VISIBLE, Math.max(items.length + 2, 4)),
		getSettingsListTheme(),
		onChange,
		onCancel,
		{ enableSearch: true },
	);
}

function profileSummary(ctx: ExtensionContext, profile: string): string {
	const cfg = readModelsConfig(ctx.cwd)?.profiles[profile];
	if (!cfg) return "empty";
	const configured = MODEL_ROLES.filter((role) => cfg.roles[role]);
	if (configured.length === 0) return "no overrides — all roles follow session";
	const live =
		activeProfile(readModelsConfig(ctx.cwd), sessionModelId(ctx))?.name ===
		profile;
	const names =
		configured.length > 4
			? `${configured.length} of ${MODEL_ROLES.length} roles configured`
			: configured.join(", ");
	return `${live ? "active · " : ""}${names}`;
}

/** Full ordered pool (first = default), or the resolved session fallback. */
function roleModelsCell(
	ctx: ExtensionContext,
	profile: string,
	role: ModelRole,
): string {
	const models = readRoleLeaf(ctx, profile, role, "models").effective ?? [];
	if (models.length === 0) return sessionFallbackLabel(ctx);
	return models
		.map((id) =>
			id === SESSION_MODEL_SENTINEL
				? sessionFallbackLabel(ctx)
				: shortModelName(ctx, id),
		)
		.join(" › ");
}

/** Only the default effort (first configured); unset renders as auto. */
function roleEffortCell(
	ctx: ExtensionContext,
	profile: string,
	role: ModelRole,
): string {
	return readRoleLeaf(ctx, profile, role, "efforts").effective?.[0] ?? "auto";
}

function roleSummary(
	ctx: ExtensionContext,
	profile: string,
	role: ModelRole,
): string {
	return `${roleModelsCell(ctx, profile, role)} · ${roleEffortCell(ctx, profile, role)}`;
}

/** Cap the MODELS column so one long pool cannot push efforts off-screen. */
const MODELS_CELL_MAX = 56;

/**
 * One aligned `MODELS · EFFORT` table row. The role name is the SettingItem
 * label (SettingsList aligns labels itself); models pad to the widest pool
 * across roles so the effort column lines up.
 */
function roleTableRow(
	ctx: ExtensionContext,
	profile: string,
	role: ModelRole,
): string {
	const width = Math.min(
		MODELS_CELL_MAX,
		Math.max(
			...MODEL_ROLES.map((other) =>
				visibleWidth(roleModelsCell(ctx, profile, other)),
			),
		),
	);
	const models = truncateToWidth(
		roleModelsCell(ctx, profile, role),
		width,
		"…",
		true,
	);
	return `${models} · ${roleEffortCell(ctx, profile, role)}`;
}

/**
 * Registry options plus the orderable `"session"` sentinel entry, first. Its
 * label resolves the current session model whenever the rows are (re)built.
 */
function poolModelOptions(ctx: ExtensionContext): ModelOption[] {
	return [
		{
			id: SESSION_MODEL_SENTINEL,
			label: sessionFallbackLabel(ctx),
			description: "follows /model live",
			supported: ctx.model ? supportedEfforts(ctx.model) : [...THINKING_LEVELS],
		},
		...modelOptions(ctx),
	];
}

function move<T>(values: readonly T[], from: number, to: number): T[] {
	const out = [...values];
	const [value] = out.splice(from, 1);
	if (value !== undefined)
		out.splice(Math.max(0, Math.min(to, out.length)), 0, value);
	return out;
}

function makeInput(initial: string, done: (value?: string) => void): Component {
	const input = new Input();
	input.setValue(initial);
	input.onSubmit = (value) => done(value);
	input.onEscape = () => done();
	return input;
}

/** Focused multi-select used for targets and child extensions only. */
export class MultiSelectComponent implements Component {
	private readonly list: SelectList;
	private readonly selected: Set<string>;
	constructor(
		items: SelectItem[],
		selected: readonly string[],
		private readonly onToggle: (value: string, enabled: boolean) => void,
		done: () => void,
	) {
		this.selected = new Set(selected);
		this.list = new SelectList(
			this.items(items),
			Math.min(MAX_VISIBLE, Math.max(1, items.length)),
			getSelectListTheme(),
		);
		this.list.onSelect = (item) => {
			const enabled = !this.selected.has(item.value);
			if (enabled) this.selected.add(item.value);
			else this.selected.delete(item.value);
			this.onToggle(item.value, enabled);
		};
		this.list.onCancel = done;
	}

	private items(items: SelectItem[]): SelectItem[] {
		return items.map((item) => ({
			...item,
			label: `${this.selected.has(item.value) ? "[x]" : "[ ]"} ${item.label}`,
		}));
	}
	render(width: number): string[] {
		return this.list.render(width);
	}
	invalidate(): void {
		this.list.invalidate();
	}
	handleInput(data: string): void {
		const before = this.list.getSelectedItem()?.value;
		this.list.handleInput(data);
		// SelectList owns navigation; rebuild its labels after toggling by replacing
		// the selected row's label in place (items are mutable core view models).
		if (before && (data === "\r" || data === "\n")) {
			const item = this.list.getSelectedItem();
			if (item)
				item.label = `${this.selected.has(item.value) ? "[x]" : "[ ]"} ${item.label.replace(/^\[[ x]\] /, "")}`;
		}
	}
}

/**
 * One-screen ordered role pool editor. The checked, numbered head of the list
 * IS the pool (row 1 is the default); unchecked rows are the remaining
 * candidates. Every mutation writes through writeRoleLeaf immediately — the
 * same live-write style as the other editors — so esc/return only reports.
 */
class OrderedPoolComponent implements Component {
	private list: SelectList;
	private scope: Exclude<MaestroScope, "session">;
	private pool: string[];

	constructor(
		private readonly ctx: ExtensionContext,
		private readonly profile: string,
		private readonly role: ModelRole,
		private readonly done: (value?: string) => void,
	) {
		// Session overrides are runtime patches, not an editing surface here;
		// the editor persists to global/project only and starts at the models
		// leaf's effective source when that source is persistent.
		const source = readRoleLeaf(ctx, profile, role, "models").source;
		this.scope = source === "project" ? "project" : "global";
		this.pool = this.readPool();
		this.list = this.createList(this.pool[0]);
	}

	private readPool(): string[] {
		const layered = readRoleLeaf(this.ctx, this.profile, this.role, "models");
		// An unauthored write scope starts from the effective pool so the first
		// mutation copies it rather than silently shadowing it with a fragment.
		return [...(layered[this.scope] ?? layered.effective ?? [])];
	}

	private buildItems(): SelectItem[] {
		const options = poolModelOptions(this.ctx);
		const byId = new Map(options.map((option) => [option.id, option]));
		const items: SelectItem[] = this.pool.map((id, index) => ({
			value: id,
			label: `[x] ${index + 1}. ${byId.get(id)?.label ?? id}${index === 0 ? " · default" : ""}`,
			description: byId.get(id)?.description ?? "needs authentication",
		}));
		for (const option of options) {
			if (this.pool.includes(option.id)) continue;
			items.push({
				value: option.id,
				label: `[ ]    ${option.label}`,
				description: option.description,
			});
		}
		return items;
	}

	private createList(follow: string | undefined): SelectList {
		const items = this.buildItems();
		const list = new SelectList(
			items,
			Math.min(MAX_VISIBLE, Math.max(items.length, 1)),
			getSelectListTheme(),
			// Pool rows carry checkbox + index + default marker; the default
			// 32-column primary would truncate exactly the ordering signal.
			{ minPrimaryColumnWidth: 32, maxPrimaryColumnWidth: 64 },
		);
		const index = items.findIndex((item) => item.value === follow);
		if (index >= 0) list.setSelectedIndex(index);
		const finish = () =>
			this.done(roleSummary(this.ctx, this.profile, this.role));
		list.onSelect = finish;
		list.onCancel = finish;
		return list;
	}

	/** Rebuild rows after a mutation, keeping the cursor on `follow`. */
	private refresh(follow?: string): void {
		this.list = this.createList(
			follow ?? this.list.getSelectedItem()?.value ?? undefined,
		);
	}

	private write(next: readonly string[]): void {
		// Empty pools are stored as a reset scope, never an empty array.
		writeRoleLeaf(
			this.ctx,
			this.profile,
			this.role,
			"models",
			this.scope,
			next.length ? next : undefined,
		);
	}

	private toggle(): void {
		const id = this.list.getSelectedItem()?.value;
		if (!id) return;
		const next = this.pool.includes(id)
			? this.pool.filter((value) => value !== id)
			: [...this.pool, id];
		this.write(next);
		this.pool = next;
		this.refresh(id);
	}

	private movePool(delta: number): void {
		const id = this.list.getSelectedItem()?.value;
		if (!id) return;
		const index = this.pool.indexOf(id);
		// Ordering applies to checked rows only; candidates have no position.
		if (index < 0) return;
		const target = index + delta;
		if (target < 0 || target >= this.pool.length) return;
		this.pool = move(this.pool, index, target);
		this.write(this.pool);
		this.refresh(id);
	}

	private switchScope(): void {
		this.scope = this.scope === "global" ? "project" : "global";
		this.pool = this.readPool();
		this.refresh();
	}

	private cycleEffort(): void {
		const defaultModel = this.pool[0];
		if (!defaultModel) {
			this.ctx.ui.notify(
				"Add a model first — the default effort follows the default model.",
				"warning",
			);
			return;
		}
		const supported =
			poolModelOptions(this.ctx).find((option) => option.id === defaultModel)
				?.supported ?? THINKING_LEVELS;
		if (supported.length === 0) return;
		const layered = readRoleLeaf(this.ctx, this.profile, this.role, "efforts");
		const configured = [...(layered[this.scope] ?? layered.effective ?? [])];
		// indexOf misses (unset or unsupported default) wrap to supported[0].
		const next =
			supported[
				(supported.indexOf(configured[0] as ThinkingLevel) + 1) %
					supported.length
			];
		// The chosen level leads; other configured levels stay as alternates.
		writeRoleLeaf(this.ctx, this.profile, this.role, "efforts", this.scope, [
			next,
			...configured.filter((level) => level !== next),
		]);
		this.refresh();
	}

	render(width: number): string[] {
		const theme = this.ctx.ui.theme;
		const efforts = readRoleLeaf(this.ctx, this.profile, this.role, "efforts");
		const effort = (efforts[this.scope] ?? efforts.effective)?.[0] ?? "auto";
		const header = theme.fg(
			"accent",
			theme.bold(
				`${this.role} · ${this.profile} · scope: ${this.scope} · effort: ${effort}`,
			),
		);
		const hint = theme.fg(
			"dim",
			"space toggle · +/- reorder · g scope · e effort · enter/esc done",
		);
		return [` ${header}`, ...this.list.render(width), ` ${hint}`];
	}

	invalidate(): void {
		this.list.invalidate();
	}

	handleInput(data: string): void {
		if (data === " ") this.toggle();
		else if (data === "+" || data === "K") this.movePool(-1);
		else if (data === "-" || data === "J") this.movePool(1);
		else if (data === "g") this.switchScope();
		else if (data === "e") this.cycleEffort();
		else this.list.handleInput(data);
	}
}

export function rolePoolEditor(
	ctx: ExtensionContext,
	profile: string,
	role: ModelRole,
	done: (value?: string) => void,
): Component {
	return new OrderedPoolComponent(ctx, profile, role, done);
}

export function targetsEditor(
	ctx: ExtensionContext,
	profile: string,
	done: (value?: string) => void,
): Component {
	// Scope rows are SettingItems: only SettingsList submenus actually mount a
	// returned component (plain SelectList.onSelect discards return values), so
	// the multi-select must hang off a `submenu` to ever appear.
	const targetCount = (scope: "global" | "project"): string =>
		`${readProfileTargets(ctx, profile)[scope]?.length ?? 0} target(s)`;
	const source = readProfileTargets(ctx, profile).source;
	const items: SettingItem[] = PERSISTENT_SCOPES.map((scope) => ({
		id: scope,
		label: scope,
		currentValue: targetCount(scope),
		description: scope === source ? "effective source" : "inherits when unset",
		submenu: (_value, scopeDone) => {
			const targets = readProfileTargets(ctx, profile);
			let selected = [...(targets[scope] ?? targets.effective ?? [])];
			const owners = new Map<string, string>();
			for (const [name, config] of Object.entries(
				readModelsConfig(ctx.cwd)?.profiles ?? {},
			))
				for (const target of config.targets) owners.set(target, name);
			return new MultiSelectComponent(
				modelOptions(ctx).map((model) => ({
					value: model.id,
					label: model.label,
					description:
						owners.get(model.id) && owners.get(model.id) !== profile
							? `owned by ${owners.get(model.id)}; selecting moves it`
							: model.description,
				})),
				selected,
				(modelId, enabled) => {
					if (enabled) {
						const owner = owners.get(modelId);
						if (owner && owner !== profile) {
							for (const ownerScope of PERSISTENT_SCOPES) {
								const ownerTargets = readProfileTargets(ctx, owner)[ownerScope];
								if (ownerTargets?.includes(modelId)) {
									writeProfileTargets(
										ctx,
										owner,
										ownerScope,
										ownerTargets.filter((value) => value !== modelId),
									);
								}
							}
						}
						selected = [
							...selected.filter((value) => value !== modelId),
							modelId,
						];
					} else selected = selected.filter((value) => value !== modelId);
					writeProfileTargets(ctx, profile, scope, selected);
				},
				// A fresh summary refreshes the scope row's currentValue on close.
				() => scopeDone(targetCount(scope)),
			);
		},
	}));
	// Both exit paths report a fresh summary so the parent Targets row can
	// never go stale (SettingsList only refreshes on a string done()).
	const finish = () => {
		const fresh = readProfileTargets(ctx, profile);
		done(`${fresh.effective?.length ?? 0} · ${fresh.source ?? "unset"}`);
	};
	return settingsComponent(items, () => {}, finish);
}

function profileDetail(
	ctx: ExtensionContext,
	profile: string,
	done: (value?: string) => void,
): Component {
	const targets = readProfileTargets(ctx, profile);
	const items: SettingItem[] = [
		{
			id: "targets",
			label: "Targets",
			currentValue: `${targets.effective?.length ?? 0} · ${targets.source ?? "unset"}`,
			description:
				"Exclusive exact /model IDs. Activation is derived; it is never persisted.",
			submenu: (_value, targetsDone) =>
				targetsEditor(ctx, profile, targetsDone),
		},
		...MODEL_ROLES.map(
			(role): SettingItem => ({
				id: `role:${role}`,
				label: role,
				currentValue: roleSummary(ctx, profile, role),
				description:
					"First model and first compatible effort are defaults; remaining values are exact allowed alternates.",
				submenu: (_value, roleDone) =>
					rolePoolEditor(ctx, profile, role, roleDone),
			}),
		),
		{
			id: "rename",
			label: "Rename profile",
			currentValue: profile,
			submenu: (_value, renameDone) =>
				makeInput(profile, (name) => {
					const trimmed = name?.trim();
					const target = trimmed && trimmed !== profile ? trimmed : undefined;
					if (target) {
						for (const scope of PERSISTENT_SCOPES) {
							renameProfile(ctx, profile, target, scope);
						}
					}
					renameDone(trimmed);
					// The detail items were built for the old name; bail out and
					// hand the parent row a fresh summary either way.
					done(profileSummary(ctx, target ?? profile));
				}),
		},
		{
			id: "delete",
			label: "Delete profile",
			currentValue: targets.source ?? "global",
			values: ["delete"],
			description:
				"Deletes only the effective persistent scope; lower-scope definitions may become visible.",
		},
	];
	return settingsComponent(
		items,
		(id) => {
			if (id === "delete") {
				deleteProfile(
					ctx,
					profile,
					targets.source === "project" ? "project" : "global",
				);
				done("deleted");
			}
		},
		// Fresh summary on cancel too: edits inside (targets, role pools)
		// must reach the profile row in profilesMenu.
		() => done(profileSummary(ctx, profile)),
	);
}

function profilesMenu(
	ctx: ExtensionContext,
	done: (value?: string) => void,
): Component {
	const profiles = modelProfileKeys(ctx);
	const items: SettingItem[] = profiles.map((profile) => ({
		id: profile,
		label: profile,
		currentValue: profileSummary(ctx, profile),
		submenu: (_value, profileDone) => profileDetail(ctx, profile, profileDone),
	}));
	for (const scope of PERSISTENT_SCOPES) {
		items.push({
			id: `create:${scope}`,
			label: `Create ${scope} profile`,
			currentValue: "enter name",
			submenu: (_value, createDone) =>
				makeInput("", (name) => {
					if (name?.trim()) createProfile(ctx, name.trim(), scope);
					createDone(name?.trim());
				}),
		});
	}
	return settingsComponent(
		items,
		(id) => {
			// The item list is fixed at construction: a created profile has no
			// row yet, so close and let the parent rebuild on re-entry. Edits to
			// existing profiles refresh their row in place and stay open.
			if (id.startsWith("create:")) done(`${modelProfileKeys(ctx).length}`);
		},
		() => done(`${modelProfileKeys(ctx).length}`),
	);
}

export function childExtensionCandidates(agentDir = getAgentDir()): string[] {
	try {
		const raw = JSON.parse(
			readFileSync(join(agentDir, "settings.json"), "utf8"),
		) as { packages?: unknown };
		const packages = Array.isArray(raw.packages)
			? raw.packages.filter(
					(value): value is string => typeof value === "string",
				)
			: [];
		const selfRepo = resolve(
			dirname(fileURLToPath(import.meta.url)),
			"../../..",
		);
		return packages.filter((value) => resolve(value) !== selfRepo);
	} catch {
		return [];
	}
}

function selectedChildExtensions(ctx: ExtensionContext): string[] {
	const { global } = readLayeredExtensionConfig(ctx.cwd);
	const value = global.modes?.childExtensions;
	const candidates = new Set(childExtensionCandidates());
	return Array.isArray(value)
		? value.filter(
				(path): path is string =>
					typeof path === "string" && candidates.has(path),
			)
		: [];
}

function childExtensionsMenu(
	ctx: ExtensionContext,
	done: (value?: string) => void,
): Component {
	let selected = selectedChildExtensions(ctx);
	return new MultiSelectComponent(
		childExtensionCandidates().map((path) => ({
			value: path,
			label: basename(path),
			description: path,
		})),
		selected,
		(path, enabled) => {
			selected = enabled
				? [...selected.filter((value) => value !== path), path]
				: selected.filter((value) => value !== path);
			updateSettingsFile("global", ctx.cwd, undefined, (raw) => {
				if (!raw.extensionConfig || typeof raw.extensionConfig !== "object")
					raw.extensionConfig = {};
				const extensionConfig = raw.extensionConfig as Record<string, unknown>;
				if (!extensionConfig.modes || typeof extensionConfig.modes !== "object")
					extensionConfig.modes = {};
				(extensionConfig.modes as Record<string, unknown>).childExtensions = [
					...selected,
				];
			});
		},
		// Match the parent row's `enabled / candidates` format, freshly read.
		() =>
			done(
				`${selectedChildExtensions(ctx).length} / ${childExtensionCandidates().length}`,
			),
	);
}

function advancedScopeMenu(
	ctx: ExtensionContext,
	extension: string,
	path: string,
	defaultValue: SessionSettingValue | undefined,
	type: string,
	done: (value?: string) => void,
): Component {
	const layered = readAdvancedValue(ctx.cwd, extension, path, defaultValue);
	// Match the parent row's `effective · source` format, freshly read.
	const finish = () => {
		const fresh = readAdvancedValue(ctx.cwd, extension, path, defaultValue);
		done(`${formatSettingValue(fresh.effective)} · ${fresh.source}`);
	};
	return settingsComponent(
		SCOPES.map(
			(scope): SettingItem => ({
				id: scope,
				label: scope,
				currentValue: formatSettingValue(layered[scope]),
				description:
					scope === layered.source
						? "Effective source"
						: "Unset values inherit the next scope.",
				submenu: (_value, editDone) => {
					const values =
						type === "boolean"
							? ["true", "false", "reset"]
							: type === "thinking"
								? [...THINKING_LEVELS, "reset"]
								: undefined;
					if (values)
						return selectComponent(
							values.map((value) => ({ value, label: value })),
							(value) => {
								if (!value) return editDone();
								writeAdvancedValue(
									ctx.cwd,
									extension,
									path,
									scope,
									value === "reset" ? undefined : parseSettingValue(value),
								);
								editDone(value);
							},
						);
					return makeInput(
						formatSettingValue(layered[scope] ?? defaultValue).replace(
							/^—$/,
							"",
						),
						(value) => {
							if (value !== undefined)
								writeAdvancedValue(
									ctx.cwd,
									extension,
									path,
									scope,
									value === "" ? undefined : parseSettingValue(value),
								);
							editDone(value);
						},
					);
				},
			}),
		),
		// Scope rows refresh in place via editDone; both exit paths hand the
		// parent a fresh effective summary.
		() => {},
		finish,
	);
}

function advancedMenu(
	ctx: ExtensionContext,
	done: (value?: string) => void,
): Component {
	const items: SettingItem[] = [];
	for (const [extension, declarations] of settingsRegistry) {
		for (const declaration of declarations) {
			// Model policy belongs only in profile role pools; stale scalar role
			// declarations must not recreate a second policy surface.
			if (declaration.type === "model") continue;
			const layered = readAdvancedValue(
				ctx.cwd,
				extension,
				declaration.key,
				declaration.default,
			);
			items.push({
				id: `${extension}.${declaration.key}`,
				label: declaration.label,
				currentValue: `${formatSettingValue(layered.effective)} · ${layered.source}`,
				description: `${extension}.${declaration.key}`,
				submenu: (_value, settingDone) =>
					advancedScopeMenu(
						ctx,
						extension,
						declaration.key,
						declaration.default,
						declaration.type,
						settingDone,
					),
			});
		}
	}
	return settingsComponent(
		items,
		// Rows refresh in place from advancedScopeMenu's fresh summaries.
		() => {},
		() => done(`${items.length}`),
	);
}

export function createMaestroSettingsList(
	ctx: ExtensionContext,
	done: () => void,
): SettingsList {
	const config = readModelsConfig(ctx.cwd);
	const active = activeProfile(config, sessionModelId(ctx));
	const items: SettingItem[] = [
		{
			id: "session",
			label: "Session model",
			currentValue: sessionModelId(ctx)
				? resolveModelName(ctx, sessionModelId(ctx)!)
				: "none",
			description:
				"The live /model selects the active profile by exclusive target membership.",
		},
		{
			id: "active-profile",
			label: "Active profile",
			currentValue: active?.name ?? "none — all roles follow session",
		},
	];
	if (active) {
		const profileName = active.name;
		for (const role of MODEL_ROLES)
			items.push({
				id: `active-role:${role}`,
				label: role,
				// A getter keeps the row live: the session-fallback cell resolves
				// the current session model on every render, and pool edits show
				// without waiting for a submenu summary. SettingsList assigns
				// currentValue when a submenu closes; accept and ignore it.
				get currentValue() {
					return roleTableRow(ctx, profileName, role);
				},
				set currentValue(_value: string) {},
				description:
					"Ordered pool (first = default) · default effort. Enter opens the pool editor.",
				submenu: (_value, roleDone) =>
					rolePoolEditor(ctx, profileName, role, roleDone),
			});
	}
	items.push(
		{
			id: "profiles",
			label: "Profiles",
			currentValue: `${modelProfileKeys(ctx).length}`,
			description:
				"Create profiles, assign exclusive targets, and edit ordered role pools by scope.",
			submenu: (_value, profilesDone) => profilesMenu(ctx, profilesDone),
		},
		{
			id: "child-extensions",
			label: "Child extensions",
			currentValue: `${selectedChildExtensions(ctx).length} / ${childExtensionCandidates().length}`,
			description:
				"Global provider/infrastructure packages passed to isolated children. Vanished paths and Maestro itself are excluded.",
			submenu: (_value, childDone) => childExtensionsMenu(ctx, childDone),
		},
		{
			id: "advanced",
			label: "Advanced settings",
			currentValue: `${[...settingsRegistry.values()].reduce((count, declarations) => count + declarations.length, 0)}`,
			description:
				"Capability-declared non-model settings with typed session/project/global overrides.",
			submenu: (_value, advancedDone) => advancedMenu(ctx, advancedDone),
		},
	);
	return settingsComponent(items, () => {}, done);
}

export function ensureDefaultProfile(ctx: ExtensionContext): void {
	if (modelProfileKeys(ctx).length > 0 || !ctx.model) return;
	const modelId = `${ctx.model.provider}/${ctx.model.id}`;
	const name = (ctx.model as { name?: string }).name?.trim() || ctx.model.id;
	createProfile(ctx, name, "global");
	writeProfileTargets(ctx, name, "global", [modelId]);
}

export function showConfigMenu(ctx: ExtensionContext): void {
	ensureDefaultProfile(ctx);
	ctx.ui.custom((tui, _theme, _keybindings, done) => {
		const list = createMaestroSettingsList(ctx, () => done(undefined));
		const component = framed(ctx, list, "Maestro settings");
		return {
			render: (width: number) => component.render(width),
			invalidate: () => component.invalidate(),
			handleInput: (data: string) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

/** Compatibility adapters now backed by the typed process-local store. */
export function getSessionSetting(
	extension: string,
	key: string,
): string | undefined {
	const value = getSessionSettingOverride(extension, key);
	return value === undefined ? undefined : formatSettingValue(value);
}

export function setSessionSetting(
	extension: string,
	key: string,
	value: string | undefined,
): void {
	setSessionSettingOverride(
		extension,
		key,
		value === undefined ? undefined : parseSettingValue(value),
	);
}
