// @vegardx/pi-settings — layered settings reading, typed accessors, atomic
// writes, and the feature-flag SettingsLayer bridge into @vegardx/pi-core.

export {
	getSettingsCompletions,
	handleSettingsCommand,
} from "./command.js";
export { default as settingsExtension } from "./extension.js";
export {
	__resetSettingsLayer,
	createSettingsLayer,
	type InstallSettingsLayerOptions,
	installSettingsLayer,
} from "./layer.js";
export {
	getSessionSetting,
	setSessionSetting,
	showConfigMenu,
} from "./menu.js";
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
	readPath,
} from "./reader.js";
export {
	declaredSetting,
	declaredSettingKeys,
	settingsRegistry,
} from "./registry.js";
export {
	readExtensionConfigKey,
	type SettingsScope,
	settingsPath,
	updateSettingsFile,
	type WriteResult,
	writeExtensionConfigKey,
} from "./writer.js";
