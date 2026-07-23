// The whole /maestro configuration UI as a full-screen EDITOR-TAKEOVER
// (ctx.ui.custom, NON-overlay — see reference-ui-custom-overlay-focus and
// multi-select.ts). One focused component owns the entire flow: a stack of
// screens (Families → Family → Alias → Attachments; Rosters → tiers →
// resolve-preview; Bindings; Allowances; Region; Rules; Summary), navigated
// with ↑/↓/enter/esc and edited inline. Model-config edits go through the
// validated writeDomainValue path and rules through upsert/deleteUserPolicyRow,
// so the editor can never persist a shape the parser would reject; on a
// rejected write the error is surfaced and nothing changes.
//
// This is launched (from menu.ts) wherever ctx.ui.custom exists — i.e. the TUI.
// RPC/headless has no takeover: there menu.ts keeps a select-loop for rules and
// model config is authored via /maestro set.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import {
	CONSUMED_POLICY_TRIGGERS,
	CONTRACT_IDS,
	NODE_AGENT_TYPES,
	POLICY_DUTIES,
	POLICY_TOOL_TRIGGERS,
	type PolicyRow,
	type PolicyRun,
	type PolicyScope,
	SPAWNABLE_AGENT_TYPES,
	type SpawnableAgentType,
	TIER_IDS,
	type TierId,
	type V2ModelsConfig,
} from "@vegardx/pi-contracts";
import {
	activeRegion,
	activeV2Binding,
	isRegionOff,
	modelAllowedByRegion,
	parseAliasRef,
	parseModelSpec,
	parseV2Settings,
	REGION_OFF,
	readV2Config,
	regionNames,
} from "@vegardx/pi-models";
import { type DomainRegistryInput, writeDomainValue } from "./domain.js";
import {
	DEPTH_PRESETS,
	deleteUserPolicyRow,
	type EffectivePolicyRow,
	MODE_EDGES,
	POLICY_INERT_NOTE,
	readSettingsPolicyTable,
	rowLabel,
	upsertUserPolicyRow,
} from "./menu-policies.js";
import { modelsByProvider, THINKING_LEVELS } from "./menu-shared.js";
import { type KeyMatcher, supportsMultiSelect } from "./multi-select.js";
import { updateSettingsFile } from "./writer.js";

// ─── Palette ─────────────────────────────────────────────────────────────────

interface Palette {
	readonly accent: (s: string) => string;
	readonly muted: (s: string) => string;
	readonly bold: (s: string) => string;
	readonly warn: (s: string) => string;
}

const PLAIN: Palette = {
	accent: (s) => s,
	muted: (s) => s,
	bold: (s) => s,
	warn: (s) => s,
};

function paletteFromTheme(theme: unknown): Palette {
	const t = theme as {
		fg?: (color: string, text: string) => string;
		bold?: (text: string) => string;
	} | null;
	if (!t?.fg) return PLAIN;
	return {
		accent: (s) => t.fg?.("accent", s) ?? s,
		muted: (s) => t.fg?.("muted", s) ?? s,
		bold: (s) => t.bold?.(s) ?? s,
		warn: (s) => t.fg?.("warning", s) ?? s,
	};
}

// ─── Key handling ────────────────────────────────────────────────────────────

const ESC = String.fromCharCode(27);
const UP = new Set([`${ESC}[A`, `${ESC}OA`]);
const DOWN = new Set([`${ESC}[B`, `${ESC}OB`]);
const BACKSPACE = new Set([String.fromCharCode(127), String.fromCharCode(8)]);
const WINDOW = 14;

// ─── Screen contract ─────────────────────────────────────────────────────────

interface Screen {
	render(width: number, p: Palette): string[];
	handleInput(data: string): void;
}

interface Row {
	readonly label: string;
	readonly muted?: boolean;
	readonly enter?: () => void;
	/** Extra per-row keys (reorder, delete); return true when handled. */
	readonly key?: (data: string) => boolean;
}

// Mutable JSON shapes for whole-collection writes (the write helpers hand these
// plain clones to callbacks; names are object keys, never dotted key segments).
interface MutAlias {
	attach?: string[];
	effort?: string;
	efforts?: string[];
	notes?: string;
}
interface MutFamily {
	aliases: Record<string, MutAlias>;
}
interface MutBinding {
	roster?: string;
	targets?: string[];
}

/** A cursor-driven list screen: the common navigation for every menu page. */
abstract class ListScreen implements Screen {
	protected cursor = 0;
	constructor(protected readonly app: MaestroApp) {}

	abstract title(): string;
	abstract rows(): Row[];
	hint(): string {
		return "↑↓ move · enter select · esc back";
	}

	render(width: number, p: Palette): string[] {
		const rows = this.rows();
		if (rows.length > 0) this.cursor = clamp(this.cursor, 0, rows.length - 1);
		const lines: string[] = [p.bold(this.title()), p.muted(this.hint()), ""];
		const start = Math.max(
			0,
			Math.min(this.cursor - Math.floor(WINDOW / 2), rows.length - WINDOW),
		);
		const end = Math.min(rows.length, Math.max(start + WINDOW, WINDOW));
		if (start > 0) lines.push(p.muted(`  ↑ ${start} more`));
		for (let i = start; i < end && i < rows.length; i++) {
			const row = rows[i];
			const text = `${i === this.cursor ? "▸" : " "} ${row.label}`;
			lines.push(
				i === this.cursor ? p.bold(text) : row.muted ? p.muted(text) : text,
			);
		}
		if (end < rows.length) lines.push(p.muted(`  ↓ ${rows.length - end} more`));
		return lines.map((line) => line.slice(0, Math.max(1, width)));
	}

	handleInput(data: string): void {
		const rows = this.rows();
		if (data === ESC || this.app.is(data, "tui.select.cancel")) {
			this.app.pop();
			return;
		}
		if (data === "k" || UP.has(data) || this.app.is(data, "tui.select.up")) {
			this.cursor = Math.max(0, this.cursor - 1);
			return;
		}
		if (
			data === "j" ||
			DOWN.has(data) ||
			this.app.is(data, "tui.select.down")
		) {
			this.cursor = Math.min(rows.length - 1, this.cursor + 1);
			return;
		}
		const row = rows[this.cursor];
		if (
			(data === "\r" ||
				data === "\n" ||
				this.app.is(data, "tui.select.confirm")) &&
			row?.enter
		) {
			row.enter();
			return;
		}
		row?.key?.(data);
	}
}

function clamp(value: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, value));
}

function plainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Get or create a nested object at `key` on `parent`. */
function ensureObject(
	parent: Record<string, unknown>,
	key: string,
): Record<string, unknown> {
	const current = parent[key];
	if (plainObject(current)) return current;
	const created: Record<string, unknown> = {};
	parent[key] = created;
	return created;
}

/** Rename a key while preserving insertion order (families ARE ranked by it). */
function renameKeyInPlace(
	obj: Record<string, unknown>,
	from: string,
	to: string,
): void {
	const rebuilt: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj))
		rebuilt[key === from ? to : key] = value;
	for (const key of Object.keys(obj)) delete obj[key];
	Object.assign(obj, rebuilt);
}

