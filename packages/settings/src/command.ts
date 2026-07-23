// Scripted /maestro surface for scalar settings and exact agent-domain config.

import {
	type ExtensionContext,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	MODEL_ROLES,
	type ModelRole,
	SPAWNABLE_AGENT_TYPES,
	type SpawnableAgentType,
} from "@vegardx/pi-contracts";
import {
	type DomainRegistryInput,
	domainImpact,
	explainModelSelection,
	explainModelSelectionV2,
	readDomainSnapshot,
	validateDomainEdit,
	writeDomainValue,
} from "./domain.js";
import {
	formatSettingValue,
	parseSettingValue,
	readAdvancedValue,
	writeAdvancedValue,
} from "./model.js";
import { declaredSettingKeys } from "./registry.js";

const SCOPES = ["--session", "--project", "--global"] as const;
type Scope = "session" | "project" | "global";

function parseScoped(args: string): { scope: Scope; key: string; raw: string } {
	const parts = args.trim().split(/\s+/);
	let scope: Scope = "session";
	if (SCOPES.includes(parts[0] as (typeof SCOPES)[number])) {
		scope = parts.shift()!.slice(2) as Scope;
	}
	return { scope, key: parts.shift() ?? "", raw: parts.join(" ") };
}

function notify(ctx: ExtensionContext, text: string, warning = false): void {
	ctx.ui.notify(text, warning ? "warning" : "info");
}

function show(ctx: ExtensionContext, registry: DomainRegistryInput): void {
	const snapshot = readDomainSnapshot(ctx, registry);
	const lines = [
		"Maestro Configuration",
		`Active preset: ${snapshot.activePreset ?? "session fallback"}`,
		`Model sets: ${snapshot.modelSets.length}`,
		`Agent kinds: ${snapshot.kinds.length}`,
		`Runtime policies: ${snapshot.runtimePolicies.length}`,
		`Transition gates: ${snapshot.gates.length}`,
		"",
		"Use /maestro explain <kind>, /maestro validate, or get/set/reset exact keys.",
	];
	notify(ctx, lines.join("\n"));
}

function setValue(
	args: string,
	ctx: ExtensionContext,
	registry: DomainRegistryInput,
) {
	const { scope, key, raw } = parseScoped(args);
	if (!key || !raw)
		return notify(ctx, "set requires a key and JSON value", true);
	const domain =
		key.startsWith("models.") ||
		key.startsWith("agents.") ||
		key.startsWith("transitionGates.");
	try {
		if (domain) {
			const value = parseSettingValue(raw);
			const errors = validateDomainEdit(ctx, key, scope, value, registry);
			if (errors.length)
				return notify(
					ctx,
					errors.map((error) => `- ${error}`).join("\n"),
					true,
				);
			const impact = domainImpact(
				readDomainSnapshot(ctx, registry),
				key,
				value,
			);
			const written = writeDomainValue(ctx, key, scope, raw, registry);
			if (written.length)
				return notify(
					ctx,
					written.map((error) => `- ${error}`).join("\n"),
					true,
				);
			notify(ctx, `✓ ${key} updated [${scope}]\n${impact.join("\n")}`);
			return;
		}
		const dot = key.indexOf(".");
		if (dot < 1)
			return notify(
				ctx,
				"Key must be an extension or agent-domain path.",
				true,
			);
		writeAdvancedValue(
			ctx.cwd,
			key.slice(0, dot),
			key.slice(dot + 1),
			scope,
			parseSettingValue(raw),
		);
		notify(ctx, `✓ ${key} updated [${scope}]`);
	} catch (cause) {
		notify(ctx, cause instanceof Error ? cause.message : String(cause), true);
	}
}

function resetValue(args: string, ctx: ExtensionContext) {
	const { scope, key } = parseScoped(args);
	if (!key) return notify(ctx, "reset requires a key", true);
	const domain =
		key.startsWith("models.") ||
		key.startsWith("agents.") ||
		key.startsWith("transitionGates.");
	if (domain) {
		writeDomainValue(ctx, key, scope, "null");
		notify(ctx, `✓ ${key} reset [${scope}]`);
		return;
	}
	const dot = key.indexOf(".");
	if (dot < 1)
		return notify(ctx, "Key must be an extension or agent-domain path.", true);
	writeAdvancedValue(
		ctx.cwd,
		key.slice(0, dot),
		key.slice(dot + 1),
		scope,
		undefined,
	);
	notify(ctx, `✓ ${key} reset [${scope}]`);
}

