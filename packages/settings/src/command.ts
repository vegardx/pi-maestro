// Scripting surface for /maestro. It shares normalized role/source helpers with
// the interactive hierarchy; output stays intentionally plain and stable.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MODEL_ROLES, type ModelRole } from "@vegardx/pi-contracts";
import {
	activeProfile,
	readModelsConfig,
	SESSION_MODEL_SENTINEL,
} from "@vegardx/pi-models";
import {
	activeProfileName,
	formatSettingValue,
	isModelRole,
	type MaestroScope,
	modelOptions,
	modelProfileKeys,
	parseSettingValue,
	readAdvancedValue,
	readProfileTargets,
	readRoleLeaf,
	resolveModelName,
	sessionFallbackLabel,
	sessionModelId,
	supportedEfforts,
	THINKING_LEVELS,
	writeAdvancedValue,
	writeProfileTargets,
	writeRoleLeaf,
} from "./model.js";
import { readLayeredExtensionConfig } from "./reader.js";

interface ProfileKey {
	readonly profile: string;
	readonly kind: "targets" | "role";
	readonly role?: ModelRole;
	readonly leaf?: "models" | "efforts";
}

function parseProfileKey(key: string): ProfileKey | undefined {
	const parts = key.split(".");
	if (parts[0] !== "models" || parts[1] !== "profiles" || !parts[2])
		return undefined;
	if (parts.length === 4 && parts[3] === "targets")
		return { profile: parts[2], kind: "targets" };
	if (
		(parts.length === 6 || (parts.length === 7 && parts[6] === "")) &&
		parts[3] === "roles" &&
		isModelRole(parts[4]) &&
		(parts[5] === "models" || parts[5] === "efforts")
	)
		return { profile: parts[2], kind: "role", role: parts[4], leaf: parts[5] };
	return undefined;
}

function parseScope(args: string): { scope: MaestroScope; rest: string } {
	let scope: MaestroScope = "project";
	let rest = args.trim();
	for (const candidate of ["global", "project", "session"] as const) {
		const flag = `--${candidate}`;
		if (rest === flag || rest.startsWith(`${flag} `)) {
			scope = candidate;
			rest = rest.slice(flag.length).trim();
			break;
		}
	}
	return { scope, rest };
}

function splitKeyValue(
	input: string,
): { key: string; raw: string } | undefined {
	const match = input.match(/^(\S+)\s+([\s\S]+)$/);
	return match ? { key: match[1], raw: match[2] } : undefined;
}

function profileKeySuggestions(ctx: ExtensionContext): string[] {
	const suggestions: string[] = [];
	for (const profile of modelProfileKeys(ctx)) {
		suggestions.push(`models.profiles.${profile}.targets`);
		for (const role of MODEL_ROLES) {
			suggestions.push(`models.profiles.${profile}.roles.${role}.models`);
			suggestions.push(`models.profiles.${profile}.roles.${role}.efforts`);
		}
	}
	return suggestions;
}

function extensionKeySuggestions(ctx: ExtensionContext): string[] {
	const { merged } = readLayeredExtensionConfig(ctx.cwd);
	const out: string[] = [];
	const walk = (value: unknown, prefix: string): void => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			out.push(prefix);
			return;
		}
		for (const [name, child] of Object.entries(value))
			walk(child, prefix ? `${prefix}.${name}` : name);
	};
	for (const [extension, config] of Object.entries(merged))
		walk(config, extension);
	return out;
}

