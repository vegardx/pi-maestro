// @vegardx/pi-settings — read-only layered extension configuration.

export {
	type ExtensionConfig,
	type ExtensionConfigMap,
	getConfigBoolean,
	getConfigNumber,
	getConfigObject,
	getConfigString,
	getConfigStringArray,
	type LayeredExtensionConfig,
	type ProjectTrust,
	readLayeredExtensionConfig,
	readPath,
} from "./reader.js";
