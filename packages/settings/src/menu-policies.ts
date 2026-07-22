// The /maestro "Policies" pages: the ONE policy table (design §Policies)
// with full authoring. The screen shows the EFFECTIVE table — shipped
// DEFAULT_POLICY_ROWS (from contracts, the same array the modes runtime
// merges) with user rows from extensionConfig.modes.policies winning by
// trigger — and every editable field is constrained to its closed
// vocabulary: triggers from known mode edges / POLICY_DUTIES /
// POLICY_TOOL_TRIGGERS, models from TIER_IDS, agent and scope.agent from
// NODE_AGENT_TYPES (policy scope is plan-node types — the runtime-only advisor
// is not policy-scopable), contract from CONTRACT_IDS, persona from the
// personas.v1 roster when available (free text with a warning otherwise),
// scope.depth from a small preset list.
//
// User rows write to modes.policies via updateSettingsFile only after
// validatePolicyRow passes — an invalid row is unwriteable with the
// validator's message shown. Deleting a user row restores the shipped
// default. A trigger nothing consumes yet is flagged inert in plain words.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CONSUMED_POLICY_TRIGGERS,
	CONTRACT_IDS,
	DEFAULT_POLICY_ROWS,
	NODE_AGENT_TYPES,
	POLICY_DUTIES,
	POLICY_TOOL_TRIGGERS,
	type PolicyRow,
	type PolicyRun,
	type PolicyScope,
	TIER_IDS,
	validatePolicyRow,
	validatePolicyRows,
} from "@vegardx/pi-contracts";
import type { DomainRegistryInput } from "./domain.js";
import { DELETE_MARK, type Dialogs } from "./menu-shared.js";
import { isPlainObject, readLayeredExtensionConfig } from "./reader.js";
import { updateSettingsFile } from "./writer.js";

const NEW_ROW = "+ New row…";
const NOT_SET = "not set";
const ANY = "any";
const INERT_NOTE = "no consumer reads this trigger yet — the row is inert";

/** Mode edges offered for `mode:` triggers — seat modes only. */
const EDGE_MODES = ["recon", "plan", "auto", "hack"] as const;
const MODE_EDGES: readonly string[] = EDGE_MODES.flatMap((from) =>
	EDGE_MODES.filter((to) => to !== from).map((to) => `${from}->${to}`),
);

/** Preset depth constraints (seat is depth 0). */
const DEPTH_PRESETS = ["=0", ">=1", ">=2", "<=1", "<=2"] as const;

// ─── Effective table ─────────────────────────────────────────────────────────

export interface EffectivePolicyRow {
	readonly row: PolicyRow;
	readonly source: "default" | "user";
	/** True when a shipped default exists for this trigger. */
	readonly hasDefault: boolean;
}

export interface SettingsPolicyTable {
	readonly rows: readonly EffectivePolicyRow[];
	/** The validated user rows as authored (write-back base). */
	readonly userRows: readonly PolicyRow[];
	/** Fail-visible problems from invalid user rows (defaults stand). */
	readonly errors: readonly string[];
}

/**
 * Mirror of the modes runtime's readPolicyTable merge (user rows win by
 * trigger), reading `modes.policies` from the layered extension config —
 * settings owns that reader, so no modes import is needed and both sides
 * merge against the same DEFAULT_POLICY_ROWS from contracts.
 */
