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
} from "@earendil-works/pi-tui";
import {
	getSessionSettingOverride,
	MODEL_ROLES,
	type ModelRole,
	type SessionSettingValue,
	setSessionSettingOverride,
	type ThinkingLevel,
} from "@vegardx/pi-contracts";
import { activeProfile, readModelsConfig } from "@vegardx/pi-models";
import { settingsRegistry } from "./extension.js";
import {
	createProfile,
	deleteProfile,
	formatSettingValue,
	type MaestroScope,
	modelProfileKeys,
	parseSettingValue,
	type RoleLeaf,
	readAdvancedValue,
	readProfileTargets,
	readRoleLeaf,
	renameProfile,
	resolveModelName,
	sessionModelId,
	summarizeOrdered,
	THINKING_LEVELS,
	writeAdvancedValue,
	writeProfileTargets,
	writeRoleLeaf,
} from "./model.js";
import { readLayeredExtensionConfig } from "./reader.js";
import { updateSettingsFile } from "./writer.js";

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

interface ModelOption {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly supported: readonly ThinkingLevel[];
}

function supportedEfforts(model: unknown): readonly ThinkingLevel[] {
	const entry = model as {
		reasoning?: boolean;
		thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
		compat?: { forceAdaptiveThinking?: boolean };
	};
	if (entry.reasoning === false) return ["off"];
	let efforts = THINKING_LEVELS.filter(
		(level) => entry.thinkingLevelMap?.[level] !== null,
	);
	if (entry.compat?.forceAdaptiveThinking)
		efforts = efforts.filter((level) => level !== "off" && level !== "minimal");
	return efforts;
}

export function modelOptions(ctx: ExtensionContext): ModelOption[] {
	// The FULL catalog, always. Profile targets are configuration, not
	// activation: the runtime role resolver already filters pools to
	// authenticated models at spawn time, so selecting a "needs
	// authentication" model is a dormant target, never a live call. Listing
	// only getAvailable() hid every other provider's models the moment ONE
	// provider had auth — the label below was unreachable and the global
	// anthropic/openai/grok catalog could not be assigned to profiles.
	return ctx.modelRegistry.getAll().map((model) => ({
		id: `${model.provider}/${model.id}`,
		label: `${(model as { name?: string }).name ?? model.id} (${model.provider})`,
		description: ctx.modelRegistry.hasConfiguredAuth(model)
			? "available"
			: "needs authentication",
		supported: supportedEfforts(model),
	}));
}

function profileSummary(ctx: ExtensionContext, profile: string): string {
	const cfg = readModelsConfig(ctx.cwd)?.profiles[profile];
	if (!cfg) return "empty";
	const configured = MODEL_ROLES.filter((role) => cfg.roles[role]).length;
	const live =
		activeProfile(readModelsConfig(ctx.cwd), sessionModelId(ctx))?.name ===
		profile;
	return `${live ? "active · " : ""}${configured} role${configured === 1 ? "" : "s"}`;
}

function roleSummary(
	ctx: ExtensionContext,
	profile: string,
	role: ModelRole,
): string {
	const models = readRoleLeaf(ctx, profile, role, "models");
	const efforts = readRoleLeaf(ctx, profile, role, "efforts");
	const modelSummary = models.effective?.length
		? summarizeOrdered(models.effective.map((id) => resolveModelName(ctx, id)))
		: "session fallback";
	const effortSummary = efforts.effective?.length
		? summarizeOrdered(efforts.effective)
		: "provider default";
	return `${modelSummary} · ${effortSummary}`;
}