/** Rewrite every roster tier's "Family/Alias" refs through `mapRef`. */
function retargetRosterRefs(
	models: Record<string, unknown>,
	mapRef: (family: string, alias: string) => [string, string],
): void {
	const rosters = models.rosters;
	if (!plainObject(rosters)) return;
	for (const roster of Object.values(rosters)) {
		if (!plainObject(roster)) continue;
		for (const tier of Object.keys(roster)) {
			const refs = roster[tier];
			if (!Array.isArray(refs)) continue;
			roster[tier] = refs.map((ref) => {
				if (typeof ref !== "string") return ref;
				const slash = ref.indexOf("/");
				if (slash <= 0 || slash === ref.length - 1) return ref;
				const [family, alias] = mapRef(
					ref.slice(0, slash),
					ref.slice(slash + 1),
				);
				return `${family}/${alias}`;
			});
		}
	}
}

// ─── Inline text prompt ──────────────────────────────────────────────────────

class PromptScreen implements Screen {
	private value: string;
	constructor(
		private readonly app: MaestroApp,
		private readonly title: string,
		initial: string,
		private readonly onSubmit: (value: string) => void,
	) {
		this.value = initial;
	}

	render(width: number, p: Palette): string[] {
		return [
			p.bold(this.title),
			p.muted("type · enter confirm · esc cancel"),
			"",
			`  ${this.value}▏`,
		].map((line) => line.slice(0, Math.max(1, width)));
	}

	handleInput(data: string): void {
		if (data === ESC || this.app.is(data, "tui.select.cancel")) {
			this.app.pop();
			return;
		}
		if (
			data === "\r" ||
			data === "\n" ||
			this.app.is(data, "tui.select.confirm")
		) {
			const trimmed = this.value.trim();
			this.app.pop();
			if (trimmed) this.onSubmit(trimmed);
			return;
		}
		if (BACKSPACE.has(data)) {
			this.value = this.value.slice(0, -1);
			return;
		}
		// Only accept printable single characters (ignore control/escape seqs).
		if (data.length === 1 && data >= " ") this.value += data;
	}
}

// ─── Checklist ───────────────────────────────────────────────────────────────

interface CheckItem {
	readonly id: string;
	readonly label: string;
	checked: boolean;
}

class ChecklistScreen implements Screen {
	private cursor = 0;
	constructor(
		private readonly app: MaestroApp,
		private readonly title: string,
		private readonly items: CheckItem[],
		private readonly onApply: (ids: string[]) => void,
	) {}

	render(width: number, p: Palette): string[] {
		const lines: string[] = [
			p.bold(this.title),
			p.muted("space toggle · a all · n none · enter apply · esc cancel"),
			"",
		];
		const start = Math.max(
			0,
			Math.min(
				this.cursor - Math.floor(WINDOW / 2),
				this.items.length - WINDOW,
			),
		);
		const end = Math.min(this.items.length, Math.max(start + WINDOW, WINDOW));
		if (start > 0) lines.push(p.muted(`  ↑ ${start} more`));
		for (let i = start; i < end && i < this.items.length; i++) {
			const item = this.items[i];
			const text = `${i === this.cursor ? "▸" : " "} ${item.checked ? "[x]" : "[ ]"} ${item.label}`;
			lines.push(
				i === this.cursor ? p.bold(text) : item.checked ? p.accent(text) : text,
			);
		}
		if (end < this.items.length)
			lines.push(p.muted(`  ↓ ${this.items.length - end} more`));
		return lines.map((line) => line.slice(0, Math.max(1, width)));
	}

	handleInput(data: string): void {
		if (data === ESC || this.app.is(data, "tui.select.cancel")) {
			this.app.pop();
			return;
		}
		if (
			data === "\r" ||
			data === "\n" ||
			this.app.is(data, "tui.select.confirm")
		) {
			this.app.pop();
			this.onApply(
				this.items.filter((item) => item.checked).map((item) => item.id),
			);
			return;
		}
		if (data === "k" || UP.has(data) || this.app.is(data, "tui.select.up")) {
			this.cursor = Math.max(0, this.cursor - 1);
			return;
		}
		if (
			data === "j" ||
			DOWN.has(data) ||
			this.app.is(data, "tui.select.down")
		) {
			this.cursor = Math.min(this.items.length - 1, this.cursor + 1);
			return;
		}
		if (data === " ") {
			const item = this.items[this.cursor];
			if (item) item.checked = !item.checked;
			return;
		}
		if (data === "a") for (const item of this.items) item.checked = true;
		else if (data === "n") for (const item of this.items) item.checked = false;
	}
}

// ─── Model picker (provider → model) ─────────────────────────────────────────

class ProviderPickScreen extends ListScreen {
	constructor(
		app: MaestroApp,
		private readonly heading: string,
		private readonly onPick: (ref: string) => void,
		/** Returns a reason a ref can't be picked (e.g. already claimed), else undefined. */
		private readonly blocked?: (ref: string) => string | undefined,
	) {
		super(app);
	}
	title(): string {
		return `${this.heading} — provider`;
	}
	rows(): Row[] {
		return [...this.app.providers.entries()].map(([provider, ids]) => ({
			label: `${provider} — ${ids.length} model(s)`,
			enter: () =>
				this.app.push(
					new ModelPickScreen(
						this.app,
						provider,
						ids,
						this.onPick,
						this.blocked,
					),
				),
		}));
	}
}

class ModelPickScreen extends ListScreen {
	constructor(
		app: MaestroApp,
		private readonly provider: string,
		private readonly ids: string[],
		private readonly onPick: (ref: string) => void,
		private readonly blocked?: (ref: string) => string | undefined,
	) {
		super(app);
	}
	title(): string {
		return `${this.provider} — model`;
	}
	rows(): Row[] {
		return this.ids.map((id) => {
			const ref = `${this.provider}/${id}`;
			const claim = this.blocked?.(ref);
			const usable = this.app.usable(ref);
			return {
				label: claim
					? `${id} — already ${claim}`
					: `${id}${usable ? "" : " (unavailable)"}`,
				muted: Boolean(claim) || !usable,
				enter: claim
					? () =>
							this.app.notify(
								`${ref} is already ${claim} — a seat can only be in one binding.`,
								"warning",
							)
					: () => {
							// Pop provider + model screens, then hand the ref up.
							this.app.pop();
							this.app.pop();
							this.onPick(ref);
						},
			};
		});
	}
}

// ─── Home ────────────────────────────────────────────────────────────────────

