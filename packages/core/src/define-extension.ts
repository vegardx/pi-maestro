// defineExtension — every maestro extension's entry point. It:
//
//   1. Gates the whole extension on the feature-flag resolver (env >
//      settings > default-on). A disabled extension's factory never runs, so
//      it registers nothing — the behavioural half of the feature-flag
//      contract.
//   2. Builds the maestro context: an auto-disposing capability facade, the
//      typed event bus over pi.events, and a per-extension flag checker.
//   3. Tears down everything the extension registered on session_shutdown.
//
// Extensions are forbidden from importing each other; they collaborate only
// through `maestro.capabilities` and `maestro.events`.

import type {
	ExtensionAPI,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
	createExtensionCapabilities,
	type ExtensionCapabilities,
} from "./capabilities.js";
import { createTypedEventBus, type TypedEventBus } from "./events.js";
import {
	createFlagChecker,
	type FlagChecker,
	isExtensionEnabled,
} from "./feature-flags.js";

export interface DefineExtensionOptions {
	/** Stable short id, e.g. "modes". Drives PI_EXT_<NAME> and flag paths. */
	name: string;
	/** Manifest path, for diagnostics. */
	path?: string;
	/** One-line description. */
	doc?: string;
}

/** Handed to the factory alongside the raw pi API. */
export interface MaestroContext {
	readonly name: string;
	readonly capabilities: ExtensionCapabilities;
	readonly events: TypedEventBus;
	readonly flags: FlagChecker;
}

export type MaestroFactory = (
	pi: ExtensionAPI,
	maestro: MaestroContext,
) => void | Promise<void>;

export function defineExtension(
	opts: DefineExtensionOptions,
	factory: MaestroFactory,
): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		if (!isExtensionEnabled(opts.name)) return;

		const disposers: Array<() => void> = [];
		const maestro: MaestroContext = {
			name: opts.name,
			capabilities: createExtensionCapabilities(disposers),
			events: createTypedEventBus(pi.events),
			flags: createFlagChecker(opts.name),
		};

		pi.on("session_shutdown", () => {
			for (const dispose of disposers.splice(0)) dispose();
		});

		return factory(pi, maestro);
	};
}