function sourceChain<T>(value: {
	session?: T;
	project?: T;
	global?: T;
	source?: string;
}): string {
	const authored = [
		value.session !== undefined ? "session" : undefined,
		value.project !== undefined ? "project" : undefined,
		value.global !== undefined ? "global" : undefined,
	].filter(Boolean);
	return `${value.source ?? "fallback"}; precedence session → project → global${authored.length ? `; authored: ${authored.join(", ")}` : ""}`;
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

function arrayEditor(
	ctx: ExtensionContext,
	profile: string,
	role: ModelRole,
	leaf: RoleLeaf,
	scope: MaestroScope,
	done: (value?: string) => void,
): Component {
	const layered = readRoleLeaf(ctx, profile, role, leaf);
	const local = layered[scope] ?? [];
	const effective = layered.effective ?? [];
	const display =
		leaf === "models"
			? (id: string) => resolveModelName(ctx, id)
			: (id: string) => id;
	const items: SettingItem[] = [
		{
			id: "source",
			label: "Effective source",
			currentValue: sourceChain(layered),
			description:
				"Arrays replace the lower-precedence leaf; they never concatenate.",
		},
	];
	for (let index = 0; index < local.length; index++) {
		const value = local[index];
		items.push({
			id: `entry:${index}`,
			label: index === 0 ? "Default" : `Alternate ${index}`,
			currentValue: display(value),
			description: value,
			submenu: (_current, entryDone) =>
				selectComponent(
					[
						{
							value: "default",
							label: "Make default",
							description: "Move this exact value to index 0",
						},
						{ value: "up", label: "Move up" },
						{ value: "down", label: "Move down" },
						{ value: "remove", label: "Remove" },
					],
					(action) => {
						if (!action) return entryDone();
						let next = [...local];
						if (action === "default") next = move(next, index, 0);
						if (action === "up") next = move(next, index, index - 1);
						if (action === "down") next = move(next, index, index + 1);
						if (action === "remove") {
							if (next.length === 1) {
								ctx.ui.notify(
									"An explicit pool cannot be empty. Reset this scope instead.",
									"warning",
								);
								return entryDone();
							}
							next.splice(index, 1);
						}
						writeRoleLeaf(ctx, profile, role, leaf, scope, next);
						entryDone(summarizeOrdered(next.map(display)));
						done(summarizeOrdered(next.map(display)));
					},
				),
		});
	}
	items.push({
		id: "add",
		label: "Add value",
		currentValue: leaf === "models" ? "search models" : "compatible efforts",
		submenu: (_current, addDone) => {
			if (leaf === "models") {
				const selected = new Set(local);
				return selectComponent(
					modelOptions(ctx)
						.filter((model) => !selected.has(model.id))
						.map((model) => ({
							value: model.id,
							label: model.label,
							description: model.description,
						})),
					(value) => {
						if (!value) return addDone();
						const next = [...local, value];
						writeRoleLeaf(ctx, profile, role, leaf, scope, next);
						addDone(summarizeOrdered(next.map(display)));
						done(summarizeOrdered(next.map(display)));
					},
				);
			}
			const configuredModels =
				readRoleLeaf(ctx, profile, role, "models").effective ?? [];
			const supported = configuredModels.length
				? THINKING_LEVELS.filter((effort) =>
						configuredModels.some((id) =>
							modelOptions(ctx)
								.find((model) => model.id === id)
								?.supported.includes(effort),
						),
					)
				: [...THINKING_LEVELS];
			return selectComponent(
				supported
					.filter((effort) => !local.includes(effort))
					.map((effort) => ({ value: effort, label: effort })),
				(value) => {
					if (!value) return addDone();
					const next = [...local, value];
					writeRoleLeaf(ctx, profile, role, leaf, scope, next);
					addDone(summarizeOrdered(next));
					done(summarizeOrdered(next));
				},
			);
		},
	});
	if (local.length > 0)
		items.push({
			id: "reset",
			label: "Reset current scope",
			currentValue: `inherit ${scope === "session" ? "project/global" : scope === "project" ? "global" : "session model"}`,
			values: ["reset"],
		});
	if (local.length === 0 && effective.length > 0)
		items.push({
			id: "replace",
			label: "Replace at this scope",
			currentValue: `copy ${effective.length} effective value(s)`,
			values: ["copy"],
		});
	return settingsComponent(
		items,
		(id) => {
			if (id === "reset")
				writeRoleLeaf(ctx, profile, role, leaf, scope, undefined);
			if (id === "replace")
				writeRoleLeaf(ctx, profile, role, leaf, scope, effective);
			done(roleSummary(ctx, profile, role));
		},
		() => done(),
	);
}

function leafScopes(
	ctx: ExtensionContext,
	profile: string,
	role: ModelRole,
	leaf: RoleLeaf,
	done: (value?: string) => void,
): Component {
	const layered = readRoleLeaf(ctx, profile, role, leaf);
	const items = SCOPES.map(
		(scope): SettingItem => ({
			id: scope,
			label: scope[0].toUpperCase() + scope.slice(1),
			currentValue: layered[scope]?.length
				? summarizeOrdered(layered[scope]!)
				: "inherit",
			description: `${scope === layered.source ? "Effective source. " : ""}Precedence: session → project → global → live session fallback.`,
			submenu: (_value, scopeDone) =>
				arrayEditor(ctx, profile, role, leaf, scope, scopeDone),
		}),
	);
	return settingsComponent(
		items,
		() => done(roleSummary(ctx, profile, role)),
		() => done(),
	);
}

function roleDetail(
	ctx: ExtensionContext,
	profile: string,
	role: ModelRole,
	done: (value?: string) => void,
): Component {
	const models = readRoleLeaf(ctx, profile, role, "models");
	const efforts = readRoleLeaf(ctx, profile, role, "efforts");
	return settingsComponent(
		[
			{
				id: "models",
				label: "Models",
				currentValue: models.effective?.length
					? summarizeOrdered(
							models.effective.map((id) => resolveModelName(ctx, id)),
						)
					: "live session fallback",
				description: `Ordered exact provider/model allowlist. ${sourceChain(models)}`,
				submenu: (_value, leafDone) =>
					leafScopes(ctx, profile, role, "models", leafDone),
			},
			{
				id: "efforts",
				label: "Efforts",
				currentValue: efforts.effective?.length
					? summarizeOrdered(efforts.effective)
					: "provider default",
				description: `Ordered effort allowlist, filtered by configured model support. ${sourceChain(efforts)}`,
				submenu: (_value, leafDone) =>
					leafScopes(ctx, profile, role, "efforts", leafDone),
			},
		],
		() => done(roleSummary(ctx, profile, role)),
		() => done(),
	);
}

function targetsEditor(
	ctx: ExtensionContext,
	profile: string,
	done: (value?: string) => void,
): Component {
	const targets = readProfileTargets(ctx, profile);
	return selectComponent(
		PERSISTENT_SCOPES.map((scope) => ({
			value: scope,
			label: `${scope}: ${targets[scope]?.length ?? 0} target(s)`,
			description:
				scope === targets.source ? "effective source" : "inherits when unset",
		})),
		(scopeValue) => {
			if (!scopeValue) return done();
			const scope = scopeValue as "global" | "project";
			let selected = [...(targets[scope] ?? targets.effective ?? [])];
			const owners = new Map<string, string>();
			for (const [name, config] of Object.entries(
				readModelsConfig(ctx.cwd)?.profiles ?? {},
			))
				for (const target of config.targets) owners.set(target, name);
			const component = new MultiSelectComponent(
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
				() => done(`${selected.length} target(s) · ${scope}`),
			);
			return component;
		},
	);
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
				submenu: (_value, roleDone) => roleDetail(ctx, profile, role, roleDone),
			}),
		),
		{
			id: "rename",
			label: "Rename profile",
			currentValue: profile,
			submenu: (_value, renameDone) =>
				makeInput(profile, (name) => {
					if (name?.trim() && name.trim() !== profile) {
						for (const scope of PERSISTENT_SCOPES) {
							renameProfile(ctx, profile, name.trim(), scope);
						}
					}
					renameDone(name?.trim());
					done(name?.trim());
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
		() => done(),
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
		() => done(`${modelProfileKeys(ctx).length} profile(s)`),
		() => done(),
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
		() => done(`${selected.length} enabled`),
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
								done(value);
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
							done(value);
						},
					);
				},
			}),
		),
		() =>
			done(
				formatSettingValue(
					readAdvancedValue(ctx.cwd, extension, path, defaultValue).effective,
				),
			),
		() => done(),
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
		() => done(`${items.length} settings`),
		() => done(),
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
			currentValue: active?.name ?? "none · session fallbacks",
		},
	];
	if (active) {
		for (const role of MODEL_ROLES)
			items.push({
				id: `active-role:${role}`,
				label: role,
				currentValue: roleSummary(ctx, active.name, role),
				description: "Effective role pool summary for the active profile.",
				submenu: (_value, roleDone) =>
					roleDetail(ctx, active.name, role, roleDone),
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