class HomeScreen extends ListScreen {
	title(): string {
		const config = this.app.config;
		const active = activeV2Binding(config, this.app.seat);
		return `Maestro model configuration — binding: ${active?.id ?? "none (inherit the seat)"}`;
	}
	hint(): string {
		return "↑↓ move · enter open · esc exit";
	}
	rows(): Row[] {
		const c = this.app.config;
		return [
			{
				label: `Families (${Object.keys(c?.families ?? {}).length}) — models grouped by diversity axis`,
				enter: () => this.app.push(new FamiliesScreen(this.app)),
			},
			{
				label: `Rosters (${Object.keys(c?.rosters ?? {}).length}) — tiered alias line-ups`,
				enter: () => this.app.push(new RostersScreen(this.app)),
			},
			{
				label: `Bindings (${Object.keys(c?.bindings ?? {}).length}) — which seat activates which roster`,
				enter: () => this.app.push(new BindingsScreen(this.app)),
			},
			{
				label: "Allowances — which tiers each agent may draw from",
				enter: () => this.app.push(new AllowancesScreen(this.app)),
			},
			{
				label: `Region: ${activeRegion(c?.region)} — the active model allowlist`,
				enter: () => this.app.push(new RegionScreen(this.app)),
			},
			{
				label: `Rules (${readSettingsPolicyTable(this.app.cwd).rows.length}) — boundary reviews, duties, tool gating`,
				enter: () => this.app.push(new RulesScreen(this.app)),
			},
			{
				label: "Summary — the resolved configuration at a glance",
				enter: () => this.app.push(new SummaryScreen(this.app)),
			},
		];
	}
	handleInput(data: string): void {
		// Esc at the root exits the whole editor.
		if (data === ESC || this.app.is(data, "tui.select.cancel")) {
			this.app.exit();
			return;
		}
		super.handleInput(data);
	}
}

// ─── Families ────────────────────────────────────────────────────────────────

class FamiliesScreen extends ListScreen {
	title(): string {
		return "Families — order = diversity rank";
	}
	hint(): string {
		return "enter open · [ / ] reorder rank · N new · x delete · esc back";
	}
	rows(): Row[] {
		const families = Object.keys(this.app.config?.families ?? {});
		const rows: Row[] = families.map((name, index) => ({
			label: `${index + 1}. ${name} (${Object.keys(this.app.config?.families?.[name]?.aliases ?? {}).length} alias)`,
			enter: () => this.app.push(new FamilyScreen(this.app, name)),
			key: (data) => {
				if (data === "[") return this.move(index, -1);
				if (data === "]") return this.move(index, 1);
				if (data === "x") {
					this.app.writeFamilies((families) => {
						delete families[name];
					});
					return true;
				}
				return false;
			},
		}));
		rows.push({
			label: "+ New family…",
			enter: () => this.newFamily(),
		});
		return rows;
	}
	private move(index: number, delta: number): boolean {
		const order = Object.keys(this.app.config?.families ?? {});
		const next = index + delta;
		if (next < 0 || next >= order.length) return true;
		[order[index], order[next]] = [order[next], order[index]];
		// Insertion order IS the diversity rank — rebuild the map in the new order.
		if (
			this.app.writeFamilies((families) => {
				const rebuilt: Record<string, unknown> = {};
				for (const name of order)
					if (families[name] !== undefined) rebuilt[name] = families[name];
				for (const name of Object.keys(families)) delete families[name];
				Object.assign(families, rebuilt);
			})
		)
			this.cursor = clamp(next, 0, order.length);
		return true;
	}
	private newFamily(): void {
		this.app.push(
			new PromptScreen(this.app, "New family name (no /)", "", (family) => {
				if (family.includes("/")) {
					this.app.notify('Family names cannot contain "/".', "warning");
					return;
				}
				// A family needs at least one alias — create both in one step.
				this.app.push(
					new PromptScreen(this.app, `New alias in ${family}`, "", (alias) =>
						this.app.push(
							new ProviderPickScreen(
								this.app,
								`Attach a model to ${family}/${alias}`,
								(ref) =>
									this.app.writeFamilies((families) => {
										families[family] = {
											aliases: { [alias]: { attach: [ref] } },
										};
									}),
							),
						),
					),
				);
			}),
		);
	}
}

class FamilyScreen extends ListScreen {
	constructor(
		app: MaestroApp,
		private readonly family: string,
	) {
		super(app);
	}
	title(): string {
		return `Family ${this.family}`;
	}
	hint(): string {
		return "enter open · N new alias · x delete family · esc back";
	}
	rows(): Row[] {
		const aliases = Object.keys(
			this.app.config?.families?.[this.family]?.aliases ?? {},
		);
		const rows: Row[] = aliases.map((alias) => ({
			label: alias,
			enter: () => this.app.push(new AliasScreen(this.app, this.family, alias)),
		}));
		rows.push({
			label: "+ New alias…",
			enter: () => this.newAlias(),
		});
		rows.push({
			label: "✎ Rename this family",
			enter: () => this.startRename(),
		});
		rows.push({
			label: "✕ Delete this family",
			muted: true,
			enter: () =>
				this.app.writeFamilies((families) => {
					delete families[this.family];
				}),
		});
		return rows;
	}
	private startRename(): void {
		this.app.push(
			new PromptScreen(
				this.app,
				`Rename family ${this.family}`,
				this.family,
				(next) => {
					if (next === this.family) return;
					if (next.includes("/")) {
						this.app.notify('Family names cannot contain "/".', "warning");
						return;
					}
					if (this.app.renameFamily(this.family, next)) {
						this.app.pop(); // drop the stale FamilyScreen(old name)
						this.app.push(new FamilyScreen(this.app, next));
					}
				},
			),
		);
	}
	private newAlias(): void {
		this.app.push(
			new PromptScreen(this.app, `New alias in ${this.family}`, "", (alias) => {
				if (alias.includes("/")) {
					this.app.notify('Alias names cannot contain "/".', "warning");
					return;
				}
				this.app.push(
					new ProviderPickScreen(
						this.app,
						`Attach a model to ${this.family}/${alias}`,
						(ref) =>
							this.app.writeFamilies((families) => {
								const family = families[this.family] as MutFamily | undefined;
								if (family) family.aliases[alias] = { attach: [ref] };
							}),
					),
				);
			}),
		);
	}
}

class AliasScreen extends ListScreen {
	constructor(
		app: MaestroApp,
		private readonly family: string,
		private readonly alias: string,
	) {
		super(app);
	}
	private cfg() {
		return this.app.config?.families?.[this.family]?.aliases?.[this.alias];
	}
	/** Mutate this alias inside a whole-families write (name-safe for dots). */
	private mutate(apply: (alias: MutAlias) => void): void {
		this.app.writeFamilies((families) => {
			const alias = (families[this.family] as MutFamily | undefined)?.aliases?.[
				this.alias
			];
			if (alias) apply(alias);
		});
	}
	title(): string {
		return `Alias ${this.family}/${this.alias}`;
	}
	rows(): Row[] {
		const cfg = this.cfg();
		if (!cfg) return [{ label: "(alias removed)", muted: true }];
		return [
			{
				label: `Attachments (${cfg.attach.length}) — ${cfg.attach.join(", ") || "none"}`,
				enter: () =>
					this.app.push(
						new AttachmentsScreen(this.app, this.family, this.alias),
					),
			},
			{
				label: `Effort: ${cfg.effort ?? "auto"}`,
				enter: () => this.pickEffort(),
			},
			{
				label: `Notes: ${cfg.notes ?? "none"}`,
				enter: () =>
					this.app.push(
						new PromptScreen(
							this.app,
							"Notes (blank clears)",
							cfg.notes ?? "",
							(notes) =>
								this.mutate((alias) => {
									if (notes) alias.notes = notes;
									else delete alias.notes;
								}),
						),
					),
			},
			{ label: "✎ Rename this alias", enter: () => this.startRename() },
			{
				label: "✕ Delete this alias",
				muted: true,
				enter: () =>
					this.app.writeFamilies((families) => {
						const family = families[this.family] as MutFamily | undefined;
						if (!family) return;
						delete family.aliases[this.alias];
						// A family with no aliases is invalid — drop it too.
						if (Object.keys(family.aliases).length === 0)
							delete families[this.family];
					}),
			},
		];
	}
	private startRename(): void {
		this.app.push(
			new PromptScreen(
				this.app,
				`Rename alias ${this.alias}`,
				this.alias,
				(next) => {
					if (next === this.alias) return;
					if (next.includes("/")) {
						this.app.notify('Alias names cannot contain "/".', "warning");
						return;
					}
					if (this.app.renameAlias(this.family, this.alias, next)) {
						this.app.pop(); // drop the stale AliasScreen(old name)
						this.app.push(new AliasScreen(this.app, this.family, next));
					}
				},
			),
		);
	}
	private pickEffort(): void {
		const cfg = this.cfg();
		if (!cfg) return;
		this.app.push(
			new ListScreenChoice(
				this.app,
				"Effort",
				["auto", ...THINKING_LEVELS],
				(choice) =>
					this.mutate((alias) => {
						if (choice === "auto") delete alias.effort;
						else alias.effort = choice;
					}),
			),
		);
	}
}

