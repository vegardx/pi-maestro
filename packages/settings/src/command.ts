// /maestro command — show, get, set, reset, preset subcommands.
//
// Displays effective configuration with source annotations and allows
// modification of project/global settings.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MODEL_ROLES, type ModelsConfig } from "@vegardx/pi-contracts";
import { activeProfile, readModelsConfig } from "@vegardx/pi-models";
import {
	type ExtensionConfigMap,
	readLayeredExtensionConfig,
} from "./reader.js";
import { type SettingsScope, writeExtensionConfigKey } from "./writer.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

type Source = "global" | "project" | "env" | "default";

/** The profile whose targets include the current session model (derived). */
function activeProfileName(
	ctx: ExtensionContext,
	cfg: ModelsConfig,
): string | undefined {
	const sessionId = ctx.model
		? `${ctx.model.provider}/${ctx.model.id}`
		: undefined;
	return activeProfile(cfg, sessionId)?.name;
}

interface AnnotatedValue {
	key: string;
	value: unknown;
	source: Source;
}

function flattenConfig(
	obj: Record<string, unknown>,
	prefix: string,
): Array<{ key: string; value: unknown }> {
	const entries: Array<{ key: string; value: unknown }> = [];
	for (const [k, v] of Object.entries(obj)) {
		const path = prefix ? `${prefix}.${k}` : k;
		if (isPlainObject(v)) {
			entries.push(...flattenConfig(v, path));
		} else {
			entries.push({ key: path, value: v });
		}
	}
	return entries;
}

function annotate(
	global: ExtensionConfigMap,
	project: ExtensionConfigMap,
	merged: ExtensionConfigMap,
): Map<string, AnnotatedValue[]> {
	const byExtension = new Map<string, AnnotatedValue[]>();
	for (const name of Object.keys(merged)) {
		const items: AnnotatedValue[] = [];
		const flat = flattenConfig(merged[name], "");
		for (const { key, value } of flat) {
			const source = hasKey(project[name], key)
				? "project"
				: hasKey(global[name], key)
					? "global"
					: "default";
			items.push({ key, value, source });
		}
		byExtension.set(name, items);
	}
	return byExtension;
}

function hasKey(
	obj: Record<string, unknown> | undefined,
	key: string,
): boolean {
	if (!obj) return false;
	let current: unknown = obj;
	for (const part of key.split(".")) {
		if (!isPlainObject(current) || !Object.hasOwn(current, part)) return false;
		current = current[part];
	}
	return true;
}

function formatRole(config: {
	readonly models?: readonly string[];
	readonly efforts?: readonly string[];
}): string {
	const models = config.models?.join(" → ") ?? "session";
	const efforts = config.efforts?.join(" → ");
	return efforts ? `${models} (${efforts})` : models;
}

function formatValue(v: unknown): string {
	if (typeof v === "string") return v;
	if (Array.isArray(v)) return v.join(" \u2192 ");
	return JSON.stringify(v);
}

function boxDraw(title: string, content: string[]): string {
	const maxLine = Math.max(...content.map((l) => l.length), 0);
	const w = Math.max(maxLine + 4, title.length + 6, 40);
	const titleStr = ` ${title} `;
	const topPad = w - 2 - titleStr.length;
	const top = `\u256d\u2500${titleStr}${"\u2500".repeat(Math.max(topPad, 0))}\u256e`;
	const bot = `\u2570${"\u2500".repeat(w)}\u256f`;
	const lines = content.map((l) => `\u2502  ${l.padEnd(w - 3)}\u2502`);
	return [top, ...lines, bot].join("\n");
}

// ─── Subcommands ────────────────────────────────────────────────────────────

