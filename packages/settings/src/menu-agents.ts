// The /maestro "Agent tiers" screen: per-agent-type tier allowlists (design
// §Agents). One screen lists worker/explorer/reviewer with their allowed
// tiers — DEFAULT_AGENT_TIERS until an override is authored — plus a catalog
// coverage column in plain words: an allowed tier that is empty in the
// active catalog, or has no available entry, means requests fall back to
// the seat (visibly, per the resolution rules), and the screen says so
// before anyone is surprised at spawn time.
//
// Overrides write models.agents.<type>.models through the same validated v2
// write path as catalogs/profiles (legacy root agents.<type>.models is
// migrated out of the way on write); removing the override restores the
// shipped default.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_AGENT_TIERS,
	SPAWNABLE_AGENT_TYPES,
	type SpawnableAgentType,
	TIER_IDS,
	type TierId,
	type V2ModelsConfig,
} from "@vegardx/pi-contracts";
import { activeV2Profile } from "@vegardx/pi-models";
import {
	availabilityWord,
	safeV2,
	tierFacts,
	writeV2Settings,
} from "./menu-catalogs.js";
import type { Dialogs } from "./menu-shared.js";
import { sessionModelId } from "./model.js";
import { multiSelect, supportsMultiSelect } from "./multi-select.js";
import { isPlainObject } from "./reader.js";

// ─── Write helpers ───────────────────────────────────────────────────────────

/** Set (null: remove) the allowlist override at models.agents.<type>.models,
 *  migrating any legacy root-level agents.<type>.models out of the way. */
function setAgentTiers(
	raw: Record<string, unknown>,
	agent: SpawnableAgentType,
	models: readonly string[] | null,
): void {
	// Legacy root spelling: drop this agent's models key, prune empty husks.
	if (isPlainObject(raw.agents)) {
		const legacy = raw.agents as Record<string, unknown>;
		if (isPlainObject(legacy[agent])) {
			delete (legacy[agent] as Record<string, unknown>).models;
			if (Object.keys(legacy[agent] as Record<string, unknown>).length === 0)
				delete legacy[agent];
		}
		if (Object.keys(legacy).length === 0) delete raw.agents;
	}
	if (!isPlainObject(raw.models)) {
		if (models === null) return;
		raw.models = {};
	}
	const modelsRoot = raw.models as Record<string, unknown>;
	if (models === null) {
		if (isPlainObject(modelsRoot.agents)) {
			const agents = modelsRoot.agents as Record<string, unknown>;
			delete agents[agent];
			if (Object.keys(agents).length === 0) delete modelsRoot.agents;
		}
		if (Object.keys(modelsRoot).length === 0) delete raw.models;
		return;
	}
	if (!isPlainObject(modelsRoot.agents)) modelsRoot.agents = {};
	(modelsRoot.agents as Record<string, unknown>)[agent] = {
		models: [...models],
	};
}

/** Whether an authored override exists for this agent type in either scope. */
function hasOverride(
	ctx: ExtensionContext,
	agent: SpawnableAgentType,
): boolean {
	const manager = SettingsManager.create(ctx.cwd);
	for (const raw of [
		manager.getGlobalSettings() as unknown,
		manager.getProjectSettings() as unknown,
	]) {
		if (!isPlainObject(raw)) continue;
		const roots = [
			raw.agents,
			isPlainObject(raw.models)
				? (raw.models as Record<string, unknown>).agents
				: undefined,
		];
		for (const root of roots) {
			if (!isPlainObject(root)) continue;
			const entry = root[agent];
			if (isPlainObject(entry) && entry.models !== undefined) return true;
		}
	}
	return false;
}

// ─── Coverage ────────────────────────────────────────────────────────────────

/**
 * Plain-word coverage notes for one agent's allowed tiers against the
 * ACTIVE catalog: empty tier, fully unavailable tier, partially
 * unavailable tier. Empty array = full coverage, nothing to say.
 */
