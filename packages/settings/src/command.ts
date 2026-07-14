// Scripting surface for /maestro. It shares normalized role/source helpers with
// the interactive hierarchy; output stays intentionally plain and stable.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MODEL_ROLES, type ModelRole } from "@vegardx/pi-contracts";
import { activeProfile, readModelsConfig } from "@vegardx/pi-models";
import {
	activeProfileName,
	formatSettingValue,
	isModelRole,
	type MaestroScope,
	modelProfileKeys,
	parseSettingValue,
	readAdvancedValue,
	readProfileTargets,
	readRoleLeaf,
	sessionModelId,
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
		parts.length === 7 &&
		parts[3] === "roles" &&
		isModelRole(parts[4]) &&
		(parts[5] === "models" || parts[5] === "efforts")
	) {
		// Accept the documented path without a trailing segment. The length guard
		// above is retained below for compatibility with shell-added empty pieces.
		return { profile: parts[2], kind: "role", role: parts[4], leaf: parts[5] };
	}
	if (
		parts.length === 6 &&
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
		`Active profile: ${active?.name ?? "none (live-session fallbacks)"}`,
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
				`    ${role}.models = ${formatSettingValue(models.effective)} [${models.source ?? "session fallback"}]`,
			);
			lines.push(
				`    ${role}.efforts = ${formatSettingValue(efforts.effective)} [${efforts.source ?? "provider default"}]`,
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
		`Active profile: ${active ?? "none — roles use session fallbacks"}`,
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

export function handleSettingsCommand(args: string, ctx: ExtensionContext) {
	const trimmed = args.trim();
	const [sub = "show", ...rest] = trimmed.split(/\s+/);
	const subArgs = rest.join(" ");
	if (sub === "show") return handleShow(ctx);
	if (sub === "get") return handleGet(subArgs, ctx);
	if (sub === "set") return handleSet(subArgs, ctx);
	if (sub === "reset") return handleReset(subArgs, ctx);
	if (sub === "profiles") return handleProfiles(ctx);
	ctx.ui.notify(
		`Unknown subcommand "${sub}". Use: show, get, set, reset, profiles`,
		"warning",
	);
}

const SUBCOMMANDS = ["show", "get", "set", "reset", "profiles"] as const;

export function getSettingsCompletions(
	args: string,
	ctx: ExtensionContext,
): string[] {
	const trailing = args.endsWith(" ");
	const parts = args.trim().split(/\s+/);
	if (parts.length <= 1 && !trailing)
		return SUBCOMMANDS.filter((item) => item.startsWith(parts[0] ?? ""));
	const sub = parts[0];
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