export function readSettingsPolicyTable(cwd: string): SettingsPolicyTable {
	const { merged } = readLayeredExtensionConfig(cwd);
	const raw = (merged.modes as Record<string, unknown> | undefined)?.policies;
	const { rows: userRows, errors } = validatePolicyRows(raw);
	const userByTrigger = new Map(userRows.map((row) => [row.on, row]));
	const defaultTriggers = new Set(DEFAULT_POLICY_ROWS.map((row) => row.on));
	const rows: EffectivePolicyRow[] = [
		...DEFAULT_POLICY_ROWS.map((row) => {
			const user = userByTrigger.get(row.on);
			return user
				? { row: user, source: "user" as const, hasDefault: true }
				: { row, source: "default" as const, hasDefault: true };
		}),
		...userRows
			.filter((row) => !defaultTriggers.has(row.on))
			.map((row) => ({
				row,
				source: "user" as const,
				hasDefault: false,
			})),
	];
	return { rows, userRows, errors };
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/**
 * Upsert one user row (replacing any user row with the same trigger) into
 * modes.policies, global scope. Returns validation problems; nothing is
 * written unless the row passes validatePolicyRow.
 */
export function upsertUserPolicyRow(
	ctx: ExtensionContext,
	row: PolicyRow,
): string[] {
	const problems = validatePolicyRow(row);
	if (problems.length > 0) return problems;
	const { userRows } = readSettingsPolicyTable(ctx.cwd);
	const next = [...userRows.filter((r) => r.on !== row.on), row];
	writeUserPolicyRows(ctx, next);
	return [];
}

/** Remove the user row for a trigger — the shipped default (if any) stands. */
export function deleteUserPolicyRow(ctx: ExtensionContext, on: string): void {
	const { userRows } = readSettingsPolicyTable(ctx.cwd);
	writeUserPolicyRows(
		ctx,
		userRows.filter((row) => row.on !== on),
	);
}

function writeUserPolicyRows(
	ctx: ExtensionContext,
	rows: readonly PolicyRow[],
): void {
	updateSettingsFile("global", ctx.cwd, undefined, (raw) => {
		if (!isPlainObject(raw.extensionConfig)) {
			if (rows.length === 0) return;
			raw.extensionConfig = {};
		}
		const extensionConfig = raw.extensionConfig as Record<string, unknown>;
		if (!isPlainObject(extensionConfig.modes)) {
			if (rows.length === 0) return;
			extensionConfig.modes = {};
		}
		const modes = extensionConfig.modes as Record<string, unknown>;
		if (rows.length === 0) {
			delete modes.policies;
			if (Object.keys(modes).length === 0) delete extensionConfig.modes;
			if (Object.keys(extensionConfig).length === 0) delete raw.extensionConfig;
			return;
		}
		modes.policies = rows.map((row) => ({
			on: row.on,
			...(row.scope ? { scope: { ...row.scope } } : {}),
			run: { ...row.run },
		}));
	});
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function scopeSummary(scope: PolicyScope | undefined): string | undefined {
	if (!scope) return undefined;
	const parts = [
		scope.depth ? `depth ${scope.depth}` : undefined,
		scope.agent ? `agent ${scope.agent}` : undefined,
	].filter(Boolean);
	return parts.length ? `scope ${parts.join(" ")}` : undefined;
}

function rowLabel(effective: EffectivePolicyRow): string {
	const { row, source } = effective;
	const run = row.run;
	const detail = [
		`models ${run.models}`,
		run.agent ? `agent ${run.agent}` : undefined,
		run.persona ? `persona ${run.persona}` : undefined,
		run.contract ? `contract ${run.contract}` : undefined,
		scopeSummary(row.scope),
		run.enabled === false ? "disabled" : undefined,
	]
		.filter(Boolean)
		.join(" · ");
	const inert = CONSUMED_POLICY_TRIGGERS.has(row.on) ? "" : ` · ${INERT_NOTE}`;
	return `${row.on} — ${detail} (${source})${inert}`;
}

// ─── Pages ───────────────────────────────────────────────────────────────────

export async function browsePolicyTable(
	ctx: ExtensionContext,
	ui: Dialogs,
	registry: DomainRegistryInput = {},
): Promise<void> {
	while (true) {
		const table = readSettingsPolicyTable(ctx.cwd);
		if (table.errors.length > 0) {
			ctx.ui.notify(
				["Invalid user policy rows (the shipped defaults stand):"]
					.concat(table.errors.map((error) => `- ${error}`))
					.join("\n"),
				"warning",
			);
		}
		const picked = await ui.select(
			"Policies — one table: boundary reviews, duties, tool gating",
			[...table.rows.map(rowLabel), NEW_ROW],
		);
		if (!picked) return;
		if (picked === NEW_ROW) {
			const on = await createPolicyRow(ctx, ui, table);
			if (on) await editPolicyRow(ctx, ui, registry, on);
			continue;
		}
		const target = table.rows.find((entry) =>
			picked.startsWith(`${entry.row.on} `),
		);
		if (target) await editPolicyRow(ctx, ui, registry, target.row.on);
	}
}

/** Trigger picker: closed vocabulary in two steps. Returns the new `on`. */
async function createPolicyRow(
	ctx: ExtensionContext,
	ui: Dialogs,
	table: SettingsPolicyTable,
): Promise<string | undefined> {
	const kind = await ui.select("New row — trigger kind", [
		"mode:<edge> — a boundary review on a mode transition",
		"duty:<name> — a harness duty",
		"tool:<name> — tool gating on the supervisor bus",
	]);
	if (!kind) return undefined;
	let on: string | undefined;
	if (kind.startsWith("mode:")) {
		const edge = await ui.select("Which mode edge?", [...MODE_EDGES]);
		if (!edge) return undefined;
		on = `mode:${edge}`;
	} else if (kind.startsWith("duty:")) {
		const duty = await ui.select("Which duty?", [...POLICY_DUTIES]);
		if (!duty) return undefined;
		on = `duty:${duty}`;
	} else {
		const tool = await ui.select("Which tool?", [...POLICY_TOOL_TRIGGERS]);
		if (!tool) return undefined;
		on = `tool:${tool}`;
	}
	if (table.rows.some((entry) => entry.row.on === on)) {
		ctx.ui.notify(`A row for ${on} already exists — edit it instead.`, "info");
		return on;
	}
	const tier = await ui.select(
		`${on} → models (a tier is required on every row)`,
		[...TIER_IDS],
	);
	if (!tier) return undefined;
	if (!CONSUMED_POLICY_TRIGGERS.has(on)) {
		ctx.ui.notify(`${on}: ${INERT_NOTE}`, "warning");
	}
	const problems = upsertUserPolicyRow(ctx, {
		on,
		run: { models: tier as PolicyRow["run"]["models"] },
	});
	if (problems.length > 0) {
		ctx.ui.notify(problems.map((p) => `- ${p}`).join("\n"), "warning");
		return undefined;
	}
	return on;
}

/** One row: every field editable within its closed vocabulary. */
async function editPolicyRow(
	ctx: ExtensionContext,
	ui: Dialogs,
	registry: DomainRegistryInput,
	on: string,
): Promise<void> {
	while (true) {
		const table = readSettingsPolicyTable(ctx.cwd);
		const effective = table.rows.find((entry) => entry.row.on === on);
		if (!effective) return;
		const { row, source, hasDefault } = effective;
		const run = row.run;
		const inert = CONSUMED_POLICY_TRIGGERS.has(on) ? "" : ` — ${INERT_NOTE}`;
		const extras: string[] = [];
		if (run.strategy !== undefined)
			extras.push(`Strategy: ${run.strategy} — change…`);
		if (run.warm !== undefined) extras.push(`Warm: ${run.warm} — change…`);
		if (run.stale !== undefined) extras.push(`Stale: ${run.stale} — change…`);
		const picked = await ui.select(`Policy ${on} (${source})${inert}`, [
			`Models (tier): ${run.models} — change…`,
			`Agent: ${run.agent ?? NOT_SET} — change…`,
			`Persona: ${run.persona ?? NOT_SET} — change…`,
			`Contract: ${run.contract ?? NOT_SET} — change…`,
			`Enabled: ${run.enabled === false ? "off" : "on"} — toggle`,
			`Scope depth: ${row.scope?.depth ?? ANY} — change…`,
			`Scope agent: ${row.scope?.agent ?? ANY} — change…`,
			...extras,
			...(source === "user"
				? [
						`${DELETE_MARK} user row${hasDefault ? " — restore the shipped default" : ""}…`,
					]
				: []),
		]);
		if (!picked) return;
		if (picked.startsWith(DELETE_MARK)) {
			deleteUserPolicyRow(ctx, on);
			if (!hasDefault) return; // the row is gone entirely
			continue;
		}
		const write = (nextRun: PolicyRun, nextScope?: PolicyScope | undefined) => {
			const scope = nextScope ?? row.scope;
			const cleanScope =
				scope && (scope.depth !== undefined || scope.agent !== undefined)
					? scope
					: undefined;
			const problems = upsertUserPolicyRow(ctx, {
				on,
				...(cleanScope ? { scope: cleanScope } : {}),
				run: nextRun,
			});
			if (problems.length > 0)
				ctx.ui.notify(problems.map((p) => `- ${p}`).join("\n"), "warning");
		};
		const setRun = (patch: Record<string, string | boolean | undefined>) => {
			const next: Record<string, unknown> = { ...run };
			for (const [key, value] of Object.entries(patch)) {
				if (value === undefined) delete next[key];
				else next[key] = value;
			}
			write(next as unknown as PolicyRun);
		};
		if (picked.startsWith("Models")) {
			const tier = await ui.select(`${on} → models (tier)`, [...TIER_IDS]);
			if (tier) setRun({ models: tier });
		} else if (picked.startsWith("Agent:")) {
			const agent = await ui.select(`${on} → agent`, [
				NOT_SET,
				...NODE_AGENT_TYPES,
			]);
			if (!agent) continue;
			setRun({ agent: agent === NOT_SET ? undefined : agent });
		} else if (picked.startsWith("Persona:")) {
			const personas = registry.personas?.() ?? [];
			if (personas.length > 0) {
				const persona = await ui.select(`${on} → persona`, [
					NOT_SET,
					...personas.map((p) => p.name),
				]);
				if (!persona) continue;
				setRun({ persona: persona === NOT_SET ? undefined : persona });
			} else {
				if (!ui.input) continue;
				ctx.ui.notify(
					"The persona roster is unavailable on this surface — free text; an unknown persona fails at spawn time, visibly.",
					"warning",
				);
				const persona = (
					await ui.input(`${on} → persona (free text)`, run.persona ?? "")
				)?.trim();
				if (persona === undefined) continue;
				setRun({ persona: persona || undefined });
			}
		} else if (picked.startsWith("Contract:")) {
			const contract = await ui.select(`${on} → contract`, [
				NOT_SET,
				...CONTRACT_IDS,
			]);
			if (!contract) continue;
			setRun({ contract: contract === NOT_SET ? undefined : contract });
		} else if (picked.startsWith("Enabled")) {
			setRun({ enabled: run.enabled === false ? undefined : false });
		} else if (picked.startsWith("Scope depth")) {
			const depth = await ui.select(`${on} → scope depth (seat is 0)`, [
				`${ANY} — no depth constraint`,
				...DEPTH_PRESETS,
			]);
			if (!depth) continue;
			write(
				{ ...run },
				{
					...row.scope,
					depth: depth.startsWith(ANY) ? undefined : depth,
				},
			);
		} else if (picked.startsWith("Scope agent")) {
			const agent = await ui.select(`${on} → scope agent`, [
				`${ANY} — every agent type`,
				...NODE_AGENT_TYPES,
			]);
			if (!agent) continue;
			write(
				{ ...run },
				{
					...row.scope,
					agent: agent.startsWith(ANY) ? undefined : agent,
				},
			);
		} else if (picked.startsWith("Strategy:")) {
			if (!ui.input) continue;
			const strategy = (
				await ui.input(`${on} → strategy`, run.strategy ?? "")
			)?.trim();
			if (strategy === undefined) continue;
			setRun({ strategy: strategy || undefined });
		} else if (picked.startsWith("Warm:")) {
			if (!ui.input) continue;
			const warm = (await ui.input(`${on} → warm`, run.warm ?? ""))?.trim();
			if (warm === undefined) continue;
			setRun({ warm: warm || undefined });
		} else if (picked.startsWith("Stale:")) {
			if (!ui.input) continue;
			const stale = (await ui.input(`${on} → stale`, run.stale ?? ""))?.trim();
			if (stale === undefined) continue;
			setRun({ stale: stale || undefined });
		}
	}
}