class AttachmentsScreen extends ListScreen {
	constructor(
		app: MaestroApp,
		private readonly family: string,
		private readonly alias: string,
	) {
		super(app);
	}
	private attach(): string[] {
		return [
			...(this.app.config?.families?.[this.family]?.aliases?.[this.alias]
				?.attach ?? []),
		];
	}
	private write(next: string[]): void {
		if (next.length === 0) {
			this.app.notify(
				"An alias needs at least one attachment — delete the alias instead.",
				"warning",
			);
			return;
		}
		this.app.writeFamilies((families) => {
			const alias = (families[this.family] as MutFamily | undefined)?.aliases?.[
				this.alias
			];
			if (alias) alias.attach = next;
		});
	}
	title(): string {
		return `${this.family}/${this.alias} attachments — order = fallback`;
	}
	hint(): string {
		return "[ / ] reorder · x remove · N add · esc back";
	}
	rows(): Row[] {
		const attach = this.attach();
		const rows: Row[] = attach.map((ref, index) => {
			const usable = this.app.usable(ref);
			const provider = parseModelSpec(ref)?.provider ?? "?";
			return {
				label: `${index + 1}. ${ref}  [${provider}]${usable ? "" : " unavailable"}`,
				muted: !usable,
				key: (data) => {
					if (data === "[") return this.move(index, -1);
					if (data === "]") return this.move(index, 1);
					if (data === "x") {
						this.write(attach.filter((_, i) => i !== index));
						return true;
					}
					return false;
				},
			};
		});
		rows.push({
			label: "+ Add attachment…",
			enter: () =>
				this.app.push(
					new ProviderPickScreen(this.app, "Add attachment", (ref) => {
						if (this.attach().includes(ref)) {
							this.app.notify("Already attached.", "warning");
							return;
						}
						this.write([...this.attach(), ref]);
					}),
				),
		});
		return rows;
	}
	private move(index: number, delta: number): boolean {
		const attach = this.attach();
		const next = index + delta;
		if (next < 0 || next >= attach.length) return true;
		[attach[index], attach[next]] = [attach[next], attach[index]];
		this.write(attach);
		this.cursor = clamp(next, 0, attach.length);
		return true;
	}
}

/** A one-shot single-choice list (effort picker, roster/tier pick, etc.). */
class ListScreenChoice extends ListScreen {
	constructor(
		app: MaestroApp,
		private readonly heading: string,
		private readonly choices: readonly string[],
		private readonly onPick: (choice: string) => void,
	) {
		super(app);
	}
	title(): string {
		return this.heading;
	}
	rows(): Row[] {
		return this.choices.map((choice) => ({
			label: choice,
			enter: () => {
				this.app.pop();
				this.onPick(choice);
			},
		}));
	}
}

// ─── Rosters ─────────────────────────────────────────────────────────────────

class RostersScreen extends ListScreen {
	title(): string {
		return "Rosters";
	}
	hint(): string {
		return "enter open · N new · x delete · esc back";
	}
	rows(): Row[] {
		const rosters = Object.keys(this.app.config?.rosters ?? {});
		const rows: Row[] = rosters.map((name) => ({
			label: name,
			enter: () => this.app.push(new RosterScreen(this.app, name)),
			key: (data) => {
				if (data === "x") {
					this.app.writeRosters((rosters) => {
						delete rosters[name];
					});
					return true;
				}
				return false;
			},
		}));
		rows.push({ label: "+ New roster…", enter: () => this.newRoster() });
		return rows;
	}
	private newRoster(): void {
		const refs = this.app.allAliasRefs();
		if (refs.length === 0) {
			this.app.notify("Create a family and alias first.", "warning");
			return;
		}
		this.app.push(
			new PromptScreen(this.app, "New roster name", "", (name) => {
				// A roster cannot be all-empty; seed the standard tier with one ref.
				this.app.push(
					new ListScreenChoice(
						this.app,
						"Seed standard tier with",
						refs,
						(ref) =>
							this.app.writeRosters((rosters) => {
								rosters[name] = { standard: [ref] };
							}),
					),
				);
			}),
		);
	}
}

class RosterScreen extends ListScreen {
	constructor(
		app: MaestroApp,
		private readonly name: string,
	) {
		super(app);
	}
	title(): string {
		return `Roster ${this.name}`;
	}
	rows(): Row[] {
		const roster = this.app.config?.rosters?.[this.name];
		const rows: Row[] = TIER_IDS.map((tier) => ({
			label: `${tier} (${roster?.[tier]?.length ?? 0}) — ${(roster?.[tier] ?? []).join(", ") || "empty"}`,
			enter: () =>
				this.app.push(new RosterTierScreen(this.app, this.name, tier)),
		}));
		rows.push({
			label: "Resolve preview…",
			enter: () => this.app.push(new ResolvePreviewScreen(this.app, this.name)),
		});
		rows.push({
			label: "✕ Delete this roster",
			muted: true,
			enter: () =>
				this.app.writeRosters((rosters) => {
					delete rosters[this.name];
				}),
		});
		return rows;
	}
}

class RosterTierScreen extends ListScreen {
	constructor(
		app: MaestroApp,
		private readonly roster: string,
		private readonly tier: TierId,
	) {
		super(app);
	}
	private refs(): string[] {
		return [...(this.app.config?.rosters?.[this.roster]?.[this.tier] ?? [])];
	}
	private write(next: string[]): void {
		this.app.writeRosters((rosters) => {
			const roster = rosters[this.roster] as
				| Record<string, string[]>
				| undefined;
			if (roster) roster[this.tier] = next;
		});
	}
	title(): string {
		return `${this.roster} · ${this.tier} — order = preference`;
	}
	hint(): string {
		return "[ / ] reorder · x remove · N add · esc back";
	}
	rows(): Row[] {
		const refs = this.refs();
		const rows: Row[] = refs.map((ref, index) => ({
			label: `${index + 1}. ${ref}`,
			key: (data) => {
				if (data === "[") return this.move(index, -1);
				if (data === "]") return this.move(index, 1);
				if (data === "x") {
					this.write(refs.filter((_, i) => i !== index));
					return true;
				}
				return false;
			},
		}));
		rows.push({
			label: "+ Add alias…",
			enter: () => {
				const options = this.app
					.allAliasRefs()
					.filter((r) => !refs.includes(r));
				if (options.length === 0) {
					this.app.notify("No more aliases to add.", "warning");
					return;
				}
				this.app.push(
					new ListScreenChoice(this.app, "Add alias", options, (ref) =>
						this.write([...this.refs(), ref]),
					),
				);
			},
		});
		return rows;
	}
	private move(index: number, delta: number): boolean {
		const refs = this.refs();
		const next = index + delta;
		if (next < 0 || next >= refs.length) return true;
		[refs[index], refs[next]] = [refs[next], refs[index]];
		this.write(refs);
		this.cursor = clamp(next, 0, refs.length);
		return true;
	}
}

