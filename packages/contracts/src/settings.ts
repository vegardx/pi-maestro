// Settings capability contract — extensions self-declare their configurable
// settings through this interface. The settings extension provides it; other
// extensions resolve it (soft dep) and call declare().

/** The type of a setting determines the picker shown in the /maestro menu. */
export type SettingType =
	| "string"
	| "number"
	| "boolean"
	| "choice"
	| "string-list"
	| "slot"
	| "thinking"
	| "model";

/** A closed choice shown by its outcome-oriented label and help text. */
export interface SettingChoiceOption {
	/** Stable value persisted in settings. */
	value: string;
	/** Human-readable outcome. */
	label: string;
	/** Optional detail shown by select controls. */
	description?: string;
	/** Marks the option recommended for most users. */
	recommended?: boolean;
	/** Optional caution shown without changing the persisted value. */
	warning?: string;
}

/** A single configurable setting declared by an extension. */
export interface SettingDeclaration {
	/** Dot-path key within the extension (e.g. "models.agent.effort") */
	key: string;
	/** Human-readable label (e.g. "Worker tier") */
	label: string;
	/** Type determines the value picker in the menu */
	type: SettingType;
	/** Default value when nothing is set */
	default?: string | number | boolean | readonly string[];
	/** Closed values for choice declarations. */
	options?: readonly SettingChoiceOption[];
	/** Outcome-oriented help shown in menus. */
	description?: string;
	/** Preset-specific defaults; individual authored values still win. */
	presetDefaults?: Readonly<
		Record<string, string | number | boolean | readonly string[]>
	>;
	/** First-class menu group, such as "execution-policy". */
	group?: string;
	/** Marks a setting as recommended for normal use. */
	recommended?: boolean;
	/** Caution shown for settings that can weaken isolation or share state. */
	warning?: string;
}

/** The settings.v1 capability — extensions call declare() to register. */
export interface SettingsCapabilityV1 {
	/** Register configurable settings for an extension. */
	declare(extension: string, settings: SettingDeclaration[]): void;
}