async function coverageNotes(
	ctx: ExtensionContext,
	v2: V2ModelsConfig | undefined,
	allowed: readonly TierId[],
): Promise<string[]> {
	if (!v2) return [];
	const active = activeV2Profile(v2, sessionModelId(ctx));
	const catalog = active ? v2.catalogs[active.profile.catalog] : undefined;
	if (!catalog)
		return ["no active catalog — tier requests fall back to the seat"];
	const notes: string[] = [];
	for (const tier of allowed) {
		const entries = catalog[tier];
		if (entries.length === 0) {
			notes.push(`${tier} is empty — requests fall back to the seat`);
			continue;
		}
		const facts = await tierFacts(ctx, entries);
		const unavailable = facts.filter((fact) => !fact.available);
		if (unavailable.length === entries.length) {
			notes.push(
				`no ${tier} entry is available — requests fall back to the seat`,
			);
		} else if (unavailable.length > 0) {
			notes.push(
				`${tier} has ${unavailable.length} unavailable entr${unavailable.length === 1 ? "y" : "ies"} (${unavailable
					.map((fact) => `${fact.model}: ${availabilityWord(fact)}`)
					.join(", ")})`,
			);
		}
	}
	return notes;
}

// ─── Pages ───────────────────────────────────────────────────────────────────

/** One screen: worker/explorer/reviewer, allowed tiers, catalog coverage. */
export async function browseAgentTiers(
	ctx: ExtensionContext,
	ui: Dialogs,
): Promise<void> {
	while (true) {
		const v2 = safeV2(ctx);
		const rows: string[] = [];
		for (const agent of SPAWNABLE_AGENT_TYPES) {
			const allowed =
				v2?.agents[agent]?.models ?? DEFAULT_AGENT_TIERS[agent].models;
			const source = hasOverride(ctx, agent) ? "override" : "default";
			const notes = await coverageNotes(ctx, v2, allowed);
			rows.push(
				`${agent} — ${allowed.join(", ")} (${source})${
					notes.length ? ` · ${notes.join("; ")}` : ""
				}`,
			);
		}
		const picked = await ui.select(
			"Agent tiers — which tiers each agent type may draw from",
			rows,
		);
		if (!picked) return;
		const agent = SPAWNABLE_AGENT_TYPES.find((type) =>
			picked.startsWith(`${type} `),
		);
		if (agent) await editAgentTiers(ctx, ui, agent);
	}
}

async function editAgentTiers(
	ctx: ExtensionContext,
	ui: Dialogs,
	agent: SpawnableAgentType,
): Promise<void> {
	while (true) {
		const v2 = safeV2(ctx);
		const allowed =
			v2?.agents[agent]?.models ?? DEFAULT_AGENT_TIERS[agent].models;
		const override = hasOverride(ctx, agent);
		const defaults = DEFAULT_AGENT_TIERS[agent].models;
		const picked = await ui.select(
			`Agent ${agent} — allowed tiers: ${allowed.join(", ")} (${override ? "override" : "default"})`,
			[
				"Toggle tiers…",
				...(override
					? [`Reset to defaults (${defaults.join(", ")}) — remove the override`]
					: []),
			],
		);
		if (!picked) return;
		if (picked === "Toggle tiers…") {
			await toggleTiers(ctx, ui, agent, allowed);
		} else {
			writeV2Settings(ctx, (raw) => setAgentTiers(raw, agent, null));
		}
	}
}

/** Checkbox overlay when the surface has it; select-loop toggles otherwise.
 *  Either way the override lands as ONE validated write in tier order. */
async function toggleTiers(
	ctx: ExtensionContext,
	ui: Dialogs,
	agent: SpawnableAgentType,
	allowed: readonly TierId[],
): Promise<void> {
	if (supportsMultiSelect(ctx)) {
		const chosen = await multiSelect(
			ctx,
			`Agent ${agent} — allowed tiers`,
			TIER_IDS.map((tier) => ({
				id: tier,
				label: tier,
				checked: allowed.includes(tier),
			})),
		);
		if (chosen === undefined) return; // cancelled
		// An empty allowlist is invalid — the validator's message is shown
		// and nothing is written.
		writeV2Settings(ctx, (raw) => setAgentTiers(raw, agent, chosen));
		return;
	}
	while (true) {
		const v2 = safeV2(ctx);
		const current =
			v2?.agents[agent]?.models ?? DEFAULT_AGENT_TIERS[agent].models;
		const picked = await ui.select(
			`Agent ${agent} — pick to toggle, Esc when done`,
			TIER_IDS.map((tier) => `${current.includes(tier) ? "✓" : "✗"} ${tier}`),
		);
		if (!picked) return;
		const tier = picked.slice(2) as TierId;
		const next = current.includes(tier)
			? current.filter((item) => item !== tier)
			: TIER_IDS.filter((item) => item === tier || current.includes(item));
		writeV2Settings(ctx, (raw) => setAgentTiers(raw, agent, next));
	}
}