class ResolvePreviewScreen extends ListScreen {
	constructor(
		app: MaestroApp,
		private readonly roster: string,
	) {
		super(app);
	}
	title(): string {
		return `Resolve preview: ${this.roster} — seat ${this.app.seat ?? "none"}`;
	}
	hint(): string {
		return "esc back";
	}
	rows(): Row[] {
		const roster = this.app.config?.rosters?.[this.roster];
		const seatProvider = this.app.seat
			? parseModelSpec(this.app.seat)?.provider
			: undefined;
		const rows: Row[] = [];
		for (const tier of TIER_IDS) {
			rows.push({ label: `${tier}:`, muted: true });
			for (const ref of roster?.[tier] ?? []) {
				rows.push({ label: `    ${this.resolveLine(ref, seatProvider)}` });
			}
		}
		return rows;
	}
	private resolveLine(ref: string, seatProvider: string | undefined): string {
		const parsed = parseAliasRef(ref);
		const cfg = parsed
			? this.app.config?.families?.[parsed.family]?.aliases?.[parsed.alias]
			: undefined;
		if (!cfg) return `${ref} → unknown alias`;
		const available = cfg.attach.filter((spec) => this.app.usable(spec));
		const onGateway = available.find(
			(spec) => parseModelSpec(spec)?.provider === seatProvider,
		);
		if (onGateway) return `${ref} → ${onGateway} (own gateway)`;
		if (available[0]) return `${ref} → ${available[0]} (fallback)`;
		return `${ref} → seat floor (all attachments unavailable)`;
	}
}

// ─── Bindings ────────────────────────────────────────────────────────────────

class BindingsScreen extends ListScreen {
	title(): string {
		return "Bindings — seat model → roster";
	}
	hint(): string {
		return "enter open · N new · x delete · esc back";
	}
	rows(): Row[] {
		const bindings = this.app.config?.bindings ?? {};
		const rows: Row[] = Object.entries(bindings).map(([name, binding]) => ({
			label: `${name} → ${binding.roster}${binding.targets?.length ? ` (${binding.targets.length} target)` : " (default)"}`,
			enter: () => this.app.push(new BindingScreen(this.app, name)),
			key: (data) => {
				if (data === "x") {
					this.app.writeBindings((bindings) => {
						delete bindings[name];
					});
					return true;
				}
				return false;
			},
		}));
		rows.push({ label: "+ New binding…", enter: () => this.newBinding() });
		return rows;
	}
	private newBinding(): void {
		const rosters = Object.keys(this.app.config?.rosters ?? {});
		if (rosters.length === 0) {
			this.app.notify("Create a roster first.", "warning");
			return;
		}
		this.app.push(
			new PromptScreen(this.app, "New binding name", "", (name) => {
				this.app.push(
					new ListScreenChoice(
						this.app,
						"Roster for this binding",
						rosters,
						(roster) =>
							this.app.writeBindings((bindings) => {
								bindings[name] = { roster };
							}),
					),
				);
			}),
		);
	}
}

class BindingScreen extends ListScreen {
	constructor(
		app: MaestroApp,
		private readonly name: string,
	) {
		super(app);
	}
	private binding() {
		return this.app.config?.bindings?.[this.name];
	}
	title(): string {
		return `Binding ${this.name}`;
	}
	rows(): Row[] {
		const binding = this.binding();
		if (!binding) return [{ label: "(binding removed)", muted: true }];
		const targets = binding.targets ?? [];
		return [
			{
				label: `Roster: ${binding.roster}`,
				enter: () => {
					const rosters = Object.keys(this.app.config?.rosters ?? {});
					this.app.push(
						new ListScreenChoice(this.app, "Roster", rosters, (roster) =>
							this.app.writeBindings((bindings) => {
								const existing = bindings[this.name] as MutBinding | undefined;
								if (existing) existing.roster = roster;
							}),
						),
					);
				},
			},
			{
				label: `Targets (${targets.length}) — ${targets.join(", ") || "none = default binding"}`,
				enter: () =>
					this.app.push(new BindingTargetsScreen(this.app, this.name)),
			},
			{
				label: "✕ Delete this binding",
				muted: true,
				enter: () =>
					this.app.writeBindings((bindings) => {
						delete bindings[this.name];
					}),
			},
		];
	}
}

class BindingTargetsScreen extends ListScreen {
	constructor(
		app: MaestroApp,
		private readonly name: string,
	) {
		super(app);
	}
	private targets(): string[] {
		return [...(this.app.config?.bindings?.[this.name]?.targets ?? [])];
	}
	private write(next: string[]): void {
		this.app.writeBindings((bindings) => {
			const binding = bindings[this.name] as MutBinding | undefined;
			if (!binding) return;
			if (next.length) binding.targets = next;
			else delete binding.targets;
		});
	}
	/** A seat can only be in ONE binding — say which one already claims a ref. */
	private claimedElsewhere(ref: string): string | undefined {
		for (const [name, binding] of Object.entries(
			this.app.config?.bindings ?? {},
		)) {
			if (name === this.name) continue;
			if (binding.targets?.includes(ref)) return `bound to "${name}"`;
		}
		return undefined;
	}
	title(): string {
		return `${this.name} targets — seat models that activate this binding`;
	}
	hint(): string {
		return "x remove · N add · esc back";
	}
	rows(): Row[] {
		const targets = this.targets();
		const rows: Row[] = targets.map((ref, index) => ({
			label: ref,
			key: (data) => {
				if (data === "x") {
					this.write(targets.filter((_, i) => i !== index));
					return true;
				}
				return false;
			},
		}));
		rows.push({
			label: "+ Add target…",
			enter: () =>
				this.app.push(
					new ProviderPickScreen(
						this.app,
						"Add seat target",
						(ref) => {
							if (this.targets().includes(ref)) return;
							this.write([...this.targets(), ref]);
						},
						(ref) => this.claimedElsewhere(ref),
					),
				),
		});
		return rows;
	}
}

// ─── Allowances ──────────────────────────────────────────────────────────────

