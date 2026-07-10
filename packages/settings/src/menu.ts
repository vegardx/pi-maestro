// Interactive /maestro menu — TUI overlay for model profiles + scoped settings.
//
// A profile owns a SET of /model targets (exclusive across profiles) and pins the
// work/review/fast tiers; `plan` always tracks the session model. Activation is
// derived — the profile whose targets include the current /model is active. There
// is no "activate" action here; switching /model switches the profile.

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { PINNABLE_TIERS } from "@vegardx/pi-contracts";
import { activeProfile, readModelsConfig } from "@vegardx/pi-models";
import { settingsRegistry } from "./extension.js";
import { readLayeredExtensionConfig } from "./reader.js";
import { updateSettingsFile, writeExtensionConfigKey } from "./writer.js";

// ─── Types ──────────────────────────────────────────────────────────────────

interface SettingRow {
	/** Display label. */
	label: string;
	/** Extension name (e.g. "modes") or "@profiles" for the profile section. */
	extension: string;
	/** Dot-path key within the extension, or a @profiles-encoded key. */
	key: string;
	global: string | undefined;
	project: string | undefined;
	session: string | undefined;
	/** If true, only the global column is editable (project/session show ·). */
	globalOnly?: boolean;
	/** Default value (shown dimmed in global column when no explicit value set). */
	defaultValue?: string;
	/** Profile-section rows are not scope-editable; they open dedicated pickers. */
	profileRow?: boolean;
}

interface Section {
	title: string;
	rows: SettingRow[];
}

// ─── Palette ────────────────────────────────────────────────────────────────

interface Palette {
	dim: (s: string) => string;
	accent: (s: string) => string;
	heading: (s: string) => string;
	muted: (s: string) => string;
	success: (s: string) => string;
}

