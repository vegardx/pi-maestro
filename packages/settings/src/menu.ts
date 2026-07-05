// Interactive /maestro menu — TUI overlay with scope columns.

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	type OverlayHandle,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { TIERS } from "@vegardx/pi-contracts";
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
		for (const [name, tiers] of Object.entries(modelsConfig.presets)) {
			for (const tier of TIERS) {
				presetRows.push({
					label: `${name} / ${tier}`,
					extension: "@presets",
					key: `${name}.${tier}`,
					global: tiers[tier],
					project: undefined,
					session: undefined,
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
			global: globalVal ?? (defaultStr ? `${defaultStr} (default)` : undefined),
			project: projectVal,
			session: sessVal,
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

type Mode = "browse" | "edit" | "select";

const COL_NAMES = ["global", "project", "session"] as const;
type ColIdx = 0 | 1 | 2;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const TIER_OPTIONS = ["fast", "normal", "heavy"];
const BOOL_OPTIONS = ["true", "false"];

function getOptionsForKey(key: string, ctx: ExtensionContext): string[] | null {
	if (key.endsWith(".thinking")) return THINKING_LEVELS;
	if (key.endsWith(".tier")) return TIER_OPTIONS;
	if (key === "lensDisabled") return BOOL_OPTIONS;
	if (key.endsWith(".model")) {
		const models = ctx.modelRegistry.getAvailable();
		return models.map((m) => `${m.provider}/${m.id}`);
	}
	if (key === "active") {
		const config = readModelsConfig(ctx.cwd);
		if (config) return Object.keys(config.presets);
	}
	return null;
}

class ConfigMenuComponent implements Component, Focusable {
	focused = true;
	private sections: Section[];
	private flatRows: SettingRow[] = [];
	private cursor = 0;
	private col: ColIdx = 1; // start on project
	private mode: Mode = "browse";
	private editBuffer = "";
	private options: string[] = [];
	private optionCursor = 0;
	private statusMessage = "";
	private readonly palette: Palette;
	private readonly ctx: ExtensionContext;
	private readonly done: (result: undefined) => void;
	private handle: OverlayHandle | undefined;

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

	setHandle(handle: OverlayHandle): void {
		this.handle = handle;
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
		return row.session ?? row.project ?? row.global ?? "\u2014";
	}

	invalidate(): void {}

	render(_width: number): string[] {
		const p = this.palette;
		const lines: string[] = [];

		// Layout constants
		const labelW = 24;
		const colW = 16;
		const innerW = labelW + colW * 4;
		const boxW = innerW + 4; // borders + padding

		// Helper: build a full-width row inside the box
		const line = (content: string): string =>
			`${p.dim("\u2502")} ${visPad(content, innerW)} ${p.dim("\u2502")}`;

		// Title bar
		const title = " maestro config ";
		const topFill = "\u2500".repeat(Math.max(boxW - 2 - title.length, 0));
		lines.push(p.dim(`\u256d\u2500${title}${topFill}\u256e`));

		// Header
		const hdr =
			visPad("", labelW) +
			COL_NAMES.map((name, i) => {
				const cell = visPad(name, colW);
				return i === this.col && this.mode === "browse"
					? p.accent(cell)
					: p.muted(cell);
			}).join("") +
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
					const isActive = selected && i === this.col;
					let display: string;

					if (this.mode === "edit" && isActive) {
						display = `${this.editBuffer}\u2588`;
					} else if (isActive) {
						const v = val ?? "\u2014";
						const inner = truncateToWidth(v, colW - 4);
						display = `[${inner}]`;
					} else {
						display = val ?? "\u2014";
					}

					const cell = visPad(truncateToWidth(display, colW - 1), colW);
					if (isActive) return p.accent(cell);
					if (val) return cell;
					return p.dim(cell);
				});

				const eff = this.effective(r);
				const effCell = p.success(visPad(truncateToWidth(eff, colW - 1), colW));

				lines.push(line(`${pointer}${label}${cells.join("")}${effCell}`));
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
				const text = sel ? p.accent(opt) : opt;
				lines.push(line(`    ${marker}${text}`));
			}
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

		switch (data) {
			case KEY_UP:
				this.cursor = Math.max(0, this.cursor - 1);
				break;
			case KEY_DOWN:
				this.cursor = Math.min(this.flatRows.length - 1, this.cursor + 1);
				break;
			case KEY_LEFT:
				this.col = Math.max(0, this.col - 1) as ColIdx;
				break;
			case KEY_RIGHT:
				this.col = Math.min(2, this.col + 1) as ColIdx;
				break;
			case KEY_ENTER: {
				const row = this.flatRows[this.cursor];
				if (row) {
					const opts = getOptionsForKey(row.key, this.ctx);
					if (opts && opts.length > 0) {
						this.options = opts;
						const current = [row.global, row.project, row.session][this.col];
						this.optionCursor = Math.max(0, opts.indexOf(current ?? ""));
						this.mode = "select";
					} else {
						const current = [row.global, row.project, row.session][this.col];
						this.editBuffer = current ?? "";
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
			case KEY_ESC:
			case "q":
				this.handle?.hide();
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
					if (row) this.writeCell(row, selected);
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
		} else if (row.extension !== "@presets") {
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

export async function showConfigMenu(ctx: ExtensionContext): Promise<void> {
	let comp: ConfigMenuComponent | undefined;
	await ctx.ui.custom<undefined>(
		(_tui: TUI, theme: Theme, _keybindings, done) => {
			const palette = paletteFromTheme(theme);
			comp = new ConfigMenuComponent(ctx, palette, done);
			return comp;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "95%",
				maxHeight: "80%",
			},
			onHandle: (handle: OverlayHandle) => {
				comp?.setHandle(handle);
			},
		} as any,
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