class AllowancesScreen extends ListScreen {
	title(): string {
		return "Allowances — tiers each agent may draw from";
	}
	rows(): Row[] {
		return SPAWNABLE_AGENT_TYPES.map((agent) => {
			const tiers = this.app.config?.allowances?.[agent]?.tiers ?? [];
			return {
				label: `${agent}: ${tiers.join(", ") || "none"}`,
				enter: () => this.editAgent(agent),
			};
		});
	}
	private editAgent(agent: SpawnableAgentType): void {
		const current = new Set(this.app.config?.allowances?.[agent]?.tiers ?? []);
		this.app.push(
			new ChecklistScreen(
				this.app,
				`${agent} — allowed tiers`,
				TIER_IDS.map((tier) => ({
					id: tier,
					label: tier,
					checked: current.has(tier),
				})),
				(ids) => {
					if (ids.length === 0) {
						this.app.notify(
							"An allowance needs at least one tier (empty = inherit the seat is the default when unset).",
							"warning",
						);
						return;
					}
					this.app.write(`models.allowances.${agent}`, {
						tiers: TIER_IDS.filter((tier) => ids.includes(tier)),
					});
				},
			),
		);
	}
}

// ─── Region ──────────────────────────────────────────────────────────────────

class RegionScreen extends ListScreen {
	title(): string {
		return `Region — active: ${activeRegion(this.app.config?.region)}`;
	}
	hint(): string {
		return "enter open · A set active · N new list · x delete · esc back";
	}
	rows(): Row[] {
		const region = this.app.config?.region;
		const lists = Object.keys(region?.lists ?? {});
		const rows: Row[] = [
			{
				label: `Active: ${activeRegion(region)} — change…`,
				enter: () => this.setActive(),
			},
		];
		for (const name of lists) {
			rows.push({
				label: `${name} — ${region?.lists?.[name]?.length ?? 0} model(s)`,
				enter: () => this.app.push(new RegionListScreen(this.app, name)),
				key: (data) => {
					if (data === "x") {
						this.deleteList(name);
						return true;
					}
					return false;
				},
			});
		}
		rows.push({ label: "+ New list…", enter: () => this.newList() });
		return rows;
	}
	private setActive(): void {
		const names = regionNames(this.app.config?.region);
		this.app.push(
			new ListScreenChoice(this.app, "Set active region", names, (name) =>
				this.app.write(
					"models.region.active",
					isRegionOff(name) ? REGION_OFF : name,
				),
			),
		);
	}
	private deleteList(name: string): void {
		const wasActive = activeRegion(this.app.config?.region) === name;
		this.app.writeRegion((region) => {
			delete region.lists[name];
			if (wasActive) delete region.active;
		});
	}
	private newList(): void {
		this.app.push(
			new PromptScreen(this.app, "New region list name", "", (name) => {
				if (isRegionOff(name)) {
					this.app.notify('"off"/"none" are reserved.', "warning");
					return;
				}
				this.app.push(new RegionListScreen(this.app, name));
			}),
		);
	}
}

class RegionListScreen extends ListScreen {
	constructor(
		app: MaestroApp,
		private readonly name: string,
	) {
		super(app);
	}
	title(): string {
		return `Region list ${this.name}`;
	}
	hint(): string {
		return "enter edit provider · esc back";
	}
	rows(): Row[] {
		const members = new Set(this.app.config?.region?.lists?.[this.name] ?? []);
		return [...this.app.providers.entries()].map(([provider, ids]) => {
			const inList = ids.filter((id) =>
				members.has(`${provider}/${id}`),
			).length;
			return {
				label: `${provider} — ${inList} of ${ids.length}`,
				enter: () => this.editProvider(provider, ids),
			};
		});
	}
	private editProvider(provider: string, ids: string[]): void {
		const members = new Set(this.app.config?.region?.lists?.[this.name] ?? []);
		this.app.push(
			new ChecklistScreen(
				this.app,
				`${this.name} · ${provider}`,
				ids.map((id) => ({
					id: `${provider}/${id}`,
					label: id,
					checked: members.has(`${provider}/${id}`),
				})),
				(chosen) => {
					const next = new Set(
						[...members].filter((ref) => !ref.startsWith(`${provider}/`)),
					);
					for (const ref of chosen) next.add(ref);
					if (next.size === 0) {
						this.app.notify(
							"A region list cannot be empty — delete the list instead.",
							"warning",
						);
						return;
					}
					this.app.writeRegion((region) => {
						region.lists[this.name] = [...next].sort();
					});
				},
			),
		);
	}
}

// ─── Rules (the policy table) ────────────────────────────────────────────────

class RulesScreen extends ListScreen {
	title(): string {
		return "Rules — one table: boundary reviews, duties, tool gating";
	}
	hint(): string {
		return "enter edit · N new · esc back";
	}
	rows(): Row[] {
		const table = readSettingsPolicyTable(this.app.cwd);
		const rows: Row[] = table.rows.map((effective) => ({
			label: rowLabel(effective),
			enter: () => this.app.push(new RuleScreen(this.app, effective.row.on)),
		}));
		rows.push({ label: "+ New rule…", enter: () => this.newRule() });
		return rows;
	}
	private newRule(): void {
		const pickTier = (on: string) => {
			if (
				readSettingsPolicyTable(this.app.cwd).rows.some((e) => e.row.on === on)
			) {
				this.app.notify(`A rule for ${on} already exists — edit it.`, "info");
				return;
			}
			this.app.push(
				new ListScreenChoice(
					this.app,
					`${on} → tier`,
					[...TIER_IDS],
					(tier) => {
						if (!CONSUMED_POLICY_TRIGGERS.has(on))
							this.app.notify(`${on}: ${POLICY_INERT_NOTE}`, "warning");
						this.app.writePolicy({ on, run: { models: tier as TierId } });
					},
				),
			);
		};
		this.app.push(
			new ListScreenChoice(
				this.app,
				"New rule — trigger kind",
				["mode:<edge>", "duty:<name>", "tool:<name>"],
				(kind) => {
					if (kind.startsWith("mode:"))
						this.app.push(
							new ListScreenChoice(
								this.app,
								"Which mode edge?",
								[...MODE_EDGES],
								(edge) => pickTier(`mode:${edge}`),
							),
						);
					else if (kind.startsWith("duty:"))
						this.app.push(
							new ListScreenChoice(
								this.app,
								"Which duty?",
								[...POLICY_DUTIES],
								(duty) => pickTier(`duty:${duty}`),
							),
						);
					else
						this.app.push(
							new ListScreenChoice(
								this.app,
								"Which tool?",
								[...POLICY_TOOL_TRIGGERS],
								(tool) => pickTier(`tool:${tool}`),
							),
						);
				},
			),
		);
	}
}