function handleShow(ctx: ExtensionContext): void {
	const config = readModelsConfig(ctx.cwd);
	const active = activeProfile(config, sessionModelId(ctx));
	const lines = [
		"Maestro Configuration",
		`Session model: ${sessionModelId(ctx) ?? "none"}`,
		`Active profile: ${active?.name ?? "none (all roles follow session)"}`,
		"",
		"Model profiles:",
	];
	for (const profile of modelProfileKeys(ctx)) {
		const targets = readProfileTargets(ctx, profile);
		lines.push(`  ${profile}${profile === active?.name ? " (active)" : ""}`);
		lines.push(
			`    targets = ${formatSettingValue(targets.effective)} [${targets.source ?? "unset"}]`,
		);
		for (const role of MODEL_ROLES) {
			const models = readRoleLeaf(ctx, profile, role, "models");
			const efforts = readRoleLeaf(ctx, profile, role, "efforts");
			if (!models.effective?.length && !efforts.effective?.length) continue;
			lines.push(
				`    ${role}.models = ${models.effective?.length ? formatSettingValue(models.effective) : sessionFallbackLabel(ctx)} [${models.source ?? "unset"}]`,
			);
			lines.push(
				`    ${role}.efforts = ${efforts.effective?.length ? formatSettingValue(efforts.effective) : "auto"} [${efforts.source ?? "unset"}]`,
			);
		}
	}
	const { merged } = readLayeredExtensionConfig(ctx.cwd);
	if (Object.keys(merged).length > 0) {
		lines.push("", "Extension settings:");
		let previousExtension = "";
		for (const key of extensionKeySuggestions(ctx)) {
			const dot = key.indexOf(".");
			if (dot < 1) continue;
			const extension = key.slice(0, dot);
			if (extension !== previousExtension) {
				lines.push(`Extension: ${extension}`);
				previousExtension = extension;
			}
			const layered = readAdvancedValue(ctx.cwd, extension, key.slice(dot + 1));
			lines.push(
				`  ${key} = ${formatSettingValue(layered.effective)} [${layered.source}]`,
			);
		}
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

function handleGet(args: string, ctx: ExtensionContext) {
	const key = args.trim();
	if (!key) return ctx.ui.notify("Usage: /maestro get <key>", "warning");
	const profileKey = parseProfileKey(key);
	if (profileKey?.kind === "targets") {
		const value = readProfileTargets(ctx, profileKey.profile);
		ctx.ui.notify(
			`${key} = ${formatSettingValue(value.effective)} [${value.source ?? "unset"}]`,
			"info",
		);
		return;
	}
	if (profileKey?.kind === "role" && profileKey.role && profileKey.leaf) {
		const value = readRoleLeaf(
			ctx,
			profileKey.profile,
			profileKey.role,
			profileKey.leaf,
		);
		ctx.ui.notify(
			`${key} = ${formatSettingValue(value.effective)} [${value.source ?? "fallback"}]`,
			"info",
		);
		return;
	}
	const dot = key.indexOf(".");
	if (dot < 1)
		return ctx.ui.notify(
			"Key must be an extension path or models.profiles.<name> path.",
			"warning",
		);
	const value = readAdvancedValue(
		ctx.cwd,
		key.slice(0, dot),
		key.slice(dot + 1),
	);
	if (value.effective === undefined)
		return ctx.ui.notify(`Key "${key}" not found.`, "warning");
	ctx.ui.notify(
		`${key} = ${formatSettingValue(value.effective)} [${value.source}]`,
		"info",
	);
}

function stringArray(raw: string): readonly string[] | undefined {
	const value = parseSettingValue(raw);
	return Array.isArray(value) &&
		value.length > 0 &&
		value.every((entry) => typeof entry === "string")
		? value
		: undefined;
}

function handleSet(args: string, ctx: ExtensionContext) {
	const { scope, rest } = parseScope(args);
	const parsed = splitKeyValue(rest);
	if (!parsed)
		return ctx.ui.notify(
			"Usage: /maestro set [--session|--project|--global] <key> <value>",
			"warning",
		);
	const profileKey = parseProfileKey(parsed.key);
	if (profileKey) {
		const values = stringArray(parsed.raw);
		if (!values)
			return ctx.ui.notify(
				"Profile targets/models/efforts require a non-empty JSON string array.",
				"warning",
			);
		if (profileKey.kind === "targets") {
			if (scope === "session")
				return ctx.ui.notify(
					"Profile targets support only project or global scope.",
					"warning",
				);
			writeProfileTargets(ctx, profileKey.profile, scope, values);
		} else if (profileKey.role && profileKey.leaf) {
			writeRoleLeaf(
				ctx,
				profileKey.profile,
				profileKey.role,
				profileKey.leaf,
				scope,
				values,
			);
		}
		ctx.ui.notify(
			`✓ Set ${parsed.key} = ${formatSettingValue(values)} [${scope}]`,
			"info",
		);
		return;
	}
	const dot = parsed.key.indexOf(".");
	if (dot < 1)
		return ctx.ui.notify(
			"Key must be an extension path or models.profiles.<name> path.",
			"warning",
		);
	const value = parseSettingValue(parsed.raw);
	writeAdvancedValue(
		ctx.cwd,
		parsed.key.slice(0, dot),
		parsed.key.slice(dot + 1),
		scope,
		value,
	);
	ctx.ui.notify(
		`✓ Set ${parsed.key} = ${formatSettingValue(value)} [${scope}]`,
		"info",
	);
}

function handleReset(args: string, ctx: ExtensionContext) {
	const { scope, rest } = parseScope(args);
	const key = rest.trim();
	if (!key)
		return ctx.ui.notify(
			"Usage: /maestro reset [--session|--project|--global] <key>",
			"warning",
		);
	const profileKey = parseProfileKey(key);
	if (profileKey) {
		if (profileKey.kind === "targets") {
			if (scope === "session")
				return ctx.ui.notify(
					"Profile targets support only project or global scope.",
					"warning",
				);
			writeProfileTargets(ctx, profileKey.profile, scope, undefined);
		} else if (profileKey.role && profileKey.leaf) {
			writeRoleLeaf(
				ctx,
				profileKey.profile,
				profileKey.role,
				profileKey.leaf,
				scope,
				undefined,
			);
		}
		ctx.ui.notify(`✓ Reset ${key} [${scope}]`, "info");
		return;
	}
	const dot = key.indexOf(".");
	if (dot < 1)
		return ctx.ui.notify(
			"Key must be an extension path or models.profiles.<name> path.",
			"warning",
		);
	const before = readAdvancedValue(
		ctx.cwd,
		key.slice(0, dot),
		key.slice(dot + 1),
	)[scope];
	writeAdvancedValue(
		ctx.cwd,
		key.slice(0, dot),
		key.slice(dot + 1),
		scope,
		undefined,
	);
	ctx.ui.notify(
		before === undefined
			? `Key "${key}" was not set in ${scope} settings.`
			: `✓ Reset ${key} (was: ${formatSettingValue(before)}) [${scope}]`,
		"info",
	);
}

function handleProfiles(ctx: ExtensionContext) {
	const config = readModelsConfig(ctx.cwd);
	if (!config)
		return ctx.ui.notify(
			"No model profiles configured. Open /maestro to create one.",
			"info",
		);
	const active = activeProfileName(ctx);
	const lines = [
		`Active profile: ${active ?? "none — all roles follow session"}`,
		"",
	];
	for (const profile of modelProfileKeys(ctx)) {
		lines.push(`${profile}${profile === active ? " (active)" : ""}`);
		lines.push(
			`  targets: ${formatSettingValue(readProfileTargets(ctx, profile).effective)}`,
		);
		for (const role of MODEL_ROLES) {
			const models = readRoleLeaf(ctx, profile, role, "models");
			const efforts = readRoleLeaf(ctx, profile, role, "efforts");
			if (models.effective?.length)
				lines.push(
					`  ${role}.models: ${formatSettingValue(models.effective)} [${models.source}]`,
				);
			if (efforts.effective?.length)
				lines.push(
					`  ${role}.efforts: ${formatSettingValue(efforts.effective)} [${efforts.source}]`,
				);
		}
	}
	lines.push("", "Switch profiles with /model; activation is target-derived.");
	ctx.ui.notify(lines.join("\n"), "info");
}

const ROLE_VERBS = ["list", "add", "remove", "default", "effort"] as const;

/**
 * One-liners edit the pool the user currently sees: the models leaf's
 * effective source, falling back to global for leaves not yet authored.
 */
function roleWriteScope(
	ctx: ExtensionContext,
	profile: string,
	role: ModelRole,
): MaestroScope {
	const source = readRoleLeaf(ctx, profile, role, "models").source;
	return source === undefined || source === "default" ? "global" : source;
}

/** True when every character of `needle` appears in `haystack`, in order. */
function isSubsequence(needle: string, haystack: string): boolean {
	let matched = 0;
	for (const char of haystack) if (char === needle[matched]) matched += 1;
	return matched === needle.length;
}

/** Registry ids resembling `query`, for "did you mean" on unknown models. */
function modelSuggestions(ctx: ExtensionContext, query: string): string[] {
	const fragment = (query.split("/").pop() ?? query).toLowerCase();
	return ctx.modelRegistry
		.getAll()
		.map((model) => `${model.provider}/${model.id}`)
		.filter((id) => {
			const name = id.split("/")[1]?.toLowerCase() ?? id.toLowerCase();
			// Subsequence in either direction absorbs missing/extra characters
			// (gemni → gemini); substring covers partial ids (sonnet → …sonnet…).
			return (
				name.includes(fragment) ||
				fragment.includes(name) ||
				isSubsequence(fragment, name) ||
				isSubsequence(name, fragment)
			);
		})
		.slice(0, 3);
}

function defaultEffortModel(
	ctx: ExtensionContext,
	pool: readonly string[],
): { supported: readonly string[]; model: string } | undefined {
	const model = pool[0];
	if (!model) return undefined;
	// The sentinel default narrows to the live session model's support.
	if (model === SESSION_MODEL_SENTINEL)
		return {
			supported: ctx.model ? supportedEfforts(ctx.model) : THINKING_LEVELS,
			model: sessionModelId(ctx) ?? model,
		};
	// Ids the registry does not know cannot be narrowed; allow every level.
	const supported =
		modelOptions(ctx).find((option) => option.id === model)?.supported ??
		THINKING_LEVELS;
	return { supported, model };
}

function handleRole(role: ModelRole, args: string, ctx: ExtensionContext) {
	const profile = activeProfileName(ctx);
	if (!profile)
		return ctx.ui.notify(
			"No active profile — select a model owned by a profile's targets with /model first.",
			"warning",
		);
	const [verb = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
	const argument = rest.join(" ").trim();
	const scope = roleWriteScope(ctx, profile, role);
	const layered = readRoleLeaf(ctx, profile, role, "models");
	const pool = [...(layered[scope] ?? layered.effective ?? [])];

	if (verb === "list") {
		const efforts = readRoleLeaf(ctx, profile, role, "efforts");
		const lines = [
			`${role} · ${profile} · scope: ${layered.source ?? "unset (writes global)"}`,
		];
		if (pool.length === 0)
			lines.push(`  (empty — ${sessionFallbackLabel(ctx)})`);
		for (const [index, id] of pool.entries())
			lines.push(
				`  ${index + 1}. ${id === SESSION_MODEL_SENTINEL ? sessionFallbackLabel(ctx) : resolveModelName(ctx, id)} — ${id}${index === 0 ? " (default)" : ""}`,
			);
		lines.push(`default effort: ${efforts.effective?.[0] ?? "auto"}`);
		return ctx.ui.notify(lines.join("\n"), "info");
	}
	if (verb === "add" || verb === "default") {
		if (!argument)
			return ctx.ui.notify(
				`Usage: /maestro ${role} ${verb} <provider/model>`,
				"warning",
			);
		if (
			argument !== SESSION_MODEL_SENTINEL &&
			!modelOptions(ctx).some((option) => option.id === argument)
		) {
			const suggestions = modelSuggestions(ctx, argument);
			return ctx.ui.notify(
				`Unknown model "${argument}".${suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""}`,
				"warning",
			);
		}
		if (verb === "add" && pool.includes(argument))
			return ctx.ui.notify(
				`${argument} is already in the ${role} pool.`,
				"info",
			);
		const next =
			verb === "add"
				? [...pool, argument]
				: [argument, ...pool.filter((id) => id !== argument)];
		writeRoleLeaf(ctx, profile, role, "models", scope, next);
		return ctx.ui.notify(
			`✓ ${role}.models = ${next.join(" → ")} [${scope}]`,
			"info",
		);
	}
	if (verb === "remove") {
		if (!argument)
			return ctx.ui.notify(
				`Usage: /maestro ${role} remove <provider/model>`,
				"warning",
			);
		if (!pool.includes(argument))
			return ctx.ui.notify(
				`${argument} is not in the ${role} pool.`,
				"warning",
			);
		const next = pool.filter((id) => id !== argument);
		// Empty pools are stored as a reset scope, never an empty array.
		writeRoleLeaf(
			ctx,
			profile,
			role,
			"models",
			scope,
			next.length ? next : undefined,
		);
		return ctx.ui.notify(
			next.length
				? `✓ ${role}.models = ${next.join(" → ")} [${scope}]`
				: `✓ ${role}.models reset [${scope}] — role follows ${sessionFallbackLabel(ctx)}`,
			"info",
		);
	}
	if (verb === "effort") {
		if (!argument)
			return ctx.ui.notify(
				`Usage: /maestro ${role} effort <level|auto>`,
				"warning",
			);
		// "auto" clears the leaf: the spawner picks the effort per task (the
		// provider default applies if it stays silent). No default model needed.
		if (argument === "auto") {
			writeRoleLeaf(ctx, profile, role, "efforts", scope, undefined);
			return ctx.ui.notify(
				`✓ ${role}.efforts = auto [${scope}] — spawner picks per task`,
				"info",
			);
		}
		const target = defaultEffortModel(ctx, pool);
		if (!target)
			return ctx.ui.notify(
				`${role} has no default model — add one before setting effort.`,
				"warning",
			);
		if (!target.supported.includes(argument))
			return ctx.ui.notify(
				`"${argument}" is not supported by ${target.model}. Supported: ${target.supported.join(", ")}, or auto.`,
				"warning",
			);
		const efforts = readRoleLeaf(ctx, profile, role, "efforts");
		const configured = [...(efforts[scope] ?? efforts.effective ?? [])];
		// The chosen level leads; other configured levels stay as alternates.
		const next = [
			argument,
			...configured.filter((level) => level !== argument),
		];
		writeRoleLeaf(ctx, profile, role, "efforts", scope, next);
		return ctx.ui.notify(
			`✓ ${role}.efforts = ${next.join(" → ")} [${scope}]`,
			"info",
		);
	}
	ctx.ui.notify(
		`Unknown verb "${verb}". Use: ${ROLE_VERBS.join(", ")}`,
		"warning",
	);
}

export function handleSettingsCommand(args: string, ctx: ExtensionContext) {
	const trimmed = args.trim();
	const [sub = "show", ...rest] = trimmed.split(/\s+/);
	const subArgs = rest.join(" ");
	if (sub === "show") return handleShow(ctx);
	if (sub === "get") return handleGet(subArgs, ctx);
	if (sub === "set") return handleSet(subArgs, ctx);
	if (sub === "reset") return handleReset(subArgs, ctx);
	if (sub === "profiles") return handleProfiles(ctx);
	if (isModelRole(sub)) return handleRole(sub, subArgs, ctx);
	ctx.ui.notify(
		`Unknown subcommand "${sub}". Use: show, get, set, reset, profiles, or a role name (${MODEL_ROLES.join(", ")})`,
		"warning",
	);
}

const SUBCOMMANDS = ["show", "get", "set", "reset", "profiles"] as const;

function roleCompletions(
	role: ModelRole,
	parts: string[],
	trailing: boolean,
	ctx: ExtensionContext,
): string[] {
	if (parts.length === 1 && trailing) return [...ROLE_VERBS];
	if (parts.length === 2 && !trailing)
		return ROLE_VERBS.filter((verb) => verb.startsWith(parts[1] ?? ""));
	// Role verbs take exactly one argument.
	if (parts.length > 3 || (parts.length === 3 && trailing)) return [];
	const verb = parts[1];
	const prefix = trailing ? "" : (parts[2] ?? "");
	if (verb === "add" || verb === "remove" || verb === "default")
		return [
			SESSION_MODEL_SENTINEL,
			...modelOptions(ctx).map((option) => option.id),
		].filter((id) => id.startsWith(prefix));
	if (verb === "effort") {
		const profile = activeProfileName(ctx);
		const pool = profile
			? (readRoleLeaf(ctx, profile, role, "models").effective ?? [])
			: [];
		const supported =
			defaultEffortModel(ctx, pool)?.supported ?? THINKING_LEVELS;
		return [...supported, "auto"].filter((level) => level.startsWith(prefix));
	}
	return [];
}

export function getSettingsCompletions(
	args: string,
	ctx: ExtensionContext,
): string[] {
	const trailing = args.endsWith(" ");
	const parts = args.trim().split(/\s+/);
	if (parts.length <= 1 && !trailing)
		return [...SUBCOMMANDS, ...MODEL_ROLES].filter((item) =>
			item.startsWith(parts[0] ?? ""),
		);
	const sub = parts[0];
	if (isModelRole(sub)) return roleCompletions(sub, parts, trailing, ctx);
	if (sub !== "get" && sub !== "set" && sub !== "reset") return [];
	const flags = ["--session", "--project", "--global"];
	const offset = flags.includes(parts[1]) ? 2 : 1;
	const key = parts[offset] ?? "";
	const valuePosition =
		parts.length > offset + 1 || (trailing && parts.length > offset);
	if (sub === "set" && valuePosition) {
		if (key.endsWith(".efforts"))
			return [`["${THINKING_LEVELS[0]}"]`, ...THINKING_LEVELS];
		if (key.endsWith(".models") || key.endsWith(".targets"))
			return ['["provider/model"]'];
		if (key.endsWith("thinking") || key.endsWith("effort"))
			return [...THINKING_LEVELS];
		return [];
	}
	const prefix = trailing ? "" : key;
	const suggestions = [
		...profileKeySuggestions(ctx),
		...extensionKeySuggestions(ctx),
	].filter((item) => item.startsWith(prefix));
	if ((sub === "set" || sub === "reset") && offset === 1 && parts.length <= 2)
		suggestions.push(...flags.filter((flag) => flag.startsWith(prefix)));
	return [...new Set(suggestions)];
}