function getValue(args: string, ctx: ExtensionContext) {
	const { key } = parseScoped(args);
	if (!key) return notify(ctx, "get requires a key", true);
	const manager = SettingsManager.create(ctx.cwd);
	const readPath = (raw: unknown): unknown =>
		key
			.split(".")
			.reduce<unknown>(
				(value, part) =>
					typeof value === "object" && value !== null
						? (value as Record<string, unknown>)[part]
						: undefined,
				raw,
			);
	const project = readPath(manager.getProjectSettings());
	const global = readPath(manager.getGlobalSettings());
	if (
		key.startsWith("models.") ||
		key.startsWith("agents.") ||
		key.startsWith("transitionGates.")
	) {
		notify(
			ctx,
			`${key} = ${formatSettingValue(project ?? global)} [${project !== undefined ? "project" : global !== undefined ? "global" : "unset"}]`,
		);
		return;
	}
	const dot = key.indexOf(".");
	if (dot < 1)
		return notify(ctx, "Key must be an extension or agent-domain path.", true);
	const value = readAdvancedValue(
		ctx.cwd,
		key.slice(0, dot),
		key.slice(dot + 1),
	);
	notify(
		ctx,
		`${key} = ${formatSettingValue(value.effective)} [${value.source ?? "unset"}]`,
	);
}

export function handleSettingsCommand(
	args: string,
	ctx: ExtensionContext,
	registry: DomainRegistryInput = {},
) {
	const [sub = "show", ...rest] = args.trim().split(/\s+/);
	const tail = rest.join(" ");
	if (sub === "show" || sub === "") return show(ctx, registry);
	if (sub === "get") return getValue(tail, ctx);
	if (sub === "set") return setValue(tail, ctx, registry);
	if (sub === "reset") return resetValue(tail, ctx);
	if (sub === "explain") {
		// v2 first: explain the inheritance-first story per agent type
		// (worker default). Legacy v1 roles keep working for the fallback
		// paths that still read them.
		const agent = SPAWNABLE_AGENT_TYPES.includes(tail as SpawnableAgentType)
			? (tail as SpawnableAgentType)
			: undefined;
		if (agent || tail === "") {
			void explainModelSelectionV2(ctx, agent ?? "worker").then((text) =>
				notify(ctx, text),
			);
			return;
		}
		const role = MODEL_ROLES.includes(tail as ModelRole)
			? (tail as ModelRole)
			: undefined;
		if (!role)
			return notify(
				ctx,
				`Unknown target: ${tail}. Use an agent type (${SPAWNABLE_AGENT_TYPES.join(", ")}) or a legacy v1 role.`,
				true,
			);
		void explainModelSelection(ctx, role).then((text) => notify(ctx, text));
		return;
	}
	if (sub === "validate") {
		const errors = validateDomainEdit(
			ctx,
			"transitionGates.execution-readiness",
			"session",
			JSON.stringify(readDomainSnapshot(ctx, registry).gates[0] ?? {}),
			registry,
		);
		notify(
			ctx,
			errors.length
				? errors.map((error) => `- ${error}`).join("\n")
				: "✓ Maestro configuration is valid.",
			errors.length > 0,
		);
		return;
	}
	notify(
		ctx,
		`Unknown subcommand "${sub}". Use show, get, set, reset, explain, validate, or region.`,
		true,
	);
}

export function getSettingsCompletions(
	args: string,
	_ctx: ExtensionContext,
): string[] {
	const parts = args.trim().split(/\s+/);
	if (parts.length <= 1 && !args.endsWith(" "))
		return [
			"show",
			"get",
			"set",
			"reset",
			"explain",
			"validate",
			"region",
		].filter((item) => item.startsWith(parts[0] ?? ""));
	const sub = parts[0];
	if (!["get", "set", "reset"].includes(sub)) return [];
	const key =
		parts.find((part) => !part.startsWith("--") && part !== sub) ?? "";
	return [
		...declaredSettingKeys(),
		"models.families.",
		"models.rosters.",
		"models.bindings.",
		"models.region.",
		"models.allowances.",
		"agents.kinds.",
		"agents.runtimePolicies.",
		"transitionGates.",
	].filter((item) => item.startsWith(key));
}