class RuleScreen extends ListScreen {
	constructor(
		app: MaestroApp,
		private readonly on: string,
	) {
		super(app);
	}
	private effective(): EffectivePolicyRow | undefined {
		return readSettingsPolicyTable(this.app.cwd).rows.find(
			(entry) => entry.row.on === this.on,
		);
	}
	title(): string {
		return `Rule ${this.on}`;
	}
	rows(): Row[] {
		const eff = this.effective();
		if (!eff) return [{ label: "(rule removed)", muted: true }];
		const { row, source, hasDefault } = eff;
		const run = row.run;
		const rows: Row[] = [
			{
				label: `Models (tier): ${run.models}`,
				enter: () =>
					this.pick("tier", [...TIER_IDS], (v) => this.setRun({ models: v })),
			},
			{
				label: `Agent: ${run.agent ?? "not set"}`,
				enter: () =>
					this.pick("agent", ["not set", ...NODE_AGENT_TYPES], (v) =>
						this.setRun({ agent: v === "not set" ? undefined : v }),
					),
			},
			{
				label: `Persona: ${run.persona ?? "not set"}`,
				enter: () => this.pickPersona(run.persona),
			},
			{
				label: `Contract: ${run.contract ?? "not set"}`,
				enter: () =>
					this.pick("contract", ["not set", ...CONTRACT_IDS], (v) =>
						this.setRun({ contract: v === "not set" ? undefined : v }),
					),
			},
			{
				label: `Enabled: ${run.enabled === false ? "off" : "on"}`,
				enter: () =>
					this.setRun({ enabled: run.enabled === false ? undefined : false }),
			},
			{
				label: `Scope depth: ${row.scope?.depth ?? "any"}`,
				enter: () =>
					this.pick("scope depth", ["any", ...DEPTH_PRESETS], (v) =>
						this.setScope({ depth: v === "any" ? undefined : v }),
					),
			},
			{
				label: `Scope agent: ${row.scope?.agent ?? "any"}`,
				enter: () =>
					this.pick("scope agent", ["any", ...NODE_AGENT_TYPES], (v) =>
						this.setScope({ agent: v === "any" ? undefined : v }),
					),
			},
		];
		if (source === "user")
			rows.push({
				label: `✕ Delete user rule${hasDefault ? " — restore shipped default" : ""}`,
				muted: true,
				enter: () => this.app.deletePolicy(this.on),
			});
		return rows;
	}
	private pick(
		what: string,
		choices: string[],
		onPick: (value: string) => void,
	): void {
		this.app.push(
			new ListScreenChoice(this.app, `${this.on} → ${what}`, choices, onPick),
		);
	}
	private pickPersona(current?: string): void {
		const personas = this.app.registry.personas?.() ?? [];
		if (personas.length > 0)
			this.pick("persona", ["not set", ...personas.map((p) => p.name)], (v) =>
				this.setRun({ persona: v === "not set" ? undefined : v }),
			);
		else
			this.app.push(
				new PromptScreen(
					this.app,
					`${this.on} → persona (free text)`,
					current ?? "",
					(v) => this.setRun({ persona: v || undefined }),
				),
			);
	}
	private setRun(patch: Record<string, string | boolean | undefined>): void {
		const eff = this.effective();
		if (!eff) return;
		const next: Record<string, unknown> = { ...eff.row.run };
		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined) delete next[key];
			else next[key] = value;
		}
		this.app.writePolicy({
			on: this.on,
			...(eff.row.scope ? { scope: eff.row.scope } : {}),
			run: next as unknown as PolicyRun,
		});
	}
	private setScope(patch: { depth?: string; agent?: string }): void {
		const eff = this.effective();
		if (!eff) return;
		const merged = { ...eff.row.scope, ...patch };
		const clean: { depth?: string; agent?: string } = {};
		if (merged.depth !== undefined) clean.depth = merged.depth;
		if (merged.agent !== undefined) clean.agent = merged.agent;
		const hasScope = clean.depth !== undefined || clean.agent !== undefined;
		this.app.writePolicy({
			on: this.on,
			...(hasScope ? { scope: clean as PolicyScope } : {}),
			run: eff.row.run,
		});
	}
}

// ─── Summary ─────────────────────────────────────────────────────────────────

class SummaryScreen implements Screen {
	constructor(private readonly app: MaestroApp) {}
	render(width: number, p: Palette): string[] {
		const c = this.app.config;
		const active = activeV2Binding(c, this.app.seat);
		const table = readSettingsPolicyTable(this.app.cwd);
		return [
			p.bold("Summary"),
			p.muted("esc back"),
			"",
			`Seat: ${this.app.seat ?? "none"}`,
			`Active binding: ${active?.id ?? "none (everything inherits the seat)"}`,
			`Families: ${Object.keys(c?.families ?? {}).length} · rosters: ${Object.keys(c?.rosters ?? {}).length} · bindings: ${Object.keys(c?.bindings ?? {}).length}`,
			`Region: ${activeRegion(c?.region)}`,
			`Rules: ${table.rows.length}`,
		].map((line) => line.slice(0, Math.max(1, width)));
	}
	handleInput(data: string): void {
		if (data === ESC || this.app.is(data, "tui.select.cancel")) this.app.pop();
	}
}

// ─── The component ───────────────────────────────────────────────────────────

class MaestroApp implements Component, Focusable {
	focused = false;
	private readonly stack: Screen[] = [];
	config: V2ModelsConfig | undefined;

	constructor(
		private readonly ctx: ExtensionContext,
		readonly providers: Map<string, string[]>,
		/** Refs whose provider is authenticated (region applied live in preview). */
		private readonly authed: Set<string>,
		readonly seat: string | undefined,
		readonly registry: DomainRegistryInput,
		private readonly palette: Palette,
		private readonly keys: KeyMatcher | undefined,
		private readonly done: () => void,
	) {
		this.reload();
		this.stack.push(new HomeScreen(this));
	}

	/** The repo root — policy reads/writes and config reads key off it. */
	get cwd(): string {
		return this.ctx.cwd;
	}

	is(data: string, action: string): boolean {
		return this.keys?.matches(data, action) ?? false;
	}

	/** Upsert a policy row (validated; problems surfaced, nothing written on error). */
	writePolicy(row: PolicyRow): void {
		const problems = upsertUserPolicyRow(this.ctx, row);
		if (problems.length)
			this.notify(
				problems.map((problem) => `- ${problem}`).join("\n"),
				"warning",
			);
	}

	/** Remove a user policy row — the shipped default (if any) stands. */
	deletePolicy(on: string): void {
		deleteUserPolicyRow(this.ctx, on);
	}

	/** Usable = provider authenticated AND allowed by the active region. */
	usable(ref: string): boolean {
		return (
			this.authed.has(ref) && modelAllowedByRegion(this.config?.region, ref)
		);
	}

	/** Every configured `"Family/Alias"` ref (roster/tier pickers draw from this). */
	allAliasRefs(): string[] {
		const refs: string[] = [];
		for (const [family, cfg] of Object.entries(this.config?.families ?? {}))
			for (const alias of Object.keys(cfg.aliases))
				refs.push(`${family}/${alias}`);
		return refs;
	}

	push(screen: Screen): void {
		this.stack.push(screen);
	}
	pop(): void {
		this.stack.pop();
		if (this.stack.length === 0) this.exit();
	}
	exit(): void {
		this.done();
	}

	notify(message: string, level: "info" | "warning" = "info"): void {
		this.ctx.ui.notify(message, level);
	}

	/** Validated write (global scope); reloads config; false + notify on error. */
	write(key: string, value: unknown): boolean {
		const errors = writeDomainValue(
			this.ctx,
			key,
			"global",
			value === null ? "null" : JSON.stringify(value),
		);
		if (errors.length) {
			this.notify(errors.map((error) => `- ${error}`).join("\n"), "warning");
			return false;
		}
		this.reload();
		return true;
	}