function handleShow(ctx: ExtensionContext): void {
	const { global, project, merged } = readLayeredExtensionConfig(ctx.cwd);
	const modelsConfig = readModelsConfig(ctx.cwd);

	const content: string[] = [];

	// Model profiles section
	if (modelsConfig) {
		const active = activeProfileName(ctx, modelsConfig);
		content.push("Model profiles");
		content.push("");
		for (const [name, profile] of Object.entries(modelsConfig.profiles)) {
			const marker = name === active ? " (active)" : "";
			content.push(`  ${name}${marker}`);
			content.push(
				`    targets: ${profile.targets.length ? profile.targets.join(", ") : "(none)"}`,
			);
			for (const role of MODEL_ROLES) {
				const config = profile.roles[role];
				if (!config) continue;
				content.push(`    ${role.padEnd(20)} ${formatRole(config)}`);
			}
		}
		content.push("");
	}

	// Extension configs
	const byExt = annotate(global, project, merged);
	for (const [name, items] of byExt) {
		if (items.length === 0) continue;
		content.push(`Extension: ${name}`);
		const maxKey = Math.max(...items.map((i) => i.key.length), 0);
		for (const item of items) {
			const val = formatValue(item.value);
			content.push(
				`  ${item.key.padEnd(maxKey + 2)} = ${val.padEnd(24)} [${item.source}]`,
			);
		}
		content.push("");
	}

	if (content.length === 0) {
		content.push("No profiles or extension settings configured.");
		content.push("");
		content.push("Open the interactive editor with /maestro, or hand-edit");
		content.push("settings.json:");
		content.push('  { "models": { "profiles": {');
		content.push('    "opus": {');
		content.push('      "targets": ["anthropic/claude-opus-4-8"],');
		content.push(
			'      "roles": { "reviewer": { "models": ["openai/gpt-5.5"], "efforts": ["high"] } }',
		);
		content.push("    } } } }");
	}

	ctx.ui.notify(boxDraw("Maestro Configuration", content), "info");
}

function handleGet(args: string, ctx: ExtensionContext): void {
	const key = args.trim();
	if (!key) {
		ctx.ui.notify("Usage: /maestro get <extension>.<key>", "warning");
		return;
	}

	const dotIndex = key.indexOf(".");
	if (dotIndex <= 0) {
		ctx.ui.notify(
			"Key must be in format: <extension>.<path> (e.g. modes.models.agent.thinking)",
			"warning",
		);
		return;
	}

	const extName = key.slice(0, dotIndex);
	const subKey = key.slice(dotIndex + 1);

	const { global, project, merged } = readLayeredExtensionConfig(ctx.cwd);
	const entry = merged[extName];
	if (!entry) {
		ctx.ui.notify(`No settings for extension "${extName}".`, "warning");
		return;
	}

	let current: unknown = entry;
	for (const part of subKey.split(".")) {
		if (!isPlainObject(current) || !Object.hasOwn(current, part)) {
			ctx.ui.notify(`Key "${key}" not found.`, "warning");
			return;
		}
		current = current[part];
	}

	const source = hasKey(project[extName], subKey)
		? "project"
		: hasKey(global[extName], subKey)
			? "global"
			: "default";

	const val = isPlainObject(current)
		? JSON.stringify(current, null, 2)
		: formatValue(current);
	ctx.ui.notify(`${key} = ${val}  [${source}]`, "info");
}

function handleSet(args: string, ctx: ExtensionContext): void {
	let scope: SettingsScope = "project";
	let rest = args.trim();

	if (rest.startsWith("--global ")) {
		scope = "global";
		rest = rest.slice("--global ".length).trim();
	}

	const parts = rest.split(/\s+/);
	if (parts.length < 2) {
		ctx.ui.notify(
			"Usage: /maestro set [--global] <extension>.<key> <value>",
			"warning",
		);
		return;
	}

	const key = parts[0];
	const rawValue = parts.slice(1).join(" ");
	const dotIndex = key.indexOf(".");
	if (dotIndex <= 0) {
		ctx.ui.notify(
			"Key must be in format: <extension>.<path> (e.g. modes.models.agent.thinking)",
			"warning",
		);
		return;
	}

	const extName = key.slice(0, dotIndex);
	const subKey = key.slice(dotIndex + 1);

	// Parse value: try JSON first, fall back to string
	let value: boolean | string | number | readonly string[];
	try {
		const parsed = JSON.parse(rawValue);
		if (
			typeof parsed === "boolean" ||
			typeof parsed === "number" ||
			typeof parsed === "string" ||
			(Array.isArray(parsed) && parsed.every((v) => typeof v === "string"))
		) {
			value = parsed;
		} else {
			value = rawValue;
		}
	} catch {
		value = rawValue;
	}

	const result = writeExtensionConfigKey(
		scope,
		ctx.cwd,
		extName,
		subKey,
		value,
	);
	ctx.ui.notify(
		`\u2713 Set ${key} = ${formatValue(value)} [${scope}]\n  \u2192 ${result.path}`,
		"info",
	);
}

