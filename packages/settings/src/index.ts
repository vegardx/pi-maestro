// @vegardx/pi-settings — layered settings reading, typed accessors, atomic
// writes, and the feature-flag SettingsLayer bridge into @vegardx/pi-core.

export {
	__resetSettingsLayer,
	createSettingsLayer,
	type InstallSettingsLayerOptions,
	installSettingsLayer,
} from "./layer.js";
export {
	type ExtensionConfig,
	type ExtensionConfigMap,
	getConfigBoolean,
	getConfigNumber,
	getConfigObject,
	getConfigString,
	getConfigStringArray,
	type LayeredExtensionConfig,
	readLayeredExtensionConfig,
} from "./reader.js";
export {
	readExtensionConfigKey,
	type SettingsScope,
	settingsPath,
	updateSettingsFile,
	type WriteResult,
	writeExtensionConfigKey,
} from "./writer.js";
