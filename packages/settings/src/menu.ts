// Interactive /maestro entry. The exact domain graph is authoritative; this
// compact menu exposes its summary and directs edits through scripted keys.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getSessionSettingOverride,
	setSessionSettingOverride,
} from "@vegardx/pi-contracts";
import { type DomainRegistryInput, readDomainSnapshot } from "./domain.js";

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

export async function showConfigMenu(
	ctx: ExtensionContext,
	registry: DomainRegistryInput = {},
): Promise<void> {
	const snapshot = readDomainSnapshot(ctx, registry);
	// Interactive browser wherever a select dialog exists (TUI overlay, or an
	// extension_ui_request over RPC — a driver can navigate it too). The plain
	// notify summary remains the fallback for print/json surfaces.
	const select = ctx.hasUI ? ctx.ui.select?.bind(ctx.ui) : undefined;
	if (!select) {
		notifySummary(ctx, snapshot);
		return;
	}
	// Esc/cancel anywhere exits the menu (select resolves undefined).
	while (true) {
		const choice = await select(
			`Maestro configuration — preset: ${snapshot.activePreset ?? "session fallback"}`,
			[
				`Model sets (${snapshot.modelSets.length})`,
				`Presets (${snapshot.presets.length})`,
				`Agent kinds (${snapshot.kinds.length})`,
				`Runtime policies (${snapshot.runtimePolicies.length})`,
				`Transition gates (${snapshot.gates.length})`,
				"Summary",
			],
		);
		if (!choice) return;
		if (choice.startsWith("Model sets")) await browseModelSets(ctx, snapshot);
		else if (choice.startsWith("Presets")) await browsePresets(ctx, snapshot);
		else if (choice.startsWith("Agent kinds")) await browseKinds(ctx, snapshot);
		else if (choice.startsWith("Runtime policies"))
			notifyPolicies(ctx, snapshot);
		else if (choice.startsWith("Transition gates")) notifyGates(ctx, snapshot);
		else notifySummary(ctx, snapshot);
	}
}

type Snapshot = ReturnType<typeof readDomainSnapshot>;
type SelectFn = (
	title: string,
	options: string[],
) => Promise<string | undefined>;

async function browseModelSets(
	ctx: ExtensionContext,
	snapshot: Snapshot,
): Promise<void> {
	const select = ctx.ui.select?.bind(ctx.ui) as SelectFn;
	if (snapshot.modelSets.length === 0) {
		ctx.ui.notify(
			"No exact model sets configured. Define models.modelSets in settings; /maestro set edits them.",
			"info",
		);
		return;
	}
	while (true) {
		const picked = await select(
			"Model sets (Esc to go back)",
			snapshot.modelSets.map(
				(s) =>
					`${s.id} — ${s.options.length} option(s)${s.usedBy.length ? ` · used by ${s.usedBy.join(", ")}` : ""}`,
			),
		);
		if (!picked) return;
		const set = snapshot.modelSets.find((s) => picked.startsWith(`${s.id} `));
		if (!set) return;
		ctx.ui.notify(
			[
				`Model set ${set.id}${set.usedBy.length ? ` — used by ${set.usedBy.join(", ")}` : ""}`,
				...set.options.map(
					(o) => `  ${o.id}: ${o.model} @${o.effort} — ${o.summary}`,
				),
				"",
				"First available option wins; `session` sorts to the back.",
				"Edit via /maestro set (scripted), or settings.json models.modelSets.",
			].join("\n"),
			"info",
		);
	}
}

async function browsePresets(
	ctx: ExtensionContext,
	snapshot: Snapshot,
): Promise<void> {
	const select = ctx.ui.select?.bind(ctx.ui) as SelectFn;
	if (snapshot.presets.length === 0) {
		ctx.ui.notify("No presets configured (session fallback).", "info");
		return;
	}
	while (true) {
		const picked = await select(
			"Presets (Esc to go back)",
			snapshot.presets.map(
				(preset) =>
					`${preset.id}${preset.id === snapshot.activePreset ? " (active)" : ""} — targets: ${preset.targets.join(", ") || "(none)"}`,
			),
		);
		if (!picked) return;
		const preset = snapshot.presets.find((candidate) =>
			picked.startsWith(candidate.id),
		);
		if (!preset) return;
		const roleLines = Object.entries(preset.modelSets).map(
			([role, set]) => `  ${role} → ${set}`,
		);
		ctx.ui.notify(
			[
				`Preset ${preset.id} (${preset.source})`,
				`Targets: ${preset.targets.join(", ") || "(none)"}`,
				roleLines.length ? "Role → model set:" : "No role mappings.",
				...roleLines,
				"",
				"Live per-role resolution: /models (or /models <role>).",
			].join("\n"),
			"info",
		);
	}
}

async function browseKinds(
	ctx: ExtensionContext,
	snapshot: Snapshot,
): Promise<void> {
	const select = ctx.ui.select?.bind(ctx.ui) as SelectFn;
	while (true) {
		const picked = await select(
			"Agent kinds (Esc to go back)",
			snapshot.kinds.map(
				(k) =>
					`${k.kind} — policy ${k.runtimePolicy}${k.modelSet ? ` · set ${k.modelSet}` : ""} (${k.source})`,
			),
		);
		if (!picked) return;
		const kind = picked.split(" ")[0];
		ctx.ui.notify(`Full detail: /maestro explain ${kind}`, "info");
	}
}

function notifyPolicies(ctx: ExtensionContext, snapshot: Snapshot): void {
	ctx.ui.notify(
		[
			"Runtime policies:",
			...snapshot.runtimePolicies.map(
				(p) =>
					`  ${p.id}: permissions=${p.permissions} session=${p.session} transport=${p.transport}`,
			),
		].join("\n"),
		"info",
	);
}

function notifyGates(ctx: ExtensionContext, snapshot: Snapshot): void {
	ctx.ui.notify(
		snapshot.gates.length
			? [
					"Transition gates:",
					...snapshot.gates.map(
						(g) =>
							`  ${g.id}: ${g.edges.join("/")} via ${g.agentKind} (${g.contract}) ${g.enabled ? "on" : "off"}`,
					),
				].join("\n")
			: "No transition gates configured.",
		"info",
	);
}

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
