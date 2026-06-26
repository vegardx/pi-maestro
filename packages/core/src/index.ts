// @vegardx/pi-core — the runtime spine. Consumes @vegardx/pi-contracts; every
// extension builds on these four pieces: defineExtension (the gated entry),
// the capability registry, the typed event bus, and runAgentTurn.

export { runAgentTurn } from "./agent-turn.js";
export {
	__resetCapabilityRegistry,
	createExtensionCapabilities,
	type ExtensionCapabilities,
	getCapability,
	registerCapability,
	requireCapability,
	whenCapabilityAvailable,
} from "./capabilities.js";
export {
	type DefineExtensionOptions,
	defineExtension,
	type MaestroContext,
	type MaestroFactory,
} from "./define-extension.js";
export { createTypedEventBus, type TypedEventBus } from "./events.js";
export {
	createFlagChecker,
	type FlagChecker,
	isExtensionEnabled,
	isFlagEnabled,
	type SettingsLayer,
	setSettingsLayer,
} from "./feature-flags.js";
export { redactSecrets } from "./redact.js";