function paletteFromTheme(theme: Theme): Palette {
	const t = theme as {
		fg?: (color: string, text: string) => string;
		bold?: (text: string) => string;
	} | null;
	if (!t?.fg) {
		return {
			dim: (s) => s,
			accent: (s) => s,
			heading: (s) => s,
			muted: (s) => s,
			success: (s) => s,
		};
	}
	return {
		dim: (s) => t.fg!("dim", s),
		accent: (s) => t.fg!("accent", s),
		heading: (s) => t.bold!(t.fg!("text", s)),
		muted: (s) => t.fg!("muted", s),
		success: (s) => t.fg!("success", s),
	};
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Pad a string to target visible width (ANSI-safe). */
function visPad(s: string, targetWidth: number): string {
	const vw = visibleWidth(s);
	if (vw >= targetWidth) return truncateToWidth(s, targetWidth);
	return s + " ".repeat(targetWidth - vw);
}

function readPath(obj: unknown, key: string): unknown {
	let current = obj;
	for (const part of key.split(".")) {
		if (!isPlainObject(current) || !Object.hasOwn(current, part))
			return undefined;
		current = current[part];
	}
	return current;
}

function formatVal(v: unknown): string | undefined {
	if (v === undefined) return undefined;
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	if (Array.isArray(v)) return v.join(" → ");
	return JSON.stringify(v);
}

function sessionModelId(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

// ─── Known settings from capability registry ───────────────────────────────

function getRegisteredSettings(): Array<{
	extension: string;
	key: string;
	label: string;
	type: string;
	default?: string | number | boolean;
}> {
	const all: Array<{
		extension: string;
		key: string;
		label: string;
		type: string;
		default?: string | number | boolean;
	}> = [];
	for (const [ext, declarations] of settingsRegistry) {
		for (const decl of declarations) {
			all.push({ extension: ext, ...decl });
		}
	}
	return all;
}

// ─── Session store (in-memory only) ─────────────────────────────────────────

const sessionStore: Map<string, string> = new Map();

function sessionKey(extension: string, key: string): string {
	return `${extension}.${key}`;
}

// ─── Build sections ─────────────────────────────────────────────────────────

/** Human display for a tier config: pinned model+effort, or "= plan". */
function tierDisplay(
	ctx: ExtensionContext,
	tc: { model?: string; effort?: string } | undefined,
): string {
	if (!tc?.model) return "= plan";
	const name = resolveModelName(ctx, tc.model);
	return tc.effort ? `${name} · ${tc.effort}` : name;
}

function resolveModelName(ctx: ExtensionContext, modelId: string): string {
	if (!modelId.includes("/")) return modelId;
	const [provider, ...rest] = modelId.split("/");
	const model = ctx.modelRegistry.find(provider, rest.join("/"));
	return (model as { name?: string } | undefined)?.name ?? modelId;
}

function buildSections(ctx: ExtensionContext): Section[] {
	const { global, project } = readLayeredExtensionConfig(ctx.cwd);
	const modelsConfig = readModelsConfig(ctx.cwd);
	const activeName = activeProfile(modelsConfig, sessionModelId(ctx))?.name;
	const sections: Section[] = [];

	// Model profiles section (always first)
	const profileRows: SettingRow[] = [];
	if (modelsConfig) {
		for (const [name, profile] of Object.entries(modelsConfig.profiles)) {
			profileRows.push({
				label: name,
				extension: "@profiles",
				key: `@name.${name}`,
				global: name === activeName ? "active" : undefined,
				project: undefined,
				session: undefined,
				globalOnly: true,
				profileRow: true,
			});
			// targets
			profileRows.push({
				label: "  targets",
				extension: "@profiles",
				key: `${name}.@targets`,
				global: profile.targets.length
					? profile.targets.map((t) => resolveModelName(ctx, t)).join(", ")
					: undefined,
				project: undefined,
				session: undefined,
				globalOnly: true,
				profileRow: true,
			});
			// plan (read-only, always the session model)
			profileRows.push({
				label: "  plan",
				extension: "@profiles",
				key: `${name}.plan`,
				global: ctx.model
					? `${resolveModelName(ctx, sessionModelId(ctx)!)} · = /model`
					: "= /model",
				project: undefined,
				session: undefined,
				globalOnly: true,
				profileRow: true,
			});
			// pinnable tiers
			for (const tier of PINNABLE_TIERS) {
				profileRows.push({
					label: `  ${tier}`,
					extension: "@profiles",
					key: `${name}.${tier}`,
					global: tierDisplay(ctx, profile[tier]),
					project: undefined,
					session: undefined,
					globalOnly: true,
					profileRow: true,
				});
			}
		}
	}
	sections.push({ title: "profiles", rows: profileRows });

	// Extension settings from capability registry
	const registered = getRegisteredSettings();
	const byExt = new Map<string, SettingRow[]>();

	for (const decl of registered) {
		const globalVal = formatVal(readPath(global[decl.extension], decl.key));
		const projectVal = formatVal(readPath(project[decl.extension], decl.key));
		const sessVal = sessionStore.get(sessionKey(decl.extension, decl.key));
		const defaultStr =
			decl.default !== undefined ? String(decl.default) : undefined;

		const row: SettingRow = {
			label: decl.label,
			extension: decl.extension,
			key: decl.key,
			global: globalVal,
			project: projectVal,
			session: sessVal,
			defaultValue: defaultStr,
		};

		const list = byExt.get(decl.extension) ?? [];
		list.push(row);
		byExt.set(decl.extension, list);
	}

	for (const [ext, rows] of byExt) {
		sections.push({ title: ext, rows });
	}

	return sections;
}

// ─── Interactive Component ──────────────────────────────────────────────────

const KEY_UP = "[A";
const KEY_DOWN = "[B";
const KEY_LEFT = "[D";
const KEY_RIGHT = "[C";
const KEY_ENTER = "\r";
const KEY_ESC = "";
const KEY_BACKSPACE = "";
const KEY_SPACE = " ";

type Mode =
	| "browse"
	| "edit"
	| "select"
	| "naming"
	| "renaming"
	| "confirm-delete"
	| "tier-pick-model"
	| "tier-pick-effort"
	| "targets";

const COL_NAMES = ["global", "project", "session"] as const;
type ColIdx = 0 | 1 | 2;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

const ADAPTIVE_DESCRIPTIONS: Record<string, string> = {
	low: "may skip thinking on simple problems",
	medium: "thinks when the problem warrants it",
	high: "almost always thinks (default)",
	xhigh: "maximum reasoning depth",
};

function isAdaptiveThinking(model: unknown): boolean {
	return (
		(model as { compat?: { forceAdaptiveThinking?: boolean } })?.compat
			?.forceAdaptiveThinking === true
	);
}

interface OptionItem {
	label: string;
	value: string;
}

function getOptionsForKey(key: string): OptionItem[] | null {
	if (key.endsWith(".thinking") || key.endsWith(".effort"))
		return THINKING_LEVELS.map((v) => ({ label: v, value: v }));
	return null;
}

/**
 * Models to offer when picking one. Prefer authed models (scoped, matches
 * /model, doesn't overflow the screen); fall back to ALL known models only
 * when nothing is authed yet — the clean-config case.
 */
function pickerModels(ctx: ExtensionContext) {
	const authed = ctx.modelRegistry.getAvailable();
	return authed.length > 0 ? authed : ctx.modelRegistry.getAll();
}

interface PickerModel {
	modelId: string;
	name: string;
	adaptive: boolean;
}

/** The "= plan" pseudo-entry the tier model picker offers first. */
const TRACK_PLAN = "@plan";

export class ConfigMenuComponent implements Component, Focusable {
	focused = true;
	expanded = true;
	private sections: Section[];
	private flatRows: SettingRow[] = [];
	private cursor = 0;
	private col: ColIdx = 0;
	private mode: Mode = "browse";
	private editBuffer = "";
	private options: Array<{ label: string; value: string }> = [];
	private optionCursor = 0;
	private statusMessage = "";
	private pendingDeleteProfile = "";
	// Tier picker state
	private tierPickerModels: PickerModel[] = [];
	private tierPickerEfforts: Array<{ level: string; desc?: string }> = [];
	private tierPickerCursor = 0;
	private tierPickerSelectedModel = "";
	private tierPickerModelName = "";
	private tierPickerAdaptive = false;
	// Targets multi-select state
	private targetModels: PickerModel[] = [];
	private targetSelected: Set<string> = new Set();
	private targetOwner: Map<string, string> = new Map();
	private targetCursor = 0;
	private readonly palette: Palette;
	private readonly ctx: ExtensionContext;
	private readonly done: (result: undefined) => void;
	/** Live terminal height in rows (for scroll windowing). */
	private readonly viewportRows: () => number;
	/**
	 * Index into the just-rendered `lines` of the currently-active row (cursor
	 * or picker selection). The scroll window centers on it so the selected row
	 * is always visible. Reset each render, set by the sub-renderers.
	 */
	private activeLineIdx = -1;

	constructor(
		ctx: ExtensionContext,
		palette: Palette,
		done: (result: undefined) => void,
		viewport: () => number = () => Number.POSITIVE_INFINITY,
	) {
		this.ctx = ctx;
		this.palette = palette;
		this.done = done;
		this.viewportRows = viewport;
		this.sections = buildSections(ctx);
		this.rebuildFlat();
	}

	private rebuildFlat(): void {
		this.flatRows = [];
		for (const section of this.sections) {
			for (const row of section.rows) {
				this.flatRows.push(row);
			}
		}
	}

	private isProfileRow(row?: SettingRow): boolean {
		return row?.extension === "@profiles";
	}

	private isNameRow(row?: SettingRow): boolean {
		return Boolean(row?.key.startsWith("@name."));
	}

	private effective(row: SettingRow): string {
		const val =
			row.session ?? row.project ?? row.global ?? row.defaultValue ?? "—";
		return val;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		const p = this.palette;
		const lines: string[] = [];
		this.activeLineIdx = -1;

		const innerW = _width - 4;
		const labelW = Math.max(18, Math.floor(innerW * 0.24));
		const colW = Math.min(24, Math.max(8, Math.floor(innerW * 0.14)));
		const spacerTotal = Math.max(0, innerW - labelW - colW * 4);
		const spacer1 = Math.floor(spacerTotal * 0.6);
		const spacer2 = spacerTotal - spacer1;
		const boxW = _width;

		const line = (content: string): string => {
			const raw = `${p.dim("│")} ${visPad(content, innerW)} ${p.dim("│")}`;
			if (visibleWidth(raw) > _width) return truncateToWidth(raw, _width);
			return raw;
		};

		const title = " maestro · models ";
		const topFill = "─".repeat(Math.max(boxW - 3 - title.length, 0));
		lines.push(p.dim(`╭─${title}${topFill}╮`));

		if (this.mode === "tier-pick-model") {
			this.renderTierModelPicker(lines, line);
		} else if (this.mode === "tier-pick-effort") {
			this.renderTierEffortPicker(lines, line);
		} else if (this.mode === "targets") {
			this.renderTargetsPicker(lines, line);
		} else {
			this.renderBrowse(lines, line, {
				innerW,
				labelW,
				colW,
				spacer1,
				spacer2,
			});
		}

		this.renderOverlays(lines, line);
		this.renderHelp(lines, line);
		lines.push(p.dim(`╰${"─".repeat(boxW - 2)}╯`));
		return this.windowLines(lines, line);
	}

	/**
	 * Bound the rendered box to a fraction of the live terminal height, keeping
	 * the active row visible. The menu mounts in place of the editor (like core's
	 * /settings), so an unbounded dynamic profile list would grow past the screen
	 * and push rows out of reach. Window the content to ~60% of the terminal so
	 * the menu stays a panel above the chat rather than swallowing it.
	 *
	 * Layout is [top border, ...content..., help, bottom border]; the top border
	 * and the trailing help + bottom border stay pinned while the content region
	 * scrolls around `activeLineIdx`.
	 */
	private windowLines(lines: string[], line: (s: string) => string): string[] {
		const rows = this.viewportRows();
		if (!Number.isFinite(rows)) return lines;
		const budget = Math.max(12, Math.floor(rows * 0.6));
		if (lines.length <= budget) return lines;

		const top = lines[0];
		const help = lines[lines.length - 2];
		const bottom = lines[lines.length - 1];
		const content = lines.slice(1, lines.length - 2);
		// Reserve: top + help + bottom (3) + up to two "⋯ more" markers.
		const avail = Math.max(3, budget - 5);
		const focus =
			this.activeLineIdx >= 1
				? Math.min(this.activeLineIdx - 1, content.length - 1)
				: 0;

		let start = Math.max(0, focus - Math.floor(avail / 2));
		start = Math.min(start, Math.max(0, content.length - avail));
		const end = Math.min(content.length, start + avail);

		const out = [top];
		if (start > 0) out.push(line(this.palette.dim(`  ⋯ ${start} more above`)));
		out.push(...content.slice(start, end));
		if (end < content.length)
			out.push(
				line(this.palette.dim(`  ⋯ ${content.length - end} more below`)),
			);
		out.push(help, bottom);
		return out;
	}

	private renderBrowse(
		lines: string[],
		line: (s: string) => string,
		dims: {
			innerW: number;
			labelW: number;
			colW: number;
			spacer1: number;
			spacer2: number;
		},
	): void {
		const p = this.palette;
		const { innerW, labelW, colW, spacer1, spacer2 } = dims;

		// ─── Profiles section ───────────────────────────────────────────────
		const modelW = Math.min(34, Math.floor(innerW * 0.42));
		lines.push(line(""));
		lines.push(line(p.heading("profiles")));
		lines.push(line(""));
		for (let fi = 0; fi < this.flatRows.length; fi++) {
			const r = this.flatRows[fi];
			if (!this.isProfileRow(r)) continue;
			const selected = fi === this.cursor;
			const ptr = selected ? p.accent("▶ ") : "  ";
			if (selected && this.mode === "browse") this.activeLineIdx = lines.length;
			if (this.isNameRow(r)) {
				const nm = r.key.slice(6);
				const isActive = r.global === "active";
				const suffix = isActive ? p.muted(" (active · via /model)") : "";
				const nameText = isActive ? p.heading(nm) : p.dim(nm);
				lines.push(line(`${ptr}${nameText}${suffix}`));
			} else {
				const label = visPad(r.label, labelW - 2);
				const raw = r.global ?? "= plan";
				const readOnly = r.key.endsWith(".plan");
				let cell: string;
				if (selected && !readOnly) {
					const inner = truncateToWidth(raw, modelW - 4);
					cell = p.accent(visPad(`[${inner}]`, modelW));
				} else if (readOnly) {
					cell = p.dim(visPad(truncateToWidth(raw, modelW - 1), modelW));
				} else if (r.global) {
					cell = visPad(truncateToWidth(raw, modelW - 1), modelW);
				} else {
					cell = p.dim(visPad(truncateToWidth(raw, modelW - 1), modelW));
				}
				lines.push(line(`${ptr}${label}${cell}`));
			}
		}
		if (!this.flatRows.some((r) => this.isProfileRow(r))) {
			lines.push(line(p.dim("  (no profiles — press n to create one)")));
		}

		// Divider
		lines.push(line(""));
		lines.push(line(p.dim("─".repeat(innerW))));
		lines.push(line(""));

		// ─── Scoped settings section ────────────────────────────────────────
		const sp1 = " ".repeat(spacer1);
		const sp2 = " ".repeat(spacer2);
		const hdr =
			visPad("", labelW) +
			sp1 +
			COL_NAMES.map((name, i) => {
				const cell = visPad(name, colW);
				const active =
					i === this.col &&
					this.mode === "browse" &&
					!this.isProfileRow(this.flatRows[this.cursor]);
				return active ? p.accent(cell) : p.muted(cell);
			}).join("") +
			sp2 +
			p.muted(visPad("effective", colW));
		lines.push(line(hdr));
		lines.push(line(""));

		let lastSection = "";
		for (let fi = 0; fi < this.flatRows.length; fi++) {
			const r = this.flatRows[fi];
			if (this.isProfileRow(r)) continue;
			const sectionTitle = this.sections.find((s) => s.rows.includes(r))?.title;
			if (sectionTitle && sectionTitle !== lastSection) {
				lines.push(line(p.heading(sectionTitle)));
				lastSection = sectionTitle;
			}
			const selected = fi === this.cursor;
			const ptr = selected ? p.accent("▶ ") : "  ";
			if (selected && this.mode === "browse") this.activeLineIdx = lines.length;
			const label = visPad(r.label, labelW - 2);
			const cells = [r.global, r.project, r.session].map((val, i) => {
				if (r.globalOnly && i > 0) return p.dim(visPad("·", colW));
				const isActive = selected && i === this.col;
				const showDefault = !val && i === 0 && r.defaultValue;
				let display: string;
				if (this.mode === "edit" && isActive) {
					display = `${this.editBuffer}█`;
				} else if (isActive) {
					const v = val ?? r.defaultValue ?? "—";
					display = `[${truncateToWidth(v, colW - 4)}]`;
				} else if (showDefault) {
					display = `${r.defaultValue} (def)`;
				} else {
					display = val ?? "—";
				}
				const cell = visPad(truncateToWidth(display, colW - 1), colW);
				if (isActive) return p.accent(cell);
				if (showDefault) return p.dim(cell);
				if (val) return cell;
				return p.dim(cell);
			});
			const effCell = p.success(
				visPad(truncateToWidth(this.effective(r), colW - 1), colW),
			);
			lines.push(line(`${ptr}${label}${sp1}${cells.join("")}${sp2}${effCell}`));
		}

		if (this.mode === "select" && this.options.length > 0) {
			lines.push(line(p.heading("Select value:")));
			for (let i = 0; i < this.options.length; i++) {
				const opt = this.options[i];
				const sel = i === this.optionCursor;
				const marker = sel ? p.accent("▶ ") : "  ";
				const text = sel ? p.accent(opt.label) : opt.label;
				if (sel) this.activeLineIdx = lines.length;
				lines.push(line(`    ${marker}${text}`));
			}
			lines.push(line(""));
		}
	}

	private renderTierModelPicker(
		lines: string[],
		line: (s: string) => string,
	): void {
		const p = this.palette;
		const row = this.flatRows[this.cursor];
		const tier = row?.key.split(".")[1] ?? "tier";
		lines.push(line(""));
		lines.push(line(`  ${p.accent(`Model for ${tier}`)}`));
		lines.push(line(""));
		for (let i = 0; i < this.tierPickerModels.length; i++) {
			const m = this.tierPickerModels[i];
			const ptr = i === this.tierPickerCursor ? p.accent("▶ ") : "  ";
			if (i === this.tierPickerCursor) this.activeLineIdx = lines.length;
			const badge =
				m.modelId === TRACK_PLAN
					? ""
					: m.adaptive
						? p.muted(" [adaptive]")
						: "";
			const label = m.modelId === TRACK_PLAN ? p.muted(m.name) : m.name;
			lines.push(line(`  ${ptr}${label}${badge}`));
		}
		lines.push(line(""));
		lines.push(
			line(
				p.muted(
					"  Pin review to a DIFFERENT model than work for a true 2nd opinion.",
				),
			),
		);
	}

	private renderTierEffortPicker(
		lines: string[],
		line: (s: string) => string,
	): void {
		const p = this.palette;
		const badge = this.tierPickerAdaptive ? p.muted(" [adaptive]") : "";
		lines.push(line(""));
		lines.push(
			line(`  ${p.accent(`Effort for ${this.tierPickerModelName}`)}${badge}`),
		);
		lines.push(line(""));
		if (this.tierPickerAdaptive) {
			lines.push(
				line(p.muted("  Adaptive — effort steers, the model sets its budget.")),
			);
		} else {
			lines.push(line(p.muted("  Fixed — effort IS the reasoning budget.")));
		}
		lines.push(line(""));
		for (let i = 0; i < this.tierPickerEfforts.length; i++) {
			const e = this.tierPickerEfforts[i];
			const ptr = i === this.tierPickerCursor ? p.accent("▶ ") : "  ";
			if (i === this.tierPickerCursor) this.activeLineIdx = lines.length;
			const desc = e.desc ? p.muted(`  ${e.desc}`) : "";
			lines.push(line(`  ${ptr}${e.level}${desc}`));
		}
	}

	private renderTargetsPicker(
		lines: string[],
		line: (s: string) => string,
	): void {
		const p = this.palette;
		const profile = this.currentProfileName();
		lines.push(line(""));
		lines.push(line(`  ${p.accent(`Targets for "${profile}"`)}`));
		lines.push(
			line(
				p.muted("  Which /model choices activate this profile (exclusive)."),
			),
		);
		lines.push(line(""));
		for (let i = 0; i < this.targetModels.length; i++) {
			const m = this.targetModels[i];
			const ptr = i === this.targetCursor ? p.accent("▶ ") : "  ";
			if (i === this.targetCursor) this.activeLineIdx = lines.length;
			const box = this.targetSelected.has(m.modelId) ? "[x]" : "[ ]";
			const owner = this.targetOwner.get(m.modelId);
			const note =
				owner && owner !== profile
					? p.muted(`  → in "${owner}" (checking moves it here)`)
					: "";
			lines.push(line(`  ${ptr}${box} ${m.name}${note}`));
		}
		lines.push(line(""));
	}

	private renderOverlays(lines: string[], line: (s: string) => string): void {
		const p = this.palette;
		if (this.mode === "naming") {
			lines.push(line(""));
			this.activeLineIdx = lines.length;
			lines.push(
				line(`  New profile name: ${p.accent(`${this.editBuffer}█`)}`),
			);
			lines.push(line(""));
		}
		if (this.mode === "renaming") {
			lines.push(line(""));
			this.activeLineIdx = lines.length;
			lines.push(line(`  Rename profile: ${p.accent(`${this.editBuffer}█`)}`));
			lines.push(line(""));
		}
		if (this.mode === "confirm-delete") {
			lines.push(line(""));
			this.activeLineIdx = lines.length;
			lines.push(
				line(`  ${p.accent(`Delete profile "${this.pendingDeleteProfile}"?`)}`),
			);
			lines.push(line(""));
		} else if (this.statusMessage) {
			lines.push(line(`  ${p.success(this.statusMessage)}`));
		}
	}

	private renderHelp(lines: string[], line: (s: string) => string): void {
		const p = this.palette;
		const row = this.flatRows[this.cursor];
		const help =
			this.mode === "tier-pick-model"
				? "↑↓ navigate  Enter select  Esc cancel"
				: this.mode === "tier-pick-effort"
					? "↑↓ navigate  Enter confirm  Esc back"
					: this.mode === "targets"
						? "↑↓ navigate  Space toggle  Esc done"
						: this.mode === "confirm-delete"
							? "y confirm  Esc cancel"
							: this.mode === "select"
								? "↑↓ choose  Enter confirm  Esc cancel"
								: this.mode === "edit"
									? "Enter: save  Esc: cancel"
									: this.mode === "naming" || this.mode === "renaming"
										? "Enter: confirm  Esc: cancel"
										: this.isNameRow(row)
											? "↑↓ navigate  r rename  d delete  n new  Esc close"
											: "↑↓ navigate  ←→ scope  Enter edit  n new profile  Esc close";
		lines.push(line(p.muted(help)));
	}

	// ─── Input ────────────────────────────────────────────────────────────────

	handleInput(data: string): void {
		this.statusMessage = "";
		switch (this.mode) {
			case "edit":
				this.handleEditInput(data);
				break;
			case "select":
				this.handleSelectInput(data);
				break;
			case "naming":
				this.handleNamingInput(data);
				break;
			case "renaming":
				this.handleRenamingInput(data);
				break;
			case "confirm-delete":
				this.handleConfirmDeleteInput(data);
				break;
			case "tier-pick-model":
				this.handleTierModelInput(data);
				break;
			case "tier-pick-effort":
				this.handleTierEffortInput(data);
				break;
			case "targets":
				this.handleTargetsInput(data);
				break;
			default:
				this.handleBrowseInput(data);
		}
	}

	private handleBrowseInput(data: string): void {
		switch (data) {
			case KEY_UP:
				this.cursor = Math.max(0, this.cursor - 1);
				break;
			case KEY_DOWN:
				this.cursor = Math.min(this.flatRows.length - 1, this.cursor + 1);
				break;
			case KEY_LEFT: {
				const r = this.flatRows[this.cursor];
				if (!this.isProfileRow(r) && !r?.globalOnly)
					this.col = Math.max(0, this.col - 1) as ColIdx;
				break;
			}
			case KEY_RIGHT: {
				const r = this.flatRows[this.cursor];
				if (!this.isProfileRow(r) && !r?.globalOnly)
					this.col = Math.min(2, this.col + 1) as ColIdx;
				break;
			}
			case KEY_ENTER:
				this.onEnter();
				break;
			case "d": {
				const row = this.flatRows[this.cursor];
				if (this.isNameRow(row)) this.startDeleteProfile(row.key.slice(6));
				else if (row && !this.isProfileRow(row)) this.deleteCell(row);
				break;
			}
			case "r": {
				const row = this.flatRows[this.cursor];
				if (this.isNameRow(row)) {
					this.editBuffer = row.key.slice(6);
					this.mode = "renaming";
				}
				break;
			}
			case "n":
				this.editBuffer = "";
				this.mode = "naming";
				break;
			case KEY_ESC:
			case "q":
				this.done(undefined);
				break;
		}
	}

	private onEnter(): void {
		const row = this.flatRows[this.cursor];
		if (!row) return;
		if (this.isProfileRow(row)) {
			if (this.isNameRow(row)) return; // name row: use r/d/n
			if (row.key.endsWith(".@targets")) {
				this.openTargetsPicker();
			} else if (!row.key.endsWith(".plan")) {
				this.openTierModelPicker(); // work/review/fast (plan is read-only)
			}
			return;
		}
		// Scoped setting row
		const opts = getOptionsForKey(row.key);
		if (opts && opts.length > 0) {
			this.options = opts;
			const current = [row.global, row.project, row.session][this.col];
			const matchVal = current ?? row.defaultValue ?? "";
			this.optionCursor = Math.max(
				0,
				opts.findIndex((o) => o.value === matchVal),
			);
			this.mode = "select";
		} else {
			const current = [row.global, row.project, row.session][this.col];
			this.editBuffer = current ?? row.defaultValue ?? "";
			this.mode = "edit";
		}
	}

	private handleEditInput(data: string): void {
		if (data === KEY_ESC) {
			this.mode = "browse";
			this.editBuffer = "";
			return;
		}
		if (data === KEY_ENTER) {
			const row = this.flatRows[this.cursor];
			if (row) this.writeCell(row, this.editBuffer);
			this.mode = "browse";
			this.editBuffer = "";
			return;
		}
		if (data === KEY_BACKSPACE) {
			this.editBuffer = this.editBuffer.slice(0, -1);
			return;
		}
		if (data.length === 1 && data >= " ") this.editBuffer += data;
	}

	private handleSelectInput(data: string): void {
		switch (data) {
			case KEY_UP:
				this.optionCursor = Math.max(0, this.optionCursor - 1);
				break;
			case KEY_DOWN:
				this.optionCursor = Math.min(
					this.options.length - 1,
					this.optionCursor + 1,
				);
				break;
			case KEY_ENTER: {
				const selected = this.options[this.optionCursor];
				if (selected) {
					const row = this.flatRows[this.cursor];
					if (row) this.writeCell(row, selected.value);
				}
				this.mode = "browse";
				this.options = [];
				break;
			}
			case KEY_ESC:
				this.mode = "browse";
				this.options = [];
				break;
		}
	}

	private handleNamingInput(data: string): void {
		if (data === KEY_ESC) {
			this.mode = "browse";
			this.editBuffer = "";
			return;
		}
		if (data === KEY_ENTER) {
			const name = this.editBuffer.trim();
			if (name) this.createProfile(name);
			this.mode = "browse";
			this.editBuffer = "";
			return;
		}
		if (data === KEY_BACKSPACE) {
			this.editBuffer = this.editBuffer.slice(0, -1);
			return;
		}
		if (data.length === 1 && data >= " ") this.editBuffer += data;
	}

	private handleRenamingInput(data: string): void {
		if (data === KEY_ESC) {
			this.mode = "browse";
			this.editBuffer = "";
			return;
		}
		if (data === KEY_ENTER) {
			const row = this.flatRows[this.cursor];
			const oldName = row?.key.slice(6);
			const newName = this.editBuffer.trim();
			if (oldName && newName && newName !== oldName)
				this.renameProfile(oldName, newName);
			this.mode = "browse";
			this.editBuffer = "";
			return;
		}
		if (data === KEY_BACKSPACE) {
			this.editBuffer = this.editBuffer.slice(0, -1);
			return;
		}
		if (data.length === 1 && data >= " ") this.editBuffer += data;
	}

	private handleConfirmDeleteInput(data: string): void {
		if (data === "y" || data === "Y") {
			this.executeDeleteProfile(this.pendingDeleteProfile);
			this.mode = "browse";
			this.pendingDeleteProfile = "";
			return;
		}
		this.mode = "browse";
		this.pendingDeleteProfile = "";
		this.statusMessage = "Delete cancelled";
	}

	// ─── Tier picker ────────────────────────────────────────────────────────

	private openTierModelPicker(): void {
		const models = pickerModels(this.ctx);
		this.tierPickerModels = [
			{
				modelId: TRACK_PLAN,
				name: "= plan (track session model)",
				adaptive: false,
			},
			...models.map((m) => {
				const modelName = (m as { name?: string }).name || m.id;
				const suffix = this.ctx.modelRegistry.hasConfiguredAuth(m)
					? ""
					: " · needs auth";
				return {
					modelId: `${m.provider}/${m.id}`,
					name: `${modelName} (${m.provider})${suffix}`,
					adaptive: isAdaptiveThinking(m),
				};
			}),
		];
		this.tierPickerCursor = 0;
		this.mode = "tier-pick-model";
	}

	private handleTierModelInput(data: string): void {
		switch (data) {
			case KEY_UP:
				this.tierPickerCursor = Math.max(0, this.tierPickerCursor - 1);
				break;
			case KEY_DOWN:
				this.tierPickerCursor = Math.min(
					this.tierPickerModels.length - 1,
					this.tierPickerCursor + 1,
				);
				break;
			case KEY_ENTER: {
				const selected = this.tierPickerModels[this.tierPickerCursor];
				if (!selected) break;
				if (selected.modelId === TRACK_PLAN) {
					this.commitTierPick(undefined, undefined);
					break;
				}
				this.tierPickerSelectedModel = selected.modelId;
				this.tierPickerModelName = selected.name;
				this.tierPickerAdaptive = selected.adaptive;
				this.tierPickerEfforts = this.getValidEfforts(
					selected.modelId,
					selected.adaptive,
				);
				if (this.tierPickerEfforts.length === 1) {
					this.commitTierPick(
						this.tierPickerSelectedModel,
						this.tierPickerEfforts[0].level,
					);
				} else {
					this.tierPickerCursor = Math.max(
						0,
						this.tierPickerEfforts.findIndex((e) => e.level === "high"),
					);
					this.mode = "tier-pick-effort";
				}
				break;
			}
			case KEY_ESC:
				this.mode = "browse";
				break;
		}
	}

	private handleTierEffortInput(data: string): void {
		switch (data) {
			case KEY_UP:
				this.tierPickerCursor = Math.max(0, this.tierPickerCursor - 1);
				break;
			case KEY_DOWN:
				this.tierPickerCursor = Math.min(
					this.tierPickerEfforts.length - 1,
					this.tierPickerCursor + 1,
				);
				break;
			case KEY_ENTER: {
				const selected = this.tierPickerEfforts[this.tierPickerCursor];
				if (selected)
					this.commitTierPick(this.tierPickerSelectedModel, selected.level);
				break;
			}
			case KEY_ESC:
				this.tierPickerCursor = 0;
				this.mode = "tier-pick-model";
				break;
		}
	}

	private commitTierPick(model: string | undefined, effort?: string): void {
		const row = this.flatRows[this.cursor];
		if (!row) return;
		const dot = row.key.indexOf(".");
		const profileName = row.key.slice(0, dot);
		const tier = row.key.slice(dot + 1);
		updateSettingsFile("global", this.ctx.cwd, undefined, (obj) => {
			const profile = ensureProfileObject(obj, profileName);
			if (model) profile[tier] = { model, ...(effort ? { effort } : {}) };
			else delete profile[tier];
		});
		this.statusMessage = model
			? `✓ ${profileName}.${tier} = ${this.tierPickerModelName}${effort ? ` · ${effort}` : ""}`
			: `✓ ${profileName}.${tier} = plan`;
		this.refresh();
		this.mode = "browse";
	}

	private getValidEfforts(
		modelId: string,
		adaptive: boolean,
	): Array<{ level: string; desc?: string }> {
		const parsed = modelId.split("/");
		const model = this.ctx.modelRegistry.find(
			parsed[0],
			parsed.slice(1).join("/"),
		);
		const reasoning =
			(model as { reasoning?: boolean } | undefined)?.reasoning ?? true;
		if (!reasoning) return [{ level: "off", desc: "thinking not supported" }];
		const map = (
			model as { thinkingLevelMap?: Record<string, string | null> } | undefined
		)?.thinkingLevelMap;
		const levels = THINKING_LEVELS.filter((l) => map?.[l] !== null);
		if (adaptive) {
			return levels
				.filter((l) => l !== "off" && l !== "minimal")
				.map((l) => ({ level: l, desc: ADAPTIVE_DESCRIPTIONS[l] }));
		}
		return levels.map((l) => ({ level: l }));
	}

	// ─── Targets picker ─────────────────────────────────────────────────────

	private currentProfileName(): string {
		const row = this.flatRows[this.cursor];
		return row?.key.split(".")[0] ?? "";
	}

	private openTargetsPicker(): void {
		const profile = this.currentProfileName();
		const config = readModelsConfig(this.ctx.cwd);
		this.targetSelected = new Set(config?.profiles[profile]?.targets ?? []);
		this.targetOwner = new Map();
		for (const [name, prof] of Object.entries(config?.profiles ?? {})) {
			for (const t of prof.targets) this.targetOwner.set(t, name);
		}
		this.targetModels = pickerModels(this.ctx).map((m) => {
			const modelName = (m as { name?: string }).name || m.id;
			const suffix = this.ctx.modelRegistry.hasConfiguredAuth(m)
				? ""
				: " · needs auth";
			return {
				modelId: `${m.provider}/${m.id}`,
				name: `${modelName} (${m.provider})${suffix}`,
				adaptive: isAdaptiveThinking(m),
			};
		});
		this.targetCursor = 0;
		this.mode = "targets";
	}

	private handleTargetsInput(data: string): void {
		switch (data) {
			case KEY_UP:
				this.targetCursor = Math.max(0, this.targetCursor - 1);
				break;
			case KEY_DOWN:
				this.targetCursor = Math.min(
					this.targetModels.length - 1,
					this.targetCursor + 1,
				);
				break;
			case KEY_SPACE:
			case KEY_ENTER:
				this.toggleTarget();
				break;
			case KEY_ESC:
				this.mode = "browse";
				this.refresh();
				break;
		}
	}

	private toggleTarget(): void {
		const m = this.targetModels[this.targetCursor];
		if (!m) return;
		const profile = this.currentProfileName();
		const modelId = m.modelId;
		const owner = this.targetOwner.get(modelId);
		updateSettingsFile("global", this.ctx.cwd, undefined, (obj) => {
			const profiles = ensureProfilesMap(obj);
			if (this.targetSelected.has(modelId)) {
				// Remove from this profile.
				setTargets(
					profiles,
					profile,
					(profiles[profile]?.targets ?? []).filter((t) => t !== modelId),
				);
				this.targetSelected.delete(modelId);
				this.targetOwner.delete(modelId);
			} else {
				// Move here: strip from any current owner, then add.
				if (owner && owner !== profile) {
					setTargets(
						profiles,
						owner,
						(profiles[owner]?.targets ?? []).filter((t) => t !== modelId),
					);
				}
				setTargets(profiles, profile, [
					...(profiles[profile]?.targets ?? []),
					modelId,
				]);
				this.targetSelected.add(modelId);
				this.targetOwner.set(modelId, profile);
			}
		});
	}

	// ─── Profile CRUD ───────────────────────────────────────────────────────

	private createProfile(name: string): void {
		updateSettingsFile("global", this.ctx.cwd, undefined, (obj) => {
			ensureProfileObject(obj, name);
		});
		this.statusMessage = `✓ Created profile "${name}"`;
		this.refresh();
	}

	private renameProfile(oldName: string, newName: string): void {
		updateSettingsFile("global", this.ctx.cwd, undefined, (obj) => {
			const profiles = ensureProfilesMap(obj);
			if (profiles[oldName]) {
				profiles[newName] = profiles[oldName];
				delete profiles[oldName];
			}
		});
		this.statusMessage = `✓ Renamed "${oldName}" → "${newName}"`;
		this.refresh();
	}

	private startDeleteProfile(name: string): void {
		this.pendingDeleteProfile = name;
		this.mode = "confirm-delete";
	}

	private executeDeleteProfile(name: string): void {
		updateSettingsFile("global", this.ctx.cwd, undefined, (obj) => {
			const profiles = ensureProfilesMap(obj);
			delete profiles[name];
		});
		this.statusMessage = `✓ Deleted profile "${name}"`;
		this.refresh();
		this.cursor = Math.min(this.cursor, this.flatRows.length - 1);
	}

	// ─── Scoped setting writes ──────────────────────────────────────────────

	private writeCell(row: SettingRow, raw: string): void {
		const scope = COL_NAMES[this.col];
		if (scope === "session") {
			sessionStore.set(sessionKey(row.extension, row.key), raw);
			this.statusMessage = `✓ ${row.extension}.${row.key} = ${raw} [session]`;
		} else {
			writeExtensionConfigKey(
				scope,
				this.ctx.cwd,
				row.extension,
				row.key,
				this.parseValue(raw),
			);
			this.statusMessage = `✓ ${row.extension}.${row.key} = ${raw} [${scope}]`;
		}
		this.refresh();
	}

	private deleteCell(row: SettingRow): void {
		const scope = COL_NAMES[this.col];
		if (scope === "session") {
			sessionStore.delete(sessionKey(row.extension, row.key));
			this.statusMessage = `✓ cleared ${row.extension}.${row.key} [session]`;
		} else {
			writeExtensionConfigKey(
				scope,
				this.ctx.cwd,
				row.extension,
				row.key,
				null,
			);
			this.statusMessage = `✓ cleared ${row.extension}.${row.key} [${scope}]`;
		}
		this.refresh();
	}

	private parseValue(
		raw: string,
	): boolean | string | number | readonly string[] {
		try {
			const parsed = JSON.parse(raw);
			if (
				typeof parsed === "boolean" ||
				typeof parsed === "number" ||
				typeof parsed === "string" ||
				(Array.isArray(parsed) && parsed.every((v) => typeof v === "string"))
			) {
				return parsed;
			}
		} catch {
			// fall through
		}
		const num = Number(raw);
		if (Number.isFinite(num) && raw.trim() !== "") return num;
		return raw;
	}

	private refresh(): void {
		this.sections = buildSections(this.ctx);
		this.rebuildFlat();
	}
}

// ─── settings.json mutation helpers ──────────────────────────────────────────

type RawProfile = Record<string, unknown> & { targets?: string[] };

function ensureProfilesMap(
	obj: Record<string, unknown>,
): Record<string, RawProfile> {
	if (!isPlainObject(obj.models)) obj.models = {};
	const models = obj.models as Record<string, unknown>;
	if (!isPlainObject(models.profiles)) models.profiles = {};
	return models.profiles as Record<string, RawProfile>;
}

function ensureProfileObject(
	obj: Record<string, unknown>,
	name: string,
): RawProfile {
	const profiles = ensureProfilesMap(obj);
	if (!isPlainObject(profiles[name]))
		profiles[name] = { targets: [] } as RawProfile;
	const profile = profiles[name] as RawProfile;
	if (!Array.isArray(profile.targets)) profile.targets = [];
	return profile;
}

function setTargets(
	profiles: Record<string, RawProfile>,
	name: string,
	targets: string[],
): void {
	if (!isPlainObject(profiles[name]))
		profiles[name] = { targets: [] } as RawProfile;
	(profiles[name] as RawProfile).targets = targets;
}

// ─── Seeding + public API ────────────────────────────────────────────────────

/**
 * Seed a profile from the current session model when NO profile exists yet:
 * one target (the session model), all tiers tracking plan. Runs lazily the
 * first time the menu opens so a clean config lands on a working profile that
 * mirrors /model — the user then pins review/fast to differentiate.
 */
export function ensureDefaultProfile(ctx: ExtensionContext): void {
	const existing = readModelsConfig(ctx.cwd);
	if (existing && Object.keys(existing.profiles).length > 0) return;
	const model = ctx.model;
	if (!model) return;
	const modelId = `${model.provider}/${model.id}`;
	const name = (model as { name?: string }).name?.trim() || model.id;
	updateSettingsFile("global", ctx.cwd, undefined, (raw) => {
		const profiles = ensureProfilesMap(raw);
		if (Object.keys(profiles).length > 0) return; // race guard
		profiles[name] = { targets: [modelId] } as RawProfile;
	});
}

export function showConfigMenu(ctx: ExtensionContext): void {
	ensureDefaultProfile(ctx);
	const palette = paletteFromTheme(ctx.ui.theme);
	// No options → pi mounts the component in place of the editor (editorContainer
	// swap), exactly like core's /settings selector. The component self-windows to
	// the live terminal height so its dynamic profile list never overflows.
	ctx.ui.custom(
		(tui, _theme, _keybindings, done) =>
			new ConfigMenuComponent(
				ctx,
				palette,
				() => done(undefined),
				() => tui.terminal.rows,
			),
	);
}

/** Read session-scoped value (for resolver integration). */
export function getSessionSetting(
	extension: string,
	key: string,
): string | undefined {
	return sessionStore.get(sessionKey(extension, key));
}

/** Write session-scoped value programmatically. */
export function setSessionSetting(
	extension: string,
	key: string,
	value: string | undefined,
): void {
	const k = sessionKey(extension, key);
	if (value === undefined) sessionStore.delete(k);
	else sessionStore.set(k, value);
}
