// Interactive /maestro menu — TUI overlay with scope columns.

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { SLOTS } from "@vegardx/pi-contracts";
import { readModelsConfig } from "@vegardx/pi-models";
import { settingsRegistry } from "./extension.js";
import { readLayeredExtensionConfig } from "./reader.js";
import { updateSettingsFile, writeExtensionConfigKey } from "./writer.js";

// ─── Types ──────────────────────────────────────────────────────────────────

interface SettingRow {
	/** Display label (e.g. "models.worker.tier") */
	label: string;
	/** Extension name (e.g. "modes") */
	extension: string;
	/** Dot-path key within the extension (e.g. "models.worker.tier") */
	key: string;
	/** Value at global scope, or undefined */
	global: string | undefined;
	/** Value at project scope, or undefined */
	project: string | undefined;
	/** Value at session scope, or undefined */
	session: string | undefined;
	/** If true, only the global column is editable (project/session show ·) */
	globalOnly?: boolean;
	/** Default value (shown dimmed in global column when no explicit value set) */
	defaultValue?: string;
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
		// biome-ignore lint/style/noNonNullAssertion: guarded above
		dim: (s) => t.fg!("dim", s),
		// biome-ignore lint/style/noNonNullAssertion: guarded above
		accent: (s) => t.fg!("accent", s),
		// biome-ignore lint/style/noNonNullAssertion: guarded above
		heading: (s) => t.bold!(t.fg!("text", s)),
		// biome-ignore lint/style/noNonNullAssertion: guarded above
		muted: (s) => t.fg!("muted", s),
		// biome-ignore lint/style/noNonNullAssertion: guarded above
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
	if (Array.isArray(v)) return v.join(" \u2192 ");
	return JSON.stringify(v);
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

function buildSections(ctx: ExtensionContext): Section[] {
	const { global, project } = readLayeredExtensionConfig(ctx.cwd);
	const modelsConfig = readModelsConfig(ctx.cwd);
	const sections: Section[] = [];

	// Model presets section (always first)
	const presetRows: SettingRow[] = [
		{
			label: "Active preset",
			extension: "@presets",
			key: "active",
			global: modelsConfig?.active,
			project: undefined,
			session: sessionStore.get("@presets.active"),
		},
	];
	if (modelsConfig) {
		for (const [name, preset] of Object.entries(modelsConfig.presets)) {
			for (const slot of SLOTS) {
				presetRows.push({
					label: `${name} / ${slot}`,
					extension: "@presets",
					key: `${name}.${slot}`,
					global: preset[slot],
					project: undefined,
					session: undefined,
					globalOnly: true,
				});
			}
		}
	}
	sections.push({ title: "presets", rows: presetRows });

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

const KEY_UP = "\u001b[A";
const KEY_DOWN = "\u001b[B";
const KEY_LEFT = "\u001b[D";
const KEY_RIGHT = "\u001b[C";
const KEY_ENTER = "\r";
const KEY_ESC = "\u001b";
const KEY_BACKSPACE = "\u007f";

type Mode = "browse" | "edit" | "select" | "naming";

const COL_NAMES = ["global", "project", "session"] as const;
type ColIdx = 0 | 1 | 2;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const BOOL_OPTIONS = ["true", "false"];

interface OptionItem {
	label: string;
	value: string;
}

function getOptionsForKey(
	key: string,
	extension: string,
	ctx: ExtensionContext,
): OptionItem[] | null {
	if (key.endsWith(".thinking") || key.endsWith(".effort"))
		return THINKING_LEVELS.map((v) => ({ label: v, value: v }));
	if (key.endsWith(".slot")) return SLOTS.map((v) => ({ label: v, value: v }));
	if (key === "lensDisabled")
		return BOOL_OPTIONS.map((v) => ({ label: v, value: v }));
	if (
		key.endsWith(".model") ||
		(extension === "@presets" && key !== "active")
	) {
		const models = ctx.modelRegistry.getAvailable();
		return models.map((m) => ({
			label: m.name || `${m.provider}/${m.id}`,
			value: `${m.provider}/${m.id}`,
		}));
	}
	if (key === "active") {
		const config = readModelsConfig(ctx.cwd);
		if (config)
			return Object.keys(config.presets).map((v) => ({ label: v, value: v }));
	}
	return null;
}

class ConfigMenuComponent implements Component, Focusable {
	focused = true;
	expanded = true;
	private sections: Section[];
	private flatRows: SettingRow[] = [];
	private cursor = 0;
	private col: ColIdx = 1; // start on project
	private mode: Mode = "browse";
	private editBuffer = "";
	private options: Array<{ label: string; value: string }> = [];
	private optionCursor = 0;
	private statusMessage = "";
	private readonly palette: Palette;
	private readonly ctx: ExtensionContext;
	private readonly done: (result: undefined) => void;

	constructor(
		ctx: ExtensionContext,
		palette: Palette,
		done: (result: undefined) => void,
	) {
		this.ctx = ctx;
		this.palette = palette;
		this.done = done;
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

	private effective(row: SettingRow): string {
		const val =
			row.session ?? row.project ?? row.global ?? row.defaultValue ?? "\u2014";
		return this.displayModel(row, val);
	}

	/** Resolve provider/id to human-readable model name for display. */
	private displayModel(row: SettingRow, val: string): string {
		if (val === "\u2014") return val;
		const isModelField =
			row.key.endsWith(".model") ||
			(row.extension === "@presets" && row.key !== "active");
		if (!isModelField) return val;
		if (!val.includes("/")) return val;
		const [provider, ...rest] = val.split("/");
		const id = rest.join("/");
		const model = this.ctx.modelRegistry.find(provider, id);
		return (model as { name?: string } | undefined)?.name ?? val;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		const p = this.palette;
		const lines: string[] = [];

		// Layout: percentages of available width, spacers fill rest
		const innerW = _width - 4; // borders + padding
		const labelW = Math.max(20, Math.floor(innerW * 0.25));
		const colW = Math.min(20, Math.max(8, Math.floor(innerW * 0.14)));
		const spacerTotal = Math.max(0, innerW - labelW - colW * 4);
		const spacer1 = Math.floor(spacerTotal * 0.6);
		const spacer2 = spacerTotal - spacer1;
		const boxW = _width;

		// Helper: build a full-width row inside the box
		const line = (content: string): string => {
			const raw = `${p.dim("\u2502")} ${visPad(content, innerW)} ${p.dim("\u2502")}`;
			// Hard guard: never exceed terminal width
			if (visibleWidth(raw) > _width) return truncateToWidth(raw, _width);
			return raw;
		};

		// Title bar
		const title = " maestro config ";
		const topFill = "\u2500".repeat(Math.max(boxW - 3 - title.length, 0));
		lines.push(p.dim(`\u256d\u2500${title}${topFill}\u256e`));

		// Header
		const sp1 = " ".repeat(spacer1);
		const sp2 = " ".repeat(spacer2);
		const hdr =
			visPad("", labelW) +
			sp1 +
			COL_NAMES.map((name, i) => {
				const cell = visPad(name, colW);
				return i === this.col && this.mode === "browse"
					? p.accent(cell)
					: p.muted(cell);
			}).join("") +
			sp2 +
			p.muted(visPad("effective", colW));
		lines.push(line(hdr));
		lines.push(line(""));

		// Sections
		let flatIdx = 0;
		for (const section of this.sections) {
			lines.push(line(p.heading(section.title)));

			for (const r of section.rows) {
				const selected = flatIdx === this.cursor;
				const pointer = selected ? p.accent("\u25b6 ") : "  ";
				const label = visPad(r.label, labelW - 2);

				const cells = [r.global, r.project, r.session].map((val, i) => {
					// Global-only rows show · for project/session
					if (r.globalOnly && i > 0) {
						return p.dim(visPad("\u00b7", colW));
					}

					const isActive = selected && i === this.col;

					// Resolve display value: actual value, or default (for global col)
					const actualVal = val;
					const showDefault = !actualVal && i === 0 && r.defaultValue;
					let display: string;

					if (this.mode === "edit" && isActive) {
						display = `${this.editBuffer}\u2588`;
					} else if (isActive) {
						const v = actualVal ?? r.defaultValue ?? "\u2014";
						const inner = truncateToWidth(this.displayModel(r, v), colW - 4);
						display = `[${inner}]`;
					} else if (showDefault) {
						display = `${r.defaultValue} (def)`;
					} else {
						display = this.displayModel(r, actualVal ?? "\u2014");
					}

					const cell = visPad(truncateToWidth(display, colW - 1), colW);
					if (isActive) return p.accent(cell);
					if (showDefault) return p.dim(cell);
					if (actualVal) return cell;
					return p.dim(cell);
				});

				const eff = this.effective(r);
				const effCell = p.success(visPad(truncateToWidth(eff, colW - 1), colW));

				lines.push(
					line(`${pointer}${label}${sp1}${cells.join("")}${sp2}${effCell}`),
				);
				flatIdx++;
			}
			lines.push(line(""));
		}

		// Option list (select mode)
		if (this.mode === "select" && this.options.length > 0) {
			lines.push(line(p.heading("Select value:")));
			for (let i = 0; i < this.options.length; i++) {
				const opt = this.options[i];
				const sel = i === this.optionCursor;
				const marker = sel ? p.accent("\u25b6 ") : "  ";
				const text = sel ? p.accent(opt.label) : opt.label;
				lines.push(line(`    ${marker}${text}`));
			}
			lines.push(line(""));
		}

		// Naming mode (create new preset)
		if (this.mode === "naming") {
			lines.push(line(""));
			lines.push(
				line(`  New preset name: ${p.accent(`${this.editBuffer}\u2588`)}`),
			);
			lines.push(line(""));
		}

		// Status
		if (this.statusMessage) {
			lines.push(line(`  ${p.success(this.statusMessage)}`));
		}

		// Help bar
		const help =
			this.mode === "select"
				? "\u2191\u2193 choose  Enter confirm  Esc cancel"
				: this.mode === "edit"
					? "Enter: save  Esc: cancel"
					: this.mode === "naming"
						? "Enter: create  Esc: cancel"
						: "\u2191\u2193 navigate  \u2190\u2192 scope  Enter edit  d delete  n new preset  Esc close";
		lines.push(line(p.muted(help)));

		// Bottom border
		lines.push(p.dim(`\u2570${"\u2500".repeat(boxW - 2)}\u256f`));

		return lines;
	}

	handleInput(data: string): void {
		this.statusMessage = "";

		if (this.mode === "edit") {
			this.handleEditInput(data);
			return;
		}
		if (this.mode === "select") {
			this.handleSelectInput(data);
			return;
		}
		if (this.mode === "naming") {
			this.handleNamingInput(data);
			return;
		}

		switch (data) {
			case KEY_UP:
				this.cursor = Math.max(0, this.cursor - 1);
				if (this.flatRows[this.cursor]?.globalOnly) this.col = 0 as ColIdx;
				break;
			case KEY_DOWN:
				this.cursor = Math.min(this.flatRows.length - 1, this.cursor + 1);
				if (this.flatRows[this.cursor]?.globalOnly) this.col = 0 as ColIdx;
				break;
			case KEY_LEFT: {
				const r = this.flatRows[this.cursor];
				if (r?.globalOnly) break; // can't leave global col
				this.col = Math.max(0, this.col - 1) as ColIdx;
				break;
			}
			case KEY_RIGHT: {
				const r = this.flatRows[this.cursor];
				if (r?.globalOnly) break; // can't leave global col
				this.col = Math.min(2, this.col + 1) as ColIdx;
				break;
			}
			case KEY_ENTER: {
				const row = this.flatRows[this.cursor];
				if (row) {
					const opts = getOptionsForKey(row.key, row.extension, this.ctx);
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
				break;
			}
			case "d": {
				const row = this.flatRows[this.cursor];
				if (row) this.deleteCell(row);
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
		if (data.length === 1 && data >= " ") {
			this.editBuffer += data;
		}
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
			if (name) {
				this.createPreset(name);
			}
			this.mode = "browse";
			this.editBuffer = "";
			return;
		}
		if (data === KEY_BACKSPACE) {
			this.editBuffer = this.editBuffer.slice(0, -1);
			return;
		}
		if (data.length === 1 && data >= " ") {
			this.editBuffer += data;
		}
	}

	private createPreset(name: string): void {
		updateSettingsFile("global", this.ctx.cwd, undefined, (raw) => {
			if (!isPlainObject(raw.models)) raw.models = {};
			const models = raw.models as Record<string, unknown>;
			if (!isPlainObject(models.presets)) models.presets = {};
			const presets = models.presets as Record<string, unknown>;
			presets[name] = { default: "", alternate: "" };
			if (!models.active) models.active = name;
		});
		this.statusMessage = `\u2713 Created preset "${name}"`;
		this.sections = buildSections(this.ctx);
		this.rebuildFlat();
	}

	private writeCell(row: SettingRow, raw: string): void {
		const scope = COL_NAMES[this.col];
		const value = this.parseValue(raw);

		if (scope === "session") {
			sessionStore.set(sessionKey(row.extension, row.key), raw);
			this.statusMessage = `\u2713 ${row.extension}.${row.key} = ${raw} [session]`;
		} else if (row.extension === "@presets" && row.key === "active") {
			updateSettingsFile(scope, this.ctx.cwd, undefined, (obj) => {
				if (!isPlainObject(obj.models)) obj.models = {};
				(obj.models as Record<string, unknown>).active = raw;
			});
			this.statusMessage = `\u2713 preset \u2192 ${raw} [${scope}]`;
		} else if (row.extension === "@presets") {
			// Preset slot: key is "name.slot" e.g. "anthropic.default"
			const dotIdx = row.key.indexOf(".");
			const presetName = row.key.slice(0, dotIdx);
			const slot = row.key.slice(dotIdx + 1);
			updateSettingsFile("global", this.ctx.cwd, undefined, (obj) => {
				if (!isPlainObject(obj.models)) obj.models = {};
				const models = obj.models as Record<string, unknown>;
				if (!isPlainObject(models.presets)) models.presets = {};
				const presets = models.presets as Record<string, unknown>;
				if (!isPlainObject(presets[presetName])) presets[presetName] = {};
				(presets[presetName] as Record<string, unknown>)[slot] = raw;
			});
			this.statusMessage = `\u2713 ${presetName}.${slot} = ${raw} [global]`;
		} else {
			writeExtensionConfigKey(
				scope,
				this.ctx.cwd,
				row.extension,
				row.key,
				value,
			);
			this.statusMessage = `\u2713 ${row.extension}.${row.key} = ${raw} [${scope}]`;
		}

		this.sections = buildSections(this.ctx);
		this.rebuildFlat();
	}

	private deleteCell(row: SettingRow): void {
		const scope = COL_NAMES[this.col];

		if (scope === "session") {
			sessionStore.delete(sessionKey(row.extension, row.key));
			this.statusMessage = `\u2713 cleared ${row.extension}.${row.key} [session]`;
		} else if (row.extension !== "@presets") {
			writeExtensionConfigKey(
				scope,
				this.ctx.cwd,
				row.extension,
				row.key,
				null,
			);
			this.statusMessage = `\u2713 cleared ${row.extension}.${row.key} [${scope}]`;
		}

		this.sections = buildSections(this.ctx);
		this.rebuildFlat();
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
}

// ─── Public API ─────────────────────────────────────────────────────────────
const WIDGET_KEY = "maestro.config";
const CONFIG_OVERLAY_ID = "config";

interface OverlaysApi {
	mount(id: string, comp: unknown): void;
	focusOverlay(id: string): void;
	unmount(id: string): void;
}

let activeComp: ConfigMenuComponent | null = null;

export function showConfigMenu(
	ctx: ExtensionContext,
	overlays?: OverlaysApi,
): void {
	// Toggle off if already open
	if (activeComp) {
		if (overlays) {
			overlays.unmount(CONFIG_OVERLAY_ID);
		} else {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
		activeComp = null;
		return;
	}

	const palette = paletteFromTheme(ctx.ui.theme);
	const comp = new ConfigMenuComponent(ctx, palette, () => {
		if (overlays) {
			overlays.unmount(CONFIG_OVERLAY_ID);
		} else {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
		activeComp = null;
	});
	activeComp = comp;

	if (overlays) {
		overlays.mount(CONFIG_OVERLAY_ID, comp);
		overlays.focusOverlay(CONFIG_OVERLAY_ID);
	} else {
		ctx.ui.setWidget(WIDGET_KEY, (_tui: TUI, _theme: Theme) => comp, {
			placement: "aboveEditor",
		});
	}
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