	// Whole-`models` writes: family/roster/binding/region-list NAMES can hold any
	// character (spaces, dots — e.g. "GPT 5.6 Sol"), so they must never be encoded
	// as dotted domain-key SEGMENTS (which split on "."). Instead the name lives
	// as an object key INSIDE the value. Mutating the WHOLE models block (not one
	// collection) also lets a single change span collections atomically — a rename
	// updates families AND the roster refs that point at the old name in one write,
	// so readV2Config never transiently sees a dangling ref. The candidate is
	// validated with parseV2Settings (the same check boot uses) before it lands.
	writeModels(apply: (models: Record<string, unknown>) => void): boolean {
		const manager = SettingsManager.create(this.ctx.cwd, undefined);
		const globalRaw = manager.getGlobalSettings() as Record<string, unknown>;
		const projectRaw = manager.getProjectSettings();
		const candidate = plainObject(globalRaw.models)
			? (JSON.parse(JSON.stringify(globalRaw.models)) as Record<
					string,
					unknown
				>)
			: {};
		try {
			apply(candidate);
			parseV2Settings({ ...globalRaw, models: candidate }, projectRaw);
		} catch (cause) {
			this.notify(
				`Cannot apply the change:\n${cause instanceof Error ? cause.message : String(cause)}`,
				"warning",
			);
			return false;
		}
		updateSettingsFile("global", this.ctx.cwd, undefined, (raw) => {
			const models = plainObject(raw.models) ? raw.models : {};
			apply(models);
			if (Object.keys(models).length === 0) delete raw.models;
			else raw.models = models;
			return true;
		});
		this.reload();
		return true;
	}

	writeFamilies(apply: (families: Record<string, unknown>) => void): boolean {
		return this.writeModels((models) =>
			apply(ensureObject(models, "families")),
		);
	}
	writeRosters(apply: (rosters: Record<string, unknown>) => void): boolean {
		return this.writeModels((models) => apply(ensureObject(models, "rosters")));
	}
	writeBindings(apply: (bindings: Record<string, unknown>) => void): boolean {
		return this.writeModels((models) =>
			apply(ensureObject(models, "bindings")),
		);
	}
	writeRegion(
		apply: (region: {
			active?: string;
			lists: Record<string, unknown>;
		}) => void,
	): boolean {
		return this.writeModels((models) => {
			const region = ensureObject(models, "region") as {
				active?: string;
				lists?: Record<string, unknown>;
			};
			if (!plainObject(region.lists)) region.lists = {};
			apply(region as { active?: string; lists: Record<string, unknown> });
		});
	}

	/** Rename a family, carrying its roster refs (Family/Alias → NewFamily/Alias). */
	renameFamily(from: string, to: string): boolean {
		return this.writeModels((models) => {
			const families = ensureObject(models, "families");
			if (!families[from]) throw new Error(`family ${from} not found`);
			if (families[to]) throw new Error(`a family "${to}" already exists`);
			renameKeyInPlace(families, from, to);
			retargetRosterRefs(models, (family, alias) => [
				family === from ? to : family,
				alias,
			]);
		});
	}

	/** Rename an alias within a family, carrying its roster refs. */
	renameAlias(family: string, from: string, to: string): boolean {
		return this.writeModels((models) => {
			const families = ensureObject(models, "families");
			const fam = families[family] as MutFamily | undefined;
			if (!fam?.aliases?.[from])
				throw new Error(`alias ${family}/${from} not found`);
			if (fam.aliases[to]) throw new Error(`an alias "${to}" already exists`);
			renameKeyInPlace(fam.aliases as Record<string, unknown>, from, to);
			retargetRosterRefs(models, (currentFamily, alias) => [
				currentFamily,
				currentFamily === family && alias === from ? to : alias,
			]);
		});
	}

	private reload(): void {
		try {
			this.config = readV2Config(this.ctx.cwd);
		} catch (cause) {
			this.config = undefined;
			this.notify(
				`Model config could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
				"warning",
			);
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const top = this.stack[this.stack.length - 1];
		return top ? top.render(width, this.palette) : [];
	}

	handleInput(data: string): void {
		const top = this.stack[this.stack.length - 1];
		top?.handleInput(data);
	}
}

// ─── Launch ──────────────────────────────────────────────────────────────────

function sessionSeat(ctx: ExtensionContext): string | undefined {
	const model = (ctx as { model?: { provider?: string; id?: string } }).model;
	return model?.provider && model.id
		? `${model.provider}/${model.id}`
		: undefined;
}

/** Every registry ref whose provider is authenticated (region applied later). */
async function authenticatedRefs(ctx: ExtensionContext): Promise<Set<string>> {
	const registry = ctx.modelRegistry as unknown as {
		getAll?: () => { provider: string; id: string }[];
		getApiKeyAndHeaders?: (model: {
			provider: string;
			id: string;
		}) => Promise<{ ok: boolean }>;
	};
	const set = new Set<string>();
	const all = registry.getAll?.() ?? [];
	await Promise.all(
		all.map(async (model) => {
			try {
				const auth = await registry.getApiKeyAndHeaders?.(model);
				if (auth?.ok) set.add(`${model.provider}/${model.id}`);
			} catch {
				// unauthenticated / unknown — left out
			}
		}),
	);
	return set;
}

/** Whether this surface can host the takeover editor (TUI with ui.custom). */
export function supportsMaestroApp(ctx: ExtensionContext): boolean {
	return supportsMultiSelect(ctx);
}

/**
 * Test seam: build the component directly (no ctx.ui.custom, plain palette, no
 * keybindings), so tests can drive handleInput byte-by-byte and observe the
 * writes it makes. Not used by the runtime — {@link launchMaestroApp} is.
 */
export function createMaestroAppForTest(
	ctx: ExtensionContext,
	providers: Map<string, string[]>,
	authed: Set<string>,
	seat: string | undefined,
	done: () => void,
	registry: DomainRegistryInput = {},
): Component &
	Focusable & {
		handleInput(data: string): void;
		render(width: number): string[];
	} {
	return new MaestroApp(
		ctx,
		providers,
		authed,
		seat,
		registry,
		PLAIN,
		undefined,
		done,
	);
}

/**
 * Launch the full-screen model-config editor. Resolves when the user exits it.
 * Caller must check {@link supportsMaestroApp} first (RPC/headless keep the
 * scripted /maestro set path).
 */
export async function launchMaestroApp(
	ctx: ExtensionContext,
	registry: DomainRegistryInput = {},
): Promise<void> {
	const [providers, authed] = await Promise.all([
		modelsByProvider(ctx),
		authenticatedRefs(ctx),
	]);
	const custom = (
		ctx.ui as unknown as {
			custom: <T>(
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (result: T) => void,
				) => unknown,
				options?: unknown,
			) => Promise<T>;
		}
	).custom;
	await custom<void>((_tui, theme, keybindings, done) => {
		const matcher =
			keybindings && typeof (keybindings as KeyMatcher).matches === "function"
				? (keybindings as KeyMatcher)
				: undefined;
		const app = new MaestroApp(
			ctx,
			providers,
			authed,
			sessionSeat(ctx),
			registry,
			paletteFromTheme(theme),
			matcher,
			() => done(undefined),
		);
		app.focused = true;
		return app;
	});
}