function handleReset(args: string, ctx: ExtensionContext): void {
	let scope: SettingsScope = "project";
	let rest = args.trim();

	if (rest.startsWith("--global ")) {
		scope = "global";
		rest = rest.slice("--global ".length).trim();
	}

	const key = rest.trim();
	if (!key) {
		ctx.ui.notify(
			"Usage: /maestro reset [--global] <extension>.<key>",
			"warning",
		);
		return;
	}

	const dotIndex = key.indexOf(".");
	if (dotIndex <= 0) {
		ctx.ui.notify(
			"Key must be in format: <extension>.<path> (e.g. modes.models.agent.thinking)",
			"warning",
		);
		return;
	}

	const extName = key.slice(0, dotIndex);
	const subKey = key.slice(dotIndex + 1);

	const result = writeExtensionConfigKey(scope, ctx.cwd, extName, subKey, null);
	if (result.previous === undefined) {
		ctx.ui.notify(`Key "${key}" was not set in ${scope} settings.`, "info");
	} else {
		ctx.ui.notify(
			`\u2713 Reset ${key} (was: ${formatValue(result.previous)}) [${scope}]\n  \u2192 ${result.path}`,
			"info",
		);
	}
}

function handleProfiles(ctx: ExtensionContext): void {
	const modelsConfig = readModelsConfig(ctx.cwd);
	if (!modelsConfig) {
		ctx.ui.notify(
			"No model profiles configured. Open /maestro to create one.",
			"info",
		);
		return;
	}
	const active = activeProfileName(ctx, modelsConfig);
	const lines: string[] = [];
	lines.push(
		active
			? `Active profile: ${active} (via /model)`
			: "No active profile — roles fall back to the session model.",
	);
	lines.push("");
	for (const [name, profile] of Object.entries(modelsConfig.profiles)) {
		const marker = name === active ? " (active)" : "";
		lines.push(`  ${name}${marker}`);
		lines.push(
			`    targets: ${profile.targets.length ? profile.targets.join(", ") : "(none)"}`,
		);
		for (const role of MODEL_ROLES) {
			const config = profile.roles[role];
			if (!config) continue;
			lines.push(`    ${role.padEnd(20)} ${formatRole(config)}`);
		}
	}
	lines.push("");
	lines.push(
		"Switch profiles with /model \u2014 the session model selects it.",
	);
	ctx.ui.notify(lines.join("\n"), "info");
}

// ─── Main dispatch ──────────────────────────────────────────────────────────

export function handleSettingsCommand(
	args: string,
	ctx: ExtensionContext,
): void {
	const trimmed = args.trim();
	const spaceIdx = trimmed.indexOf(" ");
	const sub = spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed || "show";
	const subArgs = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1) : "";

	switch (sub) {
		case "show":
			handleShow(ctx);
			break;
		case "get":
			handleGet(subArgs, ctx);
			break;
		case "set":
			handleSet(subArgs, ctx);
			break;
		case "reset":
			handleReset(subArgs, ctx);
			break;
		case "profiles":
			handleProfiles(ctx);
			break;
		default:
			ctx.ui.notify(
				`Unknown subcommand "${sub}". Use: show, get, set, reset, profiles`,
				"warning",
			);
	}
}

// ─── Tab completions ────────────────────────────────────────────────────────

const SUBCOMMANDS = ["show", "get", "set", "reset", "profiles"] as const;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

export function getSettingsCompletions(
	args: string,
	ctx: ExtensionContext,
): string[] {
	const hasTrailingSpace = args.endsWith(" ");
	const parts = args.trim().split(/\s+/);

	// Complete subcommand
	if (parts.length <= 1 && !hasTrailingSpace) {
		const prefix = parts[0] ?? "";
		return SUBCOMMANDS.filter((s) => s.startsWith(prefix));
	}

	const sub = parts[0];

	// Complete key for get/set/reset
	if (sub === "get" || sub === "set" || sub === "reset") {
		const offset = sub === "set" && parts[1] === "--global" ? 2 : 1;

		// For set: suggest values if key is already provided
		const keyComplete =
			parts.length > offset && (hasTrailingSpace || parts.length > offset + 1);
		if (sub === "set" && keyComplete) {
			const key = parts[offset];
			if (key.endsWith("thinking") || key.endsWith("effort")) {
				return [...THINKING_LEVELS];
			}
			return [];
		}

		const keyPart = hasTrailingSpace ? "" : (parts[offset] ?? "");

		// Suggest known extension keys
		const { merged } = readLayeredExtensionConfig(ctx.cwd);
		const suggestions: string[] = [];
		for (const name of Object.keys(merged)) {
			const flat = flattenConfig(merged[name], name);
			for (const { key } of flat) {
				if (key.startsWith(keyPart)) suggestions.push(key);
			}
		}

		if (suggestions.length > 0) return suggestions;
		// Suggest --global flag
		if (sub !== "get" && parts.length === 2 && "--global".startsWith(keyPart)) {
			return ["--global"];
		}
	}

	return [];
}
