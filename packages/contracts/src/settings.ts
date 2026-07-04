// Settings capability contract — extensions self-declare their configurable
// settings through this interface. The settings extension provides it; other
// extensions resolve it (soft dep) and call declare().

/** The type of a setting determines the picker shown in the /maestro menu. */
export type SettingType =
	| "string"
	| "number"
	| "boolean"
	| "tier"
	| "thinking"
	| "model";

/** A single configurable setting declared by an extension. */
export interface SettingDeclaration {
	/** Dot-path key within the extension (e.g. "models.worker.tier") */
	key: string;
	/** Human-readable label (e.g. "Worker tier") */
	label: string;
	/** Type determines the value picker in the menu */
	type: SettingType;
	/** Default value when nothing is set */
	default?: string | number | boolean;
}

/** The settings.v1 capability — extensions call declare() to register. */
export interface SettingsCapabilityV1 {
	/** Register configurable settings for an extension. */
	declare(extension: string, settings: SettingDeclaration[]): void;
}
